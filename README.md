# Pi Client

基于 `Electron + Vue + Pi Agent SDK` 的桌面聊天应用骨架。

## 当前能力

- Electron 主进程中运行 Pi Agent，会话不暴露给渲染进程
- Vue 聊天界面，支持流式输出
- `preload + IPC` 桥接，默认开启 `contextIsolation`
- 默认关闭工具调用，先聚焦聊天能力
- 支持通过 `.env` 切换多个 provider
- 支持通过 `.env` 注册自定义 provider 和自定义模型

## 本地启动

1. 复制 `.env.example` 为 `.env`
2. 填写 `PI_MODEL_PROVIDER`、`PI_MODEL_ID`
3. 填写对应 provider 的 API Key，或者直接填 `PI_API_KEY`
4. 安装依赖
5. 运行 `pnpm dev`

## Provider 配置示例

### OpenAI

```env
PI_MODEL_PROVIDER=openai
PI_MODEL_ID=gpt-4.1-mini
OPENAI_API_KEY=...
```

### Anthropic

```env
PI_MODEL_PROVIDER=anthropic
PI_MODEL_ID=claude-sonnet-4-0
ANTHROPIC_API_KEY=...
```

### OpenRouter

```env
PI_MODEL_PROVIDER=openrouter
PI_MODEL_ID=anthropic/claude-sonnet-4
OPENROUTER_API_KEY=...
```

### 通用写法

```env
PI_MODEL_PROVIDER=deepseek
PI_MODEL_ID=deepseek-chat
PI_API_KEY=...
```

### 自定义模型

适用于你有自己的 OpenAI-compatible 网关，或者需要接一个 Pi 内置列表之外的模型。

```env
PI_MODEL_PROVIDER=my-proxy
PI_MODEL_ID=qwen-coder-custom

PI_CUSTOM_PROVIDER_ENABLED=true
PI_CUSTOM_PROVIDER_NAME=my-proxy
PI_CUSTOM_MODEL_ID=qwen-coder-custom
PI_CUSTOM_MODEL_NAME=Qwen Coder Custom
PI_CUSTOM_BASE_URL=https://your-gateway.example.com/v1
PI_CUSTOM_API_KEY=...
PI_CUSTOM_API=openai-completions
PI_CUSTOM_REASONING=false
PI_CUSTOM_SUPPORTS_IMAGES=false
PI_CUSTOM_CONTEXT_WINDOW=128000
PI_CUSTOM_MAX_TOKENS=8192
```

`PI_CUSTOM_API` 当前支持：

- `openai-completions`
- `openai-responses`
- `openai-codex-responses`
- `anthropic`
- `google`
- `google-vertex`
- `mistral`
- `azure-openai-responses`

## 后续建议

- 增加多会话与本地持久化
- 增加模型切换和 provider 配置页面
- 按需开放 Pi Agent 工具并做权限确认
- 增加消息 markdown 渲染和代码块复制
