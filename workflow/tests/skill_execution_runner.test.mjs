import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRunnerArgs } from "../tools/runner/args.mjs";
import { EXIT_CODES } from "../tools/runner/constants.mjs";
import { buildLauncherInvocation, runFixedModeLauncher } from "../tools/runner/launcher.mjs";
import { main as runnerMain, redactText, runProduction } from "../tools/runner/main.mjs";
import { buildExecutionPlan, runPreflight } from "../tools/runner/preflight.mjs";
import { validateProductionResult } from "../tools/runner/result_validation.mjs";
import * as desktopLauncher from "../../skills/paperecho-zotero-desktop/scripts/run.mjs";
import * as webLauncher from "../../skills/paperecho-zotero-web/scripts/run.mjs";
import * as localLauncher from "../../skills/paperecho-local/scripts/run.mjs";

function sink() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, text() { return value; } };
}

function closedChild(code = 0, signal = null) {
  const child = new EventEmitter();
  queueMicrotask(() => child.emit("close", code, signal));
  return child;
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-runner-"));
  const entry = path.join(root, "fake entry.mjs");
  const input = path.join(root, "input file.json");
  const outputRoot = path.join(root, "output root");
  await fs.writeFile(entry, "export {};\n");
  await fs.writeFile(input, "[]\n");
  return { root, entry, input, outputRoot };
}

function entries(entry) {
  return { desktop: entry, web: entry, local: entry };
}

function localOptions(paths, overrides = {}) {
  return { mode: "local", action: "check", profile: "standard", input: paths.input, outputRoot: paths.outputRoot, feedback: "", email: "", llmMode: "disabled", forceResend: false, requireLlm: false, ...overrides };
}

function readyPreflight(mode = "local") {
  return { schemaVersion: 1, status: "ready", mode, profile: "standard", requiredMissing: [], featureMissing: [], optionalMissing: [], readiness: [], resolvedEntry: "fake.mjs", resolvedArgs: [], canRun: true, warnings: [], retryCommand: "retry" };
}

function completeManifest(mode, runId) {
  return { schemaVersion: 1, runId, pipelineMode: mode, status: "completed", artifacts: [{ kind: "weekly_export", rootKey: "exports", path: runId, retention: "30d" }] };
}

function desktopReport(stage5 = "skipped") {
  return {
    runId: "desktop-run-1",
    status: "completed",
    stages: [
      { name: "stage1", exitCode: 0, status: "success" },
      { name: "stage2_writeback", exitCode: 0, status: "success" },
      { name: "stage3_translation", exitCode: 0, status: "success" },
      { name: "stage4_exports", exitCode: 0, status: "success" },
    ],
    steps: { stage5_notification: { status: stage5 } },
    artifacts: { stage4_run_report: { data: { steps: { stage4_export_audit: { monthly_docx_report_generated: false } } } } },
    housekeeping: { warnings: ["fixture warning"], immediateFailedCount: 0, registeredEphemeralsRemaining: 0 },
  };
}

test("three launchers fix their own mode and use an absolute Runner path", () => {
  assert.equal(desktopLauncher.MODE, "desktop");
  assert.equal(webLauncher.MODE, "web");
  assert.equal(localLauncher.MODE, "local");
  for (const launcher of [desktopLauncher, webLauncher, localLauncher]) {
    assert.equal(path.isAbsolute(launcher.RUNNER_PATH), true);
    const invocation = buildLauncherInvocation({ mode: launcher.MODE, runnerPath: launcher.RUNNER_PATH, argv: ["--check"] });
    assert.deepEqual(invocation.args.slice(1, 4), ["--mode", launcher.MODE, "--fixed-mode"]);
  }
});

test("launcher passes spaced arguments as an argv array without shell and preserves exit code", async () => {
  let seen;
  const code = await runFixedModeLauncher(
    { mode: "local", runnerPath: "C:\\repo with space\\runner.mjs", argv: ["--run", "--input", "C:\\input dir\\items.json"] },
    { spawnImpl(command, args, options) { seen = { command, args, options }; return closedChild(23); } },
  );
  assert.equal(code, 23);
  assert.equal(seen.options.shell, false);
  assert.deepEqual(seen.args, ["C:\\repo with space\\runner.mjs", "--mode", "local", "--fixed-mode", "--run", "--input", "C:\\input dir\\items.json"]);
  assert.throws(() => buildLauncherInvocation({ mode: "desktop", runnerPath: "runner", argv: ["--mode", "web"] }), /MODE_OVERRIDE/);
});

