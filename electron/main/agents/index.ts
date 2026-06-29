// Agent 注册入口 —— main.ts 启动时 import 本文件以触发所有内置 agent 注册。
// 未来新增 agent 只需新建 descriptor 文件并在此 registerAgent。
import { registerAgent } from "./registry";
import { bossRecruitAgent } from "./boss-recruit";

export * from "./types";
export * from "./registry";

// 内置 Agent
registerAgent(bossRecruitAgent);
// 未来：registerAgent(codeAssistantAgent);
