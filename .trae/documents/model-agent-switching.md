# 切换模型与切换 Agent 方案

## Context（背景与目标）

当前项目（d:\project\pi-client）只有 1 个 BOSS 招聘 Agent，且模型固定从 `.env` 读取 `PI_MODEL_PROVIDER` / `PI_MODEL_ID` / `PI_CUSTOM_*` 一次性配置，无法运行时切换。用户希望：

1. **切换模型**：在 UI 中切换当前会话使用的模型（不丢失会话历史）。
2. **切换 Agent**：当前只有 BOSS 招聘 Agent，后续可能新增其他 Agent（不同 systemPrompt + 工具集 + 时间轴阶段）。架构需预留扩展点，新增 Agent 只需注册一个 descriptor，无需改动核心循环。

### 关键调研结论（已通过 Explore agent 验证）

- **模型切换可热切换**：pi-coding-agent 的 `AgentSession.setModel(model)` + `AuthStorage.setRuntimeApiKey(provider, key)` 可在不 dispose session 的前提下切换模型，保留对话历史。
- **Agent 切换必须重建**：不同 systemPrompt / 工具集 / agentDir 无法热切换，必须 `session.dispose()` 后用新 ResourceLoader + customTools 重新 `createAgentSession`。
- **pi-coding-agent 没有内置 AgentDescriptor / Plugin 抽象**：需在宿主层自建注册表。
- **ModelRegistry 支持多 provider 动态注册**：`registerProvider(name, { models, apiKey, baseUrl, api })`，`getAll()` / `getAvailable()` 可列出已注册模型。

---

## 方案总览

```
┌─────────────────────────────────────────────────────────┐
│  electron/main/agents/        ← 新增 Agent 注册表        │
│    types.ts                   AgentDescriptor 接口       │
│    registry.ts                AGENT_REGISTRY + list/switch│
│    boss-recruit.ts            现有 BOSS 招聘逻辑封装     │
│  electron/main/agent-core.ts  ← 改造为 BaseAgent         │
│  electron/main/ipc.ts         ← 新增模型/Agent 切换 IPC   │
│  electron/preload.ts          ← 暴露新 IPC 到渲染进程    │
│  electron/shared.ts           ← 新增类型                  │
│  electron/main/settings-store.ts ← 扩展持久化           │
│  src/components/chat/ChatHeader.vue ← 加切换下拉          │
│  src/views/Settings.vue       ← 加模型 preset 管理       │
│  src/stores/agent.ts          ← 暴露切换方法             │
└─────────────────────────────────────────────────────────┘
```

---

## 第一部分：Agent 切换（抽象 AgentDescriptor）

### 1.1 新增 `electron/main/agents/types.ts`

定义 AgentDescriptor 接口：

```typescript
import type { TimelineStage } from "../../shared";
import type { ToolDeps } from "../tools";

export interface AgentDescriptor {
  /** 唯一 id，如 "boss-recruit" */
  id: string;
  /** 显示名称，如 "BOSS 招聘 Agent" */
  name: string;
  /** 一句话描述，UI 下拉显示 */
  description: string;
  /** 系统提示（追加在 pi 默认 systemPrompt 之后） */
  systemPrompt: string[];
  /** 该 agent 可能产生的时间轴阶段（用于前端过滤/着色） */
  timelineStages: TimelineStage[];
  /** 构造该 agent 的工具集（异步：动态 import pi-ai/pi-coding-agent） */
  buildTools(deps: ToolDeps): Promise<import("@earendil-works/pi-coding-agent").CustomTool[]>;
}
```

### 1.2 新增 `electron/main/agents/registry.ts`

```typescript
import type { AgentDescriptor } from "./types";

const AGENT_REGISTRY = new Map<string, AgentDescriptor>();

export function registerAgent(desc: AgentDescriptor): void {
  AGENT_REGISTRY.set(desc.id, desc);
}

export function getAgent(id: string): AgentDescriptor | undefined {
  return AGENT_REGISTRY.get(id);
}

export function listAgents(): AgentDescriptor[] {
  return Array.from(AGENT_REGISTRY.values());
}

export function getDefaultAgentId(): string {
  // 第一个注册的 agent 作为默认
  return AGENT_REGISTRY.keys().next().value;
}
```

