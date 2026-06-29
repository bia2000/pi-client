<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import {
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NButton,
  NSpace,
  NSwitch,
  NTag,
  NAlert,
  NList,
  NListItem,
  NThing,
  NPopconfirm,
  NModal,
  NSelect,
  useMessage,
} from "naive-ui";
import {
  DEFAULT_CRAWLER_SETTINGS,
  type CrawlerSettings,
  type ModelPreset,
} from "../../electron/shared";
import { useSettingsStore } from "../stores/settings";
import { useAgentStore } from "../stores/agent";

const settings = useSettingsStore();
const agent = useAgentStore();
const message = useMessage();

const form = reactive<CrawlerSettings>({ ...DEFAULT_CRAWLER_SETTINGS });

/** 模型 preset 列表（本地编辑副本，保存时整体提交）。 */
const models = ref<ModelPreset[]>([]);
const activeModelId = ref<string | null>(null);

/** 新建/编辑 preset 弹窗状态 */
const editorVisible = ref(false);
const editorMode = ref<"create" | "edit">("create");
const editorForm = reactive<ModelPreset>(emptyPreset());

const apiOptions = [
  { label: "openai-completions", value: "openai-completions" },
  { label: "anthropic", value: "anthropic" },
  { label: "openai-responses", value: "openai-responses" },
  { label: "azure-openai-responses", value: "azure-openai-responses" },
  { label: "openai-codex-responses", value: "openai-codex-responses" },
  { label: "google", value: "google" },
  { label: "google-vertex", value: "google-vertex" },
  { label: "mistral", value: "mistral" },
  { label: "bedrock", value: "bedrock" },
];

function emptyPreset(): ModelPreset {
  return {
    id: "",
    name: "",
    provider: "openai",
    modelId: "",
    apiKey: "",
    baseUrl: "",
    api: "openai-completions",
    reasoning: false,
    supportsImages: false,
    contextWindow: 128000,
    maxTokens: 8192,
  };
}

onMounted(async () => {
  await settings.load();
  Object.assign(form, settings.crawler);
  await loadModels();
});

async function loadModels() {
  models.value = await window.piAgent.models.list();
  activeModelId.value = agent.activeModelId ?? models.value[0]?.id ?? null;
}

function saveCrawler() {
  void settings.save({ ...form }).then(() => {
    message.success("爬虫设置已保存。");
  });
}

function resetDefaults() {
  Object.assign(form, DEFAULT_CRAWLER_SETTINGS);
}

/* —— 模型 preset 增删改 —— */

function openCreate() {
  editorMode.value = "create";
  Object.assign(editorForm, emptyPreset(), { id: crypto.randomUUID() });
  editorVisible.value = true;
}

function openEdit(preset: ModelPreset) {
  editorMode.value = "edit";
  Object.assign(editorForm, emptyPreset(), preset);
  editorVisible.value = true;
}

async function savePreset() {
  if (
    !editorForm.name.trim() ||
    !editorForm.provider.trim() ||
    !editorForm.modelId.trim()
  ) {
    message.warning("名称 / Provider / Model ID 必填。");
    return;
  }
  if (editorForm.baseUrl && !editorForm.api) {
    editorForm.api = "openai-completions";
  }

  if (editorMode.value === "create") {
    models.value = [...models.value, { ...editorForm }];
  } else {
    models.value = models.value.map((m) =>
      m.id === editorForm.id ? { ...editorForm } : m,
    );
  }
  editorVisible.value = false;
  await persistModels();
}

async function deletePreset(id: string) {
  models.value = models.value.filter((m) => m.id !== id);
  await persistModels();
}

async function persistModels() {
  try {
    await agent.saveModels(models.value);
    message.success("模型预设已保存。");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "保存失败");
  }
}

async function setActiveModel(id: string) {
  if (id === activeModelId.value) return;
  try {
    await agent.switchModel(id);
    activeModelId.value = agent.activeModelId;
    message.success("已切换活动模型。");
  } catch (e) {
    message.error(e instanceof Error ? e.message : "切换失败");
  }
}
</script>