test("runner argument parser enforces one action and resolves Local paths from invocation cwd", () => {
  const parsed = parseRunnerArgs(["--mode", "local", "--run", "--input", "folder/input.json", "--output-root", "out folder"], { cwd: "C:\\invocation" });
  assert.equal(parsed.profile, "standard");
  assert.equal(parseRunnerArgs(["--mode", "desktop", "--run", "--profile", "radar"]).profile, "radar");
  assert.equal(parsed.input, path.resolve("C:\\invocation", "folder/input.json"));
  assert.throws(() => parseRunnerArgs(["--mode", "web", "--check", "--run"]), /EXACTLY_ONE/);
  assert.throws(() => parseRunnerArgs(["--mode", "desktop", "--run", "--input", "x"]), /LOCAL_ARGUMENT/);
  assert.equal(parseRunnerArgs(["--mode", "desktop", "--fixed-mode", "--run", "--resume", "zlf-run-1"]).resume, "zlf-run-1");
  assert.throws(() => parseRunnerArgs(["--mode", "desktop", "--fixed-mode", "--run", "--resume", "../escape"]), /RUN_ID_INVALID/);
  assert.throws(() => parseRunnerArgs(["--mode", "desktop", "--fixed-mode", "--check", "--resume", "zlf-run-1"]), /RESUME_REQUIRES_RUN/);
  assert.throws(() => parseRunnerArgs(["--mode", "desktop", "--run", "--resume", "zlf-run-1"]), /FIXED_LAUNCHER_REQUIRED/);
});

test("fixed launchers pass resume only through Runner and execution plan preserves it", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const invocation = buildLauncherInvocation({ mode: "desktop", runnerPath: "runner.mjs", argv: ["--run", "--resume", "zlf-run-1"] });
  assert.deepEqual(invocation.args.slice(-3), ["--run", "--resume", "zlf-run-1"]);
  const plan = buildExecutionPlan(localOptions(paths, { action: "run", input: "", resume: "local-run-1", recoveryConfigHash: "a".repeat(64) }), { env: {}, entries: entries(paths.entry), repoRoot: paths.root });
  assert.deepEqual(plan.args.slice(-2), ["--resume", "local-run-1"]);
  assert.equal(plan.childEnv.PAPERECHO_CONFIG_HASH, "a".repeat(64));
});

test("resume preflight uses persisted input and does not require SMTP or LLM execution", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const options = localOptions(paths, { action: "run", input: "", resume: "local-run-1", email: "configured@example.invalid", requireLlm: true, llmMode: "real" });
  const result = await runPreflight(options, { env: {}, entries: entries(paths.entry), existsSync: (value) => value === paths.entry, resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: false }) });
  assert.equal(result.canRun, true);
  assert.equal(result.requiredMissing.length, 0);
  assert.equal(result.resolvedArgs.includes("--resume"), true);
  assert.equal(result.resolvedArgs.includes("--email"), false);
});

test("--check never calls production entry", async () => {
  let productionCalls = 0;
  const output = sink();
  const code = await runnerMain(["--mode", "local", "--check", "--input", "x", "--output-root", "y"], {
    runPreflightImpl: async () => readyPreflight(),
    runProductionImpl: async () => { productionCalls += 1; },
    stdout: output,
    stderr: sink(),
  });
  assert.equal(code, EXIT_CODES.success);
  assert.equal(productionCalls, 0);
  assert.match(output.text(), /"type":"preflight"/);
});

test("blocked preflight never calls production entry and maps category exit code", async () => {
  let productionCalls = 0;
  const blocked = { ...readyPreflight(), status: "blocked", canRun: false, requiredMissing: [{ category: "dependency" }] };
  const code = await runnerMain(["--mode", "local", "--run", "--input", "x", "--output-root", "y"], {
    runPreflightImpl: async () => blocked,
    runProductionImpl: async () => { productionCalls += 1; },
    stdout: sink(), stderr: sink(),
  });
  assert.equal(code, EXIT_CODES.dependency);
  assert.equal(productionCalls, 0);
});

test("ready --run calls the fixed production entry once and validates once", async () => {
  let productionCalls = 0;
  let validationCalls = 0;
  const code = await runnerMain(["--mode", "local", "--run", "--input", "x", "--output-root", "y"], {
    runPreflightImpl: async () => readyPreflight(),
    buildExecutionPlanImpl: () => ({ entry: "fake", args: [], childEnv: {}, cwd: ".", runRoot: "runs" }),
    runProductionImpl: async () => { productionCalls += 1; return { code: 0, signal: null, stdout: "{}", stderr: "" }; },
    validateProductionResultImpl: async () => { validationCalls += 1; return { ok: true, exitCode: 0 }; },
    stdout: sink(), stderr: sink(),
  });
  assert.equal(code, 0);
  assert.equal(productionCalls, 1);
  assert.equal(validationCalls, 1);
});

