// RecruitmentAgent —— pi-agent ReAct 核心循环。
// 在 pi-chat-service 的会话/鉴权/模型配置基础上，按当前 AgentDescriptor 注入对应 system prompt + 工具集，
// 并把工具内部产生的思考链路事件通过 onTimeline 推送到渲染进程。
// 模型切换走热路径（session.setModel + setRuntimeApiKey），不 dispose；
// Agent 切换因 systemPrompt/工具集变化，必须 dispose + createAgentSession 重建。
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
import { getAgent, getDefaultAgentId, listAgents } from "./agents";
import { parseScoreJson } from "./tools/scorer";
import { loadSettings, saveSettings } from "./settings-store";

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
  /** 当前 Agent id；初始化为已注册的第一个 agent，或从 settings 读上次选中的 */
  private currentAgentId: string;

  constructor(
    private readonly workspace = cwd(),
    private readonly deps: RecruitmentAgentDeps,
  ) {
    const settings = loadSettings();
    const savedAgentId = settings.activeAgentId;
    this.currentAgentId =
      savedAgentId && getAgent(savedAgentId) ? savedAgentId : getDefaultAgentId();
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const runtimeSnapshot = await this.collectRuntimeSnapshot();
    const settings = loadSettings();
    const agentMeta = {
      agentId: this.currentAgentId,
      activeModelId: settings.activeModelId ?? settings.models[0]?.id,
      availableAgents: listAgents().map(({ id, name, description }) => ({ id, name, description })),
      availableModels: settings.models,
    };

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
        ...agentMeta,
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
        ...agentMeta,
      };
    }
  }

  async reset(): Promise<AgentRuntimeInfo> {
    this.currentSession?.dispose();
    this.currentSession = undefined;
    this.sessionPromise = undefined;
    return this.getRuntimeInfo();
  }

  /**
   * 中止当前流式响应 —— 调 pi-coding-agent 的 AgentSession.abort()。
   * 不重置会话历史，用户可继续在同一上下文发新指令。
   * 若当前未在流式，调用为 no-op。
   */
  async abort(): Promise<void> {
    const session = this.currentSession;
    if (!session) return;
    try {
      // abort 会让正在进行的 session.prompt() resolve，
      // 上层 sendPrompt 的 subscribe 会收到 message_end（stopReason: "aborted"），
      // 进而触发 onDone，前端 pending 自动清除。
      await session.abort();
    } catch (error) {
      console.error("[PiAgent] abort 失败", error);
    }
  }

  /**
   * 切换 Agent —— 因 systemPrompt / 工具集不同，必须 dispose + 重建 session。
   * 持久化 activeAgentId，下次启动会自动恢复。
   */
  async switchAgent(id: string): Promise<AgentRuntimeInfo> {
    if (!getAgent(id)) {
      throw new Error(`未注册的 Agent: ${id}`);
    }
    this.currentAgentId = id;
    saveSettings({ activeAgentId: id });
    return this.reset();
  }

  /**
   * 切换模型预设 —— 热切换，不 dispose，保留对话历史。
   * 若 session 尚未建立，仅更新持久化，下次 ensureSession 时生效。
   */
  async switchModel(presetId: string): Promise<AgentRuntimeInfo> {
    const settings = loadSettings();
    const preset = settings.models.find((m) => m.id === presetId);
    if (!preset) {
      throw new Error(`未找到模型预设: ${presetId}`);
    }
    saveSettings({ activeModelId: presetId });

    if (this.currentSession && this.modelRegistry && this.authStorage) {
      const model = this.modelRegistry.find(preset.provider, preset.modelId);
      if (!model) {
        throw new Error(
          `模型未注册到 ModelRegistry: ${preset.provider}/${preset.modelId}（请检查设置页 preset 配置）`,
        );
      }
      if (preset.apiKey) {
        this.authStorage.setRuntimeApiKey(preset.provider, preset.apiKey);
      }
      await this.currentSession.setModel(model);
    }

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
    const descriptor = getAgent(this.currentAgentId);
    if (!descriptor) {
      throw new Error(`未注册的 Agent: ${this.currentAgentId}`);
    }
    return descriptor.buildTools({
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
    const userSystemPrompt = process.env.PI_SYSTEM_PROMPT?.trim();
    const settings = loadSettings();

    // 1) 把所有 ModelPreset 注册到 ModelRegistry（自定义 provider 用 registerProvider；
    //    内置 provider 不需要注册，只需注入 apiKey 即可被 find 找到）
    const customProvidersRegistered = new Set<string>();
    for (const preset of settings.models) {
      const isBuiltIn = piAi.getProviders().includes(preset.provider as never) || preset.provider === "openai";
      if (!isBuiltIn && preset.baseUrl && !customProvidersRegistered.has(preset.provider)) {
        modelRegistry.registerProvider(preset.provider, {
          baseUrl: preset.baseUrl,
          apiKey: preset.apiKey,
          api: normalizeApi(preset.api),
          models: [
            {
              id: preset.modelId,
              name: preset.name,
              api: normalizeApi(preset.api),
              baseUrl: preset.baseUrl,
              reasoning: preset.reasoning ?? false,
              input: preset.supportsImages ? ["text", "image"] : ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: preset.contextWindow ?? 128000,
              maxTokens: preset.maxTokens ?? 8192,
            },
          ],
        });
        customProvidersRegistered.add(preset.provider);
      }
      if (preset.apiKey) {
        authStorage.setRuntimeApiKey(preset.provider, preset.apiKey);
      }
    }

    // 2) 解析当前活动 preset（activeModelId > 第一个 preset > 兜底 .env）
    const activePreset =
      settings.models.find((m) => m.id === settings.activeModelId) ?? settings.models[0];
    const fallbackProvider = process.env.PI_MODEL_PROVIDER?.trim();
    const fallbackModelId = process.env.PI_MODEL_ID?.trim();

    let model: ReturnType<ModelRegistry["find"]> | undefined;
    if (activePreset) {
      model = modelRegistry.find(activePreset.provider, activePreset.modelId);
    } else if (fallbackProvider && fallbackModelId) {
      model = modelRegistry.find(fallbackProvider, fallbackModelId);
    }
    const resolvedProvider = model?.provider ?? activePreset?.provider ?? fallbackProvider;

    if (resolvedProvider) {
      const resolvedApiKey = await authStorage.getApiKey(resolvedProvider, { includeFallback: true });
      if (!resolvedApiKey) {
        throw new Error(
          `未检测到 ${resolvedProvider} 的 API Key。请在设置页配置模型预设，或在 .env 中配置 PI_API_KEY。`,
        );
      }
    }

    const descriptor = getAgent(this.currentAgentId);
    if (!descriptor) {
      throw new Error(`未注册的 Agent: ${this.currentAgentId}`);
    }

    console.log("[PiAgent] createSession", {
      agentId: this.currentAgentId,
      activeModelId: activePreset?.id,
      resolvedModel: model ? `${model.provider}/${model.id}` : null,
      presetCount: settings.models.length,
    });

    const appendSystemPrompt = [
      `## ${descriptor.name}\n${descriptor.systemPrompt.join("\n")}`,
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
      // BuiltTools 类型在 types.ts 中为 unknown[] 以避免引入 ESM-only 类型，
      // 此处 cast 回 CustomTool[] 与 createAgentSession 签名对齐。
      customTools: (await this.buildTools()) as never,
      noTools: "builtin",
    });

    this.currentSession = session;
    return session;
  }

  private async collectRuntimeSnapshot() {
    const { piAi } = await this.ensureServices();
    const settings = loadSettings();
    const fallbackProvider = process.env.PI_MODEL_PROVIDER?.trim();
    const fallbackModelId = process.env.PI_MODEL_ID?.trim();
    const customProvider = resolveCustomProviderConfig();
    const envConfiguredProviders = Array.from(
      resolveRuntimeApiKeys(piAi, fallbackProvider),
      ([providerName]) => providerName,
    );

    // 合并 preset 列表中的 provider 与 env 推断的 provider
    const presetProviders = settings.models.map((m) => m.provider);
    const configuredProviders = Array.from(
      new Set([
        ...presetProviders,
        ...(customProvider
          ? [...envConfiguredProviders, customProvider.provider]
          : envConfiguredProviders),
      ]),
    );

    const hasPresetKey = settings.models.some((m) => m.apiKey);
    const hasEnvKey = envConfiguredProviders.length > 0 || Boolean(customProvider?.apiKey);

    // 当 settings.models 非空时，runtime 信息以 preset 为准
    const activePreset =
      settings.models.find((m) => m.id === settings.activeModelId) ?? settings.models[0];

    return {
      provider: activePreset?.provider ?? fallbackProvider,
      modelId: activePreset?.modelId ?? fallbackModelId,
      hasApiKey: hasPresetKey || hasEnvKey,
      configuredProviders,
      customProvider: Boolean(customProvider) || settings.models.some((m) => m.baseUrl),
      customBaseUrl: activePreset?.baseUrl ?? customProvider?.baseUrl,
    };
  }
}

