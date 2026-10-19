import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

import { importLocalCandidates } from "./local_import.mjs";
import { atomicWriteJson, LocalRepository, readFeedbackJsonl } from "./local_repository.mjs";
import { LocalTiming, formatTimingSummary } from "./local_timing.mjs";
import { buildExportManifest, buildRunSummary } from "../lib/run_summary.mjs";
import { buildLocalRuntimeConfig } from "../lib/runtime_config.mjs";
import { generateLiteratureTitleTranslations } from "../lib/title_translation_generation.mjs";
import { isManualReviewReachable } from '../stage4/finalize_exports_support.mjs';
import { resolveStage5Request, runStage5Notification } from "../stage5/main.mjs";
import { receiptPathFor, recipientHash } from "../stage5/email_receipt.mjs";
import { emailDeliveryPolicy } from '../notification/policy.mjs';
import { canonicalQueryHash } from "../stage1/source_state.mjs";
import { createRunRecoveryCoordinator, resumeRunFromLedger, acquireStartupWorkflowLease } from "../recovery/run_recovery.mjs";
import { buildLocalRecoveryReconcilers } from "../recovery/local_reconciliation.mjs";
import { hashFile, acquireWorkflowLease, releaseRunLease } from "../recovery/operation_ledger.mjs";
import {
  finishRunGroup,
  recordImmediateCleanup,
  runRetentionCleanup,
  runStateRoot,
  startRunGroup,
} from "../lib/runtime_housekeeping.mjs";
import { activateEphemeralRegistry, EphemeralRegistry, registerEphemeral } from "../lib/ephemeral_registry.mjs";

const LOCAL_REPO_ROOT = path.resolve(new URL("../../..", import.meta.url).pathname.replace(/^\/(?:([A-Za-z]:))/, "$1"));

export function parseLocalArgs(argv = process.argv.slice(2)) {
  const runtime = buildLocalRuntimeConfig({ argv, defaultRoot: path.join(LOCAL_REPO_ROOT, "review_results", "local") });
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    outputRoot: runtime.outputRoot,
    input: runtime.inputPath,
    feedback: runtime.feedbackPath,
    fixtureRoot: runtime.fixtureRoot,
    llmMode: runtime.llmMode,
    ...resolveStage5Request(argv),
    resume: (() => {
      const equals = argv.find((value) => String(value).startsWith("--resume="));
      const index = argv.indexOf("--resume");
      return equals ? String(equals).slice("--resume=".length) : index >= 0 ? String(argv[index + 1] || "") : "";
    })(),
  };
}

function feedbackRows(events, repository) {
  const byId = new Map(repository.papers.map((paper) => [paper.local_id, paper]));
  return events.map((event) => {
    const paper = byId.get(event.local_paper_id);
    return {
      event_id: event.event_id,
      local_paper_id: event.local_paper_id,
      title: event.payload?.title || paper?.title || "",
      feedback: event.action,
      comment: event.payload?.comment || "",
      rule_grade: paper?.rule_grade || paper?.grade || "",
      semantic_grade: paper?.semantic_grade || "",
      final_grade: paper?.final_grade || paper?.grade || "",
    };
  });
}

