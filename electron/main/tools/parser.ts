// resume_parser_tool —— 调用 @joohw/boss-cli 的 `boss preview <姓名>` 抓取在线简历。
// 对应文档 §3.1.3：boss-cli 截图 + OCR（可选）+ LLM 结构化。
// 重要前置：boss preview 不会自动跳转，必须先调过 boss recommend 让浏览器停在推荐页。
import { BossCliError, resolveBossCliPath, runBossCli } from "./boss-cli-runner";
import type { Resume } from "../../shared";
import { toolResult, type ToolDeps, type ToolSdk } from "./index";

const SKILL_HINTS = [
  "Vue",
  "React",
  "TypeScript",
  "JavaScript",
  "Node",
  "Java",
  "Spring",
  "Python",
  "Go",
  "MySQL",
  "Redis",
  "Docker",
  "Kubernetes",
  "Linux",
  "HTML",
  "CSS",
  "Webpack",
  "Vite",
  "MongoDB",
  "Kafka",
  "RabbitMQ",
  "Elasticsearch",
  "Git",
];

function extractSkills(text: string): string[] {
  const found = new Set<string>();
  for (const skill of SKILL_HINTS) {
    const re = new RegExp(
      `(^|[^a-zA-Z])${skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-zA-Z]|$)`,
      "i",
    );
    if (re.test(text)) found.add(skill);
  }
  return Array.from(found);
}

/** 去除 HTML 标签、script/style、连续空白（用于 rawHtml 兼容路径）。 */
function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 从清洗后的纯文本里尽力抽取结构化字段（接口/页面结构可能变动，做容错）。
 *  candidateId 在 boss-cli 方案下用于存姓名（作为 database 去重键）。 */
function parseResumeText(rawText: string, candidateName?: string): Resume {
  const text = rawText.trim();
  const skills = extractSkills(text);

  const salaryMatch = text.match(
    /(?:期望薪资|期望月薪|薪资要求|月薪)?\s*([\d]+k?[\d]*\s*[-·~]\s*[\d]+k?|[\d]+k(?:以上)?)/i,
  );
  const cityMatch = text.match(/城市[:：\s]*([一-龥]{2,6})/);
  const yearsMatch = text.match(/(\d+)\s*年(?:工作经验|经验|工作)/);

  const workExperience =
    text
      .split(/(?:工作经历|工作履历|职业经历)[:：]?/i)[1]
      ?.split(/项目经历|项目经验|教育经历|自我评价/i)[0]
      ?.split(/\s{2,}|;|；|\|\|/)
      .map((s) => s.trim())
      .filter((s) => s.length > 4 && s.length < 200)
      .slice(0, 8) ?? [];

  const projectExperience =
    text
      .split(/(?:项目经历|项目经验)[:：]?/i)[1]
      ?.split(/教育经历|自我评价|技能标签/i)[0]
      ?.split(/\s{2,}|;|；/)
      .map((s) => s.trim())
      .filter((s) => s.length > 4 && s.length < 200)
      .slice(0, 8) ?? [];

  const nameMatch = text.match(/(?:姓名|名字)[:：\s]*([一-龥A-Za-z·]{2,20})/);
  const titleMatch = text.match(/(?:职位|期望职位|当前职位)[:：\s]*([一-龥A-Za-z/]{2,30})/);

  return {
    candidateId: candidateName,
    name: nameMatch?.[1]?.trim() || candidateName,
    title: titleMatch?.[1]?.trim(),
    city: cityMatch?.[1]?.trim(),
    expectSalary: salaryMatch?.[1]?.trim(),
    workYears: yearsMatch?.[1] ? `${yearsMatch[1]}年` : undefined,
    skills,
    workExperience,
    projectExperience,
    raw: text.slice(0, 4000),
  };
}

function formatResume(r: Resume): string {
  return [
    `姓名：${r.name || "(未识别)"}`,
    `职位：${r.title || "(未识别)"}`,
    `城市：${r.city || "(未识别)"}`,
    `期望薪资：${r.expectSalary || "(未识别)"}`,
    `工龄：${r.workYears || "(未识别)"}`,
    `技能标签：${r.skills.length ? r.skills.join("、") : "(未识别)"}`,
    `工作经历：${r.workExperience.length ? "\n  - " + r.workExperience.join("\n  - ") : "(未识别)"}`,
    `项目经历：${r.projectExperience.length ? "\n  - " + r.projectExperience.join("\n  - ") : "(未识别)"}`,
  ].join("\n");
}

/** 解析 boss preview 输出，提取 OCR 文本与截图路径。
 *  输出格式（boss-cli 0.5.0 runPreview）：
 *    当前岗位：<岗位名>
 *    简历预览截图：<absPath>
 *
 *    在线简历 OCR 正文：
 *
 *    <OCR 文本>
 *
 *    说明：平台对在线简历的每日可查看次数有限，请按需使用、谨慎查看。
 *
 *  当 BOSS_RESUME_OCR=0 时缺少「在线简历 OCR 正文」段，仅返回截图路径。
 */
function parsePreviewOutput(stdout: string): {
  jobLabel: string;
  screenshotPath?: string;
  ocrText?: string;
} {
  const lines = stdout.split(/\r?\n/);
  let jobLabel = "";
  let screenshotPath: string | undefined;
  let ocrText: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const jobM = line.match(/^当前岗位：(.+)$/);
    if (jobM) jobLabel = jobM[1].trim();
    const shotM = line.match(/^简历预览截图：(.+)$/);
    if (shotM) screenshotPath = shotM[1].trim();
    // OCR 段：标识行后可能空一行，然后是正文（直到「说明：」段）
    if (/^在线简历 OCR 正文：\s*$/.test(line)) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      while (j < lines.length && !lines[j].startsWith("说明：")) {
        body.push(lines[j]);
        j++;
      }
      ocrText = body.join("\n").trim();
    }
  }

  return { jobLabel, screenshotPath, ocrText };
}

