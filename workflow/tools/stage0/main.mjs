// Must be first import: sets review_results_OVERRIDE_DATE from --date= CLI arg before stage modules load.
import "../lib/date_override_bootstrap.mjs";
import "../lib/env_file_bootstrap.mjs";

// Pipeline directory set early by main() so the global unhandledRejection
// handler can write an emergency orchestrator report.
let _emergencyPipelineDir = null;

import fs from "node:fs/promises";
import nodeFsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { checkZoteroBackendReadyStage } from "./check_zotero_backend_ready.mjs";
import { finalizeResearchOsExports, markFinalizeExportsFailure } from "../stage4/main.mjs";
import { markWritebackFailure, runZoteroWriteback } from "../stage2/main.mjs";
import { markBackfillFailure, runZoteroTranslationBackfill } from "../stage3/main.mjs";
import { runResearchOsPipeline } from "../stage1/main.mjs";
import { buildRuntimeConfig, buildRuntimeSafetyConfig } from "../lib/runtime_config.mjs";
import { filterDesktopReviewSourceByWritebackSummary } from "../lib/pipeline_stage_support.mjs";
import { buildRunContext, buildOrchestratorReport, deriveWorkflowStatus, workflowStatusToExitCode } from "../lib/orchestrator_status.mjs";
import { ensureWorkflowStartupReady } from "../lib/workflow_startup_ready.mjs";
import { writeWorkflowPerformanceSummary } from "./performance_summary.mjs";
import { buildExportManifest, buildRunSummary, pipelineModeFromBackend } from "../lib/run_summary.mjs";
import { resolveStage5Request, runStage5Notification } from "../stage5/main.mjs";
import { receiptPathFor, recipientHash } from "../stage5/email_receipt.mjs";
import { canonicalQueryHash } from "../stage1/source_state.mjs";
import { claimScheduleDayDecision } from "../lib/schedule_support.mjs";
import { getDefaultZoteroLibraryIndexPath } from "../lib/zotero_library_index_store.mjs";
import { recordRadarNotificationOutcome, selectRadarNotificationCandidates } from "../radar/state.mjs";
import { claimWeeklyRadarWritebackCandidates } from "../stage1/weekly_merge_step.mjs";
import { radarNotificationReceiptPath, sendRadarAggregateNotification } from "../stage5/radar_notification.mjs";
import { createRunRecoveryCoordinator, resumeRunFromLedger, RunRecoveryCoordinator } from "../recovery/run_recovery.mjs";
import { acquireWorkflowLease, releaseRunLease } from "../recovery/operation_ledger.mjs";
import { buildZoteroRecoveryReconcilers } from "../recovery/zotero_reconciliation.mjs";
import { dayLabel, monthLabel } from "../lib/report_period_support.mjs";
import {
  finishRunGroup,
  releaseMonthlyAggregation,
  runRetentionCleanup,
  runStateRoot,
  startRunGroup,
  recordImmediateCleanup,
} from "../lib/runtime_housekeeping.mjs";
import { activateEphemeralRegistry, EphemeralRegistry } from "../lib/ephemeral_registry.mjs";
import {
  detectRunMode,
  evaluateOrchestratorIntervalGate,
  parseStage1Only,
  parseTriggerMode,
} from "./interval_gate.mjs";

const AUTOMATION_NAME = "zotero-literature-filter";

function iso(d) {
  return d.toISOString();
}

function artifactPath(config, name) {
  return `${config.pipelineDir}/${name}`;
}

function makeStage(name, scriptPath, handler) {
  return {
    name,
    command: `node ${scriptPath}`,
    scriptPath,
    handler,
  };
}

async function defaultRunStage(stage) {
  const originalWrite = process.stdout.write;
  const originalErrorWrite = process.stderr.write;
  let stdout = "";
  let stderr = "";
  process.stdout.write = function writeStdout(chunk, ...args) {
    stdout += String(chunk);
    return originalWrite.call(this, chunk, ...args);
  };
  process.stderr.write = function writeStderr(chunk, ...args) {
    stderr += String(chunk);
    return originalErrorWrite.call(this, chunk, ...args);
  };
  try {
    const data = await stage.handler();
    return { exitCode: 0, stdout, stderr, data };
  } catch (err) {
    const message = String(err?.stack || err?.message || err);
    stderr += message;
    try {
      if (stage.name === "stage2_writeback") await markWritebackFailure(err);
      if (stage.name === "stage3_translation") await markBackfillFailure(err);
      if (stage.name === "stage4_exports") await markFinalizeExportsFailure(err);
    } catch (markErr) {
      stderr += "\n[orchestrator] markFailure also threw: " + String(markErr?.message || markErr);
    }
    return { exitCode: stage.name === "stage3_translation" && /^partial_failed:/i.test(message) ? 2 : 1, stdout, stderr };
  } finally {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrorWrite;
  }
}

async function defaultStatArtifact(p) {
  try {
    const st = await fs.stat(p);
    return { exists: true, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, mtimeMs: null };
  }
}

async function defaultReadJson(p) {
  return JSON.parse(await fs.readFile(p, "utf8"));
}

async function defaultWriteReport(report) {
  await fs.mkdir(report.pipelineDir, { recursive: true });
  await fs.writeFile(`${report.pipelineDir}/orchestrator_report.json`, JSON.stringify(report, null, 2), "utf8");
}

async function defaultWriteJson(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), "utf8");
}

function trimLog(s) {
  const v = String(s || "").trim();
  return v.length <= 2000 ? v : `${v.slice(0, 2000)}...`;
}

async function inspectArtifact(key, fileName, stageStartedAt, config, statArtifact, readJson) {
  const p = artifactPath(config, fileName);
  const stat = await statArtifact(p);
  const stageStartMs = Date.parse(stageStartedAt);
  const stale = stat.exists ? !(Number(stat.mtimeMs) >= stageStartMs) : true;
  let data = null;
  if (stat.exists && !stale) {
    try {
      data = await readJson(p);
    } catch {
      data = null;
    }
  }
  return {
    key,
    path: p,
    exists: Boolean(stat.exists),
    mtimeMs: stat.mtimeMs ?? null,
    stale,
    currentRun: Boolean(stat.exists && !stale),
    data,
  };
}

