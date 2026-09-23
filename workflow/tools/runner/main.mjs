import { spawn } from "node:child_process";
import path from "node:path";
import { watchProductionChild } from "./child_watchdog.mjs";
import { writeAtomicJson } from "../lib/atomic_json.mjs";
import { terminalWorkflowStatus, workflowLedgerStatus } from "../lib/orchestrator_status.mjs";
import { finishRunGroup } from "../lib/runtime_housekeeping.mjs";
import { OperationLedgerStore } from "../recovery/operation_ledger.mjs";
import { pathToFileURL } from "node:url";

import "../lib/env_file_bootstrap.mjs";
import { parseRunnerArgs } from "./args.mjs";
import { resolveRunnerConfiguration } from "./config_loader.mjs";
import { selectScheduledDailyRun } from "./scheduled_daily.mjs";
import { EXIT_CODES } from "./constants.mjs";
import { buildExecutionPlan, runPreflight } from "./preflight.mjs";
import { extractLastJsonObject, validateProductionResult } from "./result_validation.mjs";
import { notifyRunFailure } from "../notification/failure_notifier.mjs";
import { processHealthNotifications } from "../notification/health_notifier.mjs";

const SECRET_NAMES = ["SMTP_PASS", "ZOTERO_API_KEY", "TITLE_TRANSLATION_API_KEY", "PREFERENCE_LEARNING_API_KEY", "EASYSCHOLAR_SECRET_KEY"];

export function redactText(text, env = process.env) {
  let safe = String(text || "");
  for (const name of SECRET_NAMES) {
    const value = String(env[name] || "");
    if (value) safe = safe.split(value).join("[REDACTED]");
  }
  return safe;
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
    let rawStderr = "";
    const watchdog = watchProductionChild(child, { timeoutMs, graceMs: dependencies.graceMs, processApi: dependencies.processApi || process,
      force: dependencies.forceChildTree,
      onStop: (status) => stderr.write(`[runner] ${status}: terminating owned production child\n`),
      onUnreaped: (status) => { watchdog.cleanup(); child.unref?.(); child.stdout?.destroy?.(); child.stderr?.destroy?.(); if (child.connected) child.disconnect?.(); resolve({ code: 1, status, childExitConfirmed: false, stdout: rawStdout, stderr: rawStderr }); },
    });
    child.stdout?.on("data", (chunk) => {
      rawStdout += chunk;
      stdout.write(redactText(chunk, plan.childEnv));
    });
    child.stderr?.on("data", (chunk) => {
      rawStderr += chunk;
      stderr.write(redactText(chunk, plan.childEnv));
    });
    child.once("error", (error) => { watchdog.cleanup(); reject(error); });
    child.once("close", (code, signal) => { const status = watchdog.status || (signal ? "interrupted" : Number(code) === 0 ? "completed" : "failed"); watchdog.cleanup(); resolve({ code: status === "completed" ? 0 : Number(code || 1), status, signal, childExitConfirmed: true, stdout: rawStdout, stderr: rawStderr }); });
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
  const stdout = dependencies.stdout || process.stdout;
  const stderr = dependencies.stderr || process.stderr;
  let cliOptions;
  try { cliOptions = parseRunnerArgs(argv, { cwd: dependencies.cwd || process.cwd(), allowUnresolvedMode: true }); }
  catch (error) {
    stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "invalid_input", error: String(error?.message || error) })}\n`);
    return EXIT_CODES.input;
  }
  let resolved;
  try {
    resolved = await (dependencies.resolveRunnerConfigurationImpl || resolveRunnerConfiguration)(cliOptions, dependencies);
  } catch (error) {
    stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "invalid_configuration", code: String(error?.code || "CONFIG_INVALID"), error: redactText(error?.message || error, dependencies.env || process.env), details: error?.details || {} })}\n`);
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
      stderr.write(`${JSON.stringify({ type: "schedule", status: "blocked", reason: String(error?.message || error) })}\n`);
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
  const runtimeDependencies = { ...dependencies, env: resolved.env };
  const preflight = await (dependencies.runPreflightImpl || runPreflight)(options, runtimeDependencies);
  stdout.write(`${formatPreflightSummary(preflight)}\n${JSON.stringify({ type: "preflight", ...preflight })}\n`);
  if (!preflight.canRun) return blockedExitCode(preflight);
  if (options.action === "check") return EXIT_CODES.success;

  const plan = (dependencies.buildExecutionPlanImpl || buildExecutionPlan)(options, runtimeDependencies);
  let processResult;
  try { processResult = await (dependencies.runProductionImpl || runProduction)(plan, dependencies); }
  catch (error) {
    stderr.write(`${JSON.stringify({ type: "runner_error", status: "failed", error: redactText(error?.message || error, dependencies.env || process.env) })}\n`);
    return EXIT_CODES.pipeline;
  }
  const productionReport = extractLastJsonObject(processResult.stdout);
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
  const notificationSchemaV2 = String(resolved.env.PAPERECHO_CONFIG_SCHEMA_VERSION || "") === "2";
  const recipient = String(options.email || resolved.env.PAPERFLOW_REPORT_TO || resolved.env.NOTIFICATION_EMAIL || "").trim();
  if (processResult.code !== 0 && notificationSchemaV2 && /^(1|true|yes|on)$/i.test(String(resolved.env.PAPERECHO_FAILURE_NOTIFIER_ENABLED || ""))) {
    const stage = failedStage(productionReport);
    if (stage !== "stage5") {
      try {
        const notified = await (dependencies.notifyRunFailureImpl || notifyRunFailure)({ runRoot: plan.runRoot, runId: plan.runId, failureStage: stage, errorCategory: String(productionReport?.status || "production_entry_failed"), recipient, env: resolved.env, fsApi: dependencies.fsApi });
        stdout.write(`${JSON.stringify({ type: "failure_notification", ...notificationSummary(notified) })}\n`);
      } catch (error) {
        stdout.write(`${JSON.stringify({ type: "failure_notification", status: "failed", reason: "notifier_internal_error" })}\n`);
      }
    }
  } else if (processResult.code === 0 && notificationSchemaV2 && /^(1|true|yes|on)$/i.test(String(resolved.env.PAPERECHO_HEALTH_NOTIFIER_ENABLED || ""))) {
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
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${JSON.stringify({ schemaVersion: 1, status: "runner_crash", error: redactText(error?.message || error) })}\n`);
    process.exitCode = EXIT_CODES.pipeline;
  });
}
