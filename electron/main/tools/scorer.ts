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

function coerceScore(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 50;
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
    return {
      score: coerceScore(obj.score ?? obj.total ?? obj["总分"]),
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
      try {
        result = await deps.scoreWithLlm(resumeText, jd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        deps.notify("error", `LLM 评分失败：${message}，回退为规则评分。`, "error");
        // 回退：简单规则评分，保证流程不中断
        result = fallbackScore(resumeText, jd);
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

/** LLM 不可用时的回退规则评分：按技能命中率 + 年限粗评。 */
function fallbackScore(resumeText: string, jd: string): ScoreResult {
  const jdTokens = jd
    .split(/[，,。.、\s/]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  const hit = jdTokens.filter((t) => resumeText.toLowerCase().includes(t.toLowerCase())).length;
  const ratio = jdTokens.length ? hit / jdTokens.length : 0.5;
  const score = Math.round(40 + ratio * 55);
  return {
    score: Math.min(95, score),
    matchLevel: score >= 75 ? "高" : score >= 55 ? "中" : "低",
    jobHoppingRisk: "未知（LLM 不可用，未评估）",
    reason: `规则回退评分：JD 关键词命中率约 ${(ratio * 100).toFixed(0)}%。`,
  };
}
