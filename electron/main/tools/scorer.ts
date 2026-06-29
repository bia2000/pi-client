// resume_scorer_tool —— 智能评分。
// 成本控制：先用硬规则预过滤（薪资/年限明显不符直接淘汰，不调 LLM）；通过后再调 LLM 深度评分。
// LLM 强制 JSON 输出：总分(0-100)、技能匹配度(高/中/低)、跳槽频繁度风险、推荐理由。
import type { MatchLevel, ScoreResult } from "../../shared";
import { toolResult, type ToolDeps, type ToolSdk } from "./index";

interface HardRuleResult {
  passed: boolean;
  reason: string;
}

/** 硬规则预过滤：从简历文本与 JD 中粗匹配薪资区间与年限，明显不符直接淘汰。 */
function hardRuleFilter(resumeText: string, jd: string): HardRuleResult {
  const salary = (resumeText.match(/(\d+)\s*k?\s*[-·~]\s*(\d+)\s*k?/i) || resumeText.match(/(\d+)k(?:以上)?/i))?.[0];
  void salary; // 仅记录，不阻断；下面做年限判断

  const resumeYears = parseYears(resumeText);
  const jdYears = parseYears(jd);

  if (jdYears && resumeYears !== null) {
    if (resumeYears + 1 < jdYears) {
      return {
        passed: false,
        reason: `硬规则淘汰：JD 要求约 ${jdYears} 年经验，简历仅约 ${resumeYears} 年，差距过大。`,
      };
    }
  }
  return { passed: true, reason: "硬规则通过。" };
}

function parseYears(text: string): number | null {
  const m = text.match(/(\d+)\s*年/);
  return m ? Number(m[1]) : null;
}

function coerceMatchLevel(raw: string): MatchLevel {
  if (raw.includes("高")) return "高";
  if (raw.includes("低")) return "低";
  return "中";
}

