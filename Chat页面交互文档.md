# Chat.vue 对话页面交互文档

## 一、页面整体结构

```
┌─────────────────────────────────────────────────────────────┐
│  ChatHeader（头部）                                           │
│  - 标题、模型名称、聊天模式、Gateway状态                        │
│  - 上下文进度条（点击查看详情）                                 │
│  - 操作按钮：设置、导出、清空、启动/停止Gateway、新建会话         │
├─────────────────────────────────────────────────────────────┤
│  ChatBody（消息区域）                                          │
│  ├─ ChatWelcome（欢迎界面）- 无消息时显示                       │
│  │   - 快捷问题选择                                            │
│  │   - 模型/助手选择                                           │
│  │   - 输入框                                                  │
│  │                                                            │
│  ├─ ChatMessage（消息列表）- 有消息时显示                       │
│  │   - 用户消息：文本、图片、文件附件                            │
│  │   - 助手消息：回复内容、工具操作状态                          │
│  │                                                            │
├─────────────────────────────────────────────────────────────┤
│  ChatInput（输入区域）- 有消息时显示                            │
│  - 文本输入框                                                  │
│  - 技能选择                                                    │
│  - 图片/文件上传                                               │
│  - 发送/停止按钮                                               │
│  - 模型/助手选择                                               │
└─────────────────────────────────────────────────────────────┘

弹窗层：
├─ SettingsModal（设置弹窗）- 系统提示词、温度
├─ TemplateCenterModal（模板中心）- 预设模板选择
├─ ContextDetailModal（上下文详情）- token统计明细
```

---

## 二、核心交互流程

### 2.1 页面初始化流程

```
onMounted()
  │
  ├─ 1. clearVisibleSession()        清空当前会话状态
  │
  ├─ 2. getModelList()               获取可用模型列表
  │     ├─ 从 /api/chat/available 获取
  │     ├─ 恢复上次选择的模型（localStorage）
  │     └─ 同步模型配置到 openclaw.json
  │
  ├─ 3. loadAgents()                 加载已安装的助手列表
  │     ├─ 从 /api/agents/installed 获取
  │     ├─ 恢复上次选择的助手（localStorage/userStore）
  │     └─ 处理 URL 中的 ?agent=xxx 参数
  │
  ├─ 4. loadAgentSystemPrompt()      加载当前助手的系统提示词
  │     └─ 从 /api/agents/:id 获取 SOUL.md
  │
  ├─ 5. waitForGateway()             等待 Gateway 就绪（最多90秒）
  │     └─ 循环检查 /api/gateway/health
  │
  ├─ 6. loadModelInfo()              加载 Gateway 当前模型
  │
  ├─ 7. loadChatMode()               加载聊天模式（direct/agent）
  │
  ├─ 8. loadGatewayStatus()          加载 Gateway 状态
  │
  ├─ 9. loadSessionList()            加载会话历史列表
  │
  └─ 10. 启动定时刷新（5秒间隔）
        ├─ refreshCurrentSessionFromGateway()
        └─ loadSessionList()
```

### 2.2 发送消息流程

```
sendMessage(text, images, files)
  │
  ├─ 1. 登录检查
  │     ├─ 未登录 → 弹出登录弹窗，终止
  │     └─ 已登录 → 继续
  │
  ├─ 2. 会话检查
  │     ├─ ensureSession() → 确保当前会话存在
  │     ├─ isSessionLoading() → 检查是否正在处理
  │     └─ canStartNewTask() → 检查并行任务限制（最多3个）
  │
  ├─ 3. 构建消息内容
  │     ├─ 文本 + 图片路径 + 文件路径
  │     └─ 添加用户消息到 messages[]
  │
  ├─ 4. 添加助手占位消息
  │     └─ { role: "assistant", content: "", loading: true, status: "..." }
  │

  │
  ├─ 6. 发送请求

```

### 2.4 切换会话流程

```
handleSwitchSession(event)
  │
  ├─ 1. persistActiveSession()       保存当前会话
  │
  ├─ 2. switchSession(sessionId)     切换到目标会话
  │     ├─ 从 store 加载会话数据
  │     └─ 返回 { messages, systemPrompt }
  │
  ├─ 3. 更新 UI
  │     ├─ messages.value = result.messages
  │     ├─ systemPrompt.value = result.systemPrompt
  │     └─ scrollToBottom()
  │
  └─ 4. focusInput()                 聚焦输入框
```

### 2.5 新建会话流程

```
handleCreateSession()
  │
  ├─ 1. createSession(modelName)     创建新会话
  │     └─ POST /api/chat-history/sessions
  │
  ├─ 2. isNewSession = true          标记为新会话
  │
  ├─ 3. switchSession(newId)         切换到新会话
  │     └─ 清空 messages、systemPrompt
  │
  └─ 4. focusInput()
```

---

## 三、子组件交互

### 3.1 ChatHeader 交互

| 事件                   | 触发条件                  | 处理函数                           |
| ---------------------- | ------------------------- | ---------------------------------- |
| `@open-settings`       | 点击设置按钮              | `showSettings = true`              |
| `@export`              | 点击导出按钮              | `handleExport()` → 导出为 Markdown |
| `@clear`               | 点击清空按钮              | `clearChat()` → 清空消息           |
| `@start-gateway`       | 点击启动Gateway           | `startGateway()`                   |
| `@stop-gateway`        | 点击停止Gateway           | `stopGateway()`                    |
| `@new-session`         | 点击新建会话 / 上下文溢出 | `handleCreateSession()`            |
| `@show-context-detail` | 点击上下文进度条          | `showContextDetail = true`         |

