<script setup lang="ts">
import { NSpace, NCard, NTag } from "naive-ui";
import type { AgentRuntimeInfo } from "../../../electron/shared";

defineProps<{
  runtimeInfo: AgentRuntimeInfo | null;
}>();

const emit = defineEmits<{
  select: [text: string];
}>();

const suggestions = [
  {
    title: "批量抓取并打分",
    desc: "找 5 个北京 3 年经验的 Vue 前端，并打分",
    prompt: "帮我找 5 个北京 3 年经验的 Vue 前端，并打分",
  },
  {
    title: "按 JD 抓取",
    desc: "上海 Java 后端，5 年经验，Spring Cloud + MySQL",
    prompt: "抓取上海 Java 后端候选人，JD：5年经验、熟悉 Spring Cloud、MySQL",
  },
  {
    title: "解析已有候选人",
    desc: "解析并评分最近抓到的候选人",
    prompt: "解析并评分最近抓到的候选人",
  },
];
</script>

<template>
  <div class="welcome">
    <div class="hero">
      <h1 class="hero-title">Pi-Agent 智能招聘助手</h1>
      <p class="hero-subtitle">
        自动化 BOSS直聘招聘流程：抓取 → 解析 → 评分 → 入库
      </p>
      <NSpace v-if="runtimeInfo" :size="6" align="center" class="tags">
        <NTag v-if="runtimeInfo.modelId" size="small" type="info">{{ runtimeInfo.modelId }}</NTag>
        <NTag size="small" :type="runtimeInfo.hasApiKey ? 'success' : 'warning'">
          {{ runtimeInfo.hasApiKey ? "API Key 已配置" : "未配置 API Key" }}
        </NTag>
        <NTag v-if="runtimeInfo.dbReady === false" size="small" type="error">DB 异常</NTag>
        <NTag v-if="runtimeInfo.customProvider" size="small">Custom Provider</NTag>
      </NSpace>
    </div>

    <div class="suggestions">
      <NCard
        v-for="s in suggestions"
        :key="s.title"
        size="small"
        :bordered="true"
        hoverable
        class="suggestion-card"
        @click="emit('select', s.prompt)"
      >
        <div class="suggestion-title">{{ s.title }}</div>
        <div class="suggestion-desc">{{ s.desc }}</div>
      </NCard>
    </div>

    <div class="hint">
      <span class="hint-label">使用提示：</span>
      Enter 发送 · Shift+Enter 换行 · 消息自动保存到本地
    </div>
  </div>
</template>

<style scoped>
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 24px;
  gap: 28px;
}
.hero {
  text-align: center;
}
.hero-title {
  margin: 0;
  font-size: 28px;
  font-weight: 700;
  background: linear-gradient(135deg, #4b83ff 0%, #89baff 100%);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  letter-spacing: -0.02em;
}
.hero-subtitle {
  margin: 8px 0 14px;
  font-size: 14px;
  color: rgba(226, 236, 255, 0.55);
}
.tags {
  justify-content: center;
}
.suggestions {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  max-width: 720px;
  width: 100%;
}
.suggestion-card {
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease;
}
.suggestion-card:hover {
  transform: translateY(-2px);
  border-color: rgba(75, 131, 255, 0.45);
}
.suggestion-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 4px;
  color: rgba(226, 236, 255, 0.92);
}
.suggestion-desc {
  font-size: 12px;
  color: rgba(226, 236, 255, 0.55);
  line-height: 1.5;
}
.hint {
  font-size: 12px;
  color: rgba(226, 236, 255, 0.4);
}
.hint-label {
  color: rgba(226, 236, 255, 0.6);
}
</style>