### 1.3 新增 `electron/main/agents/boss-recruit.ts`

把现有 `agent-core.ts` 的 `RECRUITMENT_SYSTEM_PROMPT` 常量 + `tools/index.ts` 的 `buildRecruitmentTools` 封装为 descriptor：

```typescript
import type { AgentDescriptor } from "./types";
import { buildRecruitmentTools } from "../tools";

const BOSS_RECRUIT_SYSTEM_PROMPT = [
  // 从 agent-core.ts 原样搬过来 RECRUITMENT_SYSTEM_PROMPT 数组
];

export const bossRecruitAgent: AgentDescriptor = {
  id: "boss-recruit",
  name: "BOSS 招聘 Agent",
  description: "自动化 BOSS直聘招聘：抓取 → 解析 → 评分 → 入库",
  systemPrompt: BOSS_RECRUIT_SYSTEM_PROMPT,
  timelineStages: ["plan", "spider", "parse", "score", "database", "done", "login_expired", "error", "info"],
  buildTools: buildRecruitmentTools,
};
```

### 1.4 新增 `electron/main/agents/index.ts`

聚合注册：

```typescript
import { registerAgent } from "./registry";
import { bossRecruitAgent } from "./boss-recruit";

export * from "./types";
export * from "./registry";

// 启动时注册内置 agent
registerAgent(bossRecruitAgent);
// 未来：registerAgent(otherAgent);
```

### 1.5 改造 `electron/main/agent-core.ts`

- 删除 `RECRUITMENT_SYSTEM_PROMPT` 常量（移到 boss-recruit.ts）
- `RecruitmentAgent` 类增加 `private currentAgentId: string` 字段
- `createSession()` 中：
  - `appendSystemPrompt` 从 `getAgent(this.currentAgentId).systemPrompt` 取
  - `customTools` 调用 `descriptor.buildTools(deps)` 而非直接 `buildRecruitmentTools`
- 新增 `switchAgent(id: string)` 方法：
  ```typescript
  async switchAgent(id: string): Promise<AgentRuntimeInfo> {
    if (!getAgent(id)) throw new Error(`未注册的 Agent: ${id}`);
    this.currentAgentId = id;
    return this.reset(); // dispose + 重建（保留 runtimeInfo 中的 agentId）
  }
  ```
- `getRuntimeInfo()` 返回 `agentId: this.currentAgentId` + `availableAgents: listAgents().map(({ id, name, description }) => ({ id, name, description }))`

---

## 第二部分：模型切换（热切换，保留会话历史）

### 2.1 扩展 `electron/shared.ts`

新增类型：

```typescript
export interface ModelPreset {
  /** 唯一 id（前端选择用） */
  id: string;
  /** 显示名称，如 "GPT-4.1 Mini" */
  name: string;
  /** provider 名，如 "openai" / "anthropic" / 自定义 provider 名 */
  provider: string;
  /** 模型 id，如 "gpt-4.1-mini" */
  modelId: string;
  /** API Key（可空，为空时复用 provider 已配置的 key 或 env） */
  apiKey?: string;
  /** 自定义 OpenAI 兼容 endpoint（仅当 provider 不是 pi 内置时使用） */
  baseUrl?: string;
  /** API 协议，默认 "openai-completions" */
  api?: Api;
  reasoning?: boolean;
  supportsImages?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

export interface AgentInfo {
  id: string;
  name: string;
  description: string;
}

// AgentRuntimeInfo 新增字段：
//   agentId: string
//   availableAgents: AgentInfo[]
//   availableModels: ModelPreset[]
//   activeModelId: string

// AgentSettings 新增字段：
//   models: ModelPreset[]
//   activeModelId?: string
//   activeAgentId?: string
```

### 2.2 改造 `electron/main/settings-store.ts`

