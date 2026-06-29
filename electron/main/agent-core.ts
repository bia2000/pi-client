// RecruitmentAgent —— pi-agent ReAct 核心循环。
// 在 pi-chat-service 的会话/鉴权/模型配置基础上，注入 4 个招聘工具 + 招聘向 system prompt，
// 并把工具内部产生的思考链路事件通过 onTimeline 推送到渲染进程。
import { randomUUID } from "node:crypto";
import { cwd } from "node:process";
import axios from "axios";
import dotenv from "dotenv";
import type { Api } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  AgentSessionEvent,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntimeInfo,
  AgentStreamDeltaEvent,
  AgentStreamDoneEvent,
  AgentStreamErrorEvent,
  ScoreResult,
  TimelineStage,
  TimelineStatus,
} from "../shared";
import { buildRecruitmentTools } from "./tools";
import { parseScoreJson } from "./tools/scorer";

dotenv.config();

type StreamCallbacks = {
  onDelta: (event: AgentStreamDeltaEvent) => void;
  onDone: (event: AgentStreamDoneEvent) => void;
  onError: (event: AgentStreamErrorEvent) => void;
};

type PiCodingAgentModule = typeof import("@earendil-works/pi-coding-agent");
type PiAiModule = typeof import("@earendil-works/pi-ai");

type CustomProviderConfig = {
  provider: string;
  modelId: string;
  modelName: string;
  apiKey?: string;
  baseUrl: string;
  api: Api;
  reasoning: boolean;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
};

export interface RecruitmentAgentDeps {
  /** 工具思考链路事件 → 渲染进程时间轴 */
  onTimeline: (
    stage: TimelineStage,
    message: string,
    status?: TimelineStatus,
    meta?: Record<string, unknown>,
  ) => void;
  /** 读取当前爬虫设置（来自设置页持久化） */
  getSettings: () => import("../shared").AgentSettings["crawler"];
}

const RECRUITMENT_SYSTEM_PROMPT = [
  "你是 Pi-Agent 智能招聘助手，运行在本地桌面客户端，帮助 HR 自动化 BOSS直聘招聘流程。",
  "",
  "【工作闭环 ReAct】",
  "1. boss_spider_tool：传 keyword（如「Vue前端」）调 boss-cli recommend 抓取推荐列表，返回包含 candidateName 的候选人列表；",
  "2. resume_parser_tool：传上一步的 candidateName 调 boss-cli preview 抓取在线简历（OCR 文本 + 截图路径）；",
  "3. resume_scorer_tool：以用户给出的 JD 为基准对简历评分（0-100）；",
  "4. database_tool(action=upsert)：仅把评分 > 60 的候选人入库到本地牛人库。",
  "",
  "【硬约束】",
  "- boss-cli 通过本机 Chrome 复用 BOSS直聘登录态，无需 Cookie；爬虫内置随机延时(5-15s)与单任务 ≤50 上限，不要尝试绕过限频；",
  "- 任何工具返回 ERROR_CODE: LOGIN_EXPIRED 时，立即停止抓取，提醒用户在本机执行 `boss login` 重新登录 BOSS直聘（不是导入 Cookie，本客户端已改为通过 @joohw/boss-cli 驱动本机 Chrome 复用登录态，无需 Cookie）；",
  "- resume_parser_tool 依赖 boss_spider_tool 已让浏览器停在推荐页；若返回 PREVIEW_CONTEXT_MISSING，请先调 spider 再调 parser；",
  "- 仅评分 > 60 的候选人才入库；",
  "- 每一步都用一句话说明你正在做什么与得到了什么；",
  "- 候选人数据仅本地 SQLite 存储，严禁向任何外部服务器发送候选人数据。",
];

export class RecruitmentAgent {
  private modulesPromise?: Promise<{
    codingAgent: PiCodingAgentModule;
    piAi: PiAiModule;
  }>;
  private authStorage?: AuthStorage;
  private modelRegistry?: ModelRegistry;
  private sessionPromise?: Promise<AgentSession>;
  private currentSession?: AgentSession;
  private readonly toolState = { scraped: 0 };

  constructor(
    private readonly workspace = cwd(),
    private readonly deps: RecruitmentAgentDeps,
  ) {}

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const runtimeSnapshot = await this.collectRuntimeSnapshot();

