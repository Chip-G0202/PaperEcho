/**
 * Orchestrator report construction and status derivation.
 *
 * Centralizes the repeated report-building logic that was scattered across
 * multiple early-return / failed / skipped / degraded branches in
 * workflow/tools/stage0/main.mjs.
 *
 * Design goals:
 *   - Single source of truth for report shape and field names.
 *   - Deterministic status derivation from stage outcomes + artifacts.
 *   - Keep existing orchestrator_report.json field set intact for consumers.
 *   - No side-effects; pure functions only (except the exported builder).
 */

// ── Canonical workflow status values ─────────────────────────────────────────
// These MUST stay in sync with the main process exit-code mapping:
//   exit 0 → completed | completed_stage1_only | degraded_due_to_zotero_backend_unavailable | skipped
//   exit 1 → everything else

// Workflow outcomes outrank operation summaries, including vacuous empty-ledger success.
export function terminalWorkflowStatus(...values) {
  const statuses = values.filter(Boolean).map(String);
  for (const status of ["interrupted", "timed_out"]) if (statuses.includes(status)) return status;
  if (statuses.some((value) => /failed|crash/.test(value))) return "failed";
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("incomplete")) return "incomplete";
  if (statuses.some((value) => ["completed", "completed_with_warnings", "completed_stage1_only", "degraded_due_to_zotero_backend_unavailable"].includes(value))) return "completed";
  return statuses.includes("skipped") ? "skipped" : "incomplete";
}

export function workflowLedgerStatus(workflowStatus, operations = []) {
  const status = terminalWorkflowStatus(workflowStatus);
  if (status !== "completed") return status;
  return operations.length > 0 && operations.every((operation) => operation.status === "verified") ? "completed" : "incomplete";
}

export const WORKFLOW_STATUS = Object.freeze({
  COMPLETED: "completed",
  COMPLETED_WITH_WARNINGS: "completed_with_warnings",
  COMPLETED_STAGE1_ONLY: "completed_stage1_only",
  DEGRADED_DUE_TO_ZOTERO_BACKEND_UNAVAILABLE: "degraded_due_to_zotero_backend_unavailable",
  DEGRADED_DUE_TO_MCP_UNAVAILABLE: "degraded_due_to_mcp_unavailable",
  SKIPPED_DUE_TO_INTERVAL: "skipped_due_to_interval",
  FAILED_STAGE1: "failed_stage1",
  FAILED_STAGE2_WRITEBACK: "failed_stage2_writeback",
  FAILED_STAGE3_TRANSLATION: "failed_stage3_translation",
  FAILED_STAGE4_EXPORT: "failed_stage4_export",
  FAILED_DUE_TO_CONFIG_OR_DEPENDENCY: "failed_due_to_config_or_dependency",
});

function getWritebackSideEffectSummary(artifacts = {}) {
  return artifacts?.writeback_summary?.data?.writeback_side_effect_summary
    || artifacts?.writeback_summary?.writeback_side_effect_summary
    || null;
}

function getDryRunInput(extra = {}, artifacts = {}) {
  const writebackSummary = getWritebackSideEffectSummary(artifacts);
  const runtimeSafety = extra?.runtimeSafety || extra?.runtime_safety || {};
  const dryRun = Boolean(runtimeSafety?.dry_run || writebackSummary?.dry_run);
  const source = runtimeSafety?.dry_run_source || extra?.dry_run_source || (dryRun ? "unknown" : "none");
  return { dryRun, source, writebackSummary };
}

function pickWritebackWouldSummary(writebackSummary = null) {
  return {
    items_planned_count: writebackSummary?.items_planned_count ?? "unknown",
    items_attempted_count: writebackSummary?.items_attempted_count ?? "unknown",
    would_write_items_count: writebackSummary?.would_write_items_count ?? writebackSummary?.items_planned_count ?? "unknown",
    would_create_collections_count: writebackSummary?.would_create_collections_count ?? "unknown",
    would_update_fields: writebackSummary?.would_update_fields ?? "unknown",
  };
}

function pickWritebackActualSummary(writebackSummary = null) {
  return {
    actual_write_items_count: writebackSummary?.actual_write_items_count ?? writebackSummary?.items_succeeded_count ?? "unknown",
    actual_created_collections_count: writebackSummary?.actual_created_collections_count ?? writebackSummary?.collections_created_count ?? "unknown",
    actual_updated_fields: writebackSummary?.actual_updated_fields ?? "unknown",
  };
}

