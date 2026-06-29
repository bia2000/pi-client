<script setup lang="ts">
import { computed } from "vue";
import { NButton, NTooltip } from "naive-ui";
import type { ChatMessage } from "../../../electron/shared";
import { copyText, renderMarkdown } from "../../utils/chat";

const props = defineProps<{
  message: ChatMessage;
}>();

const emit = defineEmits<{
  copy: [content: string];
}>();

const rendered = computed(() => {
  if (props.message.role === "user") return "";
  return renderMarkdown(props.message.content);
});

const isUser = computed(() => props.message.role === "user");
const isPending = computed(() => props.message.pending === true);
const isError = computed(() => props.message.error === true);
const roleLabel = computed(() => (isUser.value ? "我" : "招聘 Agent"));
const time = computed(() =>
  new Date(props.message.createdAt).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }),
);

async function onCopy() {
  const ok = await copyText(props.message.content);
  if (ok) emit("copy", props.message.content);
}
</script>

<template>
  <article class="msg" :class="{ user: isUser, error: isError, pending: isPending }">
    <div class="msg-head">
      <span class="role">{{ roleLabel }}</span>
      <span class="time">{{ time }}</span>
      <div class="msg-actions">
        <NTooltip v-if="!isPending" trigger="hover">
          <template #trigger>
            <NButton text size="tiny" class="copy-btn" @click="onCopy">复制</NButton>
          </template>
          复制到剪贴板
        </NTooltip>
        <span v-if="isPending" class="streaming-dot">●</span>
      </div>
    </div>
    <div v-if="isUser" class="msg-body user-body">{{ message.content }}</div>
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-else class="msg-body markdown-body" v-html="rendered || '<p class=\'placeholder\'>(正在思考…)</p>'"></div>
  </article>
</template>

<style scoped>
.msg {
  margin-bottom: 14px;
  padding: 12px 14px;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(137, 186, 255, 0.08);
  transition: border-color 0.2s;
}
.msg.user {
  background: rgba(75, 131, 255, 0.12);
  border-color: rgba(75, 131, 255, 0.25);
}
.msg.error {
  border-color: rgba(255, 134, 134, 0.4);
  background: rgba(255, 134, 134, 0.06);
}
.msg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
  color: rgba(226, 236, 255, 0.55);
}
.role {
  font-weight: 600;
  color: rgba(226, 236, 255, 0.8);
}
.time {
  font-variant-numeric: tabular-nums;
}
.msg-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.copy-btn {
  opacity: 0;
  transition: opacity 0.15s;
  color: rgba(226, 236, 255, 0.45);
}
.msg:hover .copy-btn {
  opacity: 1;
}
.streaming-dot {
  color: #4b83ff;
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
.msg-body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.65;
  font-size: 14px;
}
.user-body {
  color: rgba(226, 236, 255, 0.95);
}
.placeholder {
  color: rgba(226, 236, 255, 0.4);
  font-style: italic;
}
</style>
