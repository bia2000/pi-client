// Agent 注册表 —— 进程级单例 Map，存储所有已注册的 AgentDescriptor。
// 切换 Agent 时通过 getAgent(id) 取出对应 descriptor，构造 systemPrompt + customTools 后重建 session。
import type { AgentDescriptor } from "./types";

const AGENT_REGISTRY = new Map<string, AgentDescriptor>();

export function registerAgent(desc: AgentDescriptor): void {
  AGENT_REGISTRY.set(desc.id, desc);
}

export function getAgent(id: string): AgentDescriptor | undefined {
  return AGENT_REGISTRY.get(id);
}

export function listAgents(): AgentDescriptor[] {
  return Array.from(AGENT_REGISTRY.values());
}

/** 第一个注册的 agent 作为默认；若未注册任何 agent 抛错。 */
export function getDefaultAgentId(): string {
  const first = AGENT_REGISTRY.keys().next();
  if (first.done) {
    throw new Error("未注册任何 Agent，请检查 electron/main/agents/index.ts 入口");
  }
  return first.value;
}
