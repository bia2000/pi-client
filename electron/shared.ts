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

export interface AgentSettings {
  crawler: CrawlerSettings;
}

export const DEFAULT_CRAWLER_SETTINGS: CrawlerSettings = {
  bossCliPath: "",
  headless: false,
  ocrEnabled: true,
  minDelaySec: 5,
  maxDelaySec: 15,
  maxPerTask: 50,
};