/**
 * 评分 LLM 子调用 —— 优先用 Settings 里当前活动 ModelPreset（与对话主模型一致），
 * 其次用 PI_SCORE_* 环境变量（可为评分单独指定网关/模型），最后回退到 PI_CUSTOM_* / PI_MODEL_*。
 * POST {baseUrl}/chat/completions，强制 JSON 输出。
 *
 * 设计动机：用户在 Settings 页配置 preset 后，评分应自动跟随，不必再改 .env。
 *
 * 注意：解析失败不再静默返回 50 分，而是抛错 —— 由调用方 scorer.ts 捕获后走 fallbackScore，
 * 这样至少能拿到基于规则的、有区分度的分数，而不是清一色的 50。
 */
export async function scoreWithLlm(resumeText: string, jd: string): Promise<ScoreResult> {
  const settings = loadSettings();
  const activePreset =
    settings.models.find((m) => m.id === settings.activeModelId) ?? settings.models[0];

  const baseUrl =
    process.env.PI_SCORE_BASE_URL?.trim() ||
    activePreset?.baseUrl ||
    process.env.PI_CUSTOM_BASE_URL?.trim();
  const apiKey =
    process.env.PI_SCORE_API_KEY?.trim() ||
    activePreset?.apiKey ||
    process.env.PI_CUSTOM_API_KEY?.trim() ||
    process.env.PI_API_KEY?.trim();
  const model =
    process.env.PI_SCORE_MODEL_ID?.trim() ||
    activePreset?.modelId ||
    process.env.PI_CUSTOM_MODEL_ID?.trim() ||
    process.env.PI_MODEL_ID?.trim();

  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      "未配置评分 LLM：请在设置页配置模型预设，或在 .env 中配置 PI_SCORE_* / PI_CUSTOM_*（BASE_URL / API_KEY / MODEL_ID）",
    );
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
      response_format: { type: "json_object" },
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
      // 透传完整响应体，便于诊断网关错误（非 2xx 时 axios 才会带 error.response）
      validateStatus: () => true,
    },
  );

  // 网关可能返回非 2xx（如安全服务拦截、404、429），此时 content 多半不可用
  const status = res.status;
  const payload = res.data;

  // 兼容两种响应封装：
  //   1) 标准 OpenAI：顶层即 { choices: [...] }
  //   2) 安全网关包裹：{ retCode, retMessage, result: { choices: [...] } }
  //     （safe.xfsk.org.cn 等网关会把 OpenAI 响应整体放进 result 字段）
  const openaiLike = payload?.choices ? payload : payload?.result;
  const content: string = openaiLike?.choices?.[0]?.message?.content ?? "";

  if (status < 200 || status >= 300) {
    const snippet = JSON.stringify(payload).slice(0, 500);
    throw new Error(
      `评分 LLM 接口返回非成功状态 ${status}。响应片段：${snippet}`,
    );
  }

  if (!content) {
    // 没拿到文本（结构异常 / 被网关改写），抛错让上层走 fallback
    const snippet = JSON.stringify(payload).slice(0, 500);
    throw new Error(`评分 LLM 未返回 message.content。响应片段：${snippet}`);
  }

  const parsed = parseScoreJson(content);
  if (parsed.score === undefined) {
    // 解析不到 score —— 原始内容贴进错误信息，便于定位是模型格式问题还是网关改写
    throw new Error(
      `评分 LLM 返回内容无法解析出 score。原始内容：${content.slice(0, 500)}`,
    );
  }

  return {
    score: parsed.score,
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
