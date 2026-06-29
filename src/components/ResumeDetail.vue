<script setup lang="ts">
import { computed } from "vue";
import {
  NDrawer,
  NDrawerContent,
  NTag,
  NSpace,
  NSelect,
  NButton,
  NDescriptions,
  NDescriptionsItem,
  NPopconfirm,
  NH3,
} from "naive-ui";
import type { Candidate, CandidateStatus } from "../../electron/shared";

const props = defineProps<{ show: boolean; candidate: Candidate | null }>();
const emit = defineEmits<{
  (e: "update:show", v: boolean): void;
  (e: "status", id: string, status: CandidateStatus): void;
  (e: "delete", id: string): void;
}>();

const STATUS_OPTIONS: Array<{ label: string; value: CandidateStatus }> = [
  { label: "待沟通", value: "待沟通" },
  { label: "已沟通", value: "已沟通" },
  { label: "已发offer", value: "已发offer" },
  { label: "已淘汰", value: "已淘汰" },
];

const parsedResume = computed(() => {
  if (!props.candidate?.resumeJson) return null;
  try {
    return JSON.parse(props.candidate.resumeJson);
  } catch {
    return null;
  }
});

function onStatus(value: CandidateStatus) {
  if (props.candidate) emit("status", props.candidate.id, value);
}

function onDelete() {
  if (props.candidate) emit("delete", props.candidate.id);
}
</script>

<template>
  <NDrawer
    :show="props.show"
    :width="520"
    placement="right"
    @update:show="(v) => emit('update:show', v)"
  >
    <NDrawerContent v-if="props.candidate" :title="props.candidate.name" closable>
      <NSpace vertical :size="14">
        <NSpace align="center" :size="8">
          <NTag type="warning" round>{{ props.candidate.score }} 分</NTag>
          <NTag>{{ props.candidate.matchLevel }}匹配</NTag>
          <NTag size="small">{{ props.candidate.status }}</NTag>
        </NSpace>

        <NDescriptions label-placement="left" bordered :column="1" size="small">
          <NDescriptionsItem label="职位">{{ props.candidate.title || "—" }}</NDescriptionsItem>
          <NDescriptionsItem label="城市">{{ props.candidate.city || "—" }}</NDescriptionsItem>
          <NDescriptionsItem label="期望薪资">{{ props.candidate.expectSalary || "—" }}</NDescriptionsItem>
          <NDescriptionsItem label="工龄">{{ props.candidate.workYears || "—" }}</NDescriptionsItem>
          <NDescriptionsItem label="跳槽风险">{{ props.candidate.jobHoppingRisk || "—" }}</NDescriptionsItem>
        </NDescriptions>

        <div>
          <NH3 class="section-title">技能标签（AI 高亮）</NH3>
          <NSpace :size="6">
            <NTag
              v-for="skill in props.candidate.skills"
              :key="skill"
              type="success"
              size="small"
            >
              {{ skill }}
            </NTag>
            <span v-if="!props.candidate.skills?.length">—</span>
          </NSpace>
        </div>

        <div>
          <NH3 class="section-title">推荐理由</NH3>
          <p class="reason">{{ props.candidate.reason || "—" }}</p>
        </div>

        <div v-if="parsedResume">
          <NH3 class="section-title">简历全文</NH3>
          <pre class="resume-raw">{{ parsedResume.raw || JSON.stringify(parsedResume, null, 2) }}</pre>
        </div>
      </NSpace>

      <template #footer>
        <NSpace vertical :size="10" style="width: 100%">
          <NSelect
            :value="props.candidate.status"
            :options="STATUS_OPTIONS"
            size="small"
            @update:value="onStatus"
          />
          <NPopconfirm @positive-click="onDelete">
            <template #trigger>
              <NButton size="small" block tertiary type="error">删除该候选人</NButton>
            </template>
            确定从牛人库删除 {{ props.candidate.name }} 吗？
          </NPopconfirm>
        </NSpace>
      </template>
    </NDrawerContent>
  </NDrawer>
</template>

<style scoped>
.section-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 600;
}
.reason {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
}
.resume-raw {
  margin: 0;
  max-height: 280px;
  overflow: auto;
  padding: 10px;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 6px;
}
</style>
