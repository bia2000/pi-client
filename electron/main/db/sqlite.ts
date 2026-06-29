// 本地 SQLite 牛人库 —— 使用 better-sqlite3。
// 隐私合规：候选人数据【仅本地存储】，本模块严禁包含任何对外网络发送逻辑。
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type {
  Candidate,
  CandidateFilter,
  CandidateStats,
  CandidateStatus,
  ScoreResult,
} from "../../shared";

type CandidateRow = {
  id: string;
  candidate_id: string | null;
  name: string;
  title: string | null;
  city: string | null;
  expect_salary: string | null;
  skills: string; // JSON
  work_years: string | null;
  score: number;
  match_level: string;
  job_hopping_risk: string;
  reason: string;
  status: string;
  jd: string | null;
  resume_json: string | null;
  source_url: string | null;
  created_at: number;
  updated_at: number;
};

let db: DatabaseType | null = null;

export function initDb(dbPath: string): DatabaseType {
  if (db) return db;
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS candidates (
      id              TEXT PRIMARY KEY,
      candidate_id    TEXT,
      name            TEXT NOT NULL,
      title           TEXT,
      city            TEXT,
      expect_salary   TEXT,
      skills          TEXT NOT NULL DEFAULT '[]',
      work_years      TEXT,
      score           INTEGER NOT NULL DEFAULT 0,
      match_level     TEXT NOT NULL DEFAULT '中',
      job_hopping_risk TEXT NOT NULL DEFAULT '',
      reason          TEXT NOT NULL DEFAULT '',
      status          TEXT NOT NULL DEFAULT '待沟通',
      jd              TEXT,
      resume_json     TEXT,
      source_url      TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_candidates_score ON candidates(score DESC);
    CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
  `);
  return db;
}

/** 显式关闭（应用退出时调用）。 */
export function closeDb() {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  db = null;
}

function getDb(): DatabaseType {
  if (!db) throw new Error("SQLite 未初始化");
  return db;
}

export function isDbReady(): boolean {
  return db !== null;
}

function rowToCandidate(row: CandidateRow): Candidate {
  let skills: string[] = [];
  try {
    skills = JSON.parse(row.skills);
  } catch {
    skills = [];
  }
  return {
    id: row.id,
    candidateId: row.candidate_id ?? undefined,
    name: row.name,
    title: row.title ?? undefined,
    city: row.city ?? undefined,
    expectSalary: row.expect_salary ?? undefined,
    skills,
    workYears: row.work_years ?? undefined,
    score: row.score,
    matchLevel: row.match_level as Candidate["matchLevel"],
    jobHoppingRisk: row.job_hopping_risk,
    reason: row.reason,
    status: row.status as CandidateStatus,
    jd: row.jd ?? undefined,
    resumeJson: row.resume_json ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpsertInput {
  candidateId?: string;
  name: string;
  title?: string;
  city?: string;
  expectSalary?: string;
  skills?: string[];
  workYears?: string;
  score: ScoreResult["score"];
  matchLevel?: ScoreResult["matchLevel"];
  jobHoppingRisk?: string;
  reason?: string;
  status?: CandidateStatus;
  jd?: string;
  resumeJson?: string;
  sourceUrl?: string;
}

/** 按 candidate_id 去重 upsert；仅当评分 > 60 才入库（调用方负责，这里也会兜底拒绝）。 */
export function upsertCandidate(input: UpsertInput): Candidate {
  const database = getDb();
  if (input.score <= 60) {
    throw new Error(`评分 ${input.score} 不大于 60，不入库`);
  }
  const now = Date.now();
  const id = randomUUID();
  const skills = JSON.stringify(input.skills ?? []);
  const matchLevel = input.matchLevel ?? "中";

  if (input.candidateId) {
    const existing = database
      .prepare("SELECT * FROM candidates WHERE candidate_id = ?")
      .get(input.candidateId) as CandidateRow | undefined;
    if (existing) {
      database
        .prepare(
          `UPDATE candidates SET name=@name, title=@title, city=@city, expect_salary=@expectSalary,
            skills=@skills, work_years=@workYears, score=@score, match_level=@matchLevel,
            job_hopping_risk=@jobHoppingRisk, reason=@reason, jd=@jd, resume_json=@resumeJson,
            source_url=@sourceUrl, updated_at=@now WHERE id=@id`,
        )
        .run({
          id: existing.id,
          name: input.name,
          title: input.title ?? null,
          city: input.city ?? null,
          expectSalary: input.expectSalary ?? null,
          skills,
          workYears: input.workYears ?? null,
          score: input.score,
          matchLevel,
          jobHoppingRisk: input.jobHoppingRisk ?? "",
          reason: input.reason ?? "",
          jd: input.jd ?? null,
          resumeJson: input.resumeJson ?? null,
          sourceUrl: input.sourceUrl ?? null,
          now,
        });
      const updated = database
        .prepare("SELECT * FROM candidates WHERE id = ?")
        .get(existing.id) as CandidateRow;
      return rowToCandidate(updated);
    }
  }

  database
    .prepare(
      `INSERT INTO candidates (id, candidate_id, name, title, city, expect_salary, skills, work_years,
        score, match_level, job_hopping_risk, reason, status, jd, resume_json, source_url, created_at, updated_at)
      VALUES (@id, @candidateId, @name, @title, @city, @expectSalary, @skills, @workYears,
        @score, @matchLevel, @jobHoppingRisk, @reason, @status, @jd, @resumeJson, @sourceUrl, @now, @now)`,
    )
    .run({
      id,
      candidateId: input.candidateId ?? null,
      name: input.name,
      title: input.title ?? null,
      city: input.city ?? null,
      expectSalary: input.expectSalary ?? null,
      skills,
      workYears: input.workYears ?? null,
      score: input.score,
      matchLevel,
      jobHoppingRisk: input.jobHoppingRisk ?? "",
      reason: input.reason ?? "",
      status: input.status ?? "待沟通",
      jd: input.jd ?? null,
      resumeJson: input.resumeJson ?? null,
      sourceUrl: input.sourceUrl ?? null,
      now,
    });

  const row = database.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as CandidateRow;
  return rowToCandidate(row);
}

export function listCandidates(filter: CandidateFilter = {}): Candidate[] {
  const database = getDb();
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.keyword) {
    where.push("(name LIKE @kw OR title LIKE @kw OR skills LIKE @kw)");
    params.kw = `%${filter.keyword}%`;
  }
  if (filter.status) {
    where.push("status = @status");
    params.status = filter.status;
  }
  if (typeof filter.minScore === "number") {
    where.push("score >= @minScore");
    params.minScore = filter.minScore;
  }

  const sql = `SELECT * FROM candidates ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY score DESC, updated_at DESC ${filter.limit ? "LIMIT @limit" : ""}`;
  if (filter.limit) params.limit = filter.limit;

  const rows = database.prepare(sql).all(params) as CandidateRow[];
  return rows.map(rowToCandidate);
}

export function getCandidate(id: string): Candidate | null {
  const database = getDb();
  const row = database.prepare("SELECT * FROM candidates WHERE id = ?").get(id) as
    | CandidateRow
    | undefined;
  return row ? rowToCandidate(row) : null;
}

export function updateStatus(id: string, status: CandidateStatus): void {
  const database = getDb();
  database
    .prepare("UPDATE candidates SET status = ?, updated_at = ? WHERE id = ?")
    .run(status, Date.now(), id);
}

export function deleteCandidate(id: string): void {
  const database = getDb();
  database.prepare("DELETE FROM candidates WHERE id = ?").run(id);
}

export function stats(): CandidateStats {
  const database = getDb();
  const rows = database
    .prepare("SELECT status, COUNT(*) AS n FROM candidates GROUP BY status")
    .all() as Array<{ status: string; n: number }>;
  const total = database.prepare("SELECT COUNT(*) AS n FROM candidates").get() as { n: number };
  const result: CandidateStats = {
    total: total.n,
    待沟通: 0,
    已沟通: 0,
    已发offer: 0,
    已淘汰: 0,
  };
  for (const row of rows) {
    if (row.status in result) {
      (result as Record<string, number>)[row.status] = row.n;
    }
  }
  return result;
}
