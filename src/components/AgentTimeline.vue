<script setup lang="ts">
import { computed } from "vue";
import { NTimeline, NTimelineItem, NEmpty } from "naive-ui";
import type { TimelineEvent, TimelineStage } from "../../electron/shared";

const props = defineProps<{ events: TimelineEvent[] }>();

const STAGE_LABEL: Record<TimelineStage, string> = {
  plan: "规划",
  spider: "爬虫",
  parse: "解析",
  score: "评分",
  database: "入库",
  done: "完成",
  login_expired: "登录失效",
  error: "异常",
  info: "信息",
};

function typeOf(status: TimelineEvent["status"]): "default" | "success" | "error" | "info" {
  switch (status) {
    case "success":
      return "success";
    case "error":
      return "error";
    case "active":
      return "info";
    default:
      return "default";
  }
}

const items = computed(() =>
  props.events.map((e) => ({
    title: STAGE_LABEL[e.stage] ?? e.stage,
    content: e.message,
    type: typeOf(e.status),
    time: new Date(e.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  })),
);
</script>

<template>
  <div class="timeline-box">
    <h3 class="box-title">Agent 思考链路</h3>
    <NEmpty v-if="items.length === 0" description="还没有执行记录，发送一条招聘指令试试。" />
    <NTimeline v-else>
      <NTimelineItem
        v-for="(item, i) in items"
        :key="i"
        :type="item.type"
        :title="item.title"
        :content="item.content"
        :time="item.time"
      />
    </NTimeline>
  </div>
</template>

<style scoped>
.timeline-box {
  height: 100%;
  overflow: auto;
  padding: 14px 14px 18px;
}
.box-title {
  margin: 0 0 12px;
  font-size: 14px;
  font-weight: 600;
}
</style>
