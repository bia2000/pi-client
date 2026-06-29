<script setup lang="ts">
import { computed } from "vue";
import {
  NSpace,
  NTag,
  NButton,
  NProgress,
  NTooltip,
  NPopconfirm,
  NDropdown,
} from "naive-ui";
import type { DropdownOption } from "naive-ui";
import type {
  AgentInfo,
  AgentRuntimeInfo,
  ModelPreset,
} from "../../../electron/shared";
import type { ContextInfo } from "../../utils/chat";

const props = defineProps<{
  runtimeInfo: AgentRuntimeInfo | null;
  context: ContextInfo;
  pending: boolean;
  sessionTitle: string;
  sessionCount: number;
  availableAgents: AgentInfo[];
  activeAgentId: string | null;
  availableModels: ModelPreset[];
  activeModelId: string | null;
}>();

const emit = defineEmits<{
  new: [];
  export: [];
  clear: [];
  stop: [];
  "switch-agent": [id: string];
  "switch-model": [id: string];
}>();

const progressStatus = computed<"success" | "warning" | "error" | "default">(
  () => {
    switch (props.context.status) {
      case "normal":
        return "success";
      case "warning":
        return "warning";
      case "danger":
      case "overflow":
        return "error";
      default:
        return "default";
    }
  },
);

const progressColor = computed(() => {
  switch (props.context.status) {
    case "normal":
      return "#52c41a";
    case "warning":
      return "#faad14";
    case "danger":
    case "overflow":
      return "#ff4d4f";
    default:
      return "#4b83ff";
  }
});

const moreOptions: DropdownOption[] = [
  { label: "导出为 Markdown", key: "export" },
  { label: "清空消息", key: "clear" },
];
function onMoreSelect(key: string) {
  if (key === "export") emit("export");
  else if (key === "clear") emit("clear");
}

/** Agent 下拉选项 */
const agentOptions = computed<DropdownOption[]>(() =>
  props.availableAgents.map((a) => ({
    label: a.name + (a.description ? ` · ${a.description}` : ""),
    key: a.id,
  })),
);
const activeAgentName = computed(
  () =>
    props.availableAgents.find((a) => a.id === props.activeAgentId)?.name ??
    "选择 Agent",
);

/** 模型下拉选项 */
const modelOptions = computed<DropdownOption[]>(() =>
  props.availableModels.map((m) => ({
    label: `${m.name} · ${m.provider}/${m.modelId}`,
    key: m.id,
  })),
);
const activeModelName = computed(
  () =>
    props.availableModels.find((m) => m.id === props.activeModelId)?.name ??
    "选择模型",
);

function onAgentSelect(key: string) {
  emit("switch-agent", key);
}
function onModelSelect(key: string) {
  emit("switch-model", key);
}
</script>

<template>
  <header class="chat-header">
    <div class="title-row">
      <div class="title-block">
        <h2 class="title">{{ sessionTitle || "新会话" }}</h2>
        <span class="subtitle">{{
          sessionCount > 0 ? `共 ${sessionCount} 个会话` : "暂无历史会话"
        }}</span>
      </div>
      <NSpace :size="6" align="center" class="tags">
        <NDropdown
          v-if="availableAgents.length > 0"
          trigger="click"
          :options="agentOptions"
          @select="onAgentSelect"
        >
          <NTag
            size="small"
            type="primary"
            :bordered="true"
            class="clickable-tag"
          >
            {{ activeAgentName }} ▾
          </NTag>
        </NDropdown>
        <NDropdown
          v-if="availableModels.length > 0"
          trigger="click"
          :options="modelOptions"
          @select="onModelSelect"
        >
          <NTag size="small" type="info" :bordered="true" class="clickable-tag">
            {{ activeModelName }} ▾
          </NTag>
        </NDropdown>
        <NTag
          size="small"
          :type="runtimeInfo?.hasApiKey ? 'success' : 'warning'"
        >
          {{ runtimeInfo?.hasApiKey ? "API Key 已配置" : "未配置 API Key" }}
        </NTag>
        <NTag v-if="runtimeInfo?.dbReady === false" size="small" type="error"
          >DB 异常</NTag
        >
      </NSpace>
    </div>

    <div class="actions-row">
      <NTooltip trigger="hover">
        <template #trigger>
          <div class="ctx-progress">
            <NProgress
              type="line"
              :percentage="context.percent"
              :height="6"
              :show-indicator="false"
              :status="progressStatus"
              :color="progressColor"
              :rail-color="'rgba(137, 186, 255, 0.12)'"
            />
            <span class="ctx-label"
              >{{ context.usedTokensK }} / 256K ·
              {{ context.percent.toFixed(0) }}%</span
            >
          </div>
        </template>
        <div>
          <div>
            已用 {{ context.usedTokens.toLocaleString() }} tokens（{{
              context.percent.toFixed(1)
            }}%）
          </div>
          <div>上限 {{ context.maxTokens.toLocaleString() }}</div>
          <div v-if="context.status === 'overflow'">已超限，建议新建会话</div>
          <div v-else-if="context.status === 'danger'">
            接近上限，注意上下文丢失
          </div>
        </div>
      </NTooltip>

      <NSpace :size="6" align="center">
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
          ghost
          :disabled="pending"
          @click="emit('new')"
        >
          新建会话
        </NButton>
        <NDropdown
          trigger="click"
          :options="moreOptions"
          @select="onMoreSelect"
        >
          <NButton size="small" quaternary>更多</NButton>
        </NDropdown>
      </NSpace>
    </div>
  </header>
</template>

<style scoped>
.chat-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 14px 12px;
  border-bottom: 1px solid rgba(137, 186, 255, 0.1);
  background: rgba(7, 16, 29, 0.4);
}
.title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.title-block {
  min-width: 0;
  flex: 1;
}
.title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgba(226, 236, 255, 0.92);
}
.subtitle {
  font-size: 11px;
  color: rgba(226, 236, 255, 0.45);
}
.tags {
  flex-shrink: 0;
}
.clickable-tag {
  cursor: pointer;
  user-select: none;
}
.clickable-tag:hover {
  opacity: 0.85;
}
.actions-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.ctx-progress {
  flex: 1;
  min-width: 80px;
  cursor: help;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ctx-label {
  font-size: 11px;
  color: rgba(226, 236, 255, 0.55);
  font-variant-numeric: tabular-nums;
}
</style>
