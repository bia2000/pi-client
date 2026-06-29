<script setup lang="ts">
import { h } from "vue";
import { NDataTable, NTag, NButton, type DataTableColumns } from "naive-ui";
import type { Candidate, MatchLevel } from "../../electron/shared";

const props = defineProps<{ data: Candidate[]; loading?: boolean }>();
const emit = defineEmits<{ (e: "select", candidate: Candidate): void }>();

function scoreColor(score: number): "success" | "warning" | "error" | "default" {
  if (score >= 80) return "success";
  if (score >= 60) return "warning";
  return "error";
}

function matchType(level: MatchLevel): "success" | "warning" | "error" {
  if (level === "高") return "success";
  if (level === "中") return "warning";
  return "error";
}

function statusType(status: Candidate["status"]): "default" | "info" | "success" | "warning" {
  switch (status) {
    case "已发offer":
      return "success";
    case "已沟通":
      return "info";
    case "已淘汰":
      return "warning";
    default:
      return "default";
  }
}

const columns: DataTableColumns<Candidate> = [
  { title: "姓名", key: "name", width: 110 },
  { title: "职位", key: "title", ellipsis: { tooltip: true } },
  { title: "城市", key: "city", width: 90 },
  {
    title: "评分",
    key: "score",
    width: 90,
    sorter: (a, b) => a.score - b.score,
    defaultSortOrder: "descend",
    render: (row) => h(NTag, { type: scoreColor(row.score), round: true }, { default: () => `${row.score}` }),
  },
  {
    title: "匹配度",
    key: "matchLevel",
    width: 90,
    render: (row) => h(NTag, { type: matchType(row.matchLevel), size: "small" }, { default: () => row.matchLevel }),
  },
  {
    title: "技能",
    key: "skills",
    ellipsis: { tooltip: true },
    render: (row) => (row.skills ?? []).join("、"),
  },
  {
    title: "状态",
    key: "status",
    width: 100,
    render: (row) => h(NTag, { type: statusType(row.status), size: "small" }, { default: () => row.status }),
  },
  {
    title: "操作",
    key: "actions",
    width: 90,
    render: (row) =>
      h(NButton, { size: "small", text: true, type: "primary", onClick: () => emit("select", row) }, { default: () => "查看" }),
  },
];
</script>

<template>
  <NDataTable
    :columns="columns"
    :data="props.data"
    :loading="props.loading"
    :bordered="false"
    :single-line="false"
    size="small"
    :row-key="(row: Candidate) => row.id"
  />
</template>