export function buildDryRunSummary({ stages = [], artifacts = {}, extra = {} } = {}) {
  const { dryRun, source, writebackSummary } = getDryRunInput(extra, artifacts);
  const stageByName = Object.fromEntries((Array.isArray(stages) ? stages : []).map((stage) => [stage.name, stage]));
  const dryRunStageSkipped = (name) => stageByName[name]?.status === "skipped"
    && String(stageByName[name]?.skipReason || "").includes("dry_run");
  const externalWritePerformed = writebackSummary?.external_write_performed === true
    ? true
    : dryRun
      ? false
      : writebackSummary?.external_write_performed ?? "unknown";
  const notes = [];
  if (dryRun) {
    notes.push("Stage 2 produced a would-write plan without Zotero backend writes.");
    notes.push(dryRunStageSkipped("stage3_translation")
      ? "Stage 3 translation and Zotero metadata writeback skipped due to dry-run."
      : "Stage 3 dry-run boundary unknown from this report.");
    notes.push(dryRunStageSkipped("stage4_exports")
      ? "Stage 4 final file exports skipped due to dry-run."
      : "Stage 4 dry-run boundary unknown from this report.");
  }

  return {
    dry_run: dryRun,
    source,
    zotero_write_blocked: dryRun ? true : false,
    translation_api_blocked: dryRun ? (dryRunStageSkipped("stage3_translation") ? true : "unknown") : false,
    zotero_translation_writeback_blocked: dryRun ? (dryRunStageSkipped("stage3_translation") ? true : "unknown") : false,
    file_exports_blocked: dryRun ? (dryRunStageSkipped("stage4_exports") ? true : "unknown") : false,
    external_write_performed: externalWritePerformed,
    would_write_summary: pickWritebackWouldSummary(writebackSummary),
    actual_write_summary: pickWritebackActualSummary(writebackSummary),
    notes,
  };
}
// ── External call summary builder ─────────────────────────────────────────

/**
 * Build the external_call_summary for the orchestrator report.
 * Derives triggered/possible/risk from stage outcomes.
 * No I/O; pure function on in-memory stage/extra data.
 *
 * @param {Array<object>} stages - Stage array from the orchestrator.
 * @param {object} [extra={}] - Extra context (startup, skipReport, etc.).
 * @returns {object} external_call_summary object.
 */
export function buildExternalCallSummary(stages = [], extra = {}, artifacts = {}) {
  const byName = {};
  for (const st of stages) byName[st.name] = st;
  const s1 = byName.stage1;
  const backendReady = byName.zotero_backend_ready || byName.mcp_ready;
  const s2 = byName.stage2_writeback;
  const s3 = byName.stage3_translation;
  const s4 = byName.stage4_exports;

  function triggered(stage) {
    if (!stage || stage.status === "skipped") return false;
    return "unknown";
  }

  function evidence(stage, defaultMsg) {
    if (!stage) return defaultMsg || "not reached";
    let msg = `${stage.name}: ${stage.status}`;
    if (stage.skipReason) msg += ` (${stage.skipReason})`;
    return msg;
  }

  const dryRunSummary = extra?.dry_run_summary || buildDryRunSummary({ stages, artifacts, extra });
  const dryRun = dryRunSummary?.dry_run === true;
  const blockedEvidence = "blocked by dry-run";

  return {
    llm_semantic_review: {
      possible: true,
      triggered: dryRun ? false : triggered(s1),
      risk: "high",
      evidence: dryRun ? blockedEvidence : evidence(s1, "not reached"),
    },
    llm_preference_learning: {
      possible: true,
      triggered: dryRun ? false : triggered(s1),
      risk: "high",
      evidence: dryRun ? blockedEvidence : evidence(s1, "not reached"),
    },
    translation_api: {
      possible: true,
      triggered: dryRunSummary?.translation_api_blocked === true ? false : triggered(s3),
      risk: "high",
      evidence: dryRunSummary?.translation_api_blocked === true ? blockedEvidence : evidence(s3, "no translation stage run"),
    },
    easy_scholar: {
      possible: true,
      triggered: triggered(s1),
      risk: "medium",
      evidence: evidence(s1, "not reached"),
    },
    zotero_backend_writeback: {
      possible: true,
      triggered: dryRunSummary?.zotero_write_blocked === true ? false : s2?.status === "completed" ? true : triggered(s2),
      risk: "medium",
      evidence: dryRunSummary?.zotero_write_blocked === true ? blockedEvidence : evidence(s2, "no writeback stage run"),
    },
    zotero_backend_read: {
      possible: true,
      triggered: triggered(s1 || backendReady),
      risk: "low",
      evidence: evidence(s1 || backendReady, "no Zotero backend stage reached"),
    },
    ncbi_pubmed_pmc: {
      possible: true,
      triggered: triggered(s1),
      risk: "low",
      evidence: evidence(s1, "not reached"),
    },
    rss_fetch: {
      possible: true,
      triggered: triggered(s1),
      risk: "low",
      evidence: evidence(s1, "not reached"),
    },
    file_exports: {
      possible: true,
      triggered: dryRunSummary?.file_exports_blocked === true ? false : s4?.status === "completed" ? true : triggered(s4),
      risk: "low",
      evidence: dryRunSummary?.file_exports_blocked === true ? blockedEvidence : evidence(s4, "no export stage run"),
    },
  };
}

