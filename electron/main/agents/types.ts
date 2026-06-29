// Agent 描述符 —— 把 systemPrompt + 工具集 + 元信息封装为可注册单元。
// 新增 Agent 只需实现该接口并调用 registerAgent，无需改动核心循环。
import type { TimelineStage } from "../../shared";
import type { ToolDeps } from "../tools";

/**
 * Agent 工具集构造函数返回值类型。
 * 用 unknown[] 避免在类型层引入 ESM-only 的 pi-coding-agent CustomTool 类型；
 * agent-core 在 createAgentSession 调用点会用类型断言转换为 CustomTool[]。
 */
export type BuiltTools = unknown[];

export interface AgentDescriptor {
  /** 唯一 id，如 "boss-recruit" */
  id: string;
  /** 显示名称，如 "BOSS 招聘 Agent" */
  name: string;
  /** 一句话描述，UI 下拉显示 */
  description: string;
  /** 系统提示（追加在 pi 默认 systemPrompt 之后） */
  systemPrompt: string[];
  /** 该 agent 可能产生的时间轴阶段（用于前端过滤/着色） */
  timelineStages: TimelineStage[];
  /** 构造该 agent 的工具集（异步：动态 import pi-ai/pi-coding-agent） */
  buildTools(deps: ToolDeps): Promise<BuiltTools>;
}