test("preflight resolves the shared Stage0 entry for Desktop/Web and Local entry for Local", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const baseDeps = { env: {}, entries: entries(paths.entry), existsSync: (value) => value === paths.entry, resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: true }) };
  const desktop = await runPreflight({ ...localOptions(paths), mode: "desktop", input: "", outputRoot: "", llmMode: "" }, { ...baseDeps, desktopApplicationImpl: () => "zotero", findExecutableImpl: () => "zotero-cli" });
  const web = await runPreflight({ ...localOptions(paths), mode: "web", input: "", outputRoot: "", llmMode: "" }, { ...baseDeps, env: { ZOTERO_API_KEY: "secret" } });
  const local = await runPreflight(localOptions(paths), baseDeps);
  assert.equal(desktop.resolvedEntry, web.resolvedEntry);
  assert.equal(local.resolvedEntry, `<external>/${path.basename(paths.entry)}`);
  assert.equal(desktop.canRun, true);
  assert.equal(web.canRun, true);
  assert.equal(local.canRun, true);
});

test("Radar preflight keeps the shared Stage0 entry without requiring a Zotero backend", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  let desktopChecks = 0;
  const radar = await runPreflight(
    { ...localOptions(paths), mode: "desktop", input: "", outputRoot: "", llmMode: "", profile: "radar" },
    {
      env: {},
      entries: entries(paths.entry),
      existsSync: (value) => value === paths.entry,
      desktopApplicationImpl: () => { desktopChecks += 1; return "zotero"; },
      findExecutableImpl: () => { desktopChecks += 1; return "zotero-cli"; },
      resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: false }),
    },
  );
  assert.equal(radar.canRun, true);
  assert.equal(desktopChecks, 0);
  assert.equal(radar.readiness.some((item) => item.name === "radar_no_writeback" && item.status === "ready"), true);
});

test("Local preflight ignores poisoned Zotero config and plan strips Zotero backend variables", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  let desktopChecks = 0;
  const env = { ZOTERO_API_KEY: "bad", ZOTERO_BACKEND: "web_api", ZOTERO_EXE: "missing" };
  const result = await runPreflight(localOptions(paths), { env, entries: entries(paths.entry), existsSync: (value) => value === paths.entry, desktopApplicationImpl: () => { desktopChecks += 1; }, resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: false }) });
  const plan = buildExecutionPlan(localOptions(paths), { env, entries: entries(paths.entry), repoRoot: paths.root });
  assert.equal(result.canRun, true);
  assert.equal(desktopChecks, 0);
  assert.equal(plan.childEnv.ZOTERO_API_KEY, undefined);
  assert.equal(plan.childEnv.ZOTERO_BACKEND, undefined);
  assert.equal(plan.args.some((value) => /stage[23]/i.test(value)), false);
});

test("standard without recipient permits missing SMTP; requested mail requires only missing SMTP names", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const deps = { env: {}, entries: entries(paths.entry), existsSync: (value) => value === paths.entry, resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: false }) };
  const noMail = await runPreflight(localOptions(paths), deps);
  const mail = await runPreflight(localOptions(paths, { email: "preview@example.invalid" }), deps);
  assert.equal(noMail.canRun, true);
  assert.equal(mail.canRun, false);
  assert.deepEqual(mail.requiredMissing.map((item) => item.name), ["SMTP_HOST", "SMTP_USER", "SMTP_PASS"]);
  assert.equal(mail.requiredMissing.every((item) => item.retryCommand === mail.retryCommand), true);
  assert.equal(JSON.stringify(mail).includes("preview@example.invalid"), false);
});

test("complete blocks real LLM only when explicitly required", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const deps = { env: {}, entries: entries(paths.entry), existsSync: (value) => value === paths.entry, resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: false }) };
  const complete = await runPreflight(localOptions(paths, { profile: "complete" }), deps);
  const required = await runPreflight(localOptions(paths, { profile: "complete", requireLlm: true, llmMode: "real" }), deps);
  assert.equal(complete.canRun, true);
  assert.equal(required.canRun, false);
  assert.match(required.requiredMissing[0].name, /API_KEY/);
});

