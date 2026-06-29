import { createRouter, createWebHashHistory, type RouteRecordRaw } from "vue-router";

// 使用 hash 路由，兼容 Electron 的 file:// 加载。
const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/console" },
  {
    path: "/console",
    name: "console",
    component: () => import("../views/AgentConsole.vue"),
    meta: { title: "智能体控制台" },
  },
  {
    path: "/talents",
    name: "talents",
    component: () => import("../views/TalentPool.vue"),
    meta: { title: "牛人库" },
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("../views/Settings.vue"),
    meta: { title: "设置" },
  },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