function coerceScore(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 健壮地从 LLM 输出里解析 JSON（可能被 ```json 包裹或带前后缀）。 */
export function parseScoreJson(text: string): Partial<ScoreResult> {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return {};
  try {
    const obj = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const score = coerceScore(obj.score ?? obj.total ?? obj["总分"]);
    // score 解析不到时不再静默兜底成 50，而是返回 undefined，让上层（scoreWithLlm）抛错走 fallback
    if (score === undefined) return {};
    return {
      score,
      matchLevel: coerceMatchLevel(String(obj.matchLevel ?? obj["技能匹配度"] ?? "中")),
      jobHoppingRisk: String(obj.jobHoppingRisk ?? obj["跳槽频繁度风险"] ?? "未知"),
      reason: String(obj.reason ?? obj["推荐理由"] ?? ""),
    };
  } catch {
    return {};
  }
}

export function createScorerTool(sdk: ToolSdk, deps: ToolDeps) {
  const Type = sdk.Type;
  return sdk.defineTool({
    name: "resume_scorer_tool",
    label: "智能评分",
    description:
      "以岗位 JD 为基准，对简历做多维度匹配评分。先做硬规则预过滤，通过后调用 LLM 输出 JSON：总分(0-100)、技能匹配度(高/中/低)、跳槽频繁度风险、推荐理由。",
    parameters: sdk.Type.Object({
      resumeText: Type.String({ description: "resume_parser_tool 解析出的简历文本（或简历全文）" }),
      jd: Type.String({ description: "岗位 JD / 招聘要求" }),
    }),
    async execute(_toolCallId, params) {
      const resumeText = params.resumeText?.trim();
      const jd = params.jd?.trim();

      if (!resumeText || !jd) {
        return toolResult("请同时提供 resumeText 与 jd 两个参数。");
      }

      // 1) 硬规则预过滤（省 LLM 成本）
      const rule = hardRuleFilter(resumeText, jd);
      if (!rule.passed) {
        deps.notify(
          "score",
          `硬规则预过滤淘汰：${rule.reason}`,
          "default",
          { eliminated: true },
        );
        const eliminated: ScoreResult = {
          score: 30,
          matchLevel: "低",
          jobHoppingRisk: "未评估",
          reason: rule.reason,
          eliminated: true,
        };
        return toolResult(
          `评分结果（硬规则淘汰，未调用 LLM）：\n${formatScore(eliminated)}\n\n该候选人不符合基础条件，无需入库。`,
          eliminated,
        );
      }

      // 2) 调用 LLM 深度评分
      deps.notify("score", "硬规则通过，正在调用 LLM 进行深度评分…", "active");
      let result: ScoreResult;
      let usedFallback = false;
      try {
        result = await deps.scoreWithLlm(resumeText, jd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        usedFallback = true;
        deps.notify(
          "error",
          `LLM 评分失败，已回退为规则评分。失败原因：${message.slice(0, 120)}`,
          "error",
        );
        result = fallbackScore(resumeText, jd);
      }

      // 标记 fallback 评分（让前端能区分"真评分"与"规则兜底"）
      if (usedFallback) {
        result = { ...result, reason: `[规则回退] ${result.reason}` };
      }

      const verdict = result.score > 60 ? "建议入库" : "不建议入库";
      deps.notify(
        "score",
        `评分完成：${result.score} 分（${result.matchLevel}匹配）— ${verdict}。`,
        result.score > 60 ? "success" : "default",
        { score: result.score },
      );

      return toolResult(
        `评分结果：\n${formatScore(result)}\n\n${result.score > 60 ? "评分 >60，请用 database_tool(action=upsert) 入库。" : "评分 ≤60，不满足入库门槛。"}`,
        result,
      );
    },
  });
}

function formatScore(r: ScoreResult): string {
  return [
    `总分：${r.score}/100`,
    `技能匹配度：${r.matchLevel}`,
    `跳槽频繁度风险：${r.jobHoppingRisk}`,
    `推荐理由：${r.reason}`,
  ].join("\n");
}

/**
 * LLM 不可用时的回退规则评分 —— 多特征加权：
 *   - 关键词命中率（权重 50）：JD 关键词在简历中的命中比例
 *   - 年限匹配度（权重 25）：简历年限 vs JD 要求年限
 *   - 简历完整度（权重 15）：简历长度反映信息量
 *   - 技能密度（权重 10）：技能关键词在简历中出现频次
 * 最终分数区间约 35-90，避免所有候选人都卡在 50 分附近，让用户能看出区分度。
 */
function fallbackScore(resumeText: string, jd: string): ScoreResult {
  const resumeLower = resumeText.toLowerCase();
  const jdLower = jd.toLowerCase();

  // 1) 关键词命中率（去除常见停用词）
  const stopWords = new Set([
    "的", "了", "和", "是", "在", "有", "与", "或", "等", "以上", "以下",
    "需要", "要求", "优先", "具备", "熟悉", "熟练", "掌握", "了解",
  ]);
  const jdTokens = Array.from(
    new Set(
      jd
        .split(/[，,。.、\s/()（）\[\]]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2 && !stopWords.has(t.toLowerCase())),
    ),
  );
  const hitCount = jdTokens.filter((t) =>
    resumeLower.includes(t.toLowerCase()),
  ).length;
  const keywordRatio = jdTokens.length ? hitCount / jdTokens.length : 0.5;
  const keywordScore = keywordRatio * 50; // 0-50

  // 2) 年限匹配度
  const resumeYears = parseYears(resumeText);
  const jdYears = parseYears(jd);
  let yearScore: number;
  if (jdYears === null || resumeYears === null) {
    yearScore = 12.5; // 未知时给中位分
  } else if (resumeYears >= jdYears) {
    // 满足或超出年限要求
    yearScore = 25;
  } else if (resumeYears >= jdYears - 1) {
    // 差 1 年，可接受
    yearScore = 20;
  } else {
    // 差距较大
    yearScore = Math.max(0, 25 - (jdYears - resumeYears) * 5);
  }

  // 3) 简历完整度（按字数分段）
  const len = resumeText.length;
  let lenScore: number;
  if (len >= 800) lenScore = 15;
  else if (len >= 400) lenScore = 12;
  else if (len >= 200) lenScore = 8;
  else if (len >= 80) lenScore = 5;
  else lenScore = 2;

  // 4) 技能密度（统计技能关键词在简历中出现的次数）
  const skillKeywords = ["vue", "react", "typescript", "javascript", "node", "webpack",
    "java", "python", "go", "rust", "mysql", "redis", "docker", "k8s",
    "前端", "后端", "全栈", "架构", "工程", "项目"];
  const skillHits = skillKeywords.filter((k) => resumeLower.includes(k)).length;
  const skillScore = Math.min(10, skillHits * 2);

  const raw = 35 + keywordScore + yearScore + lenScore + skillScore;
  const score = Math.max(35, Math.min(90, Math.round(raw)));

  return {
    score,
    matchLevel: score >= 75 ? "高" : score >= 55 ? "中" : "低",
    jobHoppingRisk: "未知（LLM 不可用，未评估）",
    reason: `规则回退评分：关键词命中率 ${(keywordRatio * 100).toFixed(0)}%（${hitCount}/${jdTokens.length}），年限 ${resumeYears ?? "?"}/${jdYears ?? "?"}，简历 ${len} 字。`,
  };
}
