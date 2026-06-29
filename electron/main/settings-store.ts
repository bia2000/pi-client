// 设置持久化 —— boss-cli 路径 / headless / OCR / 限频阈值 + 模型 preset 列表 + 活动 agent/model。
// 存于 userData/pi-agent-settings.json。
// 隐私：boss-cli 复用本机 Chrome 登录态，候选人数据仅本地 SQLite，不上传任何外部服务。
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  DEFAULT_CRAWLER_SETTINGS,
  type AgentSettings,
  type ApiProtocol,
  type CrawlerSettings,
  type ModelPreset,
} from "../shared";

function filePath(): string {
  return path.join(app.getPath("userData"), "pi-agent-settings.json");
}

let cache: AgentSettings | null = null;

/** 把 .env 里的 BOSS_* 作为空字段默认值（已保存的用户值优先）。 */
function applyEnvDefaults(crawler: CrawlerSettings): void {
  if (!crawler.bossCliPath && process.env.BOSS_CLI_PATH) {
    crawler.bossCliPath = process.env.BOSS_CLI_PATH.trim();
  }
  if (process.env.BOSS_BROWSER_HEADLESS) {
    crawler.headless = process.env.BOSS_BROWSER_HEADLESS.trim().toLowerCase() === "true";
  }
  if (process.env.BOSS_RESUME_OCR) {
    const v = process.env.BOSS_RESUME_OCR.trim().toLowerCase();
    crawler.ocrEnabled = !(v === "0" || v === "false" || v === "no");
  }
}

/**
 * 当用户尚未配置任何 ModelPreset 时，从 .env 推导默认 preset，
 * 保证现有 .env 配置用户开箱即用。
 */
function deriveDefaultPresetFromEnv(): ModelPreset | null {
  const customEnabled = process.env.PI_CUSTOM_PROVIDER_ENABLED?.trim() === "true";
  if (customEnabled) {
    const provider =
      process.env.PI_CUSTOM_PROVIDER_NAME?.trim() ||
      process.env.PI_MODEL_PROVIDER?.trim() ||
      "custom";
    const modelId =
      process.env.PI_CUSTOM_MODEL_ID?.trim() || process.env.PI_MODEL_ID?.trim();
    const baseUrl = process.env.PI_CUSTOM_BASE_URL?.trim();
    const apiKey =
      process.env.PI_CUSTOM_API_KEY?.trim() || process.env.PI_API_KEY?.trim();
    if (modelId && baseUrl) {
      return {
        id: "default-custom",
        name: process.env.PI_CUSTOM_MODEL_NAME?.trim() || modelId,
        provider,
        modelId,
        apiKey,
        baseUrl,
        api: normalizeApiProtocol(process.env.PI_CUSTOM_API?.trim()),
        reasoning: process.env.PI_CUSTOM_REASONING?.trim() === "true",
        supportsImages: process.env.PI_CUSTOM_SUPPORTS_IMAGES?.trim() === "true",
        contextWindow: Number(process.env.PI_CUSTOM_CONTEXT_WINDOW?.trim() || "128000"),
        maxTokens: Number(process.env.PI_CUSTOM_MAX_TOKENS?.trim() || "8192"),
      };
    }
  }

  const provider = process.env.PI_MODEL_PROVIDER?.trim();
  const modelId = process.env.PI_MODEL_ID?.trim();
  const apiKey = process.env.PI_API_KEY?.trim();
  if (provider && modelId) {
    return {
      id: "default-env",
      name: modelId,
      provider,
      modelId,
      apiKey,
    };
  }

  return null;
}

function normalizeApiProtocol(value?: string): ApiProtocol | undefined {
  if (!value) return undefined;
  const allowed: ApiProtocol[] = [
    "anthropic",
    "openai-completions",
    "openai-responses",
    "azure-openai-responses",
    "openai-codex-responses",
    "google",
    "google-vertex",
    "mistral",
    "bedrock",
  ];
  return (allowed as string[]).includes(value) ? (value as ApiProtocol) : undefined;
}

export function loadSettings(): AgentSettings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    cache = {
      crawler: { ...DEFAULT_CRAWLER_SETTINGS, ...parsed.crawler },
      models: Array.isArray(parsed.models) ? parsed.models : [],
      activeModelId: parsed.activeModelId,
      activeAgentId: parsed.activeAgentId,
    };
  } catch {
    cache = {
      crawler: { ...DEFAULT_CRAWLER_SETTINGS },
      models: [],
    };
  }
  applyEnvDefaults(cache.crawler);

  // 若 models 为空，从 .env 推导一个默认 preset，保证现有 .env 配置用户开箱即用
  if (cache.models.length === 0) {
    const defaultPreset = deriveDefaultPresetFromEnv();
    if (defaultPreset) {
      cache.models = [defaultPreset];
      cache.activeModelId = defaultPreset.id;
    }
  }

  // activeModelId 必须指向 models 中存在的项，否则清空
  if (cache.activeModelId && !cache.models.some((m) => m.id === cache!.activeModelId)) {
    cache.activeModelId = cache.models[0]?.id;
  } else if (!cache.activeModelId && cache.models.length > 0) {
    cache.activeModelId = cache.models[0].id;
  }

  return cache;
}

/**
 * 保存部分设置。patch.crawler 接受 Partial<CrawlerSettings>，与现有 crawler 字段浅合并；
 * models 是整体替换（前端管理完整 preset 列表后整体提交）。
 */
export function saveSettings(patch: {
  crawler?: Partial<CrawlerSettings>;
  models?: ModelPreset[];
  activeModelId?: string;
  activeAgentId?: string;
}): AgentSettings {
  const current = loadSettings();
  cache = {
    crawler: patch.crawler ? { ...current.crawler, ...patch.crawler } : current.crawler,
    models: patch.models ?? current.models,
    activeModelId: patch.activeModelId ?? current.activeModelId,
    activeAgentId: patch.activeAgentId ?? current.activeAgentId,
  };

  // activeModelId 校验
  if (
    cache.activeModelId &&
    !cache.models.some((m) => m.id === cache!.activeModelId)
  ) {
    cache.activeModelId = cache.models[0]?.id;
  }

  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    console.error("[settings] 保存失败", error);
  }
  return cache;
}

/** 保留向后兼容：旧调用方传 Partial<CrawlerSettings> 时仍能工作。 */
export function saveCrawlerSettings(patch: Partial<CrawlerSettings>): AgentSettings {
  return saveSettings({ crawler: patch });
}
