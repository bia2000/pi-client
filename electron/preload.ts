import { contextBridge, ipcRenderer } from "electron";
import type {
  AgentRuntimeInfo,
  AgentStreamDeltaEvent,
  AgentStreamDoneEvent,
  AgentStreamErrorEvent,
} from "./shared";

const listeners = {
  delta: new Set<(event: AgentStreamDeltaEvent) => void>(),
  done: new Set<(event: AgentStreamDoneEvent) => void>(),
  error: new Set<(event: AgentStreamErrorEvent) => void>(),
};

ipcRenderer.on("chat:assistant-delta", (_event, payload: AgentStreamDeltaEvent) => {
  listeners.delta.forEach((listener) => listener(payload));
});

ipcRenderer.on("chat:assistant-done", (_event, payload: AgentStreamDoneEvent) => {
  listeners.done.forEach((listener) => listener(payload));
});

ipcRenderer.on("chat:assistant-error", (_event, payload: AgentStreamErrorEvent) => {
  listeners.error.forEach((listener) => listener(payload));
});

contextBridge.exposeInMainWorld("piChat", {
  getRuntimeInfo: (): Promise<AgentRuntimeInfo> => ipcRenderer.invoke("chat:runtime-info"),
  sendMessage: (prompt: string): Promise<void> => ipcRenderer.invoke("chat:send-message", prompt),
  resetSession: (): Promise<AgentRuntimeInfo> => ipcRenderer.invoke("chat:reset-session"),
  onAssistantDelta: (listener: (event: AgentStreamDeltaEvent) => void) => {
    listeners.delta.add(listener);
    return () => listeners.delta.delete(listener);
  },
  onAssistantDone: (listener: (event: AgentStreamDoneEvent) => void) => {
    listeners.done.add(listener);
    return () => listeners.done.delete(listener);
  },
  onAssistantError: (listener: (event: AgentStreamErrorEvent) => void) => {
    listeners.error.add(listener);
    return () => listeners.error.delete(listener);
  },
});
