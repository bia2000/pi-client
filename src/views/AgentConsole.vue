<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useAgentStore } from "../stores/agent";
import { useSessionsStore } from "../stores/sessions";
import { useMessage } from "naive-ui";
import {
  copyText as utilCopyText,
  downloadText,
  exportMessagesAsMarkdown,
  getContextInfo,
} from "../utils/chat";
import ChatHeader from "../components/chat/ChatHeader.vue";
import ChatMessage from "../components/chat/ChatMessage.vue";
import ChatWelcome from "../components/chat/ChatWelcome.vue";
import ChatInput from "../components/chat/ChatInput.vue";
import SessionList from "../components/chat/SessionList.vue";
import AgentTimeline from "../components/AgentTimeline.vue";

const agent = useAgentStore();
const sessions = useSessionsStore();
const message = useMessage();

const scrollRoot = ref<HTMLElement | null>(null);

/** 当前会话消息（计算属性：依赖 sessions.current） */
const messages = computed(() => agent.getCurrentMessages());
const hasMessages = computed(
  () => messages.value.some((m) => m.id !== "welcome") || agent.pending,
);
const contextInfo = computed(() => getContextInfo(messages.value));
const sessionTitle = computed(() => sessions.current?.title ?? "新会话");
const sessionCount = computed(() => sessions.sessions.length);

/**
 * 是否显示"思考中"加载气泡。
 * 满足以下条件时显示：
 *   1. agent.pending = true（已发请求）
 *   2. 最后一条消息不是 pending 的 assistant（否则 ChatMessage 自己有 streaming-dot）
 * 也就是说，请求发出但还没收到第一个 delta 时显示。
 */
const showThinkingBubble = computed(() => {
  if (!agent.pending) return false;
  const last = messages.value[messages.value.length - 1];
  return !last || last.role !== "assistant" || last.pending !== true;
});

function scrollToBottom() {
  nextTick(() => {
    const el = scrollRoot.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(
  () => messages.value.length,
  () => scrollToBottom(),
);

// 流式期间持续滚到底部（pending 时内容也在变）
watch(
  () => agent.pending,
  (pending) => {
    if (pending) {
      const timer = window.setInterval(() => {
        if (!agent.pending) {
          window.clearInterval(timer);
          return;
        }
        scrollToBottom();
      }, 200);
    }
  },
);

function onSend(text: string) {
  agent.send(text);
  scrollToBottom();
}

function onStop() {
  void agent.abort();
}

function onExport() {
  if (messages.value.length === 0) {
    message.warning("当前会话没有消息可导出");
    return;
  }
  const md = exportMessagesAsMarkdown(messages.value, sessionTitle.value);
  const filename = `${sessionTitle.value || "session"}-${new Date()
    .toISOString()
    .slice(0, 10)}.md`;
  downloadText(filename, md);
  message.success("已导出 Markdown 文件");
}

async function onClear() {
  agent.clearMessages();
  message.success("已清空当前会话消息");
}

async function onCopy(content: string) {
  const ok = await utilCopyText(content);
  if (ok) message.success("已复制到剪贴板");
  else message.error("复制失败");
}

function onSelectSession(id: string) {
  void agent.switchTo(id);
}

function onDeleteSession(id: string) {
  sessions.deleteSession(id);
  message.success("已删除会话");
}

function onNewSession() {
  void agent.newSession();
}

function onSuggestion(text: string) {
  agent.send(text);
  scrollToBottom();
}

function onSwitchAgent(id: string) {
  void agent.switchAgent(id);
}

function onSwitchModel(id: string) {
  void agent.switchModel(id);
}
</script>

<template>
  <div class="console">
    <SessionList
      :sessions="sessions.sortedSessions"
      :current-id="sessions.currentId"
      @select="onSelectSession"
      @delete="onDeleteSession"
      @new="onNewSession"
    />

    <div class="chat-col">
      <ChatHeader
        :runtime-info="agent.runtimeInfo"
        :context="contextInfo"
        :pending="agent.pending"
        :session-title="sessionTitle"
        :session-count="sessionCount"
        :available-agents="agent.availableAgents"
        :active-agent-id="agent.activeAgentId"
        :available-models="agent.availableModels"
        :active-model-id="agent.activeModelId"
        @new="onNewSession"
        @export="onExport"
        @clear="onClear"
        @stop="onStop"
        @switch-agent="onSwitchAgent"
        @switch-model="onSwitchModel"
      />

      <div ref="scrollRoot" class="messages">
        <ChatWelcome
          v-if="!hasMessages"
          :runtime-info="agent.runtimeInfo"
          @select="onSuggestion"
        />
        <template v-else>
          <ChatMessage
            v-for="msg in messages"
            :key="msg.id"
            :message="msg"
            @copy="onCopy"
          />
          <!-- 思考中加载气泡：pending 但还没收到第一个 delta -->
          <div v-if="showThinkingBubble" class="thinking-bubble">
            <span class="thinking-label">招聘 Agent 正在思考</span>
            <span class="thinking-dots">
              <span class="dot"></span>
              <span class="dot"></span>
              <span class="dot"></span>
            </span>
          </div>
        </template>
      </div>

      <ChatInput
        :pending="agent.pending"
        :error="agent.error"
        @send="onSend"
        @stop="onStop"
      />
    </div>

    <aside class="timeline-col">
      <AgentTimeline :events="agent.timeline" />
    </aside>
  </div>
</template>

<style scoped>
.console {
  display: flex;
  gap: 0;
  height: 100%;
}
.chat-col {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 14px 16px 6px;
  scroll-behavior: smooth;
}
.timeline-col {
  width: 320px;
  flex-shrink: 0;
  background: rgba(7, 16, 29, 0.55);
  border: 1px solid rgba(137, 186, 255, 0.1);
  border-radius: 0;
  border-top: none;
  border-right: none;
  border-bottom: none;
  overflow: hidden;
}

/* 思考中加载气泡 */
.thinking-bubble {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(75, 131, 255, 0.06);
  border: 1px solid rgba(75, 131, 255, 0.2);
  font-size: 13px;
  color: rgba(226, 236, 255, 0.7);
}
.thinking-label {
  font-weight: 500;
}
.thinking-dots {
  display: inline-flex;
  gap: 4px;
}
.thinking-dots .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #4b83ff;
  animation: thinking-bounce 1.2s infinite ease-in-out;
}
.thinking-dots .dot:nth-child(2) {
  animation-delay: 0.15s;
}
.thinking-dots .dot:nth-child(3) {
  animation-delay: 0.3s;
}
@keyframes thinking-bounce {
  0%,
  80%,
  100% {
    opacity: 0.3;
    transform: scale(0.8);
  }
  40% {
    opacity: 1;
    transform: scale(1);
  }
}
</style>
