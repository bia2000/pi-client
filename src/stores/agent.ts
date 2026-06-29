// useAgentStore —— 联动 sessionsStore 实现多会话切换。
// 当前会话消息保存在 sessionsStore，本 store 仅维护运行时状态（pending/error/timeline/runtimeInfo）
// 和与主进程交互的 send/reset 流程。
// 同时维护当前 Agent / 模型 preset 状态，提供切换方法。
import { defineStore } from "pinia";
import { ref } from "vue";
import type {
  AgentInfo,
  AgentRuntimeInfo,
  ChatMessage,
  ModelPreset,
  TimelineEvent,
} from "../../electron/shared";
import { useSessionsStore } from "./sessions";

const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "我是 Pi-Agent 智能招聘助手。告诉我招聘需求，例如：「帮我找 5 个北京 3 年经验的 Vue 前端，并打分」。",
  createdAt: Date.now(),
};

export const useAgentStore = defineStore("agent", () => {
  const sessions = useSessionsStore();

  /** 运行时 UI 状态（不持久化） */
  const timeline = ref<TimelineEvent[]>([]);
  const runtimeInfo = ref<AgentRuntimeInfo | null>(null);
  const pending = ref(false);
  const error = ref("");
  /** 流式期间正在追加的 messageId，用于 upsert 定位 */
  const streamingId = ref<string | null>(null);

  /** Agent / 模型 preset 列表（前端下拉用） */
  const availableAgents = ref<AgentInfo[]>([]);
  const activeAgentId = ref<string | null>(null);
  const availableModels = ref<ModelPreset[]>([]);
  const activeModelId = ref<string | null>(null);

  let subs: Array<() => void> = [];

  /** 当前会话消息（来自 sessionsStore + 欢迎语兜底） */
  function getCurrentMessages(): ChatMessage[] {
    const cur = sessions.current;
    if (!cur || cur.messages.length === 0) return [{ ...WELCOME }];
    return cur.messages;
  }

  /** 替换当前会话的消息（写回 sessionsStore，触发持久化）。 */
  function setMessages(next: ChatMessage[]): void {
    if (!sessions.currentId) {
      sessions.createSession();
    }
    sessions.persistCurrent(next);
  }

  function appendMessage(msg: ChatMessage): void {
    const cur = sessions.current;
    const base = cur?.messages ?? [];
    setMessages([...base, msg]);
  }

  function patchMessage(id: string, patch: Partial<ChatMessage>): void {
    const cur = sessions.current;
    if (!cur) return;
    const idx = cur.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const next = [...cur.messages];
    next[idx] = { ...next[idx], ...patch };
    sessions.persistCurrent(next);
  }

  function upsert(messageId: string, delta: string) {
    const cur = sessions.current;
    if (!cur) return;
    const idx = cur.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      appendMessage({
        id: messageId,
        role: "assistant",
        content: delta,
        createdAt: Date.now(),
        pending: true,
      });
      streamingId.value = messageId;
    } else {
      const next = [...cur.messages];
      next[idx] = {
        ...next[idx],
        content: next[idx].content + delta,
        pending: true,
      };
      sessions.persistCurrent(next);
    }
  }

  function finalize(messageId: string, text: string) {
    const cur = sessions.current;
    if (!cur) {
      pending.value = false;
      return;
    }
    const idx = cur.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      appendMessage({
        id: messageId,
        role: "assistant",
        content: text,
        createdAt: Date.now(),
      });
    } else {
      const next = [...cur.messages];
      next[idx] = {
        ...next[idx],
        content: text || next[idx].content,
        pending: false,
      };
      sessions.persistCurrent(next);
    }
    streamingId.value = null;
    pending.value = false;
  }

  function markError(messageId: string, err: string) {
    error.value = err;
    pending.value = false;
    streamingId.value = null;
    const cur = sessions.current;
    if (!cur) return;
    const idx = cur.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;
    const next = [...cur.messages];
    next[idx] = {
      ...next[idx],
      pending: false,
      error: true,
      content: next[idx].content || err,
    };
    sessions.persistCurrent(next);
  }

  function init() {
    subs = [
      window.piAgent.onAssistantDelta(({ messageId, delta }) => upsert(messageId, delta)),
      window.piAgent.onAssistantDone(({ messageId, text }) => finalize(messageId, text)),
      window.piAgent.onAssistantError(({ messageId, error: err }) => markError(messageId, err)),
      window.piAgent.onTimeline((event) => {
        timeline.value = [...timeline.value, event].slice(-200);
      }),
    ];
    // 启动时若没有当前会话，自动创建一个
    if (!sessions.currentId) {
      sessions.createSession();
    }
    void bootstrap();
  }

  function dispose() {
    subs.forEach((fn) => fn());
    subs = [];
  }

  async function bootstrap() {
    try {
      const info = await window.piAgent.getRuntimeInfo();
      runtimeInfo.value = info;
      activeAgentId.value = info.agentId ?? null;
      activeModelId.value = info.activeModelId ?? null;
      availableAgents.value = info.availableAgents ?? [];
      availableModels.value = info.availableModels ?? [];
    } catch (e) {
      runtimeInfo.value = { ready: false };
      error.value = e instanceof Error ? e.message : "无法获取运行状态。";
    }
  }

  async function send(prompt: string) {
    const text = prompt.trim();
    if (!text || pending.value) return;

    // 确保有当前会话
    if (!sessions.currentId) {
      sessions.createSession();
    }

    pending.value = true;
    error.value = "";

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: Date.now(),
    };
    appendMessage(userMsg);

    try {
      await window.piAgent.sendMessage(text);
    } catch (e) {
      error.value = e instanceof Error ? e.message : "发送失败。";
      pending.value = false;
    }
  }

  /** 新建会话：调主进程 reset 让后端开新会话，前端也建新 SessionRecord。 */
  async function newSession() {
    pending.value = false;
    error.value = "";
    timeline.value = [];
    sessions.createSession();
    try {
      const info = await window.piAgent.resetSession();
      runtimeInfo.value = info;
      activeModelId.value = info.activeModelId ?? activeModelId.value;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "重置会话失败。";
    }
  }

  /** 切换到已有会话：调主进程 reset 让后端开新会话（不恢复上下文，因为主进程不支持），前端切到目标会话快照。 */
  async function switchTo(id: string) {
    if (id === sessions.currentId) return;
    pending.value = false;
    error.value = "";
    timeline.value = [];
    sessions.switchSession(id);
    try {
      const info = await window.piAgent.resetSession();
      runtimeInfo.value = info;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "切换会话失败。";
    }
  }

  /** 清空当前会话消息（不删会话本身）。 */
  function clearMessages() {
    sessions.clearCurrentMessages();
    error.value = "";
  }

  /**
   * 中止当前流式响应 —— 调主进程 abort。
   * pending 不在这里手动清空，由后续 done/error 事件触发自动清除。
   * 若 5 秒内没收到 done/error 事件，强制清空 pending 作为兜底。
   */
  async function abort() {
    if (!pending.value) return;
    try {
      await window.piAgent.abort();
    } catch (e) {
      error.value = e instanceof Error ? e.message : "停止失败。";
      pending.value = false;
      streamingId.value = null;
      return;
    }
    // 兜底：5 秒内若 pending 仍未清除，强制清除
    window.setTimeout(() => {
      if (pending.value) {
        pending.value = false;
        streamingId.value = null;
        const cur = sessions.current;
        if (cur) {
          const idx = cur.messages.findIndex((m) => m.pending);
          if (idx !== -1) {
            const next = [...cur.messages];
            next[idx] = { ...next[idx], pending: false };
            sessions.persistCurrent(next);
          }
        }
      }
    }, 5000);
  }

  /**
   * 切换模型 preset —— 热切换，不重置会话历史。
   * 后端用 session.setModel + setRuntimeApiKey 完成切换。
   */
  async function switchModel(presetId: string) {
    if (presetId === activeModelId.value) return;
    try {
      const info = await window.piAgent.models.switch(presetId);
      runtimeInfo.value = info;
      activeModelId.value = info.activeModelId ?? presetId;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "切换模型失败。";
    }
  }

  /**
   * 切换 Agent —— 后端会 dispose + 重建 session。
   * 前端同步清空 timeline / pending / error；不自动清空当前会话消息（用户可继续查看历史），
   * 但下一条 send 会进入新 agent 的上下文。
   */
  async function switchAgent(id: string) {
    if (id === activeAgentId.value) return;
    pending.value = false;
    error.value = "";
    timeline.value = [];
    try {
      const info = await window.piAgent.agents.switch(id);
      runtimeInfo.value = info;
      activeAgentId.value = info.agentId ?? id;
    } catch (e) {
      error.value = e instanceof Error ? e.message : "切换 Agent 失败。";
    }
  }

  /** 保存模型 preset 列表（设置页用）。 */
  async function saveModels(models: ModelPreset[]) {
    await window.piAgent.models.save(models);
    availableModels.value = models;
    // 若活动模型被删除，自动切到第一个
    if (activeModelId.value && !models.some((m) => m.id === activeModelId.value)) {
      const next = models[0]?.id;
      if (next) {
        await switchModel(next);
      } else {
        activeModelId.value = null;
      }
    }
  }

  return {
    timeline,
    runtimeInfo,
    pending,
    error,
    streamingId,
    availableAgents,
    activeAgentId,
    availableModels,
    activeModelId,
    init,
    dispose,
    send,
    bootstrap,
    newSession,
    switchTo,
    clearMessages,
    abort,
    switchModel,
    switchAgent,
    saveModels,
    getCurrentMessages,
    setMessages,
  };
});
