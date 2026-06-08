<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import type { AgentRuntimeInfo, ChatMessage } from "../electron/shared";

const messages = ref<ChatMessage[]>([
  {
    id: "welcome",
    role: "assistant",
    content:
      "Pi Client 已就绪。你可以直接开始对话；默认禁用了工具调用，只保留纯聊天模式，后续再扩展 Agent 工具会更安全。",
    createdAt: Date.now(),
  },
]);
const input = ref("");
const runtimeInfo = ref<AgentRuntimeInfo | null>(null);
const pending = ref(false);
const errorMessage = ref("");
const currentAssistantMessageId = ref<string | null>(null);

const canSend = computed(() => input.value.trim().length > 0 && !pending.value);
const statusLabel = computed(() => {
  if (pending.value) {
    return "Pi 正在回复";
  }

  if (errorMessage.value) {
    return "连接异常";
  }

  return runtimeInfo.value?.ready ? "已连接 Pi Agent" : "初始化中";
});

function appendMessage(message: ChatMessage) {
  messages.value = [...messages.value, message];
}

function upsertAssistantMessage(messageId: string, delta: string) {
  const index = messages.value.findIndex((message) => message.id === messageId);

  if (index === -1) {
    appendMessage({
      id: messageId,
      role: "assistant",
      content: delta,
      createdAt: Date.now(),
      pending: true,
    });
    currentAssistantMessageId.value = messageId;
    return;
  }

  const next = [...messages.value];
  next[index] = {
    ...next[index],
    content: next[index].content + delta,
    pending: true,
  };
  messages.value = next;
}

function finalizeAssistantMessage(messageId: string, finalText: string) {
  const index = messages.value.findIndex((message) => message.id === messageId);

  if (index === -1) {
    appendMessage({
      id: messageId,
      role: "assistant",
      content: finalText,
      createdAt: Date.now(),
    });
  } else {
    const next = [...messages.value];
    next[index] = {
      ...next[index],
      content: finalText || next[index].content,
      pending: false,
    };
    messages.value = next;
  }

  pending.value = false;
  currentAssistantMessageId.value = null;
}

function markAssistantError(messageId: string, error: string) {
  const index = messages.value.findIndex((message) => message.id === messageId);

  if (index === -1) {
    appendMessage({
      id: messageId,
      role: "assistant",
      content: error,
      createdAt: Date.now(),
      error: true,
    });
  } else {
    const next = [...messages.value];
    next[index] = {
      ...next[index],
      pending: false,
      error: true,
      content: next[index].content || error,
    };
    messages.value = next;
  }

  errorMessage.value = error;
  pending.value = false;
  currentAssistantMessageId.value = null;
}

async function bootstrap() {
  runtimeInfo.value = await window.piChat.getRuntimeInfo();
}

async function sendMessage() {
  const prompt = input.value.trim();

  if (!prompt || pending.value) {
    return;
  }

  errorMessage.value = "";
  pending.value = true;

  appendMessage({
    id: crypto.randomUUID(),
    role: "user",
    content: prompt,
    createdAt: Date.now(),
  });

  input.value = "";

  try {
    await window.piChat.sendMessage(prompt);
  } catch (error) {
    pending.value = false;
    errorMessage.value = error instanceof Error ? error.message : "消息发送失败";
  }
}

async function resetConversation() {
  runtimeInfo.value = await window.piChat.resetSession();
  pending.value = false;
  errorMessage.value = "";
  currentAssistantMessageId.value = null;
  messages.value = [
    {
      id: "welcome",
      role: "assistant",
      content: "会话已重置。你现在可以开始一段新的对话。",
      createdAt: Date.now(),
    },
  ];
}

function handleComposerKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendMessage();
  }
}

let disposeDelta = () => {};
let disposeDone = () => {};
let disposeError = () => {};

onMounted(async () => {
  disposeDelta = window.piChat.onAssistantDelta(({ messageId, delta }) => {
    upsertAssistantMessage(messageId, delta);
  });

  disposeDone = window.piChat.onAssistantDone(({ messageId, text }) => {
    finalizeAssistantMessage(messageId, text);
  });

  disposeError = window.piChat.onAssistantError(({ messageId, error }) => {
    markAssistantError(messageId, error);
  });

  await bootstrap();
});

onUnmounted(() => {
  disposeDelta();
  disposeDone();
  disposeError();
});
</script>

<template>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand-card">
        <p class="eyebrow">Electron + Vue + Pi Agent</p>
        <h1>Pi Client</h1>
        <p class="brand-copy">
          桌面聊天框架已经搭好，Pi 跑在主进程，界面和状态流在 Vue 侧独立维护。
        </p>
      </div>

      <div class="status-card">
        <div class="status-pill" :class="{ live: !pending && !errorMessage }">
          {{ statusLabel }}
        </div>
        <dl class="meta-grid">
          <div>
            <dt>Provider</dt>
            <dd>{{ runtimeInfo?.provider || "未配置" }}</dd>
          </div>
          <div>
            <dt>Model</dt>
            <dd>{{ runtimeInfo?.modelId || "自动选择" }}</dd>
          </div>
          <div>
            <dt>Workspace</dt>
            <dd>{{ runtimeInfo?.workspace || "当前目录" }}</dd>
          </div>
          <div>
            <dt>API Key</dt>
            <dd>{{ runtimeInfo?.hasApiKey ? "已检测到" : "未检测到" }}</dd>
          </div>
          <div>
            <dt>Auth Providers</dt>
            <dd>{{ runtimeInfo?.configuredProviders?.join(", ") || "无" }}</dd>
          </div>
          <div>
            <dt>Custom Provider</dt>
            <dd>{{ runtimeInfo?.customProvider ? "已启用" : "未启用" }}</dd>
          </div>
          <div v-if="runtimeInfo?.customBaseUrl">
            <dt>Custom Base URL</dt>
            <dd>{{ runtimeInfo.customBaseUrl }}</dd>
          </div>
        </dl>
      </div>

      <button class="secondary-button" type="button" @click="resetConversation">
        新建会话
      </button>
    </aside>

    <main class="chat-panel">
      <header class="chat-header">
        <div>
          <p class="eyebrow">Desktop Chat</p>
          <h2>面向 Agent 的桌面对话骨架</h2>
        </div>
        <p class="header-hint">默认纯聊天模式，避免未授权工具调用。</p>
      </header>

      <section class="messages">
        <article
          v-for="message in messages"
          :key="message.id"
          class="message"
          :class="[message.role, { pending: message.pending, error: message.error }]"
        >
          <div class="message-meta">
            <span>{{ message.role === "user" ? "你" : "Pi" }}</span>
            <span>{{ new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</span>
          </div>
          <p>{{ message.content }}</p>
        </article>
      </section>

      <footer class="composer">
        <label class="composer-shell">
          <textarea
            v-model="input"
            rows="4"
            placeholder="输入你的问题，Enter 发送，Shift + Enter 换行"
            @keydown="handleComposerKeydown"
          />
        </label>
        <div class="composer-actions">
          <p class="composer-hint">{{ errorMessage || "先确认右侧已检测到 API Key，再发起真实请求。" }}</p>
          <button class="primary-button" type="button" :disabled="!canSend" @click="sendMessage">
            {{ pending ? "回复中..." : "发送" }}
          </button>
        </div>
      </footer>
    </main>
  </div>
</template>
