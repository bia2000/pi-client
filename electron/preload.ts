import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentInfo,
  AgentRuntimeInfo,
  AgentStreamDeltaEvent,
  AgentStreamDoneEvent,
  AgentStreamErrorEvent,
  AgentSettings,
  Candidate,
  CandidateFilter,
  CandidateStats,
  CandidateStatus,
  CrawlerSettings,
  ModelPreset,
  TimelineEvent,
} from "./shared";

const listeners = {
  delta: new Set<(event: AgentStreamDeltaEvent) => void>(),
  done: new Set<(event: AgentStreamDoneEvent) => void>(),
  error: new Set<(event: AgentStreamErrorEvent) => void>(),
  timeline: new Set<(event: TimelineEvent) => void>(),
};

ipcRenderer.on("agent:assistant-delta", (_event, payload: AgentStreamDeltaEvent) => {
  listeners.delta.forEach((listener) => listener(payload));
});
ipcRenderer.on("agent:assistant-done", (_event, payload: AgentStreamDoneEvent) => {
  listeners.done.forEach((listener) => listener(payload));
});
ipcRenderer.on("agent:assistant-error", (_event, payload: AgentStreamErrorEvent) => {
  listeners.error.forEach((listener) => listener(payload));
});
ipcRenderer.on("agent:timeline", (_event, payload: TimelineEvent) => {
  listeners.timeline.forEach((listener) => listener(payload));
});

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => set.delete(listener);
}

contextBridge.exposeInMainWorld("piAgent", {
  // —— Agent 会话 / 流式 ——
  getRuntimeInfo: (): Promise<AgentRuntimeInfo> => ipcRenderer.invoke("agent:runtime-info"),
  sendMessage: (prompt: string): Promise<void> => ipcRenderer.invoke("agent:send-message", prompt),
  resetSession: (): Promise<AgentRuntimeInfo> => ipcRenderer.invoke("agent:reset-session"),
  /** 中止当前流式响应，不重置会话历史 */
  abort: (): Promise<void> => ipcRenderer.invoke("agent:abort"),
  onAssistantDelta: (listener: (event: AgentStreamDeltaEvent) => void) =>
    subscribe(listeners.delta, listener),
  onAssistantDone: (listener: (event: AgentStreamDoneEvent) => void) =>
    subscribe(listeners.done, listener),
  onAssistantError: (listener: (event: AgentStreamErrorEvent) => void) =>
    subscribe(listeners.error, listener),
  onTimeline: (listener: (event: TimelineEvent) => void) => subscribe(listeners.timeline, listener),

  // —— 牛人库 ——
  talents: {
    list: (filter?: CandidateFilter): Promise<Candidate[]> =>
      ipcRenderer.invoke("talents:list", filter),
    get: (id: string): Promise<Candidate | null> => ipcRenderer.invoke("talents:get", id),
    updateStatus: (id: string, status: CandidateStatus): Promise<void> =>
      ipcRenderer.invoke("talents:update-status", id, status),
    delete: (id: string): Promise<void> => ipcRenderer.invoke("talents:delete", id),
    stats: (): Promise<CandidateStats> => ipcRenderer.invoke("talents:stats"),
  },

  // —— 设置（含模型 preset 列表） ——
  settings: {
    get: (): Promise<AgentSettings> => ipcRenderer.invoke("settings:get"),
    save: (patch: Partial<CrawlerSettings>): Promise<AgentSettings> =>
      ipcRenderer.invoke("settings:save", patch),
  },

  // —— 模型 preset 管理 / 切换 ——
  models: {
    list: (): Promise<ModelPreset[]> => ipcRenderer.invoke("agent:list-models"),
    save: (models: ModelPreset[]): Promise<AgentSettings> =>
      ipcRenderer.invoke("agent:save-models", models),
    switch: (id: string): Promise<AgentRuntimeInfo> =>
      ipcRenderer.invoke("agent:switch-model", id),
  },

  // —— Agent 列表 / 切换 ——
  agents: {
    list: (): Promise<AgentInfo[]> => ipcRenderer.invoke("agent:list-agents"),
    switch: (id: string): Promise<AgentRuntimeInfo> =>
      ipcRenderer.invoke("agent:switch-agent", id),
  },
});
