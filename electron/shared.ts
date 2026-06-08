export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  pending?: boolean;
  error?: boolean;
}

export interface ChatSendPayload {
  prompt: string;
}

export interface AgentRuntimeInfo {
  ready: boolean;
  provider?: string;
  modelId?: string;
  sessionId?: string;
  workspace?: string;
  hasApiKey?: boolean;
  configuredProviders?: string[];
  customProvider?: boolean;
  customBaseUrl?: string;
}

export interface AgentStreamEvent {
  conversationId: string;
  messageId: string;
}

export interface AgentStreamDeltaEvent extends AgentStreamEvent {
  delta: string;
}

export interface AgentStreamDoneEvent extends AgentStreamEvent {
  text: string;
}

export interface AgentStreamErrorEvent extends AgentStreamEvent {
  error: string;
}
