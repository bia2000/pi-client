import { randomUUID } from "node:crypto";
import { cwd } from "node:process";
import dotenv from "dotenv";
import type { Api } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent, AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  AgentRuntimeInfo,
  AgentStreamDeltaEvent,
  AgentStreamDoneEvent,
  AgentStreamErrorEvent,
} from "./shared";

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

export class PiChatService {
  private modulesPromise?: Promise<{
    codingAgent: PiCodingAgentModule;
    piAi: PiAiModule;
  }>;
  private authStorage?: AuthStorage;
  private modelRegistry?: ModelRegistry;
  private sessionPromise?: Promise<AgentSession>;
  private currentSession?: AgentSession;

  constructor(private readonly workspace = cwd()) {}

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const session = await this.ensureSession();
    const { piAi } = await this.ensureServices();
    const configuredProviders = Array.from(
      resolveRuntimeApiKeys(piAi, process.env.PI_MODEL_PROVIDER),
      ([providerName]) => providerName,
    );
    const customProvider = resolveCustomProviderConfig();

    return {
      ready: true,
      provider: session.model?.provider ?? process.env.PI_MODEL_PROVIDER,
      modelId: session.model?.id ?? process.env.PI_MODEL_ID,
      sessionId: session.sessionId,
      workspace: this.workspace,
      hasApiKey: configuredProviders.length > 0 || Boolean(customProvider?.apiKey),
      configuredProviders: customProvider
        ? Array.from(new Set([...configuredProviders, customProvider.provider]))
        : configuredProviders,
      customProvider: Boolean(customProvider),
      customBaseUrl: customProvider?.baseUrl,
    };
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

    console.log("[PiClient] sendPrompt:start", {
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
          console.error("[PiClient] sendPrompt:message-end-error", event.message.errorMessage);
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
        console.log("[PiClient] sendPrompt:done", {
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
        console.error("[PiClient] sendPrompt:stream-error", assistantEvent.error.errorMessage);
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
        console.log("[PiClient] sendPrompt:completed-without-stream-done", {
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
      console.error("[PiClient] sendPrompt:error", error);
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
      ]).then(([codingAgent, piAi]) => ({
        codingAgent,
        piAi,
      }));
    }

    return this.modulesPromise;
  }

  private async ensureServices() {
    const { codingAgent, piAi } = await this.loadModules();

    if (!this.authStorage || !this.modelRegistry) {
      this.authStorage = codingAgent.AuthStorage.create();
      this.modelRegistry = codingAgent.ModelRegistry.create(this.authStorage);
    }

    return {
      codingAgent,
      piAi,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    };
  }

  private async createSession() {
    const { codingAgent, piAi, authStorage, modelRegistry } = await this.ensureServices();
    const provider = process.env.PI_MODEL_PROVIDER?.trim();
    const modelId = process.env.PI_MODEL_ID?.trim();
    const systemPrompt = process.env.PI_SYSTEM_PROMPT?.trim();
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
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
            },
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

    console.log("[PiClient] createSession", {
      requestedProvider: provider,
      requestedModelId: modelId,
      resolvedModel: model ? `${model.provider}/${model.id}` : null,
      configuredProviders: runtimeApiKeys.map(([providerName]) => providerName),
      resolvedProvider,
      customProvider: customProvider
        ? {
            provider: customProvider.provider,
            modelId: customProvider.modelId,
            baseUrl: customProvider.baseUrl,
            api: customProvider.api,
          }
        : null,
    });

    const resourceLoader = new codingAgent.DefaultResourceLoader({
      cwd: this.workspace,
      agentDir: codingAgent.getAgentDir(),
      appendSystemPrompt: systemPrompt ? [`## App Instructions\n${systemPrompt}`] : undefined,
    });
    await resourceLoader.reload();

    const { session } = await codingAgent.createAgentSession({
      authStorage,
      modelRegistry,
      cwd: this.workspace,
      model,
      resourceLoader,
      sessionManager: codingAgent.SessionManager.inMemory(this.workspace),
      noTools: "all",
    });

    this.currentSession = session;
    return session;
  }
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
