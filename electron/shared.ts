// IPC 共享类型 —— 主进程与渲染进程之间的契约。
// 隐私合规：候选人数据仅本地 SQLite 存储，严禁向任何外部服务器发送。

/* ----------------------------- 基础会话 / 运行时 ----------------------------- */

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  pending?: boolean;
  error?: boolean;
}

export interface ChatSendPayload {
  prompt: string;
}

export interface AgentRuntimeInfo {
  ready: boolean;
  provider?: string;
  modelId?: string;
  sessionId?: string;
  sessionActive?: boolean;
  workspace?: string;
  hasApiKey?: boolean;
  configuredProviders?: string[];
  customProvider?: boolean;
  customBaseUrl?: string;
  blockedReason?: string;
  /** SQLite 是否可用（原生模块加载失败时为 false） */
  dbReady?: boolean;
  dbError?: string;
  /** 当前 Agent id（如 "boss-recruit"） */
  agentId?: string;
  /** 当前活动模型 preset id */
  activeModelId?: string;
  /** 已注册的 Agent 列表（前端下拉用） */
  availableAgents?: AgentInfo[];
  /** 已配置的模型 preset 列表（前端下拉用） */
  availableModels?: ModelPreset[];
}

export interface AgentStreamEvent {
  conversationId: string;
  messageId: string;
}

export interface AgentStreamDeltaEvent extends AgentStreamEvent {
  delta: string;
}

export interface AgentStreamDoneEvent extends AgentStreamEvent {
  text: string;
}

export interface AgentStreamErrorEvent extends AgentStreamEvent {
  error: string;
}

/* ----------------------------- 招聘领域模型 ----------------------------- */

export type CandidateStatus = "待沟通" | "已沟通" | "已发offer" | "已淘汰";

export type MatchLevel = "高" | "中" | "低";

/** 解析后的结构化简历 */
export interface Resume {
  candidateId?: string;
  name?: string;
  title?: string;
  city?: string;
  expectSalary?: string;
  workYears?: string;
  skills: string[];
  workExperience: string[];
  projectExperience: string[];
  education?: string;
  raw?: string;
}

/** 评分结果（LLM 强制 JSON 输出） */
export interface ScoreResult {
  score: number; // 0-100
  matchLevel: MatchLevel; // 高/中/低
  jobHoppingRisk: string; // 跳槽频繁度风险
  reason: string; // 推荐理由
  eliminated?: boolean; // 是否被硬规则预过滤淘汰
}

/** 牛人库中的候选人记录 */
export interface Candidate {
  id: string;
  candidateId?: string;
  name: string;
  title?: string;
  city?: string;
  expectSalary?: string;
  skills: string[];
  workYears?: string;
  score: number;
  matchLevel: MatchLevel;
  jobHoppingRisk: string;
  reason: string;
  status: CandidateStatus;
  jd?: string;
  resumeJson?: string;
  sourceUrl?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CandidateFilter {
  keyword?: string;
  status?: CandidateStatus;
  minScore?: number;
  limit?: number;
}

export type CandidateStats = {
  total: number;
} & Record<CandidateStatus, number>;

/* ----------------------------- Agent 思考链路 ----------------------------- */

export type TimelineStage =
  | "plan"
  | "spider"
  | "parse"
  | "score"
  | "database"
  | "done"
  | "login_expired"
  | "error"
  | "info";

export type TimelineStatus = "default" | "active" | "success" | "error";

export interface TimelineEvent {
  id: string;
  stage: TimelineStage;
  message: string;
  status: TimelineStatus;
  time: number;
  meta?: Record<string, unknown>;
}

/* ----------------------------- 设置 ----------------------------- */

export interface CrawlerSettings {
  /** boss-cli cli.js 入口路径；空则使用包内 @joohw/boss-cli/dist/cli/index.js */
  bossCliPath: string;
  /** 是否无头模式驱动 Chrome；默认 false（有头，规避自动化检测） */
  headless: boolean;
  /** 是否启用 boss-cli 自带百度 OCR（需配百度凭据）；
   *  关闭时 preview 仅返回截图路径 —— 对应文档方案 A 的 BOSS_RESUME_OCR=0 */
  ocrEnabled: boolean;
  /** 调用 boss-cli 之间最小延时（秒），拟人节奏 */
  minDelaySec: number;
  /** 调用 boss-cli 之间最大延时（秒） */
  maxDelaySec: number;
  /** 单次招聘任务抓取候选人数上限（参考文档 §7.1 反爬） */
  maxPerTask: number;
}

/**
 * API 协议字符串字面量联合（与 @earendil-works/pi-ai 的 Api 类型对齐）。
 * 用字符串字面量避免在 shared.ts 中引入 ESM-only 的 pi-ai 类型。
 */
export type ApiProtocol =
  | "anthropic"
  | "openai-completions"
  | "openai-responses"
  | "azure-openai-responses"
  | "openai-codex-responses"
  | "google"
  | "google-vertex"
  | "mistral"
  | "bedrock";

/** 模型预设 —— 用户可在设置页配置多个，运行时切换。 */
export interface ModelPreset {
  /** 唯一 id（前端选择用） */
  id: string;
  /** 显示名称，如 "GPT-4.1 Mini" */
  name: string;
  /** provider 名，如 "openai" / "anthropic" / 自定义 provider 名 */
  provider: string;
  /** 模型 id，如 "gpt-4.1-mini" */
  modelId: string;
  /** API Key（可空，为空时复用 provider 已配置的 key 或 env） */
  apiKey?: string;
  /** 自定义 OpenAI 兼容 endpoint（仅当 provider 不是 pi 内置时使用） */
  baseUrl?: string;
  /** API 协议，默认 "openai-completions" */
  api?: ApiProtocol;
  reasoning?: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** 已注册 Agent 的轻量信息（前端下拉用）。 */
export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

export interface AgentSettings {
  crawler: CrawlerSettings;
  /** 模型预设列表 */
  models: ModelPreset[];
  /** 当前活动模型 preset id */
  activeModelId?: string;
  /** 当前活动 Agent id */
  activeAgentId?: string;
}

export const DEFAULT_CRAWLER_SETTINGS: CrawlerSettings = {
  bossCliPath: "",
  headless: false,
  ocrEnabled: true,
  minDelaySec: 5,
  maxDelaySec: 15,
  maxPerTask: 50,
};

export const DEFAULT_MODEL_SETTINGS: Pick<AgentSettings, "models"> = {
  models: [],
};
