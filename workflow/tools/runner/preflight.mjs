import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { emailTransportConfig } from "../stage5/email_sender.mjs";
import { resolveStage5Request } from "../stage5/main.mjs";
import { resolveLlmRuntime } from "../lib/llm_json_support.mjs";
import { buildRuntimeConfig } from "../lib/runtime_config.mjs";
import { RUNNER_SCHEMA_VERSION } from "./constants.mjs";
import { canonicalQueryHash } from "../stage1/source_state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY_BY_MODE = Object.freeze({
  desktop: path.join(REPO_ROOT, "workflow", "tools", "stage0", "main.mjs"),
  web: path.join(REPO_ROOT, "workflow", "tools", "stage0", "main.mjs"),
  local: path.join(REPO_ROOT, "workflow", "tools", "local", "main.mjs"),
});
const LAUNCHER_BY_MODE = Object.freeze({
  desktop: "skills/paperecho-zotero-desktop/scripts/run.mjs",
  web: "skills/paperecho-zotero-web/scripts/run.mjs",
  local: "skills/paperecho-local/scripts/run.mjs",
});

function safePath(value, base = REPO_ROOT) {
  const relative = path.relative(base, path.resolve(value));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : `<external>/${path.basename(value)}`;
}

function missing(name, purpose, configure, category = "configuration") {
  return { name, purpose, configure, blocking: true, category };
}

function optional(name, purpose, configure) {
  return { name, purpose, configure, blocking: false };
}