// ── User-facing run outcome summary ─────────────────────────────────────────

function stageNameToFailureStage(name) {
  if (name === "stage1") return "stage1";
  if (name === "stage2_writeback") return "stage2";
  if (name === "stage3_translation") return "stage3";
  if (name === "stage4_exports") return "stage4";
  return null;
}

function firstCommonSkipReason(stages = []) {
  const reasons = stages
    .filter((stage) => stage?.status === "skipped")
    .map((stage) => stage.skipReason)
    .filter(Boolean);
  if (!reasons.length) return null;
  return reasons.every((reason) => reason === reasons[0]) ? reasons[0] : reasons[0];
}

function sideEffectsPossible(externalCallSummary, artifacts = {}) {
  const writebackSummary = getWritebackSideEffectSummary(artifacts);
  if (writebackSummary?.external_write_performed === true) return true;

  if (!externalCallSummary || typeof externalCallSummary !== "object") return "unknown";
  const triggeredValues = Object.values(externalCallSummary).map((entry) => entry?.triggered);
  if (triggeredValues.some((value) => value === true)) return true;
  if (triggeredValues.some((value) => value === "unknown")) return "unknown";
  if (triggeredValues.length > 0 && triggeredValues.every((value) => value === false)) return false;
  return "unknown";
}

function isStartupFailure(status, stages = [], extra = {}) {
  const skippedForStartup = stages.length > 0
    && stages.every((stage) => stage?.status === "skipped" && stage?.skipReason === "startup_failed");
  return status === WORKFLOW_STATUS.FAILED_DUE_TO_CONFIG_OR_DEPENDENCY
    && (extra?.startup?.ok === false || skippedForStartup);
}

function deriveFailedStage(status, stages = [], extra = {}) {
  if (isStartupFailure(status, stages, extra)) return "startup";
  if (status === WORKFLOW_STATUS.FAILED_STAGE1) return "stage1";
  if (status === WORKFLOW_STATUS.FAILED_STAGE2_WRITEBACK) return "stage2";
  if (status === WORKFLOW_STATUS.FAILED_STAGE3_TRANSLATION) return "stage3";
  if (status === WORKFLOW_STATUS.FAILED_STAGE4_EXPORT) return "stage4";

  const failedStage = stages.find((stage) => stage?.status === "failed");
  return stageNameToFailureStage(failedStage?.name);
}

function deriveSkippedReason(status, stages = [], extra = {}) {
  if (extra?.stage1_artifact_reason) return extra.stage1_artifact_reason;
  if (extra?.stage1_artifact_check?.reason) return extra.stage1_artifact_check.reason;
  if (extra?.skipReport?.skipped_due_to_interval) return "interval_not_reached";
  if (isStartupFailure(status, stages, extra)) return "startup_failed";
  return firstCommonSkipReason(stages);
}

