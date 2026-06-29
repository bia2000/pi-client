<script setup lang="ts">
import { computed, onMounted, onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  NConfigProvider,
  NMessageProvider,
  NLayout,
  NLayoutSider,
  NLayoutHeader,
  NLayoutContent,
  NMenu,
  NSpace,
  NTag,
  darkTheme,
  type MenuOption,
} from "naive-ui";
import { useAgentStore } from "./stores/agent";

const agent = useAgentStore();
const route = useRoute();
const router = useRouter();

const menuOptions: MenuOption[] = [
  { label: "智能体控制台", key: "/console" },
  { label: "牛人库", key: "/talents" },
  { label: "设置", key: "/settings" },
];

const activeKey = computed(() => route.path);
const title = computed(() => (route.meta.title as string) ?? "Pi-Agent");

const statusLabel = computed(() => {
  if (agent.pending) return "Agent 执行中";
  if (agent.error) return "运行异常";
  if (!agent.runtimeInfo) return "检查环境中";
  if (agent.runtimeInfo.dbReady === false) return "数据库不可用";
  return agent.runtimeInfo.ready ? "运行就绪" : "待补充模型配置";
});

const statusType = computed<"success" | "warning" | "error" | "default">(() => {
  if (agent.pending) return "default";
  if (agent.error || agent.runtimeInfo?.dbReady === false) return "error";
  if (!agent.runtimeInfo?.ready) return "warning";
  return "success";
});

function onSelect(key: string) {
  router.push(key);
}

onMounted(() => agent.init());
onUnmounted(() => agent.dispose());
</script>

<template>
  <NConfigProvider :theme="darkTheme">
   <NMessageProvider>
    <NLayout has-sider class="shell">
      <NLayoutSider bordered :width="220" content-class="sider-content">
        <div class="brand">
          <p class="brand-eyebrow">Pi-Agent</p>
          <h1>BOSS直聘<br />智能招聘助手</h1>
        </div>
        <NMenu :value="activeKey" :options="menuOptions" @update:value="onSelect" />
        <div class="sider-footer">
          <NTag size="small" :type="statusType" round>{{ statusLabel }}</NTag>
        </div>
      </NLayoutSider>

      <NLayout>
        <NLayoutHeader bordered class="topbar">
          <NSpace align="center" justify="space-between" style="width: 100%">
            <span class="topbar-title">{{ title }}</span>
            <NSpace align="center" :size="12">
              <NTag v-if="agent.runtimeInfo?.provider" size="small" type="info" round>
                {{ agent.runtimeInfo.provider }}
              </NTag>
              <NTag v-if="agent.runtimeInfo?.modelId" size="small" round>
                {{ agent.runtimeInfo.modelId }}
              </NTag>
              <NTag
                v-if="agent.runtimeInfo?.dbReady === false"
                size="small"
                type="error"
                :title="agent.runtimeInfo?.dbError"
              >
                数据库不可用
              </NTag>
            </NSpace>
          </NSpace>
        </NLayoutHeader>
        <NLayoutContent class="content">
          <RouterView />
        </NLayoutContent>
        </NLayout>
      </NLayout>
   </NMessageProvider>
  </NConfigProvider>
</template>

<style scoped>
.shell {
  height: 100vh;
}
.sider-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.brand {
  padding: 18px 18px 8px;
}
.brand-eyebrow {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.18em;
  color: rgba(226, 236, 255, 0.55);
}
.brand h1 {
  margin: 6px 0 0;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.35;
}
.sider-footer {
  margin-top: auto;
  padding: 14px 18px;
}
.topbar {
  padding: 10px 22px;
  display: flex;
  align-items: center;
}
.topbar-title {
  font-size: 15px;
  font-weight: 600;
}
.content {
  padding: 18px 22px;
  height: calc(100vh - 53px);
  overflow: auto;
}
</style>
