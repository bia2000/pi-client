/// <reference types="vite/client" />

import type {
  AgentInfo,
  AgentRuntimeInfo,
  AgentSettings,
  AgentStreamDeltaEvent,
  AgentStreamDoneEvent,
  AgentStreamErrorEvent,
  Candidate,
  CandidateFilter,
  CandidateStats,
  CandidateStatus,
  CrawlerSettings,
  ModelPreset,
  TimelineEvent,
} from "../electron/shared";

declare global {
  interface Window {
    piAgent: {
      getRuntimeInfo: () => Promise<AgentRuntimeInfo>;
      sendMessage: (prompt: string) => Promise<void>;
      resetSession: () => Promise<AgentRuntimeInfo>;
      /** 中止当前流式响应，不重置会话历史 */
      abort: () => Promise<void>;
      onAssistantDelta: (listener: (event: AgentStreamDeltaEvent) => void) => () => void;
      onAssistantDone: (listener: (event: AgentStreamDoneEvent) => void) => () => void;
      onAssistantError: (listener: (event: AgentStreamErrorEvent) => void) => () => void;
      onTimeline: (listener: (event: TimelineEvent) => void) => () => void;
      talents: {
        list: (filter?: CandidateFilter) => Promise<Candidate[]>;
        get: (id: string) => Promise<Candidate | null>;
        updateStatus: (id: string, status: CandidateStatus) => Promise<void>;
        delete: (id: string) => Promise<void>;
        stats: () => Promise<CandidateStats>;
      };
      settings: {
        get: () => Promise<AgentSettings>;
        save: (patch: Partial<CrawlerSettings>) => Promise<AgentSettings>;
      };
      models: {
        list: () => Promise<ModelPreset[]>;
        save: (models: ModelPreset[]) => Promise<AgentSettings>;
        switch: (id: string) => Promise<AgentRuntimeInfo>;
      };
      agents: {
        list: () => Promise<AgentInfo[]>;
        switch: (id: string) => Promise<AgentRuntimeInfo>;
      };
    };
  }
}

export {};