function skippedStage(name, scriptPath, skipReason, clock) {
  const at = iso(clock());
  return {
    name,
    command: `node ${scriptPath}`,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    exitCode: null,
    status: "skipped",
    skipReason,
  };
}

async function executeStage(stage, runStage, clock) {
  const started = clock();
  const startedAt = iso(started);
  const result = await runStage(stage);
  const finished = clock();
  const finishedAt = iso(finished);
  return {
    name: stage.name,
    command: stage.command,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finished.getTime() - started.getTime()),
    exitCode: Number(result.exitCode ?? 1),
    status: Number(result.exitCode ?? 1) === 0 ? "completed" : "failed",
    stdout: trimLog(result.stdout),
    stderr: trimLog(result.stderr),
    data: result.data || null,
  };
}

export async function runZoteroLiteratureFilter({
  config = buildRuntimeConfig(),
  runStage = defaultRunStage,
  runCommand = null,
  ensureStartupReady = ensureWorkflowStartupReady,
  statArtifact = defaultStatArtifact,
  readJson = defaultReadJson,
  writeReport = defaultWriteReport,
  writeJson = defaultWriteJson,
  triggerMode = parseTriggerMode(),
  runMode = detectRunMode(),
  clock = () => new Date(),
  stage1Only = parseStage1Only(),
  stage2Recovery = null,
  argv = process.argv.slice(2),
  env = process.env,
  stage5Runner = runStage5Notification,
  radarStage5Runner = sendRadarAggregateNotification,
  scheduleDecisionClaimer = claimScheduleDayDecision,
  runId = `zlf-${Date.now()}-${randomUUID().slice(0, 8)}`,
  recoveryCoordinator = null,
} = {}) {
  const startedAt = iso(clock());
  const profile = String(env.PAPERECHO_RUN_PROFILE || "standard").trim().toLowerCase();
  const radarProfile = profile === "radar";
  const manualTrigger = runMode.isManualOrForce;
  const runtimeSafety = buildRuntimeSafetyConfig({ runtime: config });
  const dryRun = Boolean(runtimeSafety.dry_run);
  const runContext = buildRunContext({
    automationName: AUTOMATION_NAME,
    runId,
    platform: config.platform || process.platform,
    startedAt,
    triggerMode,
    runMode,
    manualTrigger,
    pipelineDir: config.pipelineDir,
  });
  const stages = [];
  const artifacts = {};
  let startup = null;
  const runRoot = path.join(config.reviewRoot, "runs");
  let runGroupManifestPath = "";
  const monthlyAggregationApplicable = !radarProfile;
  let monthlyAggregationCompleted = false;
  let notificationHealthObservations = [];
  let runGroupPipelineMode = pipelineModeFromBackend(env.ZOTERO_BACKEND);
  let housekeeping = { skipped: true, reason: "not_started", warnings: [] };
  const ephemeralRegistry = new EphemeralRegistry({ allowedRoots: [os.tmpdir(), config.researchRoot, config.reviewRoot] });
  const restoreEphemeralRegistry = activateEphemeralRegistry(ephemeralRegistry);
  let ephemeralCleanupDone = false;
  const runArtifacts = [
    { kind: "run_state", rootKey: "runs", path: runId, retention: "protected" },
    { kind: "pipeline", rootKey: "research", path: path.relative(config.researchRoot, config.pipelineDir), retention: "30d" },
    ...(!radarProfile ? [{ kind: "weekly_export", rootKey: "review", path: path.join(monthLabel(config.now), dayLabel(config.now)), retention: "30d" }] : []),
  ];
  try {
    const group = await startRunGroup({
      runRoot,
      runId,
      pipelineMode: runGroupPipelineMode,
      startedAt,
      artifacts: runArtifacts,
      references: { monthlyAggregationPending: monthlyAggregationApplicable },
    });
    runGroupManifestPath = group.manifestPath;
    housekeeping = await runRetentionCleanup({
      runtimeRoot: config.researchRoot,
      runRoot,
      allowedRoots: { runs: runRoot, research: config.researchRoot, review: config.reviewRoot },
      legacyRoots: [path.join(config.researchRoot, "pipeline")],
      repoRoot: config.repoRoot,
      currentRunId: runId,
      env,
    });
  } catch (error) {
    housekeeping = { skipped: true, reason: "housekeeping_start_failed", warnings: [String(error?.message || error)] };
  }
  const completeRunGroup = async (report) => {
    if (report && typeof report === "object") report.notification_health_observations = notificationHealthObservations;
    if (!ephemeralCleanupDone) {
      ephemeralCleanupDone = true;
      try {
        const immediate = await ephemeralRegistry.cleanup({ success: !String(report?.status || "").includes("failed") });
        Object.assign(housekeeping, {
          immediateDeletedFiles: immediate.immediateDeletedFiles,
          immediateDeletedBytes: immediate.immediateDeletedBytes,
          immediateFailedCount: immediate.immediateFailedCount,
          immediateSamples: immediate.samples,
          registeredEphemeralsRemaining: immediate.registeredRemaining,
        });
        housekeeping.warnings = [...(housekeeping.warnings || []), ...(immediate.warnings || [])].slice(0, 10);
        await recordImmediateCleanup({ runtimeRoot: config.researchRoot, summary: immediate });
      } catch (error) {
        housekeeping.warnings = [...(housekeeping.warnings || []), String(error?.message || error)];
      } finally {
        restoreEphemeralRegistry();
      }
      if (report && typeof report === "object") report.housekeeping = housekeeping;
    }
    if (runGroupManifestPath) {
      try {
        await finishRunGroup({
          manifestPath: runGroupManifestPath,
          status: String(report?.status || "").includes("failed") ? "failed" : "completed",
          finishedAt: report?.finishedAt || iso(clock()),
          pipelineMode: runGroupPipelineMode,
          monthlyAggregationPending: monthlyAggregationApplicable && !monthlyAggregationCompleted,
        });
        if (monthlyAggregationApplicable && monthlyAggregationCompleted) await releaseMonthlyAggregation({ runRoot, monthPrefix: startedAt.slice(0, 7), monthArtifactPrefix: monthLabel(config.now) });
      } catch (error) {
        housekeeping.warnings = [...(housekeeping.warnings || []), String(error?.message || error)];
      }
    }
    if (recoveryCoordinator) {
      const allVerified = recoveryCoordinator.store.ledger.operations.every((operation) => operation.status === "verified");
      const reportStatus = String(report?.status || "");
      await recoveryCoordinator.store.setRunStatus(reportStatus === "skipped" ? "skipped" : reportStatus.includes("failed") ? "failed" : allVerified ? "completed" : "incomplete");
    }
    return report;
  };
  const baseStageRunner = runCommand
    ? async (stage) => runCommand(stage, config)
    : runStage;
  const runSameProcessStage = async (stage) => {
    const originalForceRun = process.env.review_results_FORCE_RUN;
    const originalLegacyForceRun = process.env.FORCE_review_results_RUN;
    const originalTrigger = process.env.review_results_ORCHESTRATOR_TRIGGER;
    const originalRunId = process.env.review_results_RUN_ID;
    const originalPaperEchoRunId = process.env.PAPERECHO_RUN_ID;
    const originalProfile = process.env.PAPERECHO_RUN_PROFILE;
    if (manualTrigger) {
      process.env.review_results_FORCE_RUN = "true";
      process.env.FORCE_review_results_RUN = "true";
      process.env.review_results_ORCHESTRATOR_TRIGGER = "manual";
    }
    process.env.review_results_RUN_ID = runId;
    process.env.PAPERECHO_RUN_ID = runId;
    process.env.PAPERECHO_RUN_PROFILE = profile;
    try {
      return await baseStageRunner(stage);
    } finally {
      if (originalForceRun === undefined) delete process.env.review_results_FORCE_RUN;
      else process.env.review_results_FORCE_RUN = originalForceRun;
      if (originalLegacyForceRun === undefined) delete process.env.FORCE_review_results_RUN;
      else process.env.FORCE_review_results_RUN = originalLegacyForceRun;
      if (originalTrigger === undefined) delete process.env.review_results_ORCHESTRATOR_TRIGGER;
      else process.env.review_results_ORCHESTRATOR_TRIGGER = originalTrigger;
      if (originalRunId === undefined) delete process.env.review_results_RUN_ID;
      else process.env.review_results_RUN_ID = originalRunId;
      if (originalPaperEchoRunId === undefined) delete process.env.PAPERECHO_RUN_ID;
      else process.env.PAPERECHO_RUN_ID = originalPaperEchoRunId;
      if (originalProfile === undefined) delete process.env.PAPERECHO_RUN_PROFILE;
      else process.env.PAPERECHO_RUN_PROFILE = originalProfile;
    }
  };
  const toolsDir = path.join(config.repoRoot, "workflow", "tools");
  const scriptPaths = {
    stage1: config.scripts?.stage1 || path.join(toolsDir, "stage1", "main.mjs"),
    zoteroReady: config.scripts?.zoteroReady || path.join(toolsDir, "stage0", "check_zotero_backend_ready.mjs"),
    stage2: config.scripts?.stage2 || path.join(toolsDir, "stage2", "main.mjs"),
    stage3: config.scripts?.stage3 || path.join(toolsDir, "stage3", "main.mjs"),
    stage4: config.scripts?.stage4 || path.join(toolsDir, "stage4", "main.mjs"),
  };
  try {
  const stageDefs = {
    stage1: makeStage("stage1", scriptPaths.stage1, () => runResearchOsPipeline()),
    zoteroBackendReady: makeStage("zotero_backend_ready", scriptPaths.zoteroReady, () => checkZoteroBackendReadyStage()),
    stage2: makeStage("stage2_writeback", scriptPaths.stage2, () => runZoteroWriteback({ recovery: recoveryCoordinator || stage2Recovery })),
    stage3: makeStage("stage3_translation", scriptPaths.stage3, () => runZoteroTranslationBackfill({ recovery: recoveryCoordinator })),
    stage4: makeStage("stage4_exports", scriptPaths.stage4, () => finalizeResearchOsExports()),
  };

  const intervalGate = await evaluateOrchestratorIntervalGate(config, () => new Date(startedAt), readJson, { triggerMode });
  const skipReport = intervalGate.skipReport;
  const intervalGateDiagnostics = intervalGate.diagnostics;
  const scheduledTrigger = new Set(["scheduled", "background"]).has(String(triggerMode || "").toLowerCase());
  let scheduleDecision = null;
  if (scheduledTrigger && (radarProfile || !skipReport)) {
    scheduleDecision = await scheduleDecisionClaimer({
      stateRoot: path.join(config.researchRoot, "schedule_decisions"),
      now: new Date(startedAt),
      weeklyDue: !skipReport,
      requestedProfile: radarProfile ? "radar" : "weekly",
      runId,
    });
  }
  const radarTakenOver = radarProfile && scheduleDecision?.decision === "weekly_takeover";
  const duplicateScheduledRun = Boolean(scheduleDecision?.duplicateTrigger && scheduleDecision.businessRunId !== runId);
  if ((skipReport && !radarProfile) || radarTakenOver || duplicateScheduledRun) {
    const scheduleSkipReason = radarTakenOver ? "weekly_takeover" : duplicateScheduledRun ? "duplicate_schedule_trigger" : "interval_not_reached";
    stages.push(skippedStage(stageDefs.stage1.name, stageDefs.stage1.scriptPath, "interval_not_reached", () => new Date(startedAt)));
    stages.at(-1).skipReason = scheduleSkipReason;
    stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, scheduleSkipReason, () => new Date(startedAt)));
    stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, scheduleSkipReason, () => new Date(startedAt)));
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, scheduleSkipReason, () => new Date(startedAt)));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, scheduleSkipReason, () => new Date(startedAt)));
    const effectiveSkipReport = skipReport || { skipped: true, skipped_due_to_interval: false, reason: scheduleSkipReason };
    await writeJson(`${config.pipelineDir}/run_skip_report.json`, { ...effectiveSkipReport, schedule_decision: scheduleDecision, reason: scheduleSkipReason });
    await writeJson(`${config.pipelineDir}/run_report.json`, { ...effectiveSkipReport, schedule_decision: scheduleDecision, reason: scheduleSkipReason });
    const report = buildOrchestratorReport({
      status: "skipped",
      runContext,
      finishedAt: startedAt,
      stages,
      artifacts,
      extra: { skipReport: effectiveSkipReport, schedule_decision: scheduleDecision, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }

  try {
    startup = radarProfile
      ? { ok: true, skipped: true, strategy: "radar_no_zotero_startup" }
      : dryRun
      ? { ok: true, skipped_due_to_dry_run: true, strategy: "dry_run_no_external_startup" }
      : await ensureStartupReady();
  } catch (err) {
    startup = {
      ok: false,
      errorCode: err?.code || "UNKNOWN",
      error: String(err?.message || err),
      failureClass: err?.details?.failureClass || null,
      details: err?.details || null,
    };
    stages.push(skippedStage(stageDefs.stage1.name, stageDefs.stage1.scriptPath, "startup_failed", clock));
    stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, "startup_failed", clock));
    stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, "startup_failed", clock));
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, "startup_failed", clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, "startup_failed", clock));
    const report = buildOrchestratorReport({
      status: "failed_due_to_config_or_dependency",
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }

  stages.push(await executeStage(stageDefs.stage1, runSameProcessStage, clock));
  notificationHealthObservations = Array.isArray(stages.at(-1).data?.report?.notification_health_observations) ? stages.at(-1).data.report.notification_health_observations : [];
  if (stage1Only && stages.at(-1).exitCode === 0) {
    stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, "stage1_only_mode", clock));
    stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, "stage1_only_mode", clock));
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, "stage1_only_mode", clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, "stage1_only_mode", clock));
    const report = buildOrchestratorReport({
      status: "completed_stage1_only",
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { stage1Only: true, startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }
  if (stages.at(-1).exitCode !== 0) {
    stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, "stage1_failed", clock));
    stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, "stage1_failed", clock));
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, "stage1_failed", clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, "stage1_failed", clock));
    const report = buildOrchestratorReport({
      status: "failed_stage1",
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }

  if (radarProfile) {
    const radarResult = stages.at(-1).data?.radar || null;
    const radarAuditPath = String(radarResult?.auditPath || "");
    const radarAuditStat = radarAuditPath ? await statArtifact(radarAuditPath) : { exists: false, mtimeMs: 0 };
    const radarAuditFresh = Boolean(radarAuditStat.exists && Number(radarAuditStat.mtimeMs || 0) >= Date.parse(stages.at(-1).startedAt));
    artifacts.radar_audit = { key: "radar_audit", path: radarAuditPath || null, exists: Boolean(radarAuditStat.exists), currentRun: radarAuditFresh, stale: !radarAuditFresh, data: radarResult?.audit || null };
    if (!radarAuditFresh || radarResult?.audit?.zoteroWriteCount !== 0 || radarResult?.audit?.xlsxWriteCount !== 0) {
      stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, "radar_audit_invalid", clock));
      stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, "radar_audit_invalid", clock));
      stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, "radar_audit_invalid", clock));
      stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, "radar_audit_invalid", clock));
      const report = buildOrchestratorReport({ status: "failed_stage1", runContext, finishedAt: iso(clock()), stages, artifacts, extra: { startup, schedule_decision: scheduleDecision, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety } });
      await writeReport(report);
      return await completeRunGroup(report);
    }
    if (recoveryCoordinator) {
      await recoveryCoordinator.bindArtifact(radarAuditPath, stages.at(-1).data?.triagedAll || []);
      await recoveryCoordinator.store.setStage("stage1", "verified", { artifactHash: recoveryCoordinator.store.ledger.artifact.hash, identityCount: Number(radarResult.audit.candidateCount || 0) });
    }
    stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, "radar_no_writeback", clock));
    stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, "radar_no_writeback", clock));
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, "radar_no_writeback", clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, "radar_json_only", clock));
    if (recoveryCoordinator) {
      await recoveryCoordinator.store.setStage("stage2_writeback", "skipped", { reason: "radar_no_writeback" });
      await recoveryCoordinator.store.setStage("stage3_translation", "skipped", { reason: "radar_no_writeback" });
      await recoveryCoordinator.store.setStage("stage4_exports", "skipped", { reason: "radar_json_only" });
    }
    const urgentItems = Array.isArray(radarResult.urgentItems) ? radarResult.urgentItems : [];
    const indexPath = getDefaultZoteroLibraryIndexPath(config.projectRoot);
    const notificationSelection = await selectRadarNotificationCandidates(indexPath, urgentItems);
    const selectedItems = notificationSelection.selected.map((entry) => entry.item);
    const stage5Request = resolveStage5Request(argv, env);
    const stage5StateRoot = runStateRoot(runRoot, runId);
    const receiptPath = radarNotificationReceiptPath(stage5StateRoot, runId, selectedItems);
    const notificationOperation = recoveryCoordinator && selectedItems.length && stage5Request.recipient
      ? await recoveryCoordinator.prepareFileOperation({ type: "notification", targetId: "radar_business", targetPath: receiptPath, input: { fingerprints: notificationSelection.selected.map((entry) => entry.fingerprint) }, retryable: false, intent: { notificationType: "radar_business", eventEpoch: runId } })
      : null;
    const stage5Notification = await radarStage5Runner({ runId, urgentItems: selectedItems, recipient: stage5Request.recipient, runStateRoot: stage5StateRoot, env, ledgerOperationId: notificationOperation?.idempotencyKey || "" });
    await recordRadarNotificationOutcome(indexPath, notificationSelection.selected, stage5Notification, { generatedAt: iso(clock()) });
    if (notificationOperation && stage5Notification.status === "accepted") {
      await recoveryCoordinator.completeNotification(notificationOperation, { ...stage5Notification, receiptStatus: "accepted", messageId: stage5Notification.receipt?.messageId || "" });
      await recoveryCoordinator.store.setStage("stage5_notification", "verified", { status: "accepted" });
    } else if (notificationOperation && stage5Notification.status === "unknown") {
      await recoveryCoordinator.store.transition(notificationOperation.idempotencyKey, "remote_observed", { verification: { possibleAccepted: true } });
      await recoveryCoordinator.store.setStage("stage5_notification", "failed", { status: "unknown" });
    } else if (notificationOperation && stage5Notification.status === "failed") {
      await recoveryCoordinator.store.transition(notificationOperation.idempotencyKey, "failed", { error: `RADAR_NOTIFICATION_${String(stage5Notification.reason || "failed").toUpperCase()}` });
      await recoveryCoordinator.store.setStage("stage5_notification", "failed", { status: "failed" });
    } else if (recoveryCoordinator) {
      await recoveryCoordinator.store.setStage("stage5_notification", "verified", { status: "skipped", reason: stage5Notification.reason });
    }
    const finalStatus = stage5Notification.status === "failed" ? "failed_stage5_notification" : stage5Notification.status === "unknown" ? "completed_with_warnings" : "completed";
    const report = buildOrchestratorReport({
      status: finalStatus,
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { startup, schedule_decision: scheduleDecision, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety, radar_notification_selection: { selected: selectedItems.length, suppressed: notificationSelection.suppressed.length } },
    });
    report.steps = { ...(report.steps || {}), stage5_notification: stage5Notification };
    await writeReport(report);
    return await completeRunGroup(report);
  }

  // Guard: Stage1 returned exitCode=0 but may have skipped internally
  // (e.g., interval race). Verify critical artifact exists before continuing.
  const stage1Artifacts = await inspectArtifact("writeback_ready", "writeback_ready_items.json", stages.at(-1).startedAt, config, statArtifact, readJson);
  if (!stage1Artifacts.currentRun) {
    const reason = stage1Artifacts.exists ? "stage1_artifacts_stale" : "stage1_artifacts_missing";
    // Try to detect Stage 1 internal skip from its skip report
    let internalSkipDetected = false;
    try {
      const skipData = await readJson(path.join(config.pipelineDir, "run_skip_report.json"));
      internalSkipDetected = skipData?.skipped === true;
    } catch {
      // skip report missing/unreadable — not an internal skip
    }
    const stage1ArtifactReason = internalSkipDetected
      ? "stage1_internal_skip"
      : reason;
    stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, reason, clock));
    stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, reason, clock));
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, reason, clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, reason, clock));
    const report = buildOrchestratorReport({
      status: "failed_stage1",
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts: { ...artifacts, writeback_ready: stage1Artifacts },
      extra: {
        startup,
        interval_gate_diagnostics: intervalGateDiagnostics,
        runtimeSafety,
        stage1_artifact_reason: stage1ArtifactReason,
        stage1_artifact_check: { exists: stage1Artifacts.exists, currentRun: stage1Artifacts.currentRun, reason },
      },
    });
    report.stage1_artifact_reason = stage1ArtifactReason;
    await writeReport(report);
    return await completeRunGroup(report);
  }
  if (recoveryCoordinator) {
    let artifactItems = Array.isArray(stage1Artifacts.data) ? stage1Artifacts.data : [];
    await recoveryCoordinator.persistArtifact(stage1Artifacts.data, artifactItems);
    if (!radarProfile) {
      const claimPreparation = await claimWeeklyRadarWritebackCandidates({ items: artifactItems, runId });
      artifacts.weekly_radar_claims = {
        claimedCount: claimPreparation.claimedCount,
        conflictCount: claimPreparation.conflictCount,
        conflicts: claimPreparation.conflicts.slice(0, 20),
      };
      if (claimPreparation.claimedCount || claimPreparation.conflictCount) {
        artifactItems = claimPreparation.items;
        stage1Artifacts.data = artifactItems;
        await writeJson(stage1Artifacts.path, artifactItems);
        await recoveryCoordinator.persistArtifact(artifactItems, artifactItems);
      }
    }
    await recoveryCoordinator.store.setStage("stage1", "verified", { artifactHash: recoveryCoordinator.store.ledger.artifact.hash, identityCount: artifactItems.length });
  }

  if (dryRun) {
    stages.push(skippedStage(stageDefs.zoteroBackendReady.name, stageDefs.zoteroBackendReady.scriptPath, "dry_run", clock));
  } else {
    stages.push(await executeStage(stageDefs.zoteroBackendReady, runSameProcessStage, clock));
  }
  if (!dryRun && stages.at(-1).exitCode === 0) runGroupPipelineMode = pipelineModeFromBackend(stages.at(-1).data?.backend || env.ZOTERO_BACKEND);
  if (!dryRun && stages.at(-1).exitCode !== 0) {
    stages.push(skippedStage(stageDefs.stage2.name, stageDefs.stage2.scriptPath, "zotero_backend_ready_failed", clock));
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, "zotero_backend_ready_failed", clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, "zotero_backend_ready_failed", clock));
    const stage1Ok = stages.find((s) => s.name === "stage1")?.exitCode === 0;
    const backendNotReadyStatus = stage1Ok ? "degraded_due_to_zotero_backend_unavailable" : "failed_stage1";
    const report = buildOrchestratorReport({
      status: backendNotReadyStatus,
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }

  const stage2 = await executeStage(stageDefs.stage2, runSameProcessStage, clock);
  stages.push(stage2);
  const writebackSummaryFile = dryRun ? "zotero_writeback_dry_run_summary.json" : "zotero_writeback_summary.json";
  artifacts.writeback_summary = await inspectArtifact("writeback_summary", writebackSummaryFile, stage2.startedAt, config, statArtifact, readJson);
  if (!artifacts.writeback_summary.currentRun) {
    const legacyWritebackSummaryFile = dryRun ? "mcp_writeback_dry_run_summary.json" : "mcp_writeback_summary.json";
    const legacyWritebackSummary = await inspectArtifact("writeback_summary_legacy", legacyWritebackSummaryFile, stage2.startedAt, config, statArtifact, readJson);
    if (legacyWritebackSummary.currentRun) {
      artifacts.writeback_summary = {
        ...legacyWritebackSummary,
        key: "writeback_summary",
        legacyArtifactName: legacyWritebackSummaryFile,
        preferredArtifactName: writebackSummaryFile,
      };
    }
  }
  if (stage2.exitCode !== 0 || !artifacts.writeback_summary.currentRun) {
    const reason = stage2.exitCode !== 0 ? "stage2_failed" : "writeback_summary_stale_or_missing";
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, reason, clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, reason, clock));
    const report = buildOrchestratorReport({
      status: "failed_stage2_writeback",
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }

  if (dryRun) {
    stages.push(skippedStage(stageDefs.stage3.name, stageDefs.stage3.scriptPath, "dry_run", clock));
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, "dry_run", clock));
    const report = buildOrchestratorReport({
      status: "completed_stage1_only",
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }

  // Filter desktop_daily_review_source.json to only include Stage 2 writeback items
  let desktopSourceFilterResult = null;
  try {
    const desktopSrcPath = `${config.pipelineDir}/desktop_daily_review_source.json`;
    const desktopSrc = await readJson(desktopSrcPath);
    const writebackData = artifacts.writeback_summary.data;
    desktopSourceFilterResult = filterDesktopReviewSourceByWritebackSummary(desktopSrc, writebackData);
    if (desktopSourceFilterResult.status !== "ok") {
      console.warn(`[orchestrator] desktop review source filter: ${desktopSourceFilterResult.status} - ${desktopSourceFilterResult.warning}`);
    }
    await writeJson(desktopSrcPath, desktopSourceFilterResult.source);
  } catch (e) {
    console.error(`[orchestrator] failed to filter desktop review source: ${String(e?.message || e).slice(0, 200)}`);
    desktopSourceFilterResult = { status: "filter_error", warning: String(e?.message || e).slice(0, 200), candidateCount: 0, writebackItemCount: 0, keptCount: 0, unmatchedCandidateCount: 0, unmatchedWritebackCount: 0, ambiguousCandidateKeyCount: 0, ambiguousWritebackKeyCount: 0 };
  }
  artifacts.desktop_source_filter = desktopSourceFilterResult;

  const stage3 = await executeStage(stageDefs.stage3, runSameProcessStage, clock);
  artifacts.translation_backfill = await inspectArtifact("translation_backfill", "abc_translation_backfill.json", stage3.startedAt, config, statArtifact, readJson);
  const stage3FailureCount = Number(artifacts.translation_backfill.data?.failure_count || 0);
  if (stage3.exitCode === 2 || (stage3.exitCode === 0 && stage3FailureCount > 0)) {
    stage3.status = "partial_failed";
  }
  stages.push(stage3);

  if ((stage3.exitCode !== 0 && stage3.exitCode !== 2) || !artifacts.translation_backfill.currentRun) {
    const reason = stage3.exitCode !== 0 && stage3.exitCode !== 2 ? "stage3_failed" : "translation_backfill_stale_or_missing";
    stages.push(skippedStage(stageDefs.stage4.name, stageDefs.stage4.scriptPath, reason, clock));
    const report = buildOrchestratorReport({
      status: "failed_stage3_translation",
      runContext,
      finishedAt: iso(clock()),
      stages,
      artifacts,
      extra: { startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety },
    });
    await writeReport(report);
    return await completeRunGroup(report);
  }

  const exportOperation = recoveryCoordinator
    ? await recoveryCoordinator.prepareFileOperation({ type: "export", targetId: "stage4_weekly_export", targetPath: path.join(config.reviewRoot, monthLabel(config.now), dayLabel(config.now), "周报.xlsx"), input: { artifactHash: recoveryCoordinator.store.ledger.artifact.hash }, retryable: false })
    : null;
  const stage4 = await executeStage(stageDefs.stage4, runSameProcessStage, clock);
  artifacts.stage4_run_report = await inspectArtifact("stage4_run_report", "run_report.json", stage4.startedAt, config, statArtifact, readJson);
  const stage4ExportAudit = artifacts.stage4_run_report.data?.steps?.stage4_export_audit || null;
  monthlyAggregationCompleted = Boolean(stage4ExportAudit?.monthly_docx_report_generated);
  const stage4OutputPath = String(stage4ExportAudit?.actual_output_path || stage4ExportAudit?.requested_output_path || "").trim();
  const stage4OutputStat = stage4OutputPath ? await statArtifact(stage4OutputPath) : { exists: false, mtimeMs: null };
  const stage4OutputFresh = Boolean(stage4OutputStat.exists && Number(stage4OutputStat.mtimeMs ?? 0) >= Date.parse(stage4.startedAt));
  const stage4ReportFresh = Boolean(artifacts.stage4_run_report.currentRun);
  const stage4AuditFresh = Boolean(stage4ExportAudit && stage4ExportAudit.stage4_export_status === "success");
  artifacts.stage4_export_audit = stage4ExportAudit;
  artifacts.stage4_output = {
    path: stage4OutputPath || null,
    exists: Boolean(stage4OutputStat.exists),
    mtimeMs: stage4OutputStat.mtimeMs ?? null,
    fresh: stage4OutputFresh,
  };
  if (stage4.exitCode === 0 && (!stage4ReportFresh || !stage4AuditFresh || !stage4OutputFresh)) {
    stage4.exitCode = 1;
    stage4.status = "failed";
    stage4.stderr = trimLog(`${stage4.stderr}\n[orchestrator] stage4 postcheck failed: reportFresh=${stage4ReportFresh} auditFresh=${stage4AuditFresh} outputFresh=${stage4OutputFresh} outputPath=${stage4OutputPath || "null"}`);
  }
  if (stage4.exitCode === 0 && exportOperation) {
    await recoveryCoordinator.completeFileOperation(exportOperation, stage4OutputPath, { stage4ReportFresh, stage4AuditFresh });
    await recoveryCoordinator.store.setStage("stage4_exports", "verified", { outputPath: stage4OutputPath });
  }
  stages.push(stage4);
  const stage4Ok = stages.at(-1).exitCode === 0;
  let stage5Notification = { status: "skipped", reason: "stage4_not_completed", attachments: [] };
  if (stage4Ok) {
    const stage5Request = resolveStage5Request(argv, env);
    const stage5StateRoot = runStateRoot(runRoot, runId);
    const notificationOperation = recoveryCoordinator && stage5Request.recipient
      ? await recoveryCoordinator.prepareFileOperation({ type: "notification", targetId: recipientHash(stage5Request.recipient), targetPath: receiptPathFor(stage5StateRoot), input: { runId, notificationType: "run_summary", artifactHash: recoveryCoordinator.store.ledger.artifact.hash }, retryable: false, intent: { notificationType: "run_summary", eventEpoch: runId } })
      : null;
    let stage4RunSummary = stage4.data?.runSummary || null;
    let literatureItems = stage4.data?.literatureItems || null;
    const resolvedBackend = stages.find((stage) => stage.name === "zotero_backend_ready")?.data?.backend || env.ZOTERO_BACKEND || artifacts.stage4_run_report.data?.backend_selected;
    if (!stage4RunSummary) {
      const exportManifest = await buildExportManifest(stage4ExportAudit, { outputRoot: stage4ExportAudit.export_root || config.reviewRoot });
      literatureItems = (artifacts.writeback_summary?.data?.writeback_items || []).map((item) => ({ title: item.title || "", grade: item.final_grade || item.grade || item.effective_grade || "" }));
      stage4RunSummary = buildRunSummary({
        runId,
        pipelineMode: pipelineModeFromBackend(resolvedBackend),
        status: "success",
        startedAt,
        finishedAt: iso(clock()),
        runReport: artifacts.stage4_run_report.data || {},
        createdItems: literatureItems,
        artifacts: exportManifest.artifacts,
        outputRoot: exportManifest.outputRoot,
      });
    }
    stage4RunSummary = { ...stage4RunSummary, pipelineMode: pipelineModeFromBackend(resolvedBackend), finishedAt: stage4RunSummary.finishedAt || iso(clock()) };
    stage5Notification = await stage5Runner({ runSummary: stage4RunSummary, literatureItems: literatureItems || [], recipient: stage5Request.recipient, forceResend: stage5Request.forceResend, config: { runStateRoot: stage5StateRoot, ledgerOperationId: notificationOperation?.idempotencyKey || "" } });
    if (notificationOperation && (stage5Notification.status === "sent" || (stage5Notification.status === "skipped" && stage5Notification.reason === "already_sent"))) {
      await recoveryCoordinator.completeNotification(notificationOperation, stage5Notification);
      await recoveryCoordinator.store.setStage("stage5_notification", "verified", { status: stage5Notification.status });
    } else if (notificationOperation) {
      await recoveryCoordinator.store.transition(notificationOperation.idempotencyKey, "failed", { error: `STAGE5_${String(stage5Notification.status || "unknown").toUpperCase()}` });
      await recoveryCoordinator.store.setStage("stage5_notification", "failed", { status: stage5Notification.status });
    } else if (recoveryCoordinator) {
      await recoveryCoordinator.store.setStage("stage5_notification", "verified", { status: "skipped", reason: stage5Notification.reason });
    }
  }
  try {
    const performance = await writeWorkflowPerformanceSummary({
      pipelineDir: config.pipelineDir,
      runContext,
      stages,
      artifacts,
      readJson,
    });
    artifacts.performance_summary = {
      key: "performance_summary",
      path: performance.jsonPath,
      text_path: performance.textPath,
      exists: true,
      stale: false,
      currentRun: true,
      data: performance.summary,
    };
  } catch (e) {
    artifacts.performance_summary = {
      key: "performance_summary",
      exists: false,
      stale: true,
      currentRun: false,
      error: String(e?.message || e).slice(0, 200),
    };
  }
  const finalStatus = deriveWorkflowStatus({
    explicitStatus: stage4Ok && ["sent", "skipped"].includes(stage5Notification.status) ? "completed" : stage4Ok ? "failed_stage5_notification" : "failed_stage4_export",
    stages,
    artifacts,
  });
  const report = buildOrchestratorReport({
    status: finalStatus,
    runContext,
    finishedAt: iso(clock()),
    stages,
    artifacts,
    extra: { startup, interval_gate_diagnostics: intervalGateDiagnostics, runtimeSafety, housekeeping },
  });
  report.steps = { ...(report.steps || {}), stage5_notification: stage5Notification };
  await writeReport(report);
  return await completeRunGroup(report);
  } catch (error) {
    await completeRunGroup({ status: "failed_unhandled", finishedAt: iso(clock()) });
    throw error;
  }
}

