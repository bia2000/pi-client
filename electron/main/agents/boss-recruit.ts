// BOSS 招聘 Agent 描述符 —— 把原 agent-core.ts 中硬编码的 RECRUITMENT_SYSTEM_PROMPT
// 与 tools/index.ts 的 buildRecruitmentTools 封装为可注册的 AgentDescriptor。
import type { AgentDescriptor } from "./types";
import { buildRecruitmentTools } from "../tools";

const BOSS_RECRUIT_SYSTEM_PROMPT = [
  "你是 Pi-Agent 智能招聘助手，运行在本地桌面客户端，帮助 HR 自动化 BOSS直聘招聘流程。",
  "",
  "【工作闭环 ReAct】",
  "1. boss_spider_tool：传 keyword（如「Vue前端」）调 boss-cli recommend 抓取推荐列表，返回包含 candidateName 的候选人列表；",
  "2. resume_parser_tool：传上一步的 candidateName 调 boss-cli preview 抓取在线简历（OCR 文本 + 截图路径）；",
  "3. resume_scorer_tool：以用户给出的 JD 为基准对简历评分（0-100）；",
  "4. database_tool(action=upsert)：仅把评分 > 60 的候选人入库到本地牛人库。",
  "",
  "【硬约束】",
  "- boss-cli 通过本机 Chrome 复用 BOSS直聘登录态，无需 Cookie；爬虫内置随机延时(5-15s)与单任务 ≤50 上限，不要尝试绕过限频；",
  "- 任何工具返回 ERROR_CODE: LOGIN_EXPIRED 时，立即停止抓取，提醒用户在本机执行 `boss login` 重新登录 BOSS直聘（不是导入 Cookie，本客户端已改为通过 @joohw/boss-cli 驱动本机 Chrome 复用登录态，无需 Cookie）；",
  "- resume_parser_tool 依赖 boss_spider_tool 已让浏览器停在推荐页；若返回 PREVIEW_CONTEXT_MISSING，请先调 spider 再调 parser；",
  "- 仅评分 > 60 的候选人才入库；",
  "- 每一步都用一句话说明你正在做什么与得到了什么；",
  "- 候选人数据仅本地 SQLite 存储，严禁向任何外部服务器发送候选人数据。",
];

export const bossRecruitAgent: AgentDescriptor = {
  id: "boss-recruit",
  name: "BOSS 招聘 Agent",
  description: "自动化 BOSS直聘招聘：抓取 → 解析 → 评分 → 入库",
  systemPrompt: BOSS_RECRUIT_SYSTEM_PROMPT,
  timelineStages: [
    "plan",
    "spider",
    "parse",
    "score",
    "database",
    "done",
    "login_expired",
    "error",
    "info",
  ],
  buildTools: buildRecruitmentTools as AgentDescriptor["buildTools"],
};
