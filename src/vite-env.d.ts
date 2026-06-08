/// <reference types="vite/client" />

import type {
  AgentRuntimeInfo,
  AgentStreamDeltaEvent,
  AgentStreamDoneEvent,
  AgentStreamErrorEvent,
} from "../electron/shared";

declare global {
  interface Window {
    piChat: {
      getRuntimeInfo: () => Promise<AgentRuntimeInfo>;
      sendMessage: (prompt: string) => Promise<void>;
      resetSession: () => Promise<AgentRuntimeInfo>;
      onAssistantDelta: (listener: (event: AgentStreamDeltaEvent) => void) => () => void;
      onAssistantDone: (listener: (event: AgentStreamDoneEvent) => void) => () => void;
      onAssistantError: (listener: (event: AgentStreamErrorEvent) => void) => () => void;
    };
  }
}

export {};
