<script setup lang="ts">
import { onMounted, reactive } from "vue";
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
  useMessage,
} from "naive-ui";
import {
  DEFAULT_CRAWLER_SETTINGS,
  type CrawlerSettings,
} from "../../electron/shared";
import { useSettingsStore } from "../stores/settings";
import { useAgentStore } from "../stores/agent";

const settings = useSettingsStore();
const agent = useAgentStore();
const message = useMessage();

const form = reactive<CrawlerSettings>({ ...DEFAULT_CRAWLER_SETTINGS });

onMounted(async () => {
  await settings.load();
  Object.assign(form, settings.crawler);
});

function save() {
  void settings.save({ ...form }).then(() => {
    message.success("设置已保存（本地存储）。");
  });
}

function resetDefaults() {
  Object.assign(form, DEFAULT_CRAWLER_SETTINGS);
}
</script>

<template>
  <div class="settings">
    <NCard title="LLM 模型配置（只读）" size="small" :bordered="false">
      <NAlert type="info" :show-icon="false" style="margin-bottom: 12px">
        模型与 API Key 在项目根目录的 <code>.env</code> 文件中配置（PI_CUSTOM_*
        / PI_MODEL_*），客户端不直接保存密钥。
      </NAlert>
      <NSpace :size="12" align="center">
        <NTag :type="agent.runtimeInfo?.hasApiKey ? 'success' : 'warning'">
          API Key：{{ agent.runtimeInfo?.hasApiKey ? "已检测到" : "未检测到" }}
        </NTag>
        <NTag>Provider：{{ agent.runtimeInfo?.provider || "—" }}</NTag>
        <NTag>Model：{{ agent.runtimeInfo?.modelId || "—" }}</NTag>
        <NTag v-if="agent.runtimeInfo?.customBaseUrl" size="small">
          {{ agent.runtimeInfo.customBaseUrl }}
        </NTag>
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
          <NButton type="primary" @click="save">保存设置</NButton>
          <NButton @click="resetDefaults">恢复默认</NButton>
        </NSpace>
      </NForm>
    </NCard>

    <NAlert type="warning" :show-icon="false">
      隐私合规：候选人简历数据仅本地 SQLite
      存储，应用不含任何向外部服务器发送候选人数据的逻辑。
    </NAlert>
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
