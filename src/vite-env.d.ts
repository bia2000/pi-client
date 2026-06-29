/// <reference types="vite/client" />

import type {
  AgentRuntimeInfo,
  AgentStreamDeltaEvent,
  AgentStreamDoneEvent,
  AgentStreamErrorEvent,
  Candidate,
  CandidateFilter,
  CandidateStats,
  CandidateStatus,
  CrawlerSettings,
  TimelineEvent,
} from "../electron/shared";

declare global {
  interface Window {
    piAgent: {
      getRuntimeInfo: () => Promise<AgentRuntimeInfo>;
      sendMessage: (prompt: string) => Promise<void>;
      resetSession: () => Promise<AgentRuntimeInfo>;
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
        get: () => Promise<{ crawler: CrawlerSettings }>;
        save: (patch: Partial<CrawlerSettings>) => Promise<{ crawler: CrawlerSettings }>;
      };
    };
  }
}

export {};