function deriveDegradedReason(status, stages = [], artifacts = {}) {
  const writebackSummary = getWritebackSideEffectSummary(artifacts);
  if (status === WORKFLOW_STATUS.FAILED_STAGE2_WRITEBACK && writebackSummary?.partial_success === true) {
    return "stage2_partial_writeback";
  }
  if (
    status === WORKFLOW_STATUS.DEGRADED_DUE_TO_ZOTERO_BACKEND_UNAVAILABLE
    || status === WORKFLOW_STATUS.DEGRADED_DUE_TO_MCP_UNAVAILABLE
  ) return "zotero_backend_unavailable";
  if (status === WORKFLOW_STATUS.COMPLETED_WITH_WARNINGS) {
    return stages.some((stage) => stage?.status === "partial_failed")
      ? "stage3_partial_failed"
      : "completed_with_warnings";
  }
  if (status === "completed_with_downgrade") return "completed_with_downgrade";
  return null;
}

function deriveRunOutcomeCategory(status, stages = [], extra = {}, artifacts = {}) {
  const allSkipped = stages.length > 0 && stages.every((stage) => stage?.status === "skipped");
  const writebackSummary = getWritebackSideEffectSummary(artifacts);

  if (isStartupFailure(status, stages, extra)) return "failed";
  if (status === "skipped" || status === WORKFLOW_STATUS.SKIPPED_DUE_TO_INTERVAL || allSkipped) return "skipped";
  if (status === WORKFLOW_STATUS.COMPLETED) return "completed";
  if (
    status === WORKFLOW_STATUS.DEGRADED_DUE_TO_ZOTERO_BACKEND_UNAVAILABLE
    || status === WORKFLOW_STATUS.DEGRADED_DUE_TO_MCP_UNAVAILABLE
    || status === WORKFLOW_STATUS.COMPLETED_WITH_WARNINGS
    || status === "completed_with_downgrade"
  ) return "degraded";
  if (status === WORKFLOW_STATUS.COMPLETED_STAGE1_ONLY) return "partial";
  if (status === WORKFLOW_STATUS.FAILED_STAGE2_WRITEBACK && writebackSummary?.partial_success === true) return "partial";
  if (String(status || "").startsWith("failed_")) return "failed";
  return "unknown";
}

function deriveWorkPerformed(category, stages = [], artifacts = {}) {
  if (category === "skipped") return false;
  const executedStages = stages.filter((stage) => stage?.status && stage.status !== "skipped");
  if (category === "completed") return true;
  if (category === "degraded") return executedStages.length > 0 ? true : "unknown";
  if (category === "partial") return "partial";
  if (category === "failed") return executedStages.length > 0 ? "partial" : false;

  const writebackSummary = getWritebackSideEffectSummary(artifacts);
  if (writebackSummary?.external_write_performed === true) return "partial";
  return executedStages.length > 0 ? "partial" : "unknown";
}

function buildUserFacingReason({ category, status, failedStage, skippedReason, degradedReason }) {
  if (category === "completed") return "Run completed successfully";
  if (category === "skipped") {
    if (skippedReason === "interval_not_reached") return "Skipped because interval gate was not due";
    return skippedReason ? `Skipped because ${skippedReason}` : "Run skipped";
  }
  if (failedStage === "startup") return "Failed during startup";
  if (failedStage === "stage1" && skippedReason) {
    return `Failed during Stage 1 artifact check: ${skippedReason}`;
  }
  if (failedStage === "stage2" && degradedReason === "stage2_partial_writeback") {
    return "Stage 2 writeback partially succeeded before failure";
  }
  if (failedStage === "stage2") return "Failed during Stage 2 writeback";
  if (failedStage === "stage3") return "Failed during Stage 3 translation after earlier stages ran";
  if (failedStage === "stage4") return "Failed during Stage 4 export after earlier stages ran";
  if (category === "degraded" && degradedReason === "zotero_backend_unavailable") {
    return "Completed with downstream stages skipped after Zotero backend unavailable";
  }
  if (category === "degraded" && degradedReason) return `Completed with degradation: ${degradedReason}`;
  if (category === "partial") return degradedReason ? `Partially completed: ${degradedReason}` : "Run partially completed";
  return status ? `Run outcome could not be classified from status: ${status}` : "Run outcome unknown";
}

/**
 * Build a compact, user-facing final outcome summary from existing report data.
 * This is pure report interpretation and must not affect stage execution.
 */