test("secrets are absent from preflight JSON and are redacted from child stdout/stderr", async (t) => {
  const paths = await fixture();
  t.after(() => fs.rm(paths.root, { recursive: true, force: true }));
  const env = { SMTP_HOST: "smtp.invalid", SMTP_USER: "sender@example.invalid", SMTP_PASS: "smtp-secret", TITLE_TRANSLATION_API_KEY: "llm-secret" };
  const report = await runPreflight(localOptions(paths, { email: "recipient@example.invalid" }), { env, entries: entries(paths.entry), existsSync: (value) => value === paths.entry, resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: true }) });
  const encoded = JSON.stringify(report);
  assert.equal(encoded.includes("smtp-secret"), false);
  assert.equal(encoded.includes("llm-secret"), false);
  assert.equal(encoded.includes("recipient@example.invalid"), false);
  assert.equal(redactText("smtp-secret llm-secret", env), "[REDACTED] [REDACTED]");
});

test("runProduction uses argv arrays, no shell, and redacts streamed output", async () => {
  let invocation;
  const stdout = sink();
  const stderr = sink();
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const promise = runProduction({ entry: "C:\\fake entry.mjs", args: ["--input", "C:\\a b.json"], cwd: "C:\\repo", childEnv: { SMTP_PASS: "secret-value" } }, {
    stdout, stderr,
    spawnImpl(command, args, options) { invocation = { command, args, options }; queueMicrotask(() => { child.stdout.emit("data", "secret-value"); child.stderr.emit("data", "secret-value"); child.emit("close", 0, null); }); return child; },
  });
  const result = await promise;
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.args.slice(1), ["--input", "C:\\a b.json"]);
  assert.equal(stdout.text(), "[REDACTED]");
  assert.equal(stderr.text(), "[REDACTED]");
  assert.equal(result.code, 0);
});