async function withLocalWorkflowLease(options, dependencies, operation) {
  if (dependencies.localWorkflowLeaseHeld || options.help) return operation(dependencies);
  if (!options.outputRoot) throw new Error('LOCAL_OUTPUT_ROOT_REQUIRED');
  const acquire = dependencies.startupGate ? acquireStartupWorkflowLease : acquireWorkflowLease;
  const lease = await acquire({ runRoot: path.join(path.resolve(options.outputRoot), 'runs'), runId: options.resume || options.runId || process.env.PAPERECHO_RUN_ID || 'local-' + randomUUID(),
    profile: process.env.PAPERECHO_RUN_PROFILE || 'standard', resumeRunId: options.resume,
    parentOwnerId: dependencies.startupGate ? process.env.PAPERECHO_PARENT_WORKFLOW_LEASE : '', dataRoots: [path.resolve(options.outputRoot)] });
  if (!lease.acquired) throw new Error('LOCAL_WORKFLOW_BUSY');
  try { return await operation({ ...dependencies, localWorkflowLeaseHeld: true, localWorkflowRunId: lease.lease.runId }); }
  finally { await releaseRunLease(lease); }
}
export async function runLocalPipeline(options = {}, dependencies = {}) {
  return withLocalWorkflowLease(options, dependencies, deps => executeLocalPipeline(options, deps));
}
async function executeLocalPipeline(options = {}, dependencies = {}) {
  if (!emailDeliveryPolicy('weekly', { env: dependencies.env || process.env }).required) options = { ...options, recipient: '' };
  const runId = options.runId || dependencies.localWorkflowRunId || `local-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`;
  const recoveryCoordinator = options.recoveryCoordinator || null;
  const startedAt = new Date().toISOString();
  const timing = dependencies.timing || new LocalTiming(runId);
  const timingPath = path.join(path.resolve(options.outputRoot || "."), "runs", runId, "timings.json");
  const writeTiming = dependencies.writeTiming || atomicWriteJson;
  let repository;
  let learningState;
  let imported = { items: [], errors: [], files: [] };
  let normalizedFeedbackRows = [];
  let consumedEventIds = new Set();
  let seenPendingEventIds = new Set();
  let stage1Result = null;
  let runGroupManifestPath = "";
  let housekeeping = { skipped: true, reason: "not_started", warnings: [] };
  let ephemeralRegistry = null;
  let restoreEphemeralRegistry = () => {};
  let localSourceRegistration = null;
  let stage4Succeeded = false;

  const previousEnv = { ...process.env };
  let businessError = null;
  let businessSucceeded = false;
  try {
    await timing.run("configuration", async () => {
      if (!options.outputRoot) throw new Error("LOCAL_OUTPUT_ROOT_REQUIRED");
      process.env.review_results_OUTPUT_ROOT = options.outputRoot;
      process.env.review_results_FORCE_RUN = "true";
      process.env.FORCE_review_results_RUN = "true";
      process.env.PAPERFLOW_ALLOW_FIXTURE_INPUT = "true";
      process.env.LLM_MODE = options.llmMode || "disabled";
    });
    const outputRoot = path.resolve(options.outputRoot);
    const runRoot = path.join(outputRoot, "runs");
    ephemeralRegistry = new EphemeralRegistry({
      allowedRoots: [os.tmpdir(), outputRoot, dependencies.sharedIndexPath ? path.dirname(path.resolve(dependencies.sharedIndexPath)) : path.join(LOCAL_REPO_ROOT, "review_results")],
    });
    restoreEphemeralRegistry = activateEphemeralRegistry(ephemeralRegistry);
    try {
      const group = await startRunGroup({
        runRoot,
        runId,
        pipelineMode: "local",
        startedAt,
        artifacts: [
          { kind: "run_state", rootKey: "runs", path: runId, retention: "30d" },
          { kind: "weekly_export", rootKey: "exports", path: runId, retention: "30d" },
          { kind: "local_export_source", rootKey: "runs", path: path.join(runId, "local_export_source.json"), retention: "ephemeral" },
        ],
      });
      runGroupManifestPath = group.manifestPath;
      housekeeping = await runRetentionCleanup({
        runtimeRoot: outputRoot,
        runRoot,
        allowedRoots: { runs: runRoot, exports: path.join(outputRoot, "exports"), local: outputRoot },
        legacyRoots: [path.join(outputRoot, "review_results", "pipeline")],
        repoRoot: LOCAL_REPO_ROOT,
        currentRunId: runId,
        env: process.env,
      });
    } catch (error) {
      housekeeping = { skipped: true, reason: "housekeeping_start_failed", warnings: [String(error?.message || error)] };
    }
    await timing.run("state_load", async () => {
      repository = dependencies.repository || await new LocalRepository(options.outputRoot, { sharedIndexPath: dependencies.sharedIndexPath }).load();
      learningState = await repository.loadLearningState();
    }, () => ({ paper_count: repository.papers.length }));
    if (options.input || options.fixtureRoot) {
      imported = await timing.run("local_import", async () => importLocalCandidates(options.input || path.join(options.fixtureRoot, "candidates.json")), (result) => ({ input_count: result.items.length, invalid_count: result.errors.length }));
      timing.skip("retrieval", "local_input_selected");
    } else {
      timing.skip("local_import", "no_local_input");
    }
    await timing.run("feedback_load", async () => {
      if (options.feedback) {
        const incoming = await readFeedbackJsonl(options.feedback, { tolerateIncompleteTail: false });
        const feedbackOperation = recoveryCoordinator && incoming.length
          ? await recoveryCoordinator.prepareFileOperation({ type: "metadata_state", targetId: repository.feedbackPath, targetPath: repository.feedbackPath, input: { eventIds: incoming.map((event) => event.event_id || "").filter(Boolean) }, retryable: false })
          : null;
        for (const event of incoming) await repository.appendFeedback(event, { source: options.feedback });
        if (feedbackOperation) await recoveryCoordinator.completeFileOperation(feedbackOperation, repository.feedbackPath, { eventCount: incoming.length });
      }
      const persistedFeedback = await readFeedbackJsonl(repository.feedbackPath);
      consumedEventIds = new Set(Array.isArray(learningState.consumed_feedback_event_ids) ? learningState.consumed_feedback_event_ids.map(String) : []);
      const pendingFeedback = [];
      seenPendingEventIds = new Set();
      for (const event of persistedFeedback) {
        const eventId = String(event?.event_id || "").trim();
        if (!eventId || consumedEventIds.has(eventId) || seenPendingEventIds.has(eventId)) continue;
        seenPendingEventIds.add(eventId);
        pendingFeedback.push(event);
      }
      normalizedFeedbackRows = feedbackRows(pendingFeedback, repository);
    }, () => ({ feedback_consumed_count: normalizedFeedbackRows.length }));
    const stage1 = dependencies.runStage1 || (await import(`../stage1/main.mjs?local=${Date.now()}`)).runResearchOsPipeline;
    stage1Result = await timing.run("stage1_pipeline", async () => stage1({
      argv: ["node", "workflow/tools/local/main.mjs", "--no-zotero-write"],
      candidateSource: imported.items.length ? imported.items : null,
      existingItemLookup: async (item) => repository.findExisting(item),
      normalizedFeedbackRows,
      feedbackSource: repository.feedbackPath,
      feedbackActionSink: async (rows) => ({
        feedback_used_for_item_actions: rows.length > 0,
        feedback_item_actions_default_enabled: true,
        feedback_item_actions_mode: "local",
        planned_actions_count: rows.length,
        executed_actions_count: rows.length,
        skipped_actions_count: 0,
        failed_actions_count: 0,
        collection_scope_guard_enabled: false,
        collection_scope_blocked_count: 0,
        collection_scope_blocked_samples: [],
        status: rows.length ? "applied_local" : "no_feedback_rows",
      }),
      skipZotero: true,
      zoteroBoundaries: dependencies.zoteroBoundaries || {},
    }), (result) => ({ candidate_count: result.triagedAll?.length || 0, feedback_consumed_count: normalizedFeedbackRows.length }));
    if (!stage1Result?.ok) throw new Error("LOCAL_STAGE1_INCOMPLETE");
    const translationTargets = (stage1Result.triagedAll || []).filter((item) => ["A", "B", "C"].includes(String(item.final_grade || item.grade || "").slice(0, 1)) || isManualReviewReachable(item));
    const translationGenerator = dependencies.generateTitleTranslations || generateLiteratureTitleTranslations;
    const generatedTranslations = await timing.run("title_translation", async () => translationGenerator(translationTargets, {
      cachePath: dependencies.translationCachePath,
      translateTitlesBatchImpl: dependencies.translateTitlesBatch,
    }), (result) => ({ translated_count: result.generated_count, failure_count: result.failures.length }));
    const translatedByTitle = new Map(generatedTranslations.items.map((item) => [String(item.title || ""), item.translatedTitle || ""]));
    stage1Result.triagedAll = (stage1Result.triagedAll || []).map((item) => {
      const translatedTitle = translatedByTitle.get(String(item.title || ""));
      return translatedTitle ? { ...item, translatedTitle } : item;
    });
    if (recoveryCoordinator) {
      await recoveryCoordinator.persistArtifact(stage1Result.triagedAll || [], stage1Result.triagedAll || []);
      await recoveryCoordinator.store.setStage("stage1", "verified", { identityCount: recoveryCoordinator.store.ledger.identities.length });
    }
    const createdLiteratureItems = stage1Result.triagedAll.filter((item) => !repository.findExisting(item).exists);
    const literatureItems = createdLiteratureItems
      .map((item) => ({ title: item.title || "", grade: item.final_grade || item.grade || "" }));
    let persistence;
    const localStateOperation = recoveryCoordinator
      ? await recoveryCoordinator.prepareFileOperation({ type: "local_state", targetId: repository.papersPath, targetPath: repository.papersPath, input: { runId, identities: recoveryCoordinator.store.ledger.identities } })
      : null;
    const sharedIndexOperation = recoveryCoordinator
      ? await recoveryCoordinator.prepareFileOperation({ type: "shared_index", targetId: repository.sharedIndexPath, targetPath: repository.sharedIndexPath, input: { runId, identities: recoveryCoordinator.store.ledger.identities } })
      : null;
    await timing.run("state_persist", async () => {
      persistence = repository.upsertPapers(stage1Result.triagedAll, { runId });
      await repository.save();
      if (localStateOperation) await recoveryCoordinator.completeFileOperation(localStateOperation, repository.papersPath, { identityCount: recoveryCoordinator.store.ledger.identities.length });
      if (sharedIndexOperation) await recoveryCoordinator.completeFileOperation(sharedIndexOperation, repository.sharedIndexPath, { identityCount: recoveryCoordinator.store.ledger.identities.length });
      const learningOperation = recoveryCoordinator
        ? await recoveryCoordinator.prepareFileOperation({ type: "metadata_state", targetId: repository.learningPath, targetPath: repository.learningPath, input: { runId, feedbackEvents: normalizedFeedbackRows.length }, retryable: false })
        : null;
      await repository.saveLearningState({
        ...learningState,
        run_id: runId,
        preference_learning_audit: path.join(stage1Result.pipeDir, "preference_learning_audit.json"),
        feedback_events_used: normalizedFeedbackRows.length,
        consumed_feedback_event_ids: [...consumedEventIds, ...seenPendingEventIds],
      });
      if (learningOperation) await recoveryCoordinator.completeFileOperation(learningOperation, repository.learningPath, { feedbackEvents: normalizedFeedbackRows.length });
      if (recoveryCoordinator) await recoveryCoordinator.store.setStage("state_persist", "verified", { created: persistence.created, updated: persistence.updated });
    }, () => ({ created_count: persistence.created, updated_count: persistence.updated, feedback_consumed_count: normalizedFeedbackRows.length }));

    const runDir = path.join(repository.runsDir, runId);
    const sourcePath = path.join(runDir, "local_export_source.json");
    const exportDayDir = path.join(repository.exportsDir, runId);
    const preferenceAudit = JSON.parse(await fs.readFile(path.join(stage1Result.pipeDir, "preference_learning_audit.json"), "utf8"));
    const { prepareLocalStage4ExportSource } = await import("../stage4/export_source_step.mjs");
    localSourceRegistration = registerEphemeral({ path: sourcePath, ownerStage: "local_stage4", cleanupWhen: "after_use", preserveOnFailure: true }, ephemeralRegistry);
    const source = await prepareLocalStage4ExportSource({ papers: repository.papers, sourcePath, runReport: stage1Result.report, preferenceLearningAudit: preferenceAudit, runId });
    localSourceRegistration.markClosed();
    const paths = { sourcePath, reviewRoot: repository.exportsDir, reviewMonthDir: repository.exportsDir, reviewDayDir: exportDayDir, requestedOutputPath: path.join(exportDayDir, "周报.xlsx"), exportInputFiles: [sourcePath] };
    const labels = { dateStr: new Date().toISOString().slice(0, 10), reviewMonthLabel: "Local", reviewDayLabel: runId };
    const exportRunner = dependencies.runStage4Export || (await import("../stage4/export_execution_step.mjs")).runStage4WorkbookExport;
    const exportSourceHash = recoveryCoordinator ? await hashFile(sourcePath) : "";
    const exportOperation = recoveryCoordinator
      ? await recoveryCoordinator.prepareFileOperation({ type: "export", targetId: "local_stage4_weekly_export", targetPath: paths.requestedOutputPath, input: { artifactHash: recoveryCoordinator.store.ledger.artifact.hash, sourceHash: exportSourceHash }, intent: { sourcePath, sourceHash: exportSourceHash, requestedOutputPath: paths.requestedOutputPath } })
      : null;
    const exported = await timing.run("stage4_export", async () => {
      const result = await exportRunner({ paths, labels, source });
      if (result.terminalExportError) throw result.terminalExportError;
      return result;
    });
    stage4Succeeded = true;
    if (exportOperation) {
      await recoveryCoordinator.completeFileOperation(exportOperation, exported.exportAudit.actual_output_path, { exportMethod: exported.exportAudit.export_method });
      await recoveryCoordinator.store.setStage("stage4_exports", "verified", { outputPath: exported.exportAudit.actual_output_path });
    }
    localSourceRegistration.markConsumed();
    const exportManifest = exported.exportManifest || await (dependencies.buildExportManifest || buildExportManifest)(exported.exportAudit, { outputRoot: exportDayDir });
    const timingReport = timing.report("success");
    const runSummary = buildRunSummary({
      runId,
      pipelineMode: "local",
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: timingReport.total_duration_ms,
      runReport: stage1Result.report,
      localPersistence: persistence,
      createdItems: literatureItems,
      humanReviewCount: createdLiteratureItems.filter((item) => item.needs_human_review).length,
      feedbackCount: normalizedFeedbackRows.length,
      translationSummary: { success_count: generatedTranslations.generated_count },
      artifacts: exportManifest.artifacts,
      outputRoot: exportManifest.outputRoot,
    });
    const stage5Runner = dependencies.runStage5Notification || runStage5Notification;
    let stage5Notification;
    const stage5StateRoot = runStateRoot(repository.runsDir, runId);
    const notificationOperation = recoveryCoordinator && options.recipient
      ? await recoveryCoordinator.prepareFileOperation({ type: "notification", targetId: recipientHash(options.recipient), targetPath: receiptPathFor(stage5StateRoot), input: { runId, notificationType: "run_summary", artifactHash: recoveryCoordinator.store.ledger.artifact.hash }, retryable: false, intent: { notificationType: "run_summary", eventEpoch: runId } })
      : null;
    if (!options.recipient) {
      stage5Notification = await stage5Runner({ runSummary, literatureItems, recipient: "", forceResend: options.forceResend, config: { env: dependencies.env || process.env, runStateRoot: stage5StateRoot, recoveryCoordinator } });
      timing.skip("stage5_notification", stage5Notification.reason);
    } else {
      stage5Notification = await timing.run("stage5_notification", () => stage5Runner({ runSummary, literatureItems, recipient: options.recipient, forceResend: options.forceResend, config: { env: dependencies.env || process.env, runStateRoot: stage5StateRoot, ledgerOperationId: notificationOperation?.idempotencyKey || "", recoveryCoordinator } }));
      if (!stage5Notification.channels && stage5Notification.status !== "sent" && !(stage5Notification.status === "skipped" && stage5Notification.reason === "already_sent")) throw new Error(`STAGE5_NOTIFICATION_${String(stage5Notification.status || "failed").toUpperCase()}:${stage5Notification.reason}`);
    }
    const emailNotification = stage5Notification.channels?.email || stage5Notification;
    if (notificationOperation && (emailNotification.status === "sent" || (emailNotification.status === "skipped" && emailNotification.reason === "already_sent"))) {
      await recoveryCoordinator.completeNotification(notificationOperation, emailNotification);
      await recoveryCoordinator.store.setStage("stage5_notification", "verified", { status: stage5Notification.status });
    } else if (notificationOperation) {
      await recoveryCoordinator.store.transition(notificationOperation.idempotencyKey, "failed", { error: `STAGE5_${String(stage5Notification.status || "unknown").toUpperCase()}` });
      await recoveryCoordinator.store.setStage("stage5_notification", "failed", { status: stage5Notification.status });
    } else if (recoveryCoordinator) {
      await recoveryCoordinator.store.setStage("stage5_notification", "verified", { status: "skipped", reason: stage5Notification.reason });
    }
    if (recoveryCoordinator && stage5Notification.channels) await recoveryCoordinator.store.setStage('stage5_notification', stage5Notification.notificationStatus === 'completed' ? 'verified' : 'failed', { status: stage5Notification.notificationStatus });
    const finalTimingReport = timing.report("success");
    businessSucceeded = true;
    if (recoveryCoordinator) await recoveryCoordinator.store.setRunStatus(recoveryCoordinator.store.ledger.operations.every((operation) => operation.status === "verified") ? "completed" : "incomplete");
    await writeTiming(timingPath, finalTimingReport);
    return { ok: true, run_id: runId, output_root: options.outputRoot, imported: imported.items.length, import_errors: imported.errors, persistence, feedback_events_used: normalizedFeedbackRows.length, export_path: exported.exportAudit.actual_output_path, export_manifest: exportManifest, run_summary: runSummary, stage5_notification: stage5Notification, notification_health_observations: stage1Result.report?.notification_health_observations || [], housekeeping, timing_path: timingPath, timings: finalTimingReport };
  } catch (error) {
    businessError = error;
    if (recoveryCoordinator) await recoveryCoordinator.store.setRunStatus("failed").catch(() => {});
    if (businessSucceeded) throw businessError;
    const timingReport = timing.report("failed");
    try { await writeTiming(timingPath, timingReport); }
    catch (timingError) { businessError.timing_write_error = String(timingError?.message || timingError); }
    throw businessError;
  } finally {
    if (ephemeralRegistry) {
      try {
        const immediate = await ephemeralRegistry.cleanup({ success: stage4Succeeded });
        Object.assign(housekeeping, {
          immediateDeletedFiles: immediate.immediateDeletedFiles,
          immediateDeletedBytes: immediate.immediateDeletedBytes,
          immediateFailedCount: immediate.immediateFailedCount,
          immediateSamples: immediate.samples,
          registeredEphemeralsRemaining: immediate.registeredRemaining,
        });
        housekeeping.warnings = [...(housekeeping.warnings || []), ...(immediate.warnings || [])].slice(0, 10);
        await recordImmediateCleanup({ runtimeRoot: path.resolve(options.outputRoot), summary: immediate });
      } catch (error) {
        housekeeping.warnings = [...(housekeeping.warnings || []), String(error?.message || error)];
      } finally {
        restoreEphemeralRegistry();
      }
    }
    if (runGroupManifestPath) {
      const extraArtifacts = [];
      if (stage1Result?.pipeDir) {
        const relativePipeline = path.relative(path.resolve(options.outputRoot), path.resolve(stage1Result.pipeDir));
        if (relativePipeline && !relativePipeline.startsWith("..") && !path.isAbsolute(relativePipeline)) {
          extraArtifacts.push({ kind: "pipeline", rootKey: "local", path: relativePipeline, retention: "30d" });
        }
      }
      try {
        await finishRunGroup({
          manifestPath: runGroupManifestPath,
          status: businessSucceeded ? "completed" : "failed",
          finishedAt: new Date().toISOString(),
          artifacts: extraArtifacts,
          monthlyAggregationPending: false,
        });
      } catch (error) {
        housekeeping.warnings = [...(housekeeping.warnings || []), String(error?.message || error)];
      }
    }
    for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
    Object.assign(process.env, previousEnv);
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  return withLocalWorkflowLease(parseLocalArgs(argv), { ...dependencies, startupGate: true }, deps => executeLocalMain(argv, deps));
}
async function executeLocalMain(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseLocalArgs(argv);
  if (options.help) {
    console.log("Usage: node workflow/tools/local/main.mjs [--output-root PATH] [--input FILE_OR_DIR] [--feedback JSONL] [--llm-mode disabled|mock|real] [--email ADDRESS] [--force-resend]\nThe sender transport must be configured by the deployer.");
    return { ok: true, help: true };
  }
  const runRoot = path.join(path.resolve(options.outputRoot || "."), "runs");
  const profile = String(process.env.PAPERECHO_RUN_PROFILE || "standard");
  const configHash = String(process.env.PAPERECHO_CONFIG_HASH || canonicalQueryHash({ mode: "local", profile, outputRoot: options.outputRoot }));
  const inputHash = String(process.env.PAPERECHO_INPUT_HASH || canonicalQueryHash({ mode: "local", input: options.input || "", feedback: options.feedback || "" }));
  let result;
  if (options.resume) {
    if (!/-fixed-launcher\/runner$/.test(String(process.env.PAPERECHO_LAUNCHER_ID || ""))) throw new Error("RECOVERY_CONTROLLED_LAUNCHER_REQUIRED");
    result = await resumeRunFromLedger({
      runRoot,
      runId: options.resume,
      mode: "local",
      profile,
      configHash,
      inputHash: "",
      notification: { recipient: options.recipient, env: process.env, transport: dependencies.notificationTransport },
      buildReconcilers: async ({ store, artifact }) => buildLocalRecoveryReconcilers({
        store,
        artifact,
        outputRoot: options.outputRoot,
        sharedIndexPath: dependencies.sharedIndexPath,
        exportExecutor: async (operation) => {
          const repository = await new LocalRepository(options.outputRoot, { sharedIndexPath: dependencies.sharedIndexPath }).load();
          const sourcePath = String(operation.intent?.sourcePath || "");
          if (!sourcePath || await hashFile(sourcePath) !== operation.intent?.sourceHash) throw new Error("RECOVERY_LOCAL_EXPORT_SOURCE_HASH_MISMATCH");
          const exportDayDir = path.join(repository.exportsDir, options.resume);
          const source = JSON.parse(await fs.readFile(sourcePath, "utf8"));
          const paths = { sourcePath, reviewRoot: repository.exportsDir, reviewMonthDir: repository.exportsDir, reviewDayDir: exportDayDir, requestedOutputPath: String(operation.intent?.requestedOutputPath || path.join(exportDayDir, "周报.xlsx")), exportInputFiles: [sourcePath] };
          const labels = { dateStr: new Date().toISOString().slice(0, 10), reviewMonthLabel: "Local", reviewDayLabel: options.resume };
          const exportRunner = dependencies.runStage4Export || (await import("../stage4/export_execution_step.mjs")).runStage4WorkbookExport;
          const exported = await exportRunner({ paths, labels, source });
          return { outputPath: exported.exportAudit.actual_output_path, exportAudit: exported.exportAudit };
        },
      }),
    }, dependencies);
  } else {
    const runId = String(dependencies.localWorkflowRunId || process.env.PAPERECHO_RUN_ID || `local-${new Date().toISOString().replace(/[-:.]/g, "")}-${randomUUID().slice(0, 8)}`);
    const recoveryCoordinator = await createRunRecoveryCoordinator({ runRoot, runId, mode: "local", profile, launcherId: String(process.env.PAPERECHO_LAUNCHER_ID || "local-controlled-entry"), configHash, inputHash, artifactPath: path.join(runRoot, runId, "input_artifact.json") }, dependencies);
    result = await runLocalPipeline({ ...options, runId, recoveryCoordinator }, dependencies);
  }
  console.log(JSON.stringify(result));
  if (result.timings) console.log(formatTimingSummary(result.timings));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(`${error.message}${error.details ? `: ${JSON.stringify(error.details)}` : ""}`);
    process.exitCode = 1;
  });
}