### 3.2 ChatWelcome 交互

| 事件              | 触发条件     | 处理函数                         |
| ----------------- | ------------ | -------------------------------- |
| `@select`         | 点击快捷问题 | `sendQuick(text)` → 发送预设问题 |
| `@open-templates` | 点击模板中心 | `showTemplateCenter = true`      |
| `@send`           | 发送消息     | `sendMessage(text)`              |
| `@stop`           | 点击停止     | `stopCurrentSession()`           |
| `@select-model`   | 选择模型     | `handleSelectModel(model)`       |
| `@select-agent`   | 选择助手     | `handleSelectAgent(agent)`       |

### 3.3 ChatInput 交互

| 事件            | 触发条件           | 处理函数                           |
| --------------- | ------------------ | ---------------------------------- |
| `@send`         | 发送消息（含附件） | `sendMessage(text, images, files)` |
| `@stop`         | 点击停止           | `stopCurrentSession()`             |
| `@select-model` | 选择模型           | `handleSelectModel(model)`         |
| `@select-agent` | 选择助手           | `handleSelectAgent(agent)`         |

### 3.4 ChatMessage 交互

| 事件    | 触发条件     | 处理函数                            |
| ------- | ------------ | ----------------------------------- |
| `@copy` | 点击复制按钮 | `copyMessage(content)` → 写入剪贴板 |

---

## 四、数据流与状态管理

### 4.1 核心状态

| 状态                    | 类型       | 说明                                           |
| ----------------------- | ---------- | ---------------------------------------------- |
| `messages`              | `ref([])`  | 当前会话的消息列表                             |
| `systemPrompt`          | `ref("")`  | 用户自定义系统提示词                           |
| `agentSystemPrompt`     | `ref("")`  | Agent SOUL.md 内容（从后端加载）               |
| `effectiveSystemPrompt` | `computed` | 合并后的系统提示词（Agent + 用户自定义）       |
| `currentSessionId`      | `ref`      | 当前会话 ID                                    |
| `currentSession`        | `ref`      | 当前会话对象                                   |
| `currentAgentId`        | `ref`      | 当前助手 ID                                    |
| `modelName`             | `ref`      | 当前模型名称                                   |
| `chatMode`              | `ref`      | 聊天模式（direct/agent）                       |
| `gatewayStatus`         | `ref`      | Gateway 状态                                   |
| `contextInfo`           | `computed` | 上下文使用情况（percent, status, usedTokensK） |
| `contextDetail`         | `computed` | 上下文详情（分类统计、消息明细）               |

### 4.2 会话持久化

```
persistActiveSession()
  │
  ├─ getPersistableMessages()       过滤掉 loading 占位消息
  │     └─ stripConversationInfo()  去除元数据标记
  │
  └─ saveCurrentSession()
     └─ POST /api/chat-history/sessions/:id
        ├─ messages
        ├─ model
        ├─ systemPrompt
        └─ touch（更新时间戳）
```

### 4.3 并行任务管理

```
MAX_PARALLEL_TASKS = 3

activeTasks = Map<sessionId, AbortController>

canStartNewTask(sessionId)
  ├─ 已有任务 → 返回 true（允许继续）
  └─ 新任务 → 检查 activeTasks.size < 3

createSessionAbortSignal(sessionId)
  └─ 创建 AbortController，存入 activeTasks

stopCurrentSession()
  └─ 获取当前会话的 AbortController，调用 abort()
```

---

## 五、特殊功能

### 5.1 上下文管理

```
上下文进度条显示（ChatHeader）
  │
  ├─ estimateSessionTokens(messages, effectiveSystemPrompt)
  │     ├─ 统计文本 token（中文/1.5 + 英文/4）
  │     ├─ 统计图片附件（每张 1000 tokens）
  │     ├─ 统计文件附件（每个 50 tokens）
  │     ├─ 统计工具操作（每个 200 tokens）
  │     └─ 统计格式开销（每条消息 4 tokens）
  │
  ├─ getContextStatus(usedTokens)
  │     ├─ normal: < 60%（绿色）
  │     ├─ warning: 60% - 80%（黄色）
  │     ├─ danger: 80% - 100%（红色）
  │     └─ overflow: ≥ 100%（红色 + 新建会话按钮）
  │
  └─ 点击进度条 → ContextDetailModal
     ├─ 总览：总 token / 最大 token（256K）
     ├─ 分类统计：
     │   ├─ 系统提示（Agent SOUL.md + 用户自定义）
     │   ├─ 对话内容
     │   ├─ 图片附件
     │   ├─ 文件附件
     │   ├─ 工具操作
     │   └─ 格式开销
     ├─ 消息明细：每条消息的 token 占用、角色、预览、附件标签
     └─ 底部操作：危险/溢出状态时显示"新建会话"按钮
```

## 十一、上下文统计详情

### Token 估算规则

| 类型         | 估算方式          |
| ------------ | ----------------- |
| 中文文本     | 字符数 / 1.5      |
| 英文文本     | 字符数 / 4        |
| 图片附件     | 每张 1000 tokens  |
| 文件附件     | 每个 50 tokens    |
| 工具操作     | 每个 200 tokens   |
| 消息格式开销 | 每条消息 4 tokens |

### 上下文限制配置

```js
CONTEXT_CONFIG = {
  maxTokens: 256000, // 最大上下文 256K
  warningRatio: 0.6, // 60% 时显示警告色（黄色）
  dangerRatio: 0.8, // 80% 时显示危险色（红色）
  overflowRatio: 1.0, // 100% 时提示新建会话
};
```

---