test("result validation reads only the exact current run-group and reports NOT_DUE", async () => {
  const reads = [];
  const report = desktopReport("skipped");
  const plan = { runRoot: "C:\\isolated runs" };
  const result = await validateProductionResult({
    options: { mode: "desktop", email: "" }, plan,
    processResult: { code: 0, signal: null, stdout: JSON.stringify(report), stderr: "" },
    fsApi: { async readFile(value) { reads.push(value); return JSON.stringify(completeManifest("desktop", report.runId)); } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.monthly, "NOT_DUE");
  assert.equal(result.xlsxRegistered, true);
  assert.deepEqual(reads, [path.join(plan.runRoot, report.runId, "run_group.json")]);
  assert.deepEqual(result.housekeeping.warnings, ["fixture warning"]);
});

test("Radar current-run validation requires a fresh zero-write audit and no weekly export", async () => {
  const runId = "radar-run-1";
  const report = {
    runId,
    status: "completed",
    stages: [
      { name: "stage1", exitCode: 0, status: "success" },
      { name: "stage2_writeback", exitCode: 0, status: "skipped" },
      { name: "stage3_translation", exitCode: 0, status: "skipped" },
      { name: "stage4_exports", exitCode: 0, status: "skipped" },
    ],
    steps: { stage5_notification: { status: "accepted" } },
    artifacts: { radar_audit: { currentRun: true, data: { zoteroWriteCount: 0, xlsxWriteCount: 0 } } },
    housekeeping: {},
  };
  const manifest = { schemaVersion: 1, runId, pipelineMode: "desktop", status: "completed", artifacts: [{ kind: "run_state", retention: "30d" }] };
  const base = { options: { mode: "desktop", profile: "radar" }, plan: { runRoot: "runs" }, fsApi: { async readFile() { return JSON.stringify(manifest); } } };
  const accepted = await validateProductionResult({ ...base, processResult: { code: 0, signal: null, stdout: JSON.stringify(report) } });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.xlsxRegistered, false);
  assert.equal(accepted.monthly, "NOT_APPLICABLE");
  report.steps.stage5_notification.status = "unknown";
  const unknown = await validateProductionResult({ ...base, processResult: { code: 0, signal: null, stdout: JSON.stringify(report) } });
  assert.equal(unknown.reason, "stage5_requirement_failed");
});

test("Local validation marks Stage2/3 and Zotero NOT_APPLICABLE", async () => {
  const runId = "local-run-1";
  const result = await validateProductionResult({
    options: { mode: "local", email: "" }, plan: { runRoot: "runs" },
    processResult: { code: 0, signal: null, stdout: JSON.stringify({ ok: true, run_id: runId, export_path: "weekly.xlsx", stage5_notification: { status: "skipped" }, housekeeping: {} }), stderr: "" },
    fsApi: { async readFile() { return JSON.stringify(completeManifest("local", runId)); } },
  });
  assert.equal(result.stages.stage2, "NOT_APPLICABLE");
  assert.equal(result.stages.stage3, "NOT_APPLICABLE");
  assert.equal(result.localZotero, "NOT_APPLICABLE");
  assert.equal(result.monthly, "NOT_APPLICABLE");
});

test("resume validation accepts only the requested persisted run", async () => {
  const runId = "local-run-1";
  const result = await validateProductionResult({
    options: { mode: "local", resume: runId }, plan: { runRoot: "runs" },
    processResult: { code: 0, signal: null, stdout: JSON.stringify({ run_id: runId, resume: true, status: "completed" }), stderr: "" },
    fsApi: { async readFile() { return JSON.stringify(completeManifest("local", runId)); } },
  });
  assert.equal(result.ok, true);
  assert.equal(result.resume, true);
  const mismatch = await validateProductionResult({
    options: { mode: "local", resume: "other-run" }, plan: { runRoot: "runs" },
    processResult: { code: 0, signal: null, stdout: JSON.stringify({ run_id: runId, resume: true, status: "completed" }), stderr: "" },
    fsApi: { async readFile() { return JSON.stringify(completeManifest("local", runId)); } },
  });
  assert.equal(mismatch.reason, "resume_result_mismatch");
});

test("Stage5 sent/skipped/failed requirements are distinguished", async () => {
  const fsApi = { async readFile() { return JSON.stringify(completeManifest("desktop", "desktop-run-1")); } };
  const base = { plan: { runRoot: "runs" }, fsApi };
  const skipped = await validateProductionResult({ ...base, options: { mode: "desktop", email: "" }, processResult: { code: 0, signal: null, stdout: JSON.stringify(desktopReport("skipped")) } });
  const sent = await validateProductionResult({ ...base, options: { mode: "desktop", email: "requested@example.invalid" }, processResult: { code: 0, signal: null, stdout: JSON.stringify(desktopReport("sent")) } });
  const failed = await validateProductionResult({ ...base, options: { mode: "desktop", email: "" }, processResult: { code: 0, signal: null, stdout: JSON.stringify(desktopReport("failed")) } });
  const requestedButSkipped = await validateProductionResult({ ...base, options: { mode: "desktop", email: "requested@example.invalid" }, processResult: { code: 0, signal: null, stdout: JSON.stringify(desktopReport("skipped")) } });
  assert.equal(skipped.ok, true);
  assert.equal(sent.ok, true);
  assert.equal(failed.reason, "stage5_requirement_failed");
  assert.equal(requestedButSkipped.reason, "stage5_requirement_failed");
});

test("run-group path/mode mismatch and production failure are validation failures", async () => {
  const report = desktopReport("skipped");
  const mismatch = await validateProductionResult({
    options: { mode: "desktop", email: "" }, plan: { runRoot: "runs" }, processResult: { code: 0, signal: null, stdout: JSON.stringify(report) },
    fsApi: { async readFile() { return JSON.stringify(completeManifest("web", report.runId)); } },
  });
  const failed = await validateProductionResult({ options: { mode: "desktop" }, plan: { runRoot: "runs" }, processResult: { code: 9, signal: null, stdout: "" } });
  assert.equal(mismatch.reason, "run_group_mode_mismatch");
  assert.equal(mismatch.exitCode, EXIT_CODES.validation);
  assert.equal(failed.reason, "production_entry_failed");
  assert.equal(failed.exitCode, EXIT_CODES.pipeline);
});

test("explicit real LLM requirement rejects fallback or unobservable results", async () => {
  const report = desktopReport("skipped");
  report.artifacts.llm_overview = { status: "fallback", fallbackReason: "llm_unavailable" };
  const result = await validateProductionResult({
    options: { mode: "desktop", email: "", requireLlm: true }, plan: { runRoot: "runs" },
    processResult: { code: 0, signal: null, stdout: JSON.stringify(report) },
    fsApi: { async readFile() { return JSON.stringify(completeManifest("desktop", report.runId)); } },
  });
  assert.equal(result.reason, "real_llm_result_unverified_or_fallback");
});

test("test harness exposes no real Zotero, SMTP, LLM, or network client", () => {
  assert.equal(typeof globalThis.fetch, "function");
  const source = [runPreflight, validateProductionResult, runProduction].map(String).join("\n");
  assert.doesNotMatch(source, /await fetch\(|nodemailer|add_items_to_collection|runStage[12345]\(/);
});
