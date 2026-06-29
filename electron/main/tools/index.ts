// Agent 工具集组装 —— spider / parser / scorer / database。
// 所有工具共享同一个 ToolDeps（思考链路通知、设置、LLM 评分、跨工具状态）。
//
// 注意：@earendil-works/pi-ai 与 pi-coding-agent 是 ESM-only 包，不能在 Electron
// 主进程（CJS）里静态 import 其运行时值（Type / defineTool），必须动态 import。
// 因此 buildRecruitmentTools 是 async，在这里动态取得 Type/defineTool 后注入各工具。
import type {
  AgentSettings,
  ScoreResult,
  TimelineStage,
  TimelineStatus,
} from "../../shared";

/** TypeBox 的 Type 构造器 + defineTool，运行时由动态 import 注入。 */
export interface ToolSdk {
  Type: typeof import("@earendil-works/pi-ai")["Type"];
  defineTool: typeof import("@earendil-works/pi-coding-agent")["defineTool"];
}

export interface ToolDeps {
  /** 向前端时间轴推送一条事件 */
  notify: (
    stage: TimelineStage,
    message: string,
    status?: TimelineStatus,
    meta?: Record<string, unknown>,
  ) => void;
  /** 读取当前爬虫设置（boss-cli 路径 / headless / OCR / 限频阈值） */
  getSettings: () => AgentSettings["crawler"];
  /** 调用 LLM 对简历打分（复用已配置的自定义 provider endpoint） */
  scoreWithLlm: (resumeText: string, jd: string) => Promise<ScoreResult>;
  /** 跨工具共享的可变状态；agent-core 在每条新指令开始时重置 */
  state: { scraped: number };
}

export async function buildRecruitmentTools(deps: ToolDeps) {
  const [{ Type }, { defineTool }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-coding-agent"),
  ]);
  const sdk: ToolSdk = { Type, defineTool };

  const [{ createSpiderTool }, { createParserTool }, { createScorerTool }, { createDatabaseTool }] =
    await Promise.all([
      import("./spider"),
      import("./parser"),
      import("./scorer"),
      import("./database"),
    ]);

  return [
    createSpiderTool(sdk, deps),
    createParserTool(sdk, deps),
    createScorerTool(sdk, deps),
    createDatabaseTool(sdk, deps),
  ];
}

/**
 * 统一构造工具返回值。AgentToolResult.details 是必填字段，
 * 这里始终带上 details（未提供时为 undefined），避免类型不匹配。
 */
export function toolResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}