async function main() {
  const runMode = detectRunMode();
  let orchestratorReportWritten = false;
  process.env.review_results_ORCHESTRATOR_TRIGGER = runMode.triggerMode;
  if (runMode.isManualOrForce) {
    process.env.review_results_FORCE_RUN = "true";
    process.env.FORCE_review_results_RUN = "true";
  }
  const dateArg = (process.argv || []).find((x) => x.startsWith("--date="));
  const overrideDateStr = dateArg ? dateArg.split("=")[1] : undefined;
  if (overrideDateStr) {
    process.env.review_results_OVERRIDE_DATE = overrideDateStr;
  }
  const overrideNow = overrideDateStr ? new Date(overrideDateStr) : undefined;
  const config = overrideNow ? buildRuntimeConfig({ now: overrideNow }) : buildRuntimeConfig();
  _emergencyPipelineDir = config.pipelineDir;
  let report;
  let attemptedResumeRunId = "";
  let workflowLease = null;
  try {
    const resumeToken = (process.argv || []).find((value) => value === "--resume" || String(value).startsWith("--resume="));
    const resumeIndex = (process.argv || []).indexOf("--resume");
    const resumeRunId = resumeToken
      ? (String(resumeToken).startsWith("--resume=") ? String(resumeToken).slice("--resume=".length) : String(process.argv[resumeIndex + 1] || ""))
      : "";
    attemptedResumeRunId = resumeRunId;
    if (resumeRunId && !/-fixed-launcher\/runner$/.test(String(process.env.PAPERECHO_LAUNCHER_ID || ""))) throw new Error("RECOVERY_CONTROLLED_LAUNCHER_REQUIRED");
    const pipelineMode = pipelineModeFromBackend(process.env.ZOTERO_BACKEND);
    const profile = String(process.env.PAPERECHO_RUN_PROFILE || "standard");
    const configHash = String(process.env.PAPERECHO_CONFIG_HASH || canonicalQueryHash({ mode: pipelineMode, profile, repoRoot: config.repoRoot, projectRoot: config.projectRoot }));
    const inputHash = String(process.env.PAPERECHO_INPUT_HASH || canonicalQueryHash({ mode: pipelineMode, profile }));
    const runRoot = path.join(config.reviewRoot, "runs");
    const targetRunId = resumeRunId || String(process.env.PAPERECHO_RUN_ID || `zlf-${Date.now()}-${randomUUID().slice(0, 8)}`);
    workflowLease = await acquireWorkflowLease({ runRoot, runId: targetRunId, profile });
    if (!workflowLease.acquired) {
      report = { runId: targetRunId, run_id: targetRunId, status: "skipped", reason: workflowLease.reason || "active_workflow_lease", profile };
      orchestratorReportWritten = true;
    } else if (resumeRunId) {
      report = await resumeRunFromLedger({
        runRoot,
        runId: resumeRunId,
        mode: pipelineMode,
        profile,
        configHash,
        inputHash: "",
        beforeReconcile: async ({ store, artifact }) => {
          const items = Array.isArray(artifact) ? artifact : [];
          const hasRadarClaimIntent = items.some((item) => item?.weekly_radar_queue_claim_intent || item?.weekly_radar_queue_claim);
          const hasStage2Operations = store.ledger.operations.some((operation) => ["zotero_item_create", "zotero_collection_add", "radar_queue_consume"].includes(operation.type));
          if (!hasRadarClaimIntent || hasStage2Operations) return { artifact: items };
          const coordinator = new RunRecoveryCoordinator(store);
          const claimPreparation = await claimWeeklyRadarWritebackCandidates({ items, runId: resumeRunId });
          await coordinator.persistArtifact(claimPreparation.items, claimPreparation.items);
          await runZoteroWriteback({ argv: [...process.argv, `--input-file=${store.ledger.artifact.path}`], recovery: coordinator });
          return { artifact: claimPreparation.items };
        },
        buildReconcilers: async ({ store, artifact }) => {
          await ensureWorkflowStartupReady();
          return buildZoteroRecoveryReconcilers({ store, artifact, exportExecutor: () => finalizeResearchOsExports() });
        },
      });
    } else {
      const runId = targetRunId;
      const recoveryCoordinator = await createRunRecoveryCoordinator({
        runRoot,
        runId,
        mode: pipelineMode,
        profile,
        launcherId: String(process.env.PAPERECHO_LAUNCHER_ID || "stage0-controlled-entry"),
        configHash,
        inputHash,
        artifactPath: path.join(runRoot, runId, "input_artifact.json"),
      });
      report = await runZoteroLiteratureFilter({ triggerMode: runMode.triggerMode, runMode, config, runId, recoveryCoordinator });
    }
    orchestratorReportWritten = true;
  } catch (orchestratorErr) {
    if (attemptedResumeRunId) {
      report = { runId: attemptedResumeRunId, resume: true, status: "failed", reason: String(orchestratorErr?.message || orchestratorErr).slice(0, 240) };
      orchestratorReportWritten = true;
    } else {
    // Emergency fallback: write a minimal report so downstream diagnostics work.
    const pipelineDir = buildRuntimeConfig().pipelineDir;
    const errMsg = String(orchestratorErr?.stack || orchestratorErr?.message || orchestratorErr);
    try { process.stderr.write(`[orchestrator] runZoteroLiteratureFilter threw: ${errMsg}\n`); } catch {}
    try {
      await fs.mkdir(pipelineDir, { recursive: true });
      const emergencyReport = {
        status: "orchestrator_crash",
        error: errMsg.slice(0, 2000),
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      };
      await fs.writeFile(`${pipelineDir}/orchestrator_report.json`, JSON.stringify(emergencyReport, null, 2), "utf8");
      orchestratorReportWritten = true;
    } catch (writeErr) {
      try { process.stderr.write(`[orchestrator] emergency report write also failed: ${writeErr}\n`); } catch {}
    }
    report = { status: "orchestrator_crash" };
    }
  } finally {
    if (workflowLease?.acquired) await releaseRunLease(workflowLease).catch(() => {});
  }
  console.log(JSON.stringify(report, null, 2));
  process.exit(["completed", "completed_with_warnings", "completed_stage1_only", "degraded_due_to_zotero_backend_unavailable", "skipped"].includes(report.status) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // Catch unhandled promise rejections from inline stage handlers (e.g. writeback
  // async operations that reject after the handler returns). Without this, the process
  // crashes silently with exit code 1 and no orchestrator_report.json is written.
  process.on("unhandledRejection", (reason) => {
    const msg = reason?.stack || reason?.message || String(reason);
    try { process.stderr.write(`[orchestrator] unhandledRejection: ${msg}\n`); } catch {}
    // Try to write an emergency orchestrator report before exiting.
    if (_emergencyPipelineDir) {
      try { nodeFsSync.mkdirSync(_emergencyPipelineDir, { recursive: true }); } catch {}
      try {
        const emergencyReport = {
          status: "orchestrator_crash",
          errorClass: "unhandledRejection",
          error: String(msg || "").slice(0, 2000),
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
        };
        nodeFsSync.writeFileSync(`${_emergencyPipelineDir}/orchestrator_report.json`, JSON.stringify(emergencyReport, null, 2), "utf8");
      } catch {}
    }
    process.exit(1);
  });
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
