// database_tool —— 操作本地 SQLite 牛人库。
// 规则：评分 > 60 才允许 upsert 入库。支持 query / get / update_status / stats。
import {
  getCandidate,
  listCandidates,
  stats,
  updateStatus,
  upsertCandidate,
} from "../db/sqlite";
import type { Candidate, CandidateStatus } from "../../shared";
import { toolResult, type ToolDeps, type ToolSdk } from "./index";

const VALID_ACTIONS = ["upsert", "query", "get", "update_status", "stats"] as const;
const VALID_STATUSES: CandidateStatus[] = ["待沟通", "已沟通", "已发offer", "已淘汰"];

export function createDatabaseTool(sdk: ToolSdk, _deps: ToolDeps) {
  const Type = sdk.Type;
  return sdk.defineTool({
    name: "database_tool",
    label: "牛人库",
    description:
      "操作本地牛人库(SQLite)。action 可选：upsert(仅评分>60入库)、query(按 keyword/status/minScore 查询)、get(取详情)、update_status(改状态)、stats(统计)。状态枚举：待沟通/已沟通/已发offer/已淘汰。",
    parameters: sdk.Type.Object({
      action: Type.String({
        description: "动作：upsert | query | get | update_status | stats",
      }),
      candidate: Type.Optional(
        Type.Any({ description: "upsert 时的候选人对象，含 name/score/matchLevel/skills 等（score 必须 >60）" }),
      ),
      id: Type.Optional(Type.String({ description: "get / update_status 时的记录 id" })),
      status: Type.Optional(
        Type.String({ description: "update_status 时的目标状态：待沟通/已沟通/已发offer/已淘汰" }),
      ),
      keyword: Type.Optional(Type.String({ description: "query 时的关键词" })),
      minScore: Type.Optional(Type.Number({ description: "query 时的最低评分" })),
    }),
    async execute(_toolCallId, params) {
      const action = String(params.action ?? "").trim() as (typeof VALID_ACTIONS)[number];

      if (!VALID_ACTIONS.includes(action)) {
        return toolResult(`未知 action：${action}。支持：${VALID_ACTIONS.join(" / ")}。`);
      }

      try {
        if (action === "stats") {
          const s = stats();
          _deps.notify("database", `牛人库统计：共 ${s.total} 人。`, "success", s);
          return toolResult(`牛人库统计：\n${JSON.stringify(s, null, 2)}`, s);
        }

        if (action === "query") {
          const list = listCandidates({
            keyword: params.keyword,
            minScore: typeof params.minScore === "number" ? params.minScore : undefined,
            limit: 50,
          });
          _deps.notify("database", `查询到 ${list.length} 名候选人。`, "success", { count: list.length });
          return toolResult(
            `查询到 ${list.length} 名候选人（按评分倒序）：\n${summarize(list)}`,
            { count: list.length },
          );
        }

        if (action === "get") {
          if (!params.id) {
            return toolResult("get 需要 id 参数。");
          }
          const c = getCandidate(params.id);
          return toolResult(c ? JSON.stringify(c, null, 2) : `未找到 id=${params.id}`, { candidate: c });
        }

        if (action === "update_status") {
          if (!params.id || !params.status) {
            return toolResult("update_status 需要 id 与 status 参数。");
          }
          if (!VALID_STATUSES.includes(params.status as CandidateStatus)) {
            return toolResult(`非法 status：${params.status}。枚举：${VALID_STATUSES.join(" / ")}`);
          }
          updateStatus(params.id, params.status as CandidateStatus);
          _deps.notify("database", `已将候选人 ${params.id} 状态更新为 ${params.status}。`, "success");
          return toolResult(`已更新：${params.id} -> ${params.status}`);
        }

        // upsert
        const candidate = params.candidate as Record<string, unknown> | undefined;
        if (!candidate || typeof candidate !== "object") {
          return toolResult("upsert 需要 candidate 对象参数。");
        }
        const name = String(candidate.name ?? "匿名牛人");
        const score = Number(candidate.score ?? 0);
        if (!Number.isFinite(score) || score <= 60) {
          _deps.notify("database", `评分 ${score} ≤ 60，未达到入库门槛，跳过。`, "default", { skipped: true });
          return toolResult(`评分 ${score} 不大于 60，不满足入库门槛，已跳过。（仅 >60 分入库）`, { skipped: true });
        }

        const saved = upsertCandidate({
          candidateId: candidate.candidateId ? String(candidate.candidateId) : undefined,
          name,
          title: candidate.title ? String(candidate.title) : undefined,
          city: candidate.city ? String(candidate.city) : undefined,
          expectSalary: candidate.expectSalary ? String(candidate.expectSalary) : undefined,
          skills: Array.isArray(candidate.skills) ? (candidate.skills as string[]) : [],
          workYears: candidate.workYears ? String(candidate.workYears) : undefined,
          score,
          matchLevel: (candidate.matchLevel as Candidate["matchLevel"]) ?? "中",
          jobHoppingRisk: candidate.jobHoppingRisk ? String(candidate.jobHoppingRisk) : "",
          reason: candidate.reason ? String(candidate.reason) : "",
          jd: candidate.jd ? String(candidate.jd) : undefined,
          resumeJson: candidate.resumeJson ? String(candidate.resumeJson) : undefined,
          sourceUrl: candidate.sourceUrl ? String(candidate.sourceUrl) : undefined,
        });
        _deps.notify("database", `已入库：${saved.name}（${saved.score} 分）。`, "success", { id: saved.id });
        return toolResult(`已入库：${saved.name}（${saved.score}分 / ${saved.matchLevel}匹配，id=${saved.id}）。`, { id: saved.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        _deps.notify("error", `数据库操作失败：${message}`, "error");
        return toolResult(`数据库操作失败：${message}`);
      }
    },
  });
}

function summarize(list: Candidate[]): string {
  if (list.length === 0) return "(空)";
  return list
    .map(
      (c, i) =>
        `${i + 1}. ${c.name} | ${c.title ?? "?"} | ${c.score}分(${c.matchLevel}) | ${c.status} | id=${c.id}`,
    )
    .join("\n");
}
