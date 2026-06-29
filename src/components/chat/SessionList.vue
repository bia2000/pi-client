<script setup lang="ts">
import { NButton, NPopconfirm, NEmpty, NTag, NTooltip } from "naive-ui";
import type { SessionRecord } from "../../stores/sessions";

const props = defineProps<{
  sessions: SessionRecord[];
  currentId: string | null;
}>();

const emit = defineEmits<{
  select: [id: string];
  delete: [id: string];
  new: [];
}>();

function formatTime(t: number): string {
  const now = Date.now();
  const diff = now - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return new Date(t).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
</script>

<template>
  <aside class="session-list">
    <div class="list-head">
      <h3 class="list-title">会话历史</h3>
      <NButton size="tiny" type="primary" ghost @click="emit('new')">+ 新建</NButton>
    </div>
    <NEmpty v-if="sessions.length === 0" size="small" description="还没有会话" style="margin: 24px 0" />
    <ul v-else class="list">
      <li
        v-for="s in sessions"
        :key="s.id"
        class="item"
        :class="{ active: s.id === currentId }"
        @click="emit('select', s.id)"
      >
        <div class="item-main">
          <div class="item-title">{{ s.title || "新会话" }}</div>
          <div class="item-meta">
            <span>{{ s.messages.length }} 条</span>
            <span class="dot">·</span>
            <span>{{ formatTime(s.updatedAt) }}</span>
          </div>
        </div>
        <NPopconfirm @positive-click="emit('delete', s.id)">
          <template #trigger>
            <NButton
              text
              size="tiny"
              class="del-btn"
              :disabled="s.id === currentId"
              @click.stop
            >
              ×
            </NButton>
          </template>
          确认删除该会话？此操作不可撤销。
        </NPopconfirm>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.session-list {
  width: 220px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid rgba(137, 186, 255, 0.08);
  background: rgba(7, 16, 29, 0.4);
  overflow: hidden;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(137, 186, 255, 0.06);
}
.list-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: rgba(226, 236, 255, 0.85);
}
.list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
  flex: 1;
}
.item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s;
  margin-bottom: 2px;
}
.item:hover {
  background: rgba(75, 131, 255, 0.08);
}
.item.active {
  background: rgba(75, 131, 255, 0.16);
}
.item-main {
  flex: 1;
  min-width: 0;
}
.item-title {
  font-size: 13px;
  color: rgba(226, 236, 255, 0.9);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 2px;
}
.item.active .item-title {
  font-weight: 600;
  color: #89baff;
}
.item-meta {
  font-size: 11px;
  color: rgba(226, 236, 255, 0.4);
  display: flex;
  gap: 4px;
  align-items: center;
  font-variant-numeric: tabular-nums;
}
.dot {
  opacity: 0.5;
}
.del-btn {
  opacity: 0;
  color: rgba(255, 134, 134, 0.6);
  font-size: 16px;
  padding: 0 4px;
}
.item:hover .del-btn {
  opacity: 1;
}
.del-btn:hover {
  color: #ff7875 !important;
}
</style>