export function buildRunOutcome({
  status,
  stages = [],
  artifacts = {},
  extra = {},
  externalCallSummary,
} = {}) {
  const stageList = Array.isArray(stages) ? stages : [];
  const stagesExecuted = stageList
    .filter((stage) => stage?.status && stage.status !== "skipped")
    .map((stage) => stage.name);
  const stagesSkipped = stageList
    .filter((stage) => stage?.status === "skipped")
    .map((stage) => stage.name);
  const stagesFailed = stageList
    .filter((stage) => stage?.status === "failed")
    .map((stage) => stage.name);

  const category = deriveRunOutcomeCategory(status, stageList, extra, artifacts);
  const failedStage = deriveFailedStage(status, stageList, extra);
  const skippedReason = deriveSkippedReason(status, stageList, extra);
  const degradedReason = deriveDegradedReason(status, stageList, artifacts);

  return {
    category,
    work_performed: deriveWorkPerformed(category, stageList, artifacts),
    user_facing_reason: buildUserFacingReason({
      category,
      status,
      failedStage,
      skippedReason,
      degradedReason,
    }),
    failed_stage: failedStage,
    skipped_reason: skippedReason,
    degraded_reason: degradedReason,
    stages_executed: stagesExecuted,
    stages_skipped: stagesSkipped,
    stages_failed: stagesFailed,
    side_effects_possible: sideEffectsPossible(externalCallSummary, artifacts),
  };
}

// ── Run context builder ──────────────────────────────────────────────────────

/**
 * Build the canonical run-context object that every report carries.
 *
 * @param {object} opts
 * @param {string} opts.automationName
 * @param {string} opts.runId
 * @param {string} opts.platform
 * @param {string} opts.startedAt - ISO-8601
 * @param {string} opts.triggerMode
 * @param {object} opts.runMode - from detectRunMode()
 * @param {boolean} opts.manualTrigger
 * @param {string} opts.pipelineDir
 * @returns {object} Frozen run-context snapshot
 */
export function buildRunContext({
  automationName,
  runId,
  platform,
  startedAt,
  triggerMode,
  runMode,
  manualTrigger,
  pipelineDir,
}) {
  const explicitForceRun = Boolean(runMode?.explicitForceRun);
  const forceRun = Boolean(manualTrigger || explicitForceRun);
  const bypassIntervalGate = forceRun; // force implies bypass
  const bypassReason = explicitForceRun
    ? "explicit_force_run"
    : manualTrigger
      ? "manual_bypass_interval_gate"
      : null;

  return Object.freeze({
    automationName,
    runId,
    platform,
    startedAt,
    triggerMode,
    runMode,
    forceRun,
    explicitForceRun,
    bypassIntervalGate,
    bypassReason,
    pipelineDir,
  });
}

// ── Status derivation ────────────────────────────────────────────────────────

/**
 * Derive the canonical workflow status from stage outcomes and artifacts.
 *
 * Call-site responsibilities:
 *   - Pass the caller's explicit status override when the branch already
 *     knows the answer (e.g. "skipped", "completed_stage1_only").
 *   - For the fall-through path (stages ran sequentially), pass null/undefined
 *     and let this function infer from stages + artifacts.
 *
 * @param {object} opts
 * @param {string|null} [opts.explicitStatus] - Caller override; wins over inference.
 * @param {Array<object>} opts.stages - Stage outcome array.
 * @param {object} [opts.artifacts] - Artifact inspection results.
 * @returns {string} One of WORKFLOW_STATUS values.
 */
export function deriveWorkflowStatus({ explicitStatus, stages, artifacts }) {
  // Caller already decided (e.g. "skipped", "completed_stage1_only", "degraded…")
  if (explicitStatus) return explicitStatus;

  // ── Infer from stages ──────────────────────────────────────────────────
  const stageByName = new Map(stages.map((s) => [s.name, s]));

  // Stage 1 failed → failed_stage1
  const s1 = stageByName.get("stage1");
  if (s1 && s1.status === "failed") return WORKFLOW_STATUS.FAILED_STAGE1;

  // Zotero backend readiness failed → degraded (if stage1 ok) or failed (if stage1 also failed)
  const backendReady = stageByName.get("zotero_backend_ready") || stageByName.get("mcp_ready");
  if (backendReady && backendReady.status === "failed") {
    return s1?.status === "completed"
      ? WORKFLOW_STATUS.DEGRADED_DUE_TO_ZOTERO_BACKEND_UNAVAILABLE
      : WORKFLOW_STATUS.FAILED_STAGE1; // stage1 failed is already caught above, defensive
  }

  // Stage 2 failed → failed_stage2_writeback
  const s2 = stageByName.get("stage2_writeback");
  if (s2 && s2.status === "failed") return WORKFLOW_STATUS.FAILED_STAGE2_WRITEBACK;

  // Stage 3 failed (hard failure, not partial) → failed_stage3_translation
  const s3 = stageByName.get("stage3_translation");
  if (s3 && s3.status === "failed") return WORKFLOW_STATUS.FAILED_STAGE3_TRANSLATION;

  // Stage 4 failed → failed_stage4_export
  const s4 = stageByName.get("stage4_exports");
  if (s4 && s4.status === "failed") return WORKFLOW_STATUS.FAILED_STAGE4_EXPORT;

  // Stage 4 completed but stage3 had partial failures → completed_with_warnings
  if (s4?.status === "completed" && s3?.status === "partial_failed") {
    return WORKFLOW_STATUS.COMPLETED_WITH_WARNINGS;
  }

  // All completed → completed
  if (s4?.status === "completed") return WORKFLOW_STATUS.COMPLETED;

  // Fallback: should not happen in normal flow
  return WORKFLOW_STATUS.FAILED_DUE_TO_CONFIG_OR_DEPENDENCY;
}