function executableCandidates(command, env, platform) {
  if (!command) return [];
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return [command];
  const extensions = platform === "win32"
    ? String(env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return String(env.PATH || "").split(path.delimiter).filter(Boolean)
    .flatMap((directory) => extensions.map((extension) => path.join(directory, platform === "win32" ? `${command}${extension}` : command)));
}

export function findExecutable(command, { env = process.env, platform = process.platform, existsSync = fs.existsSync } = {}) {
  return executableCandidates(command, env, platform).find((candidate) => existsSync(candidate)) || "";
}

function desktopApplication(env, platform, existsSync) {
  const explicit = String(env.ZOTERO_EXE || "").trim();
  if (explicit) return existsSync(explicit) ? explicit : "";
  if (platform === "win32") {
    return [
      env.ProgramFiles && path.join(env.ProgramFiles, "Zotero", "zotero.exe"),
      env["ProgramFiles(x86)"] && path.join(env["ProgramFiles(x86)"], "Zotero", "zotero.exe"),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs", "Zotero", "zotero.exe"),
      "D:/Zotero/zotero.exe",
      "C:/Zotero/zotero.exe",
    ].filter(Boolean).find((candidate) => existsSync(candidate)) || findExecutable("zotero.exe", { env, platform, existsSync });
  }
  return findExecutable(platform === "darwin" ? "open" : "zotero", { env, platform, existsSync });
}

async function nearestExisting(value, fsApi) {
  let current = path.resolve(value);
  while (true) {
    try { return { path: current, stat: await fsApi.stat(current) }; }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function unsafeOutputRoot(value, { repoRoot = REPO_ROOT, homeDir = os.homedir() } = {}) {
  const resolved = path.resolve(value || ".");
  return resolved === path.parse(resolved).root || resolved === path.resolve(repoRoot) || resolved === path.resolve(homeDir);
}

function retryCommand(options) {
  const parts = ["node", LAUNCHER_BY_MODE[options.mode], "--run", "--profile", options.profile];
  if (options.resume) parts.push("--resume", options.resume);
  if (options.configPath) parts.push("--config", safePath(options.configPath));
  if (options.mode === "local") {
    if (!options.resume) parts.push("--input", "<file>");
    parts.push("--output-root", "<path>");
  }
  if (!options.resume && options.email) parts.push("--email", "<recipient>");
  if (!options.resume && options.requireLlm) parts.push("--require-llm");
  if (!options.resume && options.forceResend) parts.push("--force-resend");
  return parts.join(" ");
}

export function buildExecutionPlan(options, { env = process.env, repoRoot = REPO_ROOT, entries = ENTRY_BY_MODE } = {}) {
  const entry = path.resolve(entries[options.mode]);
  const args = [];
  if (options.mode === "local") {
    if (!options.resume && options.input) args.push("--input", options.input);
    args.push("--output-root", options.outputRoot);
    if (!options.resume && options.feedback) args.push("--feedback", options.feedback);
  }
  if (!options.resume && options.llmMode) args.push("--llm-mode", options.llmMode);
  if (!options.resume && options.email) args.push("--email", options.email);
  if (!options.resume && options.forceResend) args.push("--force-resend");
  if (options.resume) args.push("--resume", options.resume);
  const childEnv = { ...env };
  if (options.mode === "desktop") {
    childEnv.ZOTERO_BACKEND = "cli";
    for (const name of ["ZOTERO_API_KEY", "ZOTERO_USER_ID", "ZOTERO_GROUP_ID", "ZOTERO_LIBRARY_TYPE", "ZOTERO_API_BASE"]) delete childEnv[name];
  } else if (options.mode === "web") {
    childEnv.ZOTERO_BACKEND = "web_api";
    delete childEnv.ZOTERO_EXE;
    delete childEnv.ZOTERO_GROUP_ID;
    delete childEnv.ZOTERO_LIBRARY_TYPE;
  } else {
    for (const name of ["ZOTERO_BACKEND", "ZOTERO_API_KEY", "ZOTERO_USER_ID", "ZOTERO_GROUP_ID", "ZOTERO_LIBRARY_TYPE", "ZOTERO_API_BASE", "ZOTERO_EXE"]) delete childEnv[name];
  }
  childEnv.PAPERECHO_CONFIG_HASH = options.recoveryConfigHash || canonicalQueryHash({ mode: options.mode, profile: options.profile });
  childEnv.PAPERECHO_INPUT_HASH = options.recoveryInputHash || canonicalQueryHash({ mode: options.mode, input: options.input || "", feedback: options.feedback || "" });
  childEnv.PAPERECHO_RUN_PROFILE = options.profile;
  childEnv.PAPERECHO_LAUNCHER_ID = `${options.mode}-fixed-launcher/runner`;
  const runId = options.resume || `${options.mode === "local" ? "local" : "zlf"}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  childEnv.PAPERECHO_RUN_ID = runId;
  const runtime = options.mode === "local" ? null : buildRuntimeConfig({ cwd: repoRoot, env, argv: [process.execPath, entry, ...args] });
  const runRoot = options.mode === "local" ? path.join(options.outputRoot, "runs") : path.join(runtime.reviewRoot, "runs");
  return { entry, args, childEnv, cwd: repoRoot, runRoot, runId, emailRequested: Boolean(resolveStage5Request(options.email ? ["--email", options.email] : [], env).recipient) };
}

export async function runPreflight(options, dependencies = {}) {
  const env = dependencies.env || process.env;
  const platform = dependencies.platform || process.platform;
  const repoRoot = dependencies.repoRoot || REPO_ROOT;
  const entries = dependencies.entries || ENTRY_BY_MODE;
  const fsApi = dependencies.fsApi || fsp;
  const existsSync = dependencies.existsSync || fs.existsSync;
  const findExecutableImpl = dependencies.findExecutableImpl || findExecutable;
  const requiredMissing = [];
  const featureMissing = [];
  const optionalMissing = [];
  const readiness = [];
  const warnings = [...(options.configWarnings || [])];
  const entry = path.resolve(entries[options.mode]);
  const radarProfile = options.profile === "radar";

  if (Number(process.versions.node.split(".")[0]) < 18) requiredMissing.push(missing("Node.js >= 18", "运行 PaperEcho", "安装受支持的 Node.js", "dependency"));
  if (!existsSync(entry)) requiredMissing.push(missing("production entry", "启动当前路径", `恢复 ${safePath(entry, repoRoot)}`, "dependency"));
  else readiness.push({ name: "production_entry", status: "ready" });

  if (options.mode === "desktop" && !radarProfile) {
    const app = dependencies.desktopApplicationImpl
      ? dependencies.desktopApplicationImpl(env, platform, existsSync)
      : desktopApplication(env, platform, existsSync);
    const cliName = env.ZOTERO_DESKTOP_CLI_TOOL || env.ZOTERO_CLI_TOOL || "zotero-cli";
    const cli = findExecutableImpl(cliName, { env, platform, existsSync });
    if (!app) requiredMissing.push({ ...missing("Zotero Desktop", "Desktop backend readiness", "设置 desktop.zoteroExe/ZOTERO_EXE 或安装 Zotero Desktop", "dependency"), section: "desktop" });
    if (!cli) requiredMissing.push({ ...missing("Zotero Desktop CLI bridge", "Desktop 读写桥接", "设置 desktop.cliTool/ZOTERO_DESKTOP_CLI_TOOL", "dependency"), section: "desktop" });
    readiness.push({ name: "zotero_desktop", status: app ? "ready" : "blocked" }, { name: "desktop_cli_bridge", status: cli ? "ready" : "blocked" });
  }

  if (options.mode === "web" && !radarProfile) {
    if (!String(env.ZOTERO_API_KEY || "").trim()) requiredMissing.push({ ...missing("ZOTERO_API_KEY", "认证并写入目标 Zotero 文库", "配置具有目标文库写权限的 API Key", "configuration"), section: "web" });
    if (!String(env.ZOTERO_USER_ID || "").trim()) requiredMissing.push({ ...missing("ZOTERO_USER_ID", "定位 Zotero 个人文库", "配置 web.userId", "configuration"), section: "web" });
    readiness.push({ name: "zotero_web_api", status: env.ZOTERO_API_KEY && env.ZOTERO_USER_ID ? "ready" : "blocked", connectivity: "not_probed", libraryType: "user" });
  }

  if (radarProfile && options.mode !== "local") {
    readiness.push({ name: "radar_no_writeback", status: "ready", zoteroRequired: false });
  }

  if (options.mode !== "local") {
    const outputBase = buildRuntimeConfig({ cwd: repoRoot, env, argv: [process.execPath, entry] }).reviewRoot;
    try {
      const existing = await nearestExisting(outputBase, fsApi);
      await fsApi.access(existing.path, fs.constants.W_OK);
      readiness.push({ name: "project_output_root", status: "ready", existingAncestor: safePath(existing.path, repoRoot) });
    } catch {
      requiredMissing.push(missing("writable project output root", "写入 pipeline、run-group 与周报", "检查 ZOTERO_PROJECT_ROOT 或仓库目录权限", "input"));
    }
  }

  if (options.mode === "local") {
    if (!options.input && !options.resume) requiredMissing.push({ ...missing("local.input", "读取 Local JSON/JSONL 文献", "设置 local.input 或 --input", "input"), section: "local" });
    if (!options.outputRoot) requiredMissing.push({ ...missing("local.outputRoot", "隔离 Local state/exports", "设置 local.outputRoot 或 --output-root", "input"), section: "local" });
    if (options.input && !options.resume) {
      try {
        const stat = await fsApi.stat(options.input);
        let supported = stat.isFile() && [".json", ".jsonl"].includes(path.extname(options.input).toLowerCase());
        if (stat.isDirectory()) {
          const names = await fsApi.readdir(options.input);
          supported = names.some((name) => [".json", ".jsonl"].includes(path.extname(name).toLowerCase()));
        }
        if (!supported) requiredMissing.push({ ...missing("supported Local input", "导入 JSON/JSONL", "使用 .json/.jsonl 文件或包含它们的目录", "input"), section: "local" });
        else {
          await fsApi.access(options.input, fs.constants.R_OK);
          readiness.push({ name: "local_input", status: "ready" });
        }
      } catch {
        requiredMissing.push({ ...missing("readable Local input", "导入本地文献", "检查 local.input/--input 路径和读取权限", "input"), section: "local" });
      }
    }
    if (options.feedback && !options.resume) {
      try {
        const stat = await fsApi.stat(options.feedback);
        if (!stat.isFile() || path.extname(options.feedback).toLowerCase() !== ".jsonl") throw new Error("unsupported");
        await fsApi.access(options.feedback, fs.constants.R_OK);
        readiness.push({ name: "local_feedback", status: "ready" });
      } catch {
        requiredMissing.push({ ...missing("readable Local feedback JSONL", "导入显式反馈事件", "检查 local.feedback/--feedback 文件及扩展名", "input"), section: "local" });
      }
    }
    if (options.outputRoot) {
      if (unsafeOutputRoot(options.outputRoot, { repoRoot, homeDir: dependencies.homeDir || os.homedir() })) {
        requiredMissing.push({ ...missing("safe Local output root", "避免状态写入根目录/仓库/用户目录", "选择专用 local.outputRoot", "input"), section: "local" });
      } else {
        try {
          const existing = await nearestExisting(options.outputRoot, fsApi);
          await fsApi.access(existing.path, fs.constants.W_OK);
          readiness.push({ name: "local_output_root", status: "ready", existingAncestor: safePath(existing.path, repoRoot) });
        } catch {
          requiredMissing.push({ ...missing("writable Local output root", "写入 Local state/exports", "检查 local.outputRoot/--output-root 父目录写权限", "input"), section: "local" });
        }
      }
    }
  }

  const stage5Request = resolveStage5Request(options.email ? ["--email", options.email] : [], env);
  const emailRequested = Boolean(stage5Request.recipient) && !options.resume;
  if (emailRequested) {
    const smtp = emailTransportConfig(env);
    if (smtp.configured) {
      readiness.push({ name: "smtp", status: "ready" });
    } else {
      const names = smtp.missing.length ? smtp.missing : ["SMTP configuration"];
      for (const name of names) requiredMissing.push({ ...missing(name, "发送明确请求的 Stage5 邮件", "在 common.email.smtp 或本地环境中配置", "configuration"), section: "common" });
    }
  } else optionalMissing.push(optional("Stage5 recipient", "启用邮件通知", "使用 --email、PAPERFLOW_REPORT_TO 或 NOTIFICATION_EMAIL"));

  const llmRuntime = dependencies.resolveLlmRuntimeImpl ? dependencies.resolveLlmRuntimeImpl({ env }) : resolveLlmRuntime({ env });
  if (options.requireLlm && !options.resume && !llmRuntime.apiKeyConfigured) {
    requiredMissing.push({ ...missing("PREFERENCE_LEARNING_API_KEY or TITLE_TRANSLATION_API_KEY", "明确要求的真实 LLM 功能", "通过 common.llm 的 env 引用在环境或本地 .env 中配置", "configuration"), section: "common" });
  } else if (!llmRuntime.apiKeyConfigured) {
    featureMissing.push(optional("real LLM credentials", "真实语义学习、翻译与概况", "standard 允许生产代码现有 fallback；需要时使用 --require-llm"));
  }

  if (options.profile === "complete" && !options.requireLlm && !options.resume) warnings.push("complete 仅强制用户明确请求的功能；未隐式要求真实 LLM");
  const canRun = requiredMissing.length === 0;
  const retry = retryCommand(options);
  const requiredWithRetry = requiredMissing.map((item) => ({ ...item, retryCommand: retry }));
  const missingBySection = Object.fromEntries(["common", options.mode].map((section) => [section, requiredWithRetry.filter((item) => item.section === section)]));
  const report = {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    status: canRun ? (featureMissing.length || optionalMissing.length || warnings.length ? "warning" : "ready") : "blocked",
    mode: options.mode,
    profile: options.profile,
    requiredMissing: requiredWithRetry,
    featureMissing,
    optionalMissing,
    readiness,
    resolvedEntry: safePath(entry, repoRoot),
    resolvedArgs: buildExecutionPlan(options, { env, repoRoot, entries }).args.map((value, index, args) => {
      if (args[index - 1] === "--email") return "<configured-recipient>";
      if ([options.input, options.outputRoot, options.feedback].includes(value)) return safePath(value, repoRoot);
      return value;
    }),
    canRun,
    warnings,
    retryCommand: retry,
    configuration: options.configSummary || { schemaVersion: null, path: null, source: "none", modeSource: options.fixedMode ? "fixed_launcher" : "cli", selectedMode: options.mode, profile: options.profile, sectionsChecked: ["common", options.mode], secretStatus: {} },
    missingBySection,
  };
  return report;
}
