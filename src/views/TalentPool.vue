<script setup lang="ts">
import { onMounted, ref } from "vue";
import { NSpace, NButton, NTag, NCard, NEmpty, useMessage } from "naive-ui";
import type { Candidate, CandidateStatus } from "../../electron/shared";
import { useTalentsStore } from "../stores/talents";
import ResumeTable from "../components/ResumeTable.vue";
import ResumeDetail from "../components/ResumeDetail.vue";

const store = useTalentsStore();
const message = useMessage();
const selected = ref<Candidate | null>(null);
const showDetail = ref(false);

onMounted(() => {
  if (store.list.length === 0) void store.refresh();
});

function onSelect(candidate: Candidate) {
  selected.value = candidate;
  showDetail.value = true;
}

async function onStatus(id: string, status: CandidateStatus) {
  await store.updateStatus(id, status);
  message.success(`已更新状态：${status}`);
}

async function onDelete(id: string) {
  await store.remove(id);
  showDetail.value = false;
  selected.value = null;
  message.success("已删除");
}
</script>

<template>
  <div class="talents">
    <NCard size="small" :bordered="false" class="stats-card">
      <NSpace :size="24" align="center">
        <NTag size="large" round>共 {{ store.stats.total }} 人</NTag>
        <NTag size="small">待沟通 {{ store.stats["待沟通"] }}</NTag>
        <NTag size="small" type="info">已沟通 {{ store.stats["已沟通"] }}</NTag>
        <NTag size="small" type="success">已发offer {{ store.stats["已发offer"] }}</NTag>
        <NTag size="small" type="warning">已淘汰 {{ store.stats["已淘汰"] }}</NTag>
        <NButton size="small" :loading="store.loading" @click="store.refresh()">刷新</NButton>
      </NSpace>
    </NCard>

    <NCard size="small" :bordered="false" class="table-card">
      <NEmpty v-if="!store.loading && store.list.length === 0" description="牛人库还是空的。到「智能体控制台」抓取并评分后，>60 分的候选人会自动出现在这里。" />
      <ResumeTable v-else :data="store.list" :loading="store.loading" @select="onSelect" />
    </NCard>

    <ResumeDetail
      v-model:show="showDetail"
      :candidate="selected"
      @status="onStatus"
      @delete="onDelete"
    />
  </div>
</template>

<style scoped>
.talents {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.stats-card :deep(.n-card__content),
.table-card :deep(.n-card__content) {
  padding: 14px 16px;
}
</style>
