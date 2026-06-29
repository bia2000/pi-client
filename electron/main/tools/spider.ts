// boss_spider_tool —— 通过 @joohw/boss-cli 子进程调用 BOSS直聘推荐列表。
// 对应文档 §3.1 主线 A：spawn('node', [cliPath, 'recommend', keyword]) 驱动本机 Chrome，
// 复用已登录态。反风控由 boss-cli 内置：Chrome profile 复用 + headful 默认 + 拟人滚动。
import { BossCliError, resolveBossCliPath, runBossCli } from "./boss-cli-runner";
import { toolResult, type ToolDeps, type ToolSdk } from "./index";

interface BriefCandidate {
  /** 用于调 `boss preview` 的标识（姓名） */
  candidateName: string;
  name: string;
  salary?: string;
  age?: string;
  workYears?: string;
  education?: string;
  expectPosition?: string;
  experience?: string;
  canGreet: boolean;
  hasViewed: boolean;
  hasHistoryChat: boolean;
  advantage?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

/** 解析 `boss recommend` 输出文本，提取结构化候选人列表。
 *  输出格式（boss-cli 0.5.0 renderRecommendList）：
 *    当前岗位：<岗位名>
 *
 *    推荐列表（按来源分组）：共 N 人。
 *
 *    常规推荐（M）
 *      - 1. 张三[ | 看过]｜薪资:8-12K｜信息:25岁 / 5年 / 大专｜期望:全栈开发｜可打招呼
 *        优势: 精通 React/Vue
 *    打招呼产生的推荐（K）
 *      - 暂无 / 或实际项
 */
function parseRecommendOutput(text: string): { jobLabel: string; candidates: BriefCandidate[] } {
  const lines = text.split(/\r?\n/);
  let jobLabel = "默认";
  const candidates: BriefCandidate[] = [];

  for (const line of lines) {
    const m = line.match(/^当前岗位：(.+)$/);
    if (m) {
      jobLabel = m[1].trim();
      break;
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // `  - 1. 张三[ | 看过]｜字段1｜字段2...`
    const m = line.match(/^\s*-\s+(\d+)\.\s+(.+?)(?:\s*｜\s*(.*))?$/);
    if (!m) continue;
    const seq = Number(m[1]);
    let namePart = m[2].trim();
    const fieldsPart = m[3] ?? "";

    // 剥掉 " | 看过" 后缀
    let hasViewed = false;
    const viewedMatch = namePart.match(/^(.+?)\s*\|\s*看过$/);
    if (viewedMatch) {
      namePart = viewedMatch[1].trim();
      hasViewed = true;
    }

    const fields = fieldsPart
      ? fieldsPart.split("｜").map((s) => s.trim()).filter(Boolean)
      : [];
    const candidate: BriefCandidate = {
      candidateName: namePart,
      name: namePart,
      canGreet: false,
      hasViewed,
      hasHistoryChat: false,
    };

    for (const f of fields) {
      if (f.startsWith("薪资:")) candidate.salary = f.slice(3).trim();
      else if (f.startsWith("信息:")) {
        const info = f.slice(3).trim();
        const ageM = info.match(/(\d+)\s*岁/);
        if (ageM) candidate.age = `${ageM[1]}岁`;
        const yearsM = info.match(/(\d+)\s*年/);
        if (yearsM) candidate.workYears = `${yearsM[1]}年`;
        const eduM = info.match(/(大专|本科|硕士|博士|高中|初中|中专|硕士及以上)/);
        if (eduM) candidate.education = eduM[1];
      } else if (f.startsWith("期望:")) candidate.expectPosition = f.slice(3).trim();
      else if (f.startsWith("经历:")) candidate.experience = f.slice(3).trim();
      else if (f === "同事沟通过") candidate.hasHistoryChat = true;
      else if (f === "可打招呼") candidate.canGreet = true;
      else if (f === "已打招呼") candidate.canGreet = false;
    }

    const nextLine = lines[i + 1] ?? "";
    const advM = nextLine.match(/^\s*优势:\s*(.+)$/);
    if (advM) candidate.advantage = advM[1].trim();

    void seq;
    candidates.push(candidate);
  }

  return { jobLabel, candidates };
}

function formatList(list: BriefCandidate[]): string {
  return list
    .map(
      (c, i) =>
        `${i + 1}. ${c.name}${c.hasViewed ? " | 看过" : ""} | ${c.expectPosition ?? "?"} | 薪资${c.salary ?? "?"} | ${c.age ?? "?"} / ${c.workYears ?? "?"} / ${c.education ?? "?"} | ${c.canGreet ? "可打招呼" : "已打招呼"}${c.hasHistoryChat ? " | 同事沟通过" : ""} | candidateName=${c.candidateName}\n   优势: ${c.advantage ?? "(无)"}`,
    )
    .join("\n");
}

export function createSpiderTool(sdk: ToolSdk, deps: ToolDeps) {
  const Type = sdk.Type;
  return sdk.defineTool({
    name: "boss_spider_tool",
    label: "BOSS直聘爬虫",
    description:
      "通过 @joohw/boss-cli 调用 BOSS直聘推荐列表（驱动本机 Chrome 复用登录态）。返回姓名/职位/薪资/年限/学历与 candidateName（用于 resume_parser_tool 调 boss preview）。",
    parameters: sdk.Type.Object({
      keyword: Type.String({
        description: "岗位关键字，例如 Vue前端 / Java（boss-cli 在岗位下拉里模糊匹配）",
      }),
      city: Type.String({
        description: "城市（保留参数：boss-cli 通过已登录态自动定位，本字段暂未生效）",
      }),
      page: Type.Optional(
        Type.Number({
          description: "页码（保留参数：boss-cli 一次输出当前页，翻页暂未支持）",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const settings = deps.getSettings();
      let cliPath: string;
      try {
        cliPath = resolveBossCliPath(settings.bossCliPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        deps.notify("error", `boss-cli 未就绪：${msg}`, "error");
        return toolResult(
          `ERROR_CODE: BOSS_CLI_NOT_FOUND。${msg}。请提醒用户到【设置】页配置 boss-cli 路径，并先在本机执行 \`boss login\` 完成登录。`,
        );
      }

      const minDelay = Math.max(1, settings.minDelaySec ?? 5);
      const maxDelay = Math.max(minDelay, settings.maxDelaySec ?? 15);
      await sleep(randInt(minDelay, maxDelay) * 1000);

      deps.notify(
        "spider",
        `正在调用 boss-cli recommend 获取「${params.keyword}」推荐列表…`,
        "active",
      );

      let stdout: string;
      try {
        const result = await runBossCli(cliPath, {
          args: ["recommend", params.keyword],
          timeout: 90_000,
          headless: settings.headless,
          ocrEnabled: settings.ocrEnabled,
        });
        stdout = result.stdout;
      } catch (error) {
        const msg =
          error instanceof BossCliError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        const stderr = error instanceof BossCliError ? error.stderr : "";
        deps.notify("error", `boss-cli recommend 失败：${msg}`, "error", { stderr });
        if (/未登录|登录已过期|请先登录|安全验证/.test(msg)) {
          return toolResult(
            `ERROR_CODE: LOGIN_EXPIRED。boss-cli 报告登录态失效：${msg}。请提醒用户在本机执行 \`boss login\` 重新登录后重试。`,
          );
        }
        return toolResult(
          `boss-cli recommend 调用失败：${msg}${stderr ? `\nstderr:\n${stderr.slice(-600)}` : ""}`,
        );
      }

      const { jobLabel, candidates } = parseRecommendOutput(stdout);
      deps.state.scraped += candidates.length;
      const maxPerTask = Math.max(1, settings.maxPerTask ?? 50);

      if (deps.state.scraped >= maxPerTask) {
        deps.notify(
          "spider",
          `已达单任务抓取上限 ${maxPerTask}（累计 ${deps.state.scraped}），停止后续抓取。`,
          "default",
          { scraped: deps.state.scraped, limit: maxPerTask },
        );
        return toolResult(
          `当前岗位：${jobLabel}\n本批发现 ${candidates.length} 份简历（累计 ${deps.state.scraped}），已触发单任务上限 ${maxPerTask}，停止继续抓取。\n\n候选人简要：\n${formatList(candidates) || "(未解析到结构化候选人，boss-cli 输出可能格式变动)"}\n\n下一步：对感兴趣的 candidateName 调用 resume_parser_tool 解析详情，再调用 resume_scorer_tool 评分，>60 分用 database_tool 入库。`,
          { count: candidates.length, scraped: deps.state.scraped, truncated: true, candidates },
        );
      }

      deps.notify(
        "spider",
        `抓取完成：${candidates.length} 份简历（岗位 ${jobLabel}，累计 ${deps.state.scraped}）。`,
        "success",
        { count: candidates.length, jobLabel },
      );
      return toolResult(
        `当前岗位：${jobLabel}\n抓取到 ${candidates.length} 份候选人（累计 ${deps.state.scraped} 份）：\n${formatList(candidates) || "(未解析到结构化字段)"}\n\n下一步：用 resume_parser_tool 传 candidateName 解析详情，resume_scorer_tool 评分，database_tool 把 >60 分的入库。`,
        { count: candidates.length, jobLabel, candidates },
      );
    },
  });
}
