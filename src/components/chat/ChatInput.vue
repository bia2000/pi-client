<script setup lang="ts">
import { computed, ref } from "vue";
import { NInput, NButton, NSpace, NTag, NAlert } from "naive-ui";

const props = defineProps<{
  pending: boolean;
  error: string;
}>();

const emit = defineEmits<{
  send: [text: string];
  stop: [];
}>();

const input = ref("");

const suggestions = [
  "找 5 个北京 3 年 Vue 前端",
  "解析并评分最近抓到的候选人",
  "导出当前牛人库 Top 10",
];

const canSend = computed(() => input.value.trim().length > 0 && !props.pending);

function send() {
  const text = input.value.trim();
  if (!text || props.pending) return;
  emit("send", text);
  input.value = "";
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    send();
  }
}
</script>

<template>
  <div class="composer">
    <NAlert v-if="error" type="error" :show-icon="false" style="margin-bottom: 8px">
      {{ error }}
    </NAlert>

    <NInput
      v-model:value="input"
      type="textarea"
      :autosize="{ minRows: 2, maxRows: 6 }"
      placeholder="输入招聘需求，例如：帮我找 5 个北京 3 年经验的 Vue 前端，并打分（Enter 发送 / Shift+Enter 换行）"
      :disabled="pending"
      @keydown="onKeydown"
    />

    <NSpace justify="space-between" align="center" style="margin-top: 8px">
      <NSpace :size="6" wrap>
        <NTag
          v-for="s in suggestions"
          :key="s"
          size="small"
          checkable
          :disabled="pending"
          @click="!pending && (input = s)"
        >
          {{ s }}
        </NTag>
      </NSpace>
      <NSpace :size="8">
        <NButton
          v-if="pending"
          size="small"
          type="error"
          ghost
          @click="emit('stop')"
        >
          停止
        </NButton>
        <NButton
          size="small"
          type="primary"
          :loading="pending"
          :disabled="!canSend"
          @click="send"
        >
          发送
        </NButton>
      </NSpace>
    </NSpace>
  </div>
</template>

<style scoped>
.composer {
  padding: 10px 14px 14px;
  border-top: 1px solid rgba(137, 186, 255, 0.1);
  background: rgba(7, 16, 29, 0.5);
}
</style>
