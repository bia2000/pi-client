// 设置持久化 —— boss-cli 路径 / headless / OCR / 限频阈值，存于 userData/pi-agent-settings.json。
// 隐私：boss-cli 复用本机 Chrome 登录态，候选人数据仅本地 SQLite，不上传任何外部服务。
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import {
  DEFAULT_CRAWLER_SETTINGS,
  type AgentSettings,
  type CrawlerSettings,
} from "../shared";

function filePath(): string {
  return path.join(app.getPath("userData"), "pi-agent-settings.json");
}

let cache: AgentSettings | null = null;

/** 把 .env 里的 BOSS_* 作为空字段默认值（已保存的用户值优先）。 */
function applyEnvDefaults(crawler: CrawlerSettings): void {
  if (!crawler.bossCliPath && process.env.BOSS_CLI_PATH) {
    crawler.bossCliPath = process.env.BOSS_CLI_PATH.trim();
  }
  if (process.env.BOSS_BROWSER_HEADLESS) {
    crawler.headless = process.env.BOSS_BROWSER_HEADLESS.trim().toLowerCase() === "true";
  }
  if (process.env.BOSS_RESUME_OCR) {
    const v = process.env.BOSS_RESUME_OCR.trim().toLowerCase();
    crawler.ocrEnabled = !(v === "0" || v === "false" || v === "no");
  }
}

export function loadSettings(): AgentSettings {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(filePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AgentSettings>;
    cache = { crawler: { ...DEFAULT_CRAWLER_SETTINGS, ...parsed.crawler } };
  } catch {
    cache = { crawler: { ...DEFAULT_CRAWLER_SETTINGS } };
  }
  applyEnvDefaults(cache.crawler);
  return cache;
}

export function saveSettings(patch: Partial<CrawlerSettings>): AgentSettings {
  const current = loadSettings();
  cache = { crawler: { ...current.crawler, ...patch } };
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), JSON.stringify(cache, null, 2), "utf-8");
  } catch (error) {
    console.error("[settings] 保存失败", error);
  }
  return cache;
}