- `DEFAULT_AGENT_SETTINGS` 启动时若 `models` 为空，从 `process.env` 推导 1 个默认 preset（PI_CUSTOM_* 优先，否则 PI_MODEL_PROVIDER/PI_MODEL_ID），避免破坏现有 .env 配置用户
- 新增 `getActiveModel()` / `setActiveModel(id)` / `getActiveAgentId()` / `setActiveAgentId(id)` 辅助函数
- `saveSettings` 接受 `Partial<AgentSettings>`（不只是 CrawlerSettings），支持保存 models / activeModelId / activeAgentId

### 2.3 改造 `electron/main/agent-core.ts`

- `createSession()` 中：遍历 `loadSettings().models`，对每个 preset 调用 `modelRegistry.registerProvider(preset.provider, { models, apiKey, baseUrl, api })`，再 `authStorage.setRuntimeApiKey(preset.provider, preset.apiKey)`（若有 apiKey）
- 当前活动模型从 `loadSettings().activeModelId` 取（找不到则 fallback 第一个 preset）
- 新增 `switchModel(presetId: string)` 方法（**热切换，不 dispose**）：
  ```typescript
  async switchModel(presetId: string): Promise<AgentRuntimeInfo> {
    const settings = loadSettings();
    const preset = settings.models.find((m) => m.id === presetId);
    if (!preset) throw new Error(`未找到模型预设: ${presetId}`);

    // 持久化 active model
    saveSettings({ activeModelId: presetId });

    // 若 session 已建立，热切换；否则只更新持久化，下次 createSession 生效
    if (this.currentSession) {
      const model = this.modelRegistry!.find(preset.provider, preset.modelId);
      if (!model) throw new Error(`模型未注册: ${preset.provider}/${preset.modelId}`);
      if (preset.apiKey) {
        this.authStorage!.setRuntimeApiKey(preset.provider, preset.apiKey);
      }
      await this.currentSession.setModel(model);
    }

    return this.getRuntimeInfo();
  }
  ```
- `getRuntimeInfo()` 增加 `availableModels: settings.models` + `activeModelId: settings.activeModelId ?? settings.models[0]?.id`

### 2.4 新增 IPC（`electron/main/ipc.ts`）

```typescript
ipcMain.handle("agent:list-models", async () => loadSettings().models);
ipcMain.handle("agent:switch-model", async (_e, id: string) => agent.switchModel(id));
ipcMain.handle("agent:save-models", async (_e, models: ModelPreset[]) => saveSettings({ models }));
ipcMain.handle("agent:list-agents", async () => listAgents().map(({ id, name, description }) => ({ id, name, description })));
ipcMain.handle("agent:switch-agent", async (_e, id: string) => agent.switchAgent(id));
```

### 2.5 扩展 `electron/preload.ts`

在 `contextBridge.exposeInMainWorld("piAgent", {...})` 中新增：

```typescript
models: {
  list: (): Promise<ModelPreset[]> => ipcRenderer.invoke("agent:list-models"),
  switch: (id: string): Promise<AgentRuntimeInfo> => ipcRenderer.invoke("agent:switch-model", id),
  save: (models: ModelPreset[]): Promise<void> => ipcRenderer.invoke("agent:save-models", models),
},
agents: {
  list: (): Promise<AgentInfo[]> => ipcRenderer.invoke("agent:list-agents"),
  switch: (id: string): Promise<AgentRuntimeInfo> => ipcRenderer.invoke("agent:switch-agent", id),
},
```

---

## 第三部分：前端 UI

### 3.1 改造 `src/stores/agent.ts`

- 新增 state：`availableModels: ModelPreset[]`、`activeModelId: string | null`、`availableAgents: AgentInfo[]`、`activeAgentId: string | null`
- `bootstrap()` 顺带拉 `models.list()` + `agents.list()`
- 新增方法：
  ```typescript
  async function switchModel(id: string) {
    runtimeInfo.value = await window.piAgent.models.switch(id);
    activeModelId.value = id;
  }
  async function switchAgent(id: string) {
    // 切换 agent 会重建 session，前端同步清空消息
    pending.value = false; error.value = ""; timeline.value = [];
    runtimeInfo.value = await window.piAgent.agents.switch(id);
    activeAgentId.value = id;
  }
  ```

