// Chat 工具函数 —— token 估算 / Markdown 渲染 / 上下文状态 / 导出。
// 对应文档 §5.1 上下文管理与 §十一 上下文统计详情的纯前端实现。
import MarkdownIt from "markdown-it";
import hljs from "highlight.js";
import type { ChatMessage } from "../../electron/shared";

/** 上下文 token 上限（文档 §十一：256K） */
export const MAX_CONTEXT_TOKENS = 256_000;
export const WARNING_RATIO = 0.6;
export const DANGER_RATIO = 0.8;
export const OVERFLOW_RATIO = 1.0;

export type ContextStatus = "normal" | "warning" | "danger" | "overflow";

export interface ContextInfo {
  usedTokens: number;
  usedTokensK: string;
  maxTokens: number;
  percent: number;
  status: ContextStatus;
}

/** 估算单条消息的 token 占用（文档 §十一规则）：
 *  - 中文 / 1.5，英文 / 4
 *  - 每条消息固定 4 token 格式开销
 *  - 简化实现：不区分图片/文件附件（当前 IPC 未传附件），统一按文本估算
 */
function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5 + other / 4);
}

export function estimateMessageTokens(msg: ChatMessage): number {
  return estimateTextTokens(msg.content) + 4;
}

export function estimateSessionTokens(
  messages: ChatMessage[],
  systemPrompt = "",
): number {
  let total = estimateTextTokens(systemPrompt) + 4;
  for (const m of messages) {
    if (m.pending) continue; // 不计入流式中的占位
    total += estimateMessageTokens(m);
  }
  return total;
}

export function getContextInfo(
  messages: ChatMessage[],
  systemPrompt = "",
): ContextInfo {
  const used = estimateSessionTokens(messages, systemPrompt);
  const percent = (used / MAX_CONTEXT_TOKENS) * 100;
  let status: ContextStatus = "normal";
  if (percent >= OVERFLOW_RATIO * 100) status = "overflow";
  else if (percent >= DANGER_RATIO * 100) status = "danger";
  else if (percent >= WARNING_RATIO * 100) status = "warning";
  return {
    usedTokens: used,
    usedTokensK: `${(used / 1000).toFixed(1)}K`,
    maxTokens: MAX_CONTEXT_TOKENS,
    percent: Math.min(percent, 100),
    status,
  };
}

/** 转义 HTML 特殊字符（用于无语言代码块降级）。 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Markdown 渲染器：启用代码高亮 + 链接新窗口 + 任务列表。 */
const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: true,
  breaks: true,
  highlight: (str, lang): string => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const highlighted = hljs.highlight(str, { language: lang }).value;
        return `<pre class="code-block"><code class="hljs language-${lang}">${highlighted}</code></pre>`;
      } catch {
        // 失败时走默认转义
      }
    }
    return `<pre class="code-block"><code class="hljs">${escapeHtml(str)}</code></pre>`;
  },
});

// 所有链接新窗口打开 + 加 rel="noopener noreferrer"
const defaultLinkOpen = md.renderer.rules.link_open;
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const aIndex = tokens[idx].attrIndex("target");
  if (aIndex < 0) tokens[idx].attrPush(["target", "_blank"]);
  else tokens[idx].attrs![aIndex][1] = "_blank";
  const relIndex = tokens[idx].attrIndex("rel");
  if (relIndex < 0) tokens[idx].attrPush(["rel", "noopener noreferrer"]);
  else tokens[idx].attrs![relIndex][1] = "noopener noreferrer";
  return defaultLinkOpen
    ? defaultLinkOpen(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

export function renderMarkdown(text: string): string {
  if (!text) return "";
  return md.render(text);
}

/** 导出会话为 Markdown 文件。 */
export function exportMessagesAsMarkdown(
  messages: ChatMessage[],
  sessionTitle: string,
): string {
  const lines: string[] = [`# ${sessionTitle}`, ""];
  for (const m of messages) {
    if (m.id === "welcome") continue;
    const role = m.role === "user" ? "🧑 用户" : "🤖 招聘 Agent";
    const time = new Date(m.createdAt).toLocaleString("zh-CN");
    lines.push(`## ${role}`, `> ${time}`, "", m.content || "(空)", "");
  }
  return lines.join("\n");
}

/** 触发浏览器下载文本文件。 */
export function downloadText(filename: string, content: string, mime = "text/markdown"): void {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 复制文本到剪贴板（带 navigator.clipboard 降级）。 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 走降级
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** 从消息内容生成会话标题（取首句、限长）。 */
export function deriveSessionTitle(content: string): string {
  const text = content.trim();
  if (!text) return "新会话";
  const firstLine = text.split(/\r?\n/)[0];
  if (firstLine.length <= 30) return firstLine;
  return firstLine.slice(0, 30) + "…";
}