export function createParserTool(sdk: ToolSdk, deps: ToolDeps) {
  const Type = sdk.Type;
  return sdk.defineTool({
    name: "resume_parser_tool",
    label: "简历解析",
    description:
      "通过 @joohw/boss-cli 的 `boss preview <姓名>` 抓取在线简历并 OCR（可选），结构化提取姓名/期望薪资/工作经历/项目经验/技能标签。前置：必须先调用 boss_spider_tool 加载推荐列表，否则 boss-cli 报「当前不在推荐列表页」。也可直接传 rawHtml 清洗已有片段。",
    parameters: sdk.Type.Object({
      candidateName: Type.Optional(
        Type.String({
          description: "候选人姓名（来自 boss_spider_tool 返回的 candidateName 字段）",
        }),
      ),
      jobKeyword: Type.Optional(
        Type.String({
          description: "岗位关键字，传给 boss preview --job 用于在推荐页定位岗位下拉（可选）",
        }),
      ),
      rawHtml: Type.Optional(
        Type.String({
          description: "已有的 HTML/文本片段，直接清洗解析（不调 boss-cli）",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      // 1) 直接清洗传入文本（保留兼容）
      if (params.rawHtml && params.rawHtml.trim()) {
        deps.notify(
          "parse",
          `正在解析传入的简历片段（${params.rawHtml.length} 字符）…`,
          "active",
        );
        const rawText = stripHtml(params.rawHtml);
        const resume = parseResumeText(rawText);
        deps.notify(
          "parse",
          `解析完成：${resume.name || "匿名"} · ${resume.skills.length} 个技能标签。`,
          "success",
          { name: resume.name, skills: resume.skills.length },
        );
        return toolResult(
          `简历解析结果：\n${formatResume(resume)}\n\n可直接把以上内容交给 resume_scorer_tool 进行岗位匹配评分。`,
          { resume },
        );
      }

      // 2) 通过 boss-cli preview 抓取
      const candidateName = params.candidateName?.trim();
      if (!candidateName) {
        return toolResult(
          "请提供 candidateName（来自 boss_spider_tool 的输出），或直接传 rawHtml 解析已有片段。",
        );
      }

      const settings = deps.getSettings();
      let cliPath: string;
      try {
        cliPath = resolveBossCliPath(settings.bossCliPath);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        deps.notify("error", `boss-cli 未就绪：${msg}`, "error");
        return toolResult(
          `ERROR_CODE: BOSS_CLI_NOT_FOUND。${msg}。请提醒用户到【设置】页配置 boss-cli 路径。`,
        );
      }

      deps.notify(
        "parse",
        `正在调用 boss-cli preview 抓取「${candidateName}」的在线简历…`,
        "active",
      );

      const args = ["preview", candidateName];
      if (params.jobKeyword?.trim()) {
        args.push("--job", params.jobKeyword.trim());
      }

      let stdout: string;
      try {
        const result = await runBossCli(cliPath, {
          args,
          timeout: 120_000,
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
        deps.notify("error", `boss-cli preview 失败：${msg}`, "error", { stderr });
        if (/未登录|登录已过期|请先登录|安全验证/.test(msg)) {
          return toolResult(
            `ERROR_CODE: LOGIN_EXPIRED。boss-cli 报告登录态失效：${msg}。请提醒用户在本机执行 \`boss login\` 重新登录后重试。`,
          );
        }
        if (/当前不在推荐列表页|未在列表中找到该候选人/.test(msg)) {
          return toolResult(
            `ERROR_CODE: PREVIEW_CONTEXT_MISSING。${msg}。请先调用 boss_spider_tool 加载推荐列表，再调用 resume_parser_tool。`,
          );
        }
        return toolResult(
          `boss-cli preview 调用失败：${msg}${stderr ? `\nstderr:\n${stderr.slice(-600)}` : ""}`,
        );
      }

      const { jobLabel, screenshotPath, ocrText } = parsePreviewOutput(stdout);

      if (!ocrText) {
        // OCR 禁用或未输出正文 —— 返回截图路径供用户查看
        deps.notify(
          "parse",
          `已抓取简历截图（OCR 未启用）：${screenshotPath ?? "(未识别路径)"}`,
          "default",
          { candidateName, screenshotPath, ocrEnabled: false },
        );
        return toolResult(
          `当前岗位：${jobLabel || "?"}\n候选人「${candidateName}」的简历截图已保存：${screenshotPath ?? "(未识别)"}\n\nOCR 未启用，未提取正文文本。可在【设置】页开启 OCR（需配百度凭据），或人工查看截图后用 rawHtml 参数传入解析。`,
          { candidateName, jobLabel, screenshotPath, ocrEnabled: false },
        );
      }

      const resume = parseResumeText(ocrText, candidateName);
      deps.notify(
        "parse",
        `解析完成：${resume.name || candidateName} · ${resume.skills.length} 个技能标签。`,
        "success",
        { name: resume.name, skills: resume.skills.length, screenshotPath },
      );
      return toolResult(
        `当前岗位：${jobLabel || "?"}\n简历截图：${screenshotPath ?? "(未识别)"}\n\n简历解析结果：\n${formatResume(resume)}\n\n可直接把以上内容交给 resume_scorer_tool 进行岗位匹配评分。`,
        { resume, candidateName, jobLabel, screenshotPath, ocrText },
      );
    },
  });
}