    try {
      const session = await this.ensureSession();

      return {
        ready: true,
        provider: session.model?.provider ?? runtimeSnapshot.provider,
        modelId: session.model?.id ?? runtimeSnapshot.modelId,
        sessionId: session.sessionId,
        sessionActive: true,
        workspace: this.workspace,
        hasApiKey: runtimeSnapshot.hasApiKey,
        configuredProviders: runtimeSnapshot.configuredProviders,
        customProvider: runtimeSnapshot.customProvider,
        customBaseUrl: runtimeSnapshot.customBaseUrl,
      };
    } catch (error) {
      const blockedReason =
        error instanceof Error ? error.message : "当前无法初始化招聘 Agent 会话，请检查模型配置。";

      return {
        ready: false,
        provider: runtimeSnapshot.provider,
        modelId: runtimeSnapshot.modelId,
        sessionActive: false,
        workspace: this.workspace,
        hasApiKey: runtimeSnapshot.hasApiKey,
        configuredProviders: runtimeSnapshot.configuredProviders,
        customProvider: runtimeSnapshot.customProvider,
        customBaseUrl: runtimeSnapshot.customBaseUrl,
        blockedReason,
      };
    }
  }

  async reset(): Promise<AgentRuntimeInfo> {
    this.currentSession?.dispose();
    this.currentSession = undefined;
    this.sessionPromise = undefined;
    return this.getRuntimeInfo();
  }

  async sendPrompt(prompt: string, callbacks: StreamCallbacks): Promise<void> {
    const session = await this.ensureSession();
    const conversationId = session.sessionId ?? randomUUID();
    const messageId = randomUUID();
    let finalText = "";
    let completed = false;

    // 每条新指令重置单任务抓取计数器
    this.toolState.scraped = 0;
    this.deps.onTimeline("plan", `接收招聘指令：${prompt.slice(0, 60)}${prompt.length > 60 ? "…" : ""}`, "active");

    console.log("[PiAgent] sendPrompt:start", {
      provider: session.model?.provider,
      modelId: session.model?.id,
      sessionId: session.sessionId,
      promptLength: prompt.length,
    });

    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      if (event.type !== "message_update") {
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          event.message.stopReason === "error"
        ) {
          completed = true;
          console.error("[PiAgent] sendPrompt:message-end-error", event.message.errorMessage);
          this.deps.onTimeline("error", "Agent 执行出错。", "error");
          callbacks.onError({
            conversationId,
            messageId,
            error: event.message.errorMessage ?? "Pi Agent 执行失败",
          });
        }
        return;
      }

      const assistantEvent = event.assistantMessageEvent;

      if (assistantEvent.type === "text_delta") {
        finalText += assistantEvent.delta;
        callbacks.onDelta({
          conversationId,
          messageId,
          delta: assistantEvent.delta,
        });
        return;
      }

      if (assistantEvent.type === "done") {
        completed = true;
        this.deps.onTimeline("done", "本轮招聘流程结束。", "success");
        console.log("[PiAgent] sendPrompt:done", {
          provider: session.model?.provider,
          modelId: session.model?.id,
          sessionId: session.sessionId,
          responseLength: finalText.length,
        });
        callbacks.onDone({
          conversationId,
          messageId,
          text: finalText || extractAssistantText(assistantEvent.message.content),
        });
        return;
      }

      if (assistantEvent.type === "error") {
        completed = true;
        console.error("[PiAgent] sendPrompt:stream-error", assistantEvent.error.errorMessage);
        this.deps.onTimeline("error", assistantEvent.error.errorMessage ?? "Agent 流式错误", "error");
        callbacks.onError({
          conversationId,
          messageId,
          error: assistantEvent.error.errorMessage ?? "Pi Agent 执行失败",
        });
      }
    });

    try {
      await session.prompt(prompt);

      if (!completed) {
        console.log("[PiAgent] sendPrompt:completed-without-stream-done", {
          provider: session.model?.provider,
          modelId: session.model?.id,
          sessionId: session.sessionId,
          responseLength: finalText.length,
        });
        callbacks.onDone({
          conversationId,
          messageId,
          text: finalText,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pi Agent 执行失败";
      console.error("[PiAgent] sendPrompt:error", error);
      this.deps.onTimeline("error", message, "error");
      callbacks.onError({
        conversationId,
        messageId,
        error: message,
      });
      throw error;
    } finally {
      unsubscribe();
    }
  }

  private async buildTools() {
    return buildRecruitmentTools({
      notify: this.deps.onTimeline,
      getSettings: this.deps.getSettings,
      scoreWithLlm,
      state: this.toolState,
    });
  }

  private async ensureSession() {
    if (!this.sessionPromise) {
      this.sessionPromise = this.createSession();
    }
    return this.sessionPromise;
  }

  private async loadModules() {
    if (!this.modulesPromise) {
      this.modulesPromise = Promise.all([
        import("@earendil-works/pi-coding-agent"),
        import("@earendil-works/pi-ai"),
      ]).then(([codingAgent, piAi]) => ({ codingAgent, piAi }));
    }
    return this.modulesPromise;
  }

  private async ensureServices() {
    const { codingAgent, piAi } = await this.loadModules();

    if (!this.authStorage || !this.modelRegistry) {
      this.authStorage = codingAgent.AuthStorage.create();
      this.modelRegistry = codingAgent.ModelRegistry.create(this.authStorage);
    }

    return { codingAgent, piAi, authStorage: this.authStorage, modelRegistry: this.modelRegistry };
  }

  private async createSession() {
    const { codingAgent, piAi, authStorage, modelRegistry } = await this.ensureServices();
    const provider = process.env.PI_MODEL_PROVIDER?.trim();
    const modelId = process.env.PI_MODEL_ID?.trim();
    const userSystemPrompt = process.env.PI_SYSTEM_PROMPT?.trim();
    const customProvider = resolveCustomProviderConfig();
    const runtimeApiKeys = Array.from(resolveRuntimeApiKeys(piAi, provider));

    if (customProvider) {
      modelRegistry.registerProvider(customProvider.provider, {
        baseUrl: customProvider.baseUrl,
        apiKey: customProvider.apiKey,
        api: customProvider.api,
        models: [
          {
            id: customProvider.modelId,
            name: customProvider.modelName,
            api: customProvider.api,
            baseUrl: customProvider.baseUrl,
            reasoning: customProvider.reasoning,
            input: customProvider.input,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: customProvider.contextWindow,
            maxTokens: customProvider.maxTokens,
          },
        ],
      });
    }

    for (const [providerName, apiKey] of runtimeApiKeys) {
      authStorage.setRuntimeApiKey(providerName, apiKey);
    }
    if (customProvider?.apiKey) {
      authStorage.setRuntimeApiKey(customProvider.provider, customProvider.apiKey);
    }

    const model = provider && modelId ? modelRegistry.find(provider, modelId) : undefined;
    const resolvedProvider = model?.provider ?? provider;

    if (resolvedProvider) {
      const resolvedApiKey = await authStorage.getApiKey(resolvedProvider, { includeFallback: true });
      if (!resolvedApiKey) {
        throw new Error(
          `未检测到 ${resolvedProvider} 的 API Key。请在 .env 中配置对应 provider 的密钥，或设置 PI_API_KEY。`,
        );
      }
    }

    console.log("[PiAgent] createSession", {
      requestedProvider: provider,
      requestedModelId: modelId,
      resolvedModel: model ? `${model.provider}/${model.id}` : null,
      tools: ["boss_spider_tool", "resume_parser_tool", "resume_scorer_tool", "database_tool"],
    });

    const appendSystemPrompt = [
      `## 招聘 Agent 角色与工具\n${RECRUITMENT_SYSTEM_PROMPT.join("\n")}`,
    ];
    if (userSystemPrompt) {
      appendSystemPrompt.push(`## App Instructions\n${userSystemPrompt}`);
    }

    const resourceLoader = new codingAgent.DefaultResourceLoader({
      cwd: this.workspace,
      agentDir: codingAgent.getAgentDir(),
      appendSystemPrompt,
    });
    await resourceLoader.reload();

    const { session } = await codingAgent.createAgentSession({
      authStorage,
      modelRegistry,
      cwd: this.workspace,
      model,
      resourceLoader,
      sessionManager: codingAgent.SessionManager.inMemory(this.workspace),
      customTools: await this.buildTools(),
      noTools: "builtin",
    });

    this.currentSession = session;
    return session;
  }

  private async collectRuntimeSnapshot() {
    const { piAi } = await this.ensureServices();
    const provider = process.env.PI_MODEL_PROVIDER?.trim();
    const modelId = process.env.PI_MODEL_ID?.trim();
    const customProvider = resolveCustomProviderConfig();
    const configuredProviders = Array.from(
      resolveRuntimeApiKeys(piAi, provider),
      ([providerName]) => providerName,
    );

    return {
      provider,
      modelId,
      hasApiKey: configuredProviders.length > 0 || Boolean(customProvider?.apiKey),
      configuredProviders: customProvider
        ? Array.from(new Set([...configuredProviders, customProvider.provider]))
        : configuredProviders,
      customProvider: Boolean(customProvider),
      customBaseUrl: customProvider?.baseUrl,
    };
  }
}

/**
 * 评分 LLM 子调用 —— 复用 .env 中配置的 OpenAI 兼容自定义 provider endpoint。
 * POST {PI_CUSTOM_BASE_URL}/chat/completions，强制 JSON 输出。
 */
export async function scoreWithLlm(resumeText: string, jd: string): Promise<ScoreResult> {
  const baseUrl = process.env.PI_CUSTOM_BASE_URL?.trim();
  const apiKey = process.env.PI_CUSTOM_API_KEY?.trim() || process.env.PI_API_KEY?.trim();
  const model =
    process.env.PI_CUSTOM_MODEL_ID?.trim() || process.env.PI_MODEL_ID?.trim();

  if (!baseUrl || !apiKey || !model) {
    throw new Error("未配置评分 LLM（需要 PI_CUSTOM_BASE_URL / PI_CUSTOM_API_KEY / PI_CUSTOM_MODEL_ID）");
  }

  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const system =
    "你是招聘评分助手。严格只输出一个 JSON 对象，字段：score(0-100 整数)、matchLevel(高/中/低)、jobHoppingRisk(简短描述)、reason(简短推荐理由)。禁止输出 JSON 以外的任何文字。";
  const user = `【岗位 JD】\n${jd}\n\n【候选人简历】\n${resumeText}\n\n请输出评分 JSON。`;

  const res = await axios.post(
    url,
    {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.2,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    },
  );

  const content: string = res.data?.choices?.[0]?.message?.content ?? "";
  const parsed = parseScoreJson(content);
  return {
    score: parsed.score ?? 50,
    matchLevel: parsed.matchLevel ?? "中",
    jobHoppingRisk: parsed.jobHoppingRisk ?? "未知",
    reason: parsed.reason ?? "(LLM 未给出理由)",
  };
}

function extractAssistantText(content: Array<{ type: string; text?: string }>) {
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("");
}

function resolveRuntimeApiKeys(piAi: PiAiModule, preferredProvider?: string) {
  const configuredProviders = new Set<string>();

  if (preferredProvider) {
    configuredProviders.add(preferredProvider);
  }
  for (const providerName of piAi.getProviders()) {
    configuredProviders.add(providerName);
  }
  configuredProviders.add("openai");

  const resolved = new Map<string, string>();

  for (const providerName of configuredProviders) {
    const envKeys = piAi.findEnvKeys(providerName) ?? [];
    for (const envKey of envKeys) {
      const value = process.env[envKey]?.trim();
      if (value) {
        resolved.set(providerName, value);
        break;
      }
    }
  }

  const genericProvider = process.env.PI_MODEL_PROVIDER?.trim();
  const genericApiKey = process.env.PI_API_KEY?.trim();
  if (genericProvider && genericApiKey) {
    resolved.set(genericProvider, genericApiKey);
  }

  return resolved.entries();
}

function resolveCustomProviderConfig(): CustomProviderConfig | null {
  const enabled = process.env.PI_CUSTOM_PROVIDER_ENABLED?.trim() === "true";
  if (!enabled) {
    return null;
  }

  const provider = process.env.PI_CUSTOM_PROVIDER_NAME?.trim() || process.env.PI_MODEL_PROVIDER?.trim();
  const modelId = process.env.PI_CUSTOM_MODEL_ID?.trim() || process.env.PI_MODEL_ID?.trim();
  const modelName = process.env.PI_CUSTOM_MODEL_NAME?.trim() || modelId;
  const baseUrl = process.env.PI_CUSTOM_BASE_URL?.trim();
  const apiKey = process.env.PI_CUSTOM_API_KEY?.trim() || process.env.PI_API_KEY?.trim();
  const api = normalizeApi(process.env.PI_CUSTOM_API?.trim());
  const reasoning = process.env.PI_CUSTOM_REASONING?.trim() === "true";
  const supportsImages = process.env.PI_CUSTOM_SUPPORTS_IMAGES?.trim() === "true";
  const contextWindow = Number(process.env.PI_CUSTOM_CONTEXT_WINDOW?.trim() || "128000");
  const maxTokens = Number(process.env.PI_CUSTOM_MAX_TOKENS?.trim() || "8192");

  if (!provider || !modelId || !baseUrl) {
    throw new Error(
      "已启用自定义模型，但缺少必要配置。请至少设置 PI_CUSTOM_PROVIDER_NAME、PI_CUSTOM_MODEL_ID、PI_CUSTOM_BASE_URL。",
    );
  }

  return {
    provider,
    modelId,
    modelName: modelName || modelId,
    apiKey,
    baseUrl,
    api,
    reasoning,
    input: supportsImages ? ["text", "image"] : ["text"],
    contextWindow: Number.isFinite(contextWindow) ? contextWindow : 128000,
    maxTokens: Number.isFinite(maxTokens) ? maxTokens : 8192,
  };
}

function normalizeApi(value?: string): Api {
  switch (value) {
    case "anthropic":
    case "openai-completions":
    case "openai-responses":
    case "azure-openai-responses":
    case "openai-codex-responses":
    case "google":
    case "google-vertex":
    case "mistral":
    case "bedrock":
      return value;
    default:
      return "openai-completions";
  }
}
