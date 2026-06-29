// boss-cli 子进程调用封装 —— 对应文档 §3.1 主线 A 的 BossZhipinCrawler._run_cli。
// 通过 spawn('node', [cliPath, ...args]) 调用 @joohw/boss-cli 的 CLI 入口，
// 复用本机 Chrome 登录态，避免 axios 直调接口被风控。
//
// 失败直接抛 BossCliError（含 stdout/stderr 上下文），不做静默兜底——
// 这与 boss-cli 自身的 AGENTS.md 协作规则一致：失败应直接暴露，便于定位根因。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

export interface BossCliRunOptions {
  args: string[];
  /** 单次调用超时（ms），默认 120s（与文档 §7.1 单次简历超时一致） */
  timeout?: number;
  /** 是否无头模式运行 Chrome；默认 false（有头，规避自动化检测） */
  headless?: boolean;
  /** 是否启用 boss-cli 自带 OCR；默认 true（boss-cli 自身默认）。
   *  关闭时只返回截图路径，不调用百度 OCR —— 与文档方案 A 一致。 */
  ocrEnabled?: boolean;
  /** 子进程工作目录 */
  cwd?: string;
}

export interface BossCliRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class BossCliError extends Error {
  constructor(
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null,
    message: string,
  ) {
    super(message);
    this.name = "BossCliError";
  }
}

/** 解析 boss-cli cli.js 入口路径。优先级：自定义路径 > 包内 dist/cli/index.js。 */
export function resolveBossCliPath(customPath?: string): string {
  if (customPath && customPath.trim()) {
    const p = path.resolve(customPath.trim());
    if (!existsSync(p)) {
      throw new Error(`配置的 boss-cli 路径不存在：${p}`);
    }
    return p;
  }
  try {
    return require.resolve("@joohw/boss-cli/dist/cli/index.js");
  } catch {
    throw new Error(
      "未找到 @joohw/boss-cli。请在【设置】页配置 boss-cli 路径，或在项目内 `pnpm add @joohw/boss-cli`。",
    );
  }
}

/** 子进程调用 boss-cli。失败抛 BossCliError（含 stdout/stderr 上下文）。 */
export function runBossCli(
  cliPath: string,
  options: BossCliRunOptions,
): Promise<BossCliRunResult> {
  const args = options.args;
  const timeout = options.timeout ?? 120_000;
  const env = { ...process.env };
  env.BOSS_BROWSER_HEADLESS = options.headless ? "true" : "false";
  if (options.ocrEnabled === false) {
    env.BOSS_RESUME_OCR = "0";
  }

  return new Promise((resolve, reject) => {
    const child = spawn("node", [cliPath, ...args], {
      env,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new BossCliError(stdout, stderr, null, `boss-cli 子进程启动失败：${err.message}`),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(
          new BossCliError(stdout, stderr, code, `boss-cli 执行超时（>${timeout}ms）`),
        );
        return;
      }
      if (code !== 0) {
        const lastErrLine = stderr.split(/\r?\n/).filter(Boolean).pop() ?? "";
        reject(
          new BossCliError(
            stdout,
            stderr,
            code,
            lastErrLine || `boss-cli 退出码 ${code}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}
