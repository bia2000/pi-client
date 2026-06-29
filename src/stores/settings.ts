import { defineStore } from "pinia";
import { ref } from "vue";
import {
  DEFAULT_CRAWLER_SETTINGS,
  type AgentSettings,
  type CrawlerSettings,
} from "../../electron/shared";

export const useSettingsStore = defineStore("settings", () => {
  const crawler = ref<CrawlerSettings>({ ...DEFAULT_CRAWLER_SETTINGS });
  const loaded = ref(false);

  async function load() {
    const s: AgentSettings = await window.piAgent.settings.get();
    crawler.value = { ...DEFAULT_CRAWLER_SETTINGS, ...s.crawler };
    loaded.value = true;
  }

  async function save(patch: Partial<CrawlerSettings>) {
    const s = await window.piAgent.settings.save(patch);
    crawler.value = { ...DEFAULT_CRAWLER_SETTINGS, ...s.crawler };
    return crawler.value;
  }

  return { crawler, loaded, load, save };
});
