import { spawn } from "node:child_process";
import path from "node:path";
import { watchProductionChild } from "./child_watchdog.mjs";
import { writeAtomicJson, withAtomicJsonLock } from "../lib/atomic_json.mjs";
import { terminalWorkflowStatus, workflowLedgerStatus } from "../lib/orchestrator_status.mjs";
import { finishRunGroup } from "../lib/runtime_housekeeping.mjs";
import { OperationLedgerStore } from "../recovery/operation_ledger.mjs";
import { pathToFileURL } from "node:url";

import "../lib/env_file_bootstrap.mjs";
import { parseRunnerArgs } from "./args.mjs";
import { resolveRunnerConfiguration, RunnerConfigurationError } from "./config_loader.mjs";
import { selectScheduledDailyRun } from "./scheduled_daily.mjs";
import { EXIT_CODES } from "./constants.mjs";
import { buildExecutionPlan, runPreflight } from "./preflight.mjs";
import { extractLastJsonObject, validateProductionResult } from "./result_validation.mjs";
import { notifyRunFailure } from "../notification/failure_notifier.mjs";
import { processHealthNotifications } from "../notification/health_notifier.mjs";
import { emailDeliveryPolicy } from '../notification/policy.mjs';
import { redactSecrets, secretValues } from '../lib/credential_registry.mjs';
import { resolveRuntimePaths } from '../lib/runtime_config.mjs';
import { RuntimeLog } from '../lib/runtime_logging.mjs';

export function redactText(text, env = process.env) {
  return redactSecrets(text, secretValues(env));
}

export function runProduction(plan, dependencies = {}) {
  const spawnImpl = dependencies.spawnImpl || spawn;
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  const enrichmentMs = Number(plan.childEnv?.PAPERECHO_FEEDBACK_ENRICHMENT_TIMEOUT_MS || 1800000);
  const timeoutMs = Number(dependencies.watchdogTimeoutMs ?? plan.childEnv?.PAPERECHO_RUNNER_WATCHDOG_TIMEOUT_MS ?? Math.max(7200000, enrichmentMs * 4));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || (!dependencies.watchdogTimeoutMs && timeoutMs <= enrichmentMs)) throw new Error("invalid_runner_watchdog_timeout");
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [plan.entry, ...plan.args], { cwd: plan.cwd, env: plan.childEnv, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["inherit", "pipe", "pipe", "ipc"] });
    let rawStdout = "";
    let stderrSeen = false;
    const omitted = new Set();
    const pending = { stdout: '', stderr: '' };
    const output = { stdout, stderr };
    const flush = (name, chunk = '', final = false) => {
      pending[name] += chunk;
      const end = final ? pending[name].length : pending[name].lastIndexOf('\n') + 1;
      if (end) {
        const safe = redactText(pending[name].slice(0, end), plan.childEnv);
        if (/^(?:\s*\[REDACTED\]\s*)+$/.test(safe)) output[name].write(safe);
        else if (!omitted.has(name)) { omitted.add(name); output[name].write(`[runner] child ${name} content omitted; consult registered run evidence\n`); }
        pending[name] = pending[name].slice(end);
      }
      // ponytail: bounded line buffering; oversized log lines are suppressed.
      if (pending[name].length > 1048576) { pending[name] = ''; output[name].write('[oversized log line suppressed]\n'); }
    };
    const watchdog = watchProductionChild(child, { timeoutMs, graceMs: dependencies.graceMs, processApi: dependencies.processApi || process,
      force: dependencies.forceChildTree,
      onStop: (status) => stderr.write(`[runner] ${status}: terminating owned production child\n`),
      onUnreaped: (status) => { flush('stdout', '', true); flush('stderr', '', true); watchdog.cleanup(); child.unref?.(); child.stdout?.destroy?.(); child.stderr?.destroy?.(); if (child.connected) child.disconnect?.(); resolve({ code: 1, status, childExitConfirmed: false, stdout: rawStdout, stderr: stderrSeen ? 'CHILD_STDERR_OMITTED' : '' }); },
    });
    child.stdout?.on("data", (chunk) => {
      rawStdout += chunk;
      flush('stdout', chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrSeen = true;
      flush('stderr', chunk);
    });
    child.once("error", (error) => { watchdog.cleanup(); reject(error); });
    child.once("close", (code, signal) => { flush('stdout', '', true); flush('stderr', '', true); const status = watchdog.status || (signal ? "interrupted" : Number(code) === 0 ? "completed" : "failed"); watchdog.cleanup(); resolve({ code: status === "completed" ? 0 : Number(code || 1), status, signal, childExitConfirmed: true, stdout: rawStdout, stderr: stderrSeen ? 'CHILD_STDERR_OMITTED' : '' }); });
  });
}