<template>
  <div class="settings">
    <NCard title="LLM 模型预设" size="small" :bordered="false">
      <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
        管理可在 ChatHeader 切换的模型预设。每个 preset 包含 provider / modelId
        / API Key 等信息，存于本地 <code>pi-agent-settings.json</code>。
        <strong>切换模型为热切换</strong>，不重置会话历史。
      </NAlert>

      <NList v-if="models.length > 0" bordered>
        <NListItem v-for="m in models" :key="m.id">
          <NThing>
            <template #header>
              <NSpace :size="6" align="center">
                <span>{{ m.name }}</span>
                <NTag v-if="m.id === activeModelId" size="small" type="success"
                  >当前活动</NTag
                >
              </NSpace>
            </template>
            <template #description>
              <NSpace
                :size="6"
                align="center"
                style="font-size: 12px; color: #999"
              >
                <span>{{ m.provider }} / {{ m.modelId }}</span>
                <span v-if="m.baseUrl">· {{ m.baseUrl }}</span>
                <span>· API Key: {{ m.apiKey ? "已配" : "未配" }}</span>
              </NSpace>
            </template>
            <template #action>
              <NSpace :size="6">
                <NButton
                  v-if="m.id !== activeModelId"
                  size="small"
                  type="primary"
                  ghost
                  @click="setActiveModel(m.id)"
                  >设为活动</NButton
                >
                <NButton size="small" @click="openEdit(m)">编辑</NButton>
                <NPopconfirm @positive-click="deletePreset(m.id)">
                  <template #trigger>
                    <NButton size="small" type="error" ghost>删除</NButton>
                  </template>
                  确认删除该模型预设？
                </NPopconfirm>
              </NSpace>
            </template>
          </NThing>
        </NListItem>
      </NList>
      <NAlert v-else type="warning" :show-icon="false" style="margin: 12px 0">
        暂无模型预设。点击下方按钮添加一个，或检查 <code>.env</code> 是否已配置
        PI_MODEL_* / PI_CUSTOM_*（首次启动会自动从 .env 推导默认 preset）。
      </NAlert>

      <NSpace style="margin-top: 12px">
        <NButton type="primary" @click="openCreate">+ 添加模型预设</NButton>
      </NSpace>
    </NCard>

    <NCard title="BOSS直聘爬虫设置" size="small" :bordered="false">
      <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
        本客户端通过 <code>@joohw/boss-cli</code> 驱动本机 Chrome 复用
        BOSS直聘登录态抓取简历，不再保存 Cookie。首次使用请在本机执行
        <code>boss login</code> 完成登录。
      </NAlert>
      <NForm label-placement="top">
        <NFormItem
          label="boss-cli cli.js 路径（留空则使用包内 @joohw/boss-cli）"
        >
          <NInput
            v-model:value="form.bossCliPath"
            placeholder="例如 D:\\global\\node_modules\\@joohw\\boss-cli\\dist\\cli\\index.js"
          />
        </NFormItem>

        <NSpace :size="12" align="center">
          <NFormItem label="无头模式（headless）">
            <NSwitch v-model:value="form.headless" />
            <span style="margin-left: 8px; color: #999; font-size: 12px">
              默认关闭以规避自动化检测
            </span>
          </NFormItem>
          <NFormItem label="启用 OCR（需配百度凭据）">
            <NSwitch v-model:value="form.ocrEnabled" />
            <span style="margin-left: 8px; color: #999; font-size: 12px">
              关闭时仅返回截图路径
            </span>
          </NFormItem>
        </NSpace>

        <NSpace :size="12">
          <NFormItem label="最小延时（秒）">
            <NInputNumber v-model:value="form.minDelaySec" :min="1" :max="60" />
          </NFormItem>
          <NFormItem label="最大延时（秒）">
            <NInputNumber
              v-model:value="form.maxDelaySec"
              :min="1"
              :max="120"
            />
          </NFormItem>
          <NFormItem label="单任务抓取上限">
            <NInputNumber v-model:value="form.maxPerTask" :min="1" :max="100" />
          </NFormItem>
        </NSpace>

        <NSpace>
          <NButton type="primary" @click="saveCrawler">保存爬虫设置</NButton>
          <NButton @click="resetDefaults">恢复默认</NButton>
        </NSpace>
      </NForm>
    </NCard>

    <NAlert type="warning" :show-icon="false">
      隐私合规：候选人简历数据仅本地 SQLite
      存储，应用不含任何向外部服务器发送候选人数据的逻辑。
    </NAlert>

    <!-- 模型 preset 编辑弹窗 -->
    <NModal
      v-model:show="editorVisible"
      preset="card"
      :title="editorMode === 'create' ? '添加模型预设' : '编辑模型预设'"
      style="width: 520px"
    >
      <NForm label-placement="top">
        <NFormItem label="显示名称">
          <NInput
            v-model:value="editorForm.name"
            placeholder="如 GPT-4.1 Mini"
          />
        </NFormItem>
        <NSpace :size="12">
          <NFormItem label="Provider" style="flex: 1">
            <NInput
              v-model:value="editorForm.provider"
              placeholder="openai / anthropic / 自定义名"
            />
          </NFormItem>
          <NFormItem label="Model ID" style="flex: 1">
            <NInput
              v-model:value="editorForm.modelId"
              placeholder="如 gpt-4.1-mini"
            />
          </NFormItem>
        </NSpace>
        <NFormItem label="API Key">
          <NInput
            v-model:value="editorForm.apiKey"
            type="password"
            show-password-on="click"
            placeholder="留空则使用 .env 中的 key"
          />
        </NFormItem>
        <NSpace :size="12">
          <NFormItem label="Base URL（自定义 provider 用）" style="flex: 1">
            <NInput
              v-model:value="editorForm.baseUrl"
              placeholder="如 https://api.openai.com/v1"
            />
          </NFormItem>
          <NFormItem label="API 协议" style="width: 200px">
            <NSelect
              v-model:value="editorForm.api"
              :options="apiOptions"
              placeholder="openai-completions"
            />
          </NFormItem>
        </NSpace>
        <NSpace :size="12">
          <NFormItem label="上下文窗口">
            <NInputNumber
              v-model:value="editorForm.contextWindow"
              :min="1000"
              :step="1000"
            />
          </NFormItem>
          <NFormItem label="最大输出 tokens">
            <NInputNumber
              v-model:value="editorForm.maxTokens"
              :min="256"
              :step="256"
            />
          </NFormItem>
          <NFormItem label="推理模式">
            <NSwitch v-model:value="editorForm.reasoning" />
          </NFormItem>
          <NFormItem label="支持图片">
            <NSwitch v-model:value="editorForm.supportsImages" />
          </NFormItem>
        </NSpace>
      </NForm>
      <template #footer>
        <NSpace justify="end">
          <NButton @click="editorVisible = false">取消</NButton>
          <NButton type="primary" @click="savePreset">保存</NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 760px;
}
.settings :deep(.n-card__content) {
  padding: 14px 18px;
}
</style>
