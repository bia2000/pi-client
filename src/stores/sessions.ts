// 会话本地持久化 —— 多会话列表 + 当前会话切换，存于 localStorage。
// 对应文档 §2.4 切换会话 / §2.5 新建会话 / §4.2 会话持久化。
// 注意：主进程的 RecruitmentAgent 不感知多会话，前端切换会话时调 resetSession() 让后端开始新会话。
import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import type { ChatMessage } from "../../electron/shared";

const STORAGE_KEY = "pi-agent-sessions-v1";
const MAX_SESSIONS = 50;

export interface SessionRecord {
  id: string;
  title: string;
  messages: ChatMessage[];
  /** 主进程会话开始时间，用于排序 */
  createdAt: number;
  updatedAt: number;
}

interface PersistShape {
  sessions: SessionRecord[];
  currentId: string | null;
}

function loadFromStorage(): PersistShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { sessions: [], currentId: null };
    const parsed = JSON.parse(raw) as PersistShape;
    if (!Array.isArray(parsed.sessions)) return { sessions: [], currentId: null };
    // 过滤掉空会话和异常数据
    parsed.sessions = parsed.sessions
      .filter((s) => s && typeof s.id === "string" && Array.isArray(s.messages))
      .slice(0, MAX_SESSIONS);
    return parsed;
  } catch {
    return { sessions: [], currentId: null };
  }
}

function saveToStorage(shape: PersistShape): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(shape));
  } catch {
    // 容量超限 / 隐私模式：静默失败，不影响使用
  }
}

/** 过滤掉 loading 占位与流式中的临时消息，用于持久化。 */
function getPersistableMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .filter((m) => !m.pending && m.content)
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      error: m.error,
    }));
}

export const useSessionsStore = defineStore("sessions", () => {
  const initial = loadFromStorage();
  const sessions = ref<SessionRecord[]>(initial.sessions);
  const currentId = ref<string | null>(initial.currentId);

  const current = computed<SessionRecord | null>(
    () => sessions.value.find((s) => s.id === currentId.value) ?? null,
  );
  const sortedSessions = computed(() =>
    [...sessions.value].sort((a, b) => b.updatedAt - a.updatedAt),
  );

  /** 自动持久化（深拷贝避免引用问题）。 */
  watch(
    [sessions, currentId],
    () => {
      const persist: PersistShape = {
        sessions: sessions.value.map((s) => ({
          ...s,
          messages: getPersistableMessages(s.messages),
        })),
        currentId: currentId.value,
      };
      saveToStorage(persist);
    },
    { deep: true },
  );

  function createSession(title = "新会话"): SessionRecord {
    const now = Date.now();
    const session: SessionRecord = {
      id: crypto.randomUUID(),
      title,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    sessions.value = [session, ...sessions.value].slice(0, MAX_SESSIONS);
    currentId.value = session.id;
    return session;
  }

  function switchSession(id: string): SessionRecord | null {
    const target = sessions.value.find((s) => s.id === id);
    if (!target) return null;
    currentId.value = id;
    return target;
  }

  function deleteSession(id: string): void {
    const idx = sessions.value.findIndex((s) => s.id === id);
    if (idx === -1) return;
    sessions.value.splice(idx, 1);
    if (currentId.value === id) {
      currentId.value = sessions.value[0]?.id ?? null;
    }
  }

  function renameSession(id: string, title: string): void {
    const s = sessions.value.find((x) => x.id === id);
    if (s) {
      s.title = title;
      s.updatedAt = Date.now();
    }
  }

  /** 用最新消息列表覆盖当前会话。 */
  function persistCurrent(messages: ChatMessage[]): void {
    if (!currentId.value) return;
    const s = sessions.value.find((x) => x.id === currentId.value);
    if (!s) return;
    s.messages = getPersistableMessages(messages);
    s.updatedAt = Date.now();
    // 首条用户消息作为标题（仅当标题仍是默认值）
    if (s.title === "新会话") {
      const firstUser = messages.find((m) => m.role === "user");
      if (firstUser) {
        s.title =
          firstUser.content.split(/\r?\n/)[0].slice(0, 30) || "新会话";
      }
    }
  }

  function clearCurrentMessages(): void {
    if (!currentId.value) return;
    const s = sessions.value.find((x) => x.id === currentId.value);
    if (s) {
      s.messages = [];
      s.updatedAt = Date.now();
    }
  }

  return {
    sessions,
    currentId,
    current,
    sortedSessions,
    createSession,
    switchSession,
    deleteSession,
    renameSession,
    persistCurrent,
    clearCurrentMessages,
  };
});
