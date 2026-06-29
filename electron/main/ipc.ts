// IPC 处理器注册 —— agent 流式 / 牛人库 CRUD / 设置 / 模型与 Agent 切换。
import { ipcMain, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { RecruitmentAgent } from "./agent-core";
import {
  deleteCandidate,
  getCandidate,
  isDbReady,
  listCandidates,
  stats,
  updateStatus,
} from "./db/sqlite";
import { loadSettings, saveSettings } from "./settings-store";
import { listAgents } from "./agents";
import type {
  AgentRuntimeInfo,
  CandidateFilter,
  CandidateStatus,
  CrawlerSettings,
  ModelPreset,
} from "../shared";

export interface IpcDeps {
  getWindow: () => BrowserWindow | null;
  agent: RecruitmentAgent;
  dbError?: string;
}

/** 通道名常量（主→渲染）。 */
export const CHANNELS = {
  delta: "agent:assistant-delta",
  done: "agent:assistant-done",
  error: "agent:assistant-error",
  timeline: "agent:timeline",
} as const;

export function registerIpc(deps: IpcDeps) {
  const { getWindow, agent } = deps;

  const send = (channel: string, payload: unknown) => {
    getWindow()?.webContents.send(channel, payload);
  };

  ipcMain.handle("agent:runtime-info", async (): Promise<AgentRuntimeInfo> => {
    const info = await agent.getRuntimeInfo();
    return { ...info, dbReady: isDbReady(), dbError: deps.dbError };
  });

  ipcMain.handle("agent:reset-session", async () => agent.reset());

  /** 中止当前流式响应 —— 不重置会话历史，pending 由后续 done/error 自动清除 */
  ipcMain.handle("agent:abort", async () => {
    await agent.abort();
  });

  ipcMain.handle("agent:send-message", async (_event, prompt: string) => {
    await agent.sendPrompt(prompt, {
      onDelta: (payload) => send(CHANNELS.delta, payload),
      onDone: (payload) => send(CHANNELS.done, payload),
      onError: (payload) => send(CHANNELS.error, payload),
    });
  });

  ipcMain.handle("talents:list", async (_event, filter?: CandidateFilter) =>
    listCandidates(filter ?? {}),
  );
  ipcMain.handle("talents:get", async (_event, id: string) => getCandidate(id));
  ipcMain.handle(
    "talents:update-status",
    async (_event, id: string, status: CandidateStatus) => updateStatus(id, status),
  );
  ipcMain.handle("talents:delete", async (_event, id: string) => deleteCandidate(id));
  ipcMain.handle("talents:stats", async () => stats());

  ipcMain.handle("settings:get", async () => loadSettings());
  ipcMain.handle("settings:save", async (_event, patch: Partial<CrawlerSettings>) =>
    saveSettings({ crawler: patch }),
  );

  // —— 模型 preset 管理 / 切换 ——
  ipcMain.handle("agent:list-models", async () => loadSettings().models);
  ipcMain.handle("agent:save-models", async (_event, models: ModelPreset[]) =>
    saveSettings({ models }),
  );
  ipcMain.handle("agent:switch-model", async (_event, id: string) =>
    agent.switchModel(id),
  );

  // —— Agent 列表 / 切换 ——
  ipcMain.handle("agent:list-agents", async () =>
    listAgents().map(({ id, name, description }) => ({ id, name, description })),
  );
  ipcMain.handle("agent:switch-agent", async (_event, id: string) =>
    agent.switchAgent(id),
  );
}

/** 构造一条时间轴事件（agent 的 onTimeline 回调使用）。 */
export function makeTimelineSender(getWindow: () => BrowserWindow | null) {
  return (
    stage: import("../shared").TimelineStage,
    message: string,
    status: import("../shared").TimelineStatus = "default",
    meta?: Record<string, unknown>,
  ) => {
    getWindow()?.webContents.send(CHANNELS.timeline, {
      id: randomUUID(),
      stage,
      message,
      status,
      time: Date.now(),
      meta,
    });
  };
}
