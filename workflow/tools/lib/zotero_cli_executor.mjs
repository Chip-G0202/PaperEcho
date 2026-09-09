/**
 * Zotero CLI Executor
 *
 * 封装 CLI 命令执行，支持：
 * - zotero-cli-cc (zot)
 * - cli-anything-zotero (zotero-cli)
 *
 * 提供统一的命令执行、输出解析和错误处理。
 */

import { spawn, spawnSync } from "node:child_process";
import { zoteroLookupSignal } from "./zotero_lookup_scope.mjs";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_WEB_CLI_TOOL = "zot"; // zotero-cli-cc
const DEFAULT_DESKTOP_CLI_TOOL = "zotero-cli"; // cli-anything-zotero
const WINDOWS_CMD_SHIM_RE = /\.(cmd|bat)$/i;

function quoteCmdArgument(value) {
  const raw = String(value ?? "");
  if (!raw) return "\"\"";
  if (!/[\s"&()<>^|]/.test(raw)) return raw;
  return `"${raw.replace(/(["^&|<>])/g, "^$1")}"`;
}

export function resolveCliSpawnSpec(command, args = [], {
  platform = process.platform,
  comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe",
} = {}) {
  const normalizedArgs = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
  const normalizedCommand = String(command || "");
  if (platform === "win32" && WINDOWS_CMD_SHIM_RE.test(normalizedCommand)) {
    const commandLine = [normalizedCommand, ...normalizedArgs].map(quoteCmdArgument).join(" ");
    return {
      command: comspec,
      args: ["/d", "/s", "/c", commandLine],
      windowsVerbatimArguments: false,
    };
  }
  return {
    command: normalizedCommand,
    args: normalizedArgs,
    windowsVerbatimArguments: false,
  };
}

function terminateChildProcessTree(child, { platform = process.platform } = {}) {
  if (!child?.pid) return;
  if (platform === "win32") {
    try {
      spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { encoding: "utf8" });
      return;
    } catch {
      // Fall through to direct kill.
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {}
}

/**
 * 执行 CLI 命令
 *
 * @param {string} command - CLI 命令名 (如 "zot", "zotero-cli")
 * @param {string[]} args - 命令参数
 * @param {Object} options
 * @param {number} options.timeoutMs - 超时时间
 * @param {Object} options.env - 额外环境变量
 * @param {boolean} options.json - 是否期望 JSON 输出
 * @param {string} options.stdin - 通过 stdin 传入的数据
 * @returns {Promise<{exitCode: number, stdout: string, stderr: string, data: any}>}
 */
export async function executeCli(command, args, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = {},
    json = true,
    stdin = null,
    signal = zoteroLookupSignal(),
  } = options;
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const spawnSpec = resolveCliSpawnSpec(command, args);
    const child = spawn(spawnSpec.command, spawnSpec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", ...env },
      timeout: timeoutMs,
    });

    let stdout = "";
    let stderr = "";
    const onAbort = () => {
      terminateChildProcessTree(child);
      reject(signal.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (data) => {
      stdout += Buffer.isBuffer(data) ? data.toString("utf8") : data;
    });

    child.stderr.on("data", (data) => {
      stderr += Buffer.isBuffer(data) ? data.toString("utf8") : data;
    });

    // 写入 stdin 数据
    if (stdin != null) {
      child.stdin.write(stdin);
      child.stdin.end();
    }

    const timer = setTimeout(() => {
      terminateChildProcessTree(child);
      reject(new Error(`CLI command timed out after ${timeoutMs}ms: ${command} ${args.join(" ")}`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const result = {
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        data: null,
      };

      if (json && code === 0 && result.stdout) {
        try {
          result.data = JSON.parse(result.stdout);
        } catch {
          // 非 JSON 输出，保持 data 为 null
        }
      }

      resolve(result);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error(`CLI command failed: ${command} ${args.join(" ")} - ${error.message}`));
    });
  });
}

/**
 * 检查 CLI 工具是否可用
 *
 * @param {string} command - CLI 命令名
 * @returns {Promise<boolean>}
 */
export async function checkCliAvailable(command = DEFAULT_DESKTOP_CLI_TOOL) {
  try {
    const result = await executeCli(command, ["--help"], { json: false, timeoutMs: 5000 });
    return result.exitCode === 0 || Boolean(result.stdout || result.stderr);
  } catch {
    return false;
  }
}

/**
 * 获取默认 CLI 工具名
 *
 * @param {Object} env
 * @returns {string}
 */
export function getDefaultCliTool(mode = "desktop", env = process.env) {
  if (typeof mode === "object" && mode !== null) {
    env = mode;
    mode = "desktop";
  }
  const normalized = String(mode || "desktop").toLowerCase();
  if (normalized === "web" || normalized === "web_api" || normalized === "zotero_cli_cc") {
    return env.ZOTERO_WEB_CLI_TOOL || env.ZOTERO_CLI_TOOL || DEFAULT_WEB_CLI_TOOL;
  }
  return env.ZOTERO_DESKTOP_CLI_TOOL || env.ZOTERO_CLI_TOOL || DEFAULT_DESKTOP_CLI_TOOL;
}

export default {
  executeCli,
  checkCliAvailable,
  getDefaultCliTool,
  resolveCliSpawnSpec,
};