// ── Orchestrator report builder ──────────────────────────────────────────────

/**
 * Build the full orchestrator report object.
 *
 * @param {object} opts
 * @param {string} opts.status - From deriveWorkflowStatus or caller override.
 * @param {object} opts.runContext - From buildRunContext.
 * @param {string} opts.finishedAt - ISO-8601
 * @param {Array<object>} opts.stages
 * @param {object} opts.artifacts
 * @param {Array<string>} [opts.warnings] - Optional warning strings.
 * @param {object} [opts.extra] - Additional top-level fields (e.g. skipReport, stage1Only).
 * @returns {object} The report object ready for JSON serialization.
 */
export function buildOrchestratorReport({
  status,
  runContext,
  finishedAt,
  stages,
  artifacts,
  warnings,
  extra,
}) {
  const report = {
    // ── Core identity ──────────────────────────────────────────────────
    automationName: runContext.automationName,
    runId: runContext.runId,
    platform: runContext.platform,
    startedAt: runContext.startedAt,
    finishedAt,

    // ── Status ─────────────────────────────────────────────────────────
    status,

    // ── Trigger / mode ─────────────────────────────────────────────────
    triggerMode: runContext.triggerMode,
    runMode: runContext.runMode,
    forceRun: runContext.forceRun,
    explicitForceRun: runContext.explicitForceRun,
    bypassIntervalGate: runContext.bypassIntervalGate,
    bypassReason: runContext.bypassReason,

    // ── Location ───────────────────────────────────────────────────────
    pipelineDir: runContext.pipelineDir,

    // ── Pipeline outcomes ──────────────────────────────────────────────
    stages,
    artifacts,
  };

  // Attach warnings if present and non-empty
  if (warnings && warnings.length > 0) {
    report.warnings = warnings;
  }

  // Merge extra fields (skipReport, stage1Only, etc.)
  if (extra && typeof extra === "object") {
    Object.assign(report, extra);
  }

  report.dry_run_summary = buildDryRunSummary({ stages, artifacts, extra });
  report.external_call_summary = buildExternalCallSummary(stages || [], { ...(extra || {}), dry_run_summary: report.dry_run_summary }, artifacts || {});
  report.run_outcome = buildRunOutcome({
    status,
    stages,
    artifacts,
    extra,
    externalCallSummary: report.external_call_summary,
  });
  return report;
}

// ── Convenience: exit-code mapping ───────────────────────────────────────────

// Statuses that map to exit code 0
const EXIT_ZERO_STATUSES = new Set([
  WORKFLOW_STATUS.COMPLETED,
  WORKFLOW_STATUS.COMPLETED_STAGE1_ONLY,
  WORKFLOW_STATUS.DEGRADED_DUE_TO_ZOTERO_BACKEND_UNAVAILABLE,
  WORKFLOW_STATUS.DEGRADED_DUE_TO_MCP_UNAVAILABLE,
  WORKFLOW_STATUS.SKIPPED_DUE_TO_INTERVAL,
  // Legacy alias: original code used "skipped" for interval gate
  "skipped",
]);

/**
 * Map a workflow status to the process exit code.
 *
 * @param {string} status
 * @returns {number} 0 or 1
 */
export function workflowStatusToExitCode(status) {
  return EXIT_ZERO_STATUSES.has(status) ? 0 : 1;
}