function blockedExitCode(preflight) {
  const categories = new Set(preflight.requiredMissing.map((item) => item.category));
  if (categories.has("input")) return EXIT_CODES.input;
  if (categories.has("dependency")) return EXIT_CODES.dependency;
  return EXIT_CODES.configuration;
}

export function formatPreflightSummary(preflight) {
  const missing = preflight.requiredMissing.map((item) => item.name).join(", ");
  return `[runner] preflight ${preflight.status}: mode=${preflight.mode} profile=${preflight.profile}${missing ? ` missing=${missing}` : ""}`;
}

function failedStage(report) {
  const status = String(report?.status || "").toLowerCase();
  for (const stage of ["stage1", "stage2", "stage3", "stage4", "stage5"]) if (status.includes(stage)) return stage;
  const failed = (report?.stages || []).find((stage) => Number(stage?.exitCode || 0) !== 0);
  return String(failed?.name || (status.includes("orchestrator") ? "orchestrator" : "pipeline")).replace(/_.*/, "");
}

function notificationSummary(result) {
  return { status: result?.status || "failed", reason: result?.reason || "notifier_failed", attempted: result?.attempted === true, possibleAccepted: result?.status === "unknown" };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  if (argv.some(x => ['--schedule-preflight', '--schedule-dry-run'].includes(x))) {
    const { schedulerMain } = await import('./os_scheduler.mjs');
    return schedulerMain(argv, dependencies);
  }
  if (argv.some(x => ['--backup', '--verify-backup', '--restore-backup', '--restore-existing', '--restore-preflight', '--restore-recover', '--restore-rollback'].includes(x))) {
    const { backupMain } = await import('./backup.mjs');
    return backupMain(argv, dependencies);
  }
  if (argv.includes('--doctor')) {
    const { doctorMain } = await import('./doctor.mjs');
    return doctorMain(argv, dependencies);
  }
  const logOwner = dependencies.runtimeLog || new RuntimeLog({ env: dependencies.env || process.env, applicationRoot: dependencies.cwd,
    warning: code => { try { (dependencies.stderr || process.stderr).write(`[logging] ${code}\n`); } catch {} } });
  const runtimeLog = { write: async (...args) => { try { return await logOwner.write(...args); } catch { try { (dependencies.stderr || process.stderr).write('[logging] RUNTIME_LOG_UNAVAILABLE\n'); } catch {} return { ok: false }; } } };
  const context = { ...dependencies, runtimeLog };
  let code = EXIT_CODES.pipeline;
  await runtimeLog.write('RUNNER_STARTED');
  try { code = await executeMain(argv, context); return code; }
  finally { await runtimeLog.write(code === 0 ? 'RUNNER_FINISHED' : 'RUNNER_FAILED', { exitCode: code, runId: context.logRunId }); }
}