### 3.2 改造 `src/components/chat/ChatHeader.vue`

在标题栏右侧 tags 区域新增两个 NDropdown：

```vue
<NDropdown
  trigger="click"
  :options="agentOptions"
  @select="(id) => emit('switch-agent', id)"
>
  <NTag size="small" type="primary" hoverable>
    {{ activeAgentName }} ▾
  </NTag>
</NDropdown>

<NDropdown
  trigger="click"
  :options="modelOptions"
  @select="(id) => emit('switch-model', id)"
>
  <NTag size="small" hoverable>
    {{ activeModelName }} ▾
  </NTag>
</NDropdown>
```

新增 props：`availableAgents`、`activeAgentId`、`availableModels`、`activeModelId`
新增 emits：`switch-agent`、`switch-model`

### 3.3 改造 `src/views/Settings.vue`

把"LLM 模型配置（只读）"卡片改造为可编辑：
- 列表展示当前 `models` preset（name / provider / modelId / baseUrl）
- 每行支持编辑/删除
- 底部"添加模型预设"按钮，弹窗输入 name / provider / modelId / apiKey / baseUrl / api
- 保存按钮调 `window.piAgent.models.save(models)`

### 3.4 改造 `src/views/AgentConsole.vue`

`AgentConsole.vue` 监听 ChatHeader 的 `switch-model` / `switch-agent` 事件，调用 store 方法。

---

## 第四部分：实施顺序与文件清单

| 步骤 | 文件 | 改动 |
|------|------|------|
| 1 | `electron/shared.ts` | 新增 `ModelPreset` / `AgentInfo` 类型，扩展 `AgentRuntimeInfo` / `AgentSettings` |
| 2 | `electron/main/agents/types.ts` | 新建 AgentDescriptor 接口 |
| 3 | `electron/main/agents/registry.ts` | 新建注册表 |
| 4 | `electron/main/agents/boss-recruit.ts` | 封装现有 BOSS 招聘逻辑 |
| 5 | `electron/main/agents/index.ts` | 注册入口 |
| 6 | `electron/main/agent-core.ts` | 改造：从 descriptor 读 systemPrompt + buildTools；新增 switchAgent / switchModel |
| 7 | `electron/main/settings-store.ts` | 扩展持久化 models / activeModelId / activeAgentId |
| 8 | `electron/main/ipc.ts` | 新增 5 个 IPC handler |
| 9 | `electron/preload.ts` | 暴露 models / agents 子 API |
| 10 | `electron/main.ts` | import `./main/agents` 触发注册 |
| 11 | `src/stores/agent.ts` | 新增 state + switchModel / switchAgent 方法 |
| 12 | `src/components/chat/ChatHeader.vue` | 加 agent + model 下拉 |
| 13 | `src/views/Settings.vue` | 改造模型卡片为可编辑列表 |
| 14 | `src/views/AgentConsole.vue` | 接线新事件 |

---

## 验证方案

1. **类型检查**：`npx vue-tsc --noEmit` 通过
2. **构建**：`npm run build` 通过
3. **运行时验证**：
   - 启动应用，ChatHeader 应显示当前 Agent（"BOSS 招聘 Agent"）+ 当前模型两个下拉
   - 设置页应能添加/删除模型 preset
   - 切换模型：发送一条消息后切换模型，再发一条，应使用新模型且回话历史保留
   - 切换 Agent：切换后 timeline 清空、新会话开始；切回 BOSS 招聘 Agent 应能正常使用 4 个工具
   - 重启应用：上次选中的 agent + model 应保持

## 不在本次范围

- 后端会话多实例（一个 agent 一个独立 session 上下文）—— 仍采用切换时 reset 单 session
- 新增第二个具体 agent（如"代码助手 Agent"）—— 本次只搭架构，不实现具体 agent
- 模型 preset 的 OAuth 登录流程 —— 仅支持 API Key 直填