async function executeMain(argv, dependencies) {
  let outputEnv = dependencies.env || process.env;
  const stdout = { write: value => (dependencies.stdout || process.stdout).write(redactText(value, outputEnv)) };
  const stderr = { write: value => (dependencies.stderr || process.stderr).write(redactText(value, outputEnv)) };
  let cliOptions;
  try {
    const paths = resolveRuntimePaths({ env: outputEnv });
    cliOptions = parseRunnerArgs(argv, { cwd: paths.layout === 'dev' ? dependencies.cwd || process.cwd() : paths.userDataRoot, allowUnresolvedMode: true });
  }
  catch (error) {
    stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "invalid_input", code: 'RUNNER_ARGUMENT_INVALID', error: '检查启动参数。' })}\n`);
    return EXIT_CODES.input;
  }
  let resolved;
  try {
    resolved = await (dependencies.resolveRunnerConfigurationImpl || resolveRunnerConfiguration)(cliOptions, dependencies);
  } catch (error) {
    const code = error instanceof RunnerConfigurationError && /^CONFIG_[A-Z0-9_]+$/.test(error.code) ? error.code : 'CONFIG_INVALID';
    stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "invalid_configuration", code, error: '检查配置格式、路径和运行模式。' })}\n`);
    return EXIT_CODES.configuration;
  }
  if (cliOptions.scheduledDaily) {
    let selection;
    try {
      selection = await (dependencies.selectScheduledDailyRunImpl || selectScheduledDailyRun)(resolved, {
        now: (dependencies.clock || (() => new Date()))(),
        repoRoot: dependencies.repoRoot,
        fsApi: dependencies.fsApi,
      });
    } catch (error) {
      stderr.write(`${JSON.stringify({ type: "schedule", status: "blocked", reason: 'SCHEDULE_STATUS_UNAVAILABLE' })}\n`);
      return EXIT_CODES.configuration;
    }
    stdout.write(`${JSON.stringify({ type: "schedule", status: selection.status, plannedSlot: selection.decision.plannedSlot, selectedFlow: selection.decision.selectedFlow, weeklyMode: selection.decision.weeklyMode, reason: selection.reason || selection.decision.reason, ...(selection.runId ? { runId: selection.runId } : {}) })}\n`);
    if (!["ready", "resume"].includes(selection.status)) {
      return ["before_scheduled_slot", "already_completed"].includes(selection.status) ? EXIT_CODES.success
        : selection.status === "recovery_required" ? EXIT_CODES.pipeline : EXIT_CODES.configuration;
    }
    resolved = { ...selection.resolved, options: { ...selection.resolved.options, scheduledDecision: selection.decision } };
  }
  const options = resolved.options;
  outputEnv = resolved.env;
  const runtimeDependencies = { ...dependencies, env: resolved.env };
  const preflight = await (dependencies.runPreflightImpl || runPreflight)(options, runtimeDependencies);
  await dependencies.runtimeLog.write(preflight.canRun ? 'RUNNER_PREFLIGHT_READY' : 'RUNNER_PREFLIGHT_BLOCKED', { runId: options.resume });
  stdout.write(`${formatPreflightSummary(preflight)}\n${JSON.stringify({ type: "preflight", ...preflight })}\n`);
  if (!preflight.canRun) return blockedExitCode(preflight);
  if (options.action === "check") return EXIT_CODES.success;

  const plan = (dependencies.buildExecutionPlanImpl || buildExecutionPlan)(options, runtimeDependencies);
  // Parent completion can still write ledger/receipts after the child exits.
  // Backup takes this admission lock before taking workflow leases.
  const execute = async () => {
  dependencies.logRunId = plan.runId;
  await dependencies.runtimeLog.write('RUNNER_ADMITTED', { runId: plan.runId });
  let processResult;
  try { processResult = await (dependencies.runProductionImpl || runProduction)(plan, dependencies); }
  catch (error) {
    stderr.write(`${JSON.stringify({ type: "runner_error", status: "failed", code: 'RUNNER_EXECUTION_FAILED', error: '检查本次运行登记状态。' })}\n`);
    return EXIT_CODES.pipeline;
  }
  const productionReport = extractLastJsonObject(processResult.stdout);
  if (processResult.stderr) await dependencies.runtimeLog.write('CHILD_STDERR', { runId: plan.runId });
  if (options.scheduledDaily && processResult.code === 0 && productionReport?.status === "skipped"
    && productionReport?.skipReport?.reason === "duplicate_schedule_trigger") {
    stdout.write(`${JSON.stringify({ type: "result", status: "already_claimed", plannedSlot: options.scheduledDecision.plannedSlot, runId: productionReport?.schedule_decision?.businessRunId || null })}\n`);
    return EXIT_CODES.success;
  }
  const terminal = terminalWorkflowStatus(processResult.status, productionReport?.status, processResult.code !== 0 ? "failed" : null);
  if (["timed_out", "interrupted"].includes(terminal)) processResult.status = terminal;
  if (["timed_out", "interrupted"].includes(processResult.status)) {
    const result = { type: "result", ok: false, status: processResult.status, runId: plan.runId, childExitConfirmed: processResult.childExitConfirmed, lastKnownPhase: productionReport?.last_known_phase || productionReport?.status || "unknown", sideEffects: "consult_current_run_ledger", exitCode: processResult.status === "interrupted" ? EXIT_CODES.canceled : EXIT_CODES.pipeline };
    if (plan.runRoot && plan.runId) {
      // Never race a live child. A confirmed exit lets the parent persist watchdog authority.
      if (processResult.childExitConfirmed === true) {
        await finishRunGroup({ manifestPath: path.join(plan.runRoot, plan.runId, "run_group.json"), status: terminal });
        try {
          const store = await OperationLedgerStore.load({ runRoot: plan.runRoot, runId: plan.runId });
          await store.setRunStatus(workflowLedgerStatus(terminal, store.ledger.operations), terminal);
        } catch (error) { if (error?.code !== "ENOENT") result.ledgerStatusError = String(error?.message || error).slice(0, 160); }
      }
      await writeAtomicJson(path.join(plan.runRoot, plan.runId, "runner_report.json"), result);
    }
    stdout.write(`${JSON.stringify(result)}\n`);
    return result.exitCode;
  }
  const notificationSchemaSupported = Number(resolved.env.PAPERECHO_CONFIG_SCHEMA_VERSION || 0) >= 2 && emailDeliveryPolicy('failure', { env: resolved.env }).required;
  const recipient = String(options.email || resolved.env.PAPERFLOW_REPORT_TO || resolved.env.NOTIFICATION_EMAIL || "").trim();
  if (processResult.code !== 0 && notificationSchemaSupported && /^(1|true|yes|on)$/i.test(String(resolved.env.PAPERECHO_FAILURE_NOTIFIER_ENABLED || ""))) {
    const stage = failedStage(productionReport);
    if (stage !== "stage5") {
      try {
        const notified = await (dependencies.notifyRunFailureImpl || notifyRunFailure)({ runRoot: plan.runRoot, runId: plan.runId, failureStage: stage, errorCategory: String(productionReport?.status || "production_entry_failed"), recipient, env: resolved.env, fsApi: dependencies.fsApi });
        stdout.write(`${JSON.stringify({ type: "failure_notification", ...notificationSummary(notified) })}\n`);
      } catch (error) {
        stdout.write(`${JSON.stringify({ type: "failure_notification", status: "failed", reason: "notifier_internal_error" })}\n`);
      }
    }
  } else if (processResult.code === 0 && notificationSchemaSupported && /^(1|true|yes|on)$/i.test(String(resolved.env.PAPERECHO_HEALTH_NOTIFIER_ENABLED || ""))) {
    try {
      const health = await (dependencies.processHealthNotificationsImpl || processHealthNotifications)({ runRoot: plan.runRoot, runId: plan.runId, observations: productionReport?.notification_health_observations || [], recipient, env: resolved.env, fsApi: dependencies.fsApi });
      stdout.write(`${JSON.stringify({ type: "health_notifications", status: health.status, eventCount: health.events?.length || 0, maxNotifications: health.maxNotifications || 0 })}\n`);
    } catch {
      stdout.write(`${JSON.stringify({ type: "health_notifications", status: "failed", reason: "health_notifier_internal_error" })}\n`);
    }
  }
  const validation = await (dependencies.validateProductionResultImpl || validateProductionResult)({ options, plan, processResult, fsApi: dependencies.fsApi });
  stdout.write(`${JSON.stringify({ type: "result", ...validation })}\n`);
  return validation.exitCode;
  };
  return plan.runRoot ? withAtomicJsonLock(path.join(plan.runRoot, '.runner.operation'), execute, { timeoutMs: 0, staleMs: Infinity, metadata: { owner: 'paperecho-runner' } }) : execute();
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "runner_crash", code: 'RUNNER_CRASH', error: '检查运行环境和本次运行登记状态。' })}\n`);
    process.exitCode = EXIT_CODES.pipeline;
  });
}
