import fs from "node:fs/promises";
import path from "node:path";

export const RUN_SUMMARY_SCHEMA_VERSION = 1;
export const PIPELINE_MODES = new Set(["desktop", "web", "local"]);
export const MAIL_ARTIFACT_KINDS = new Set(["weekly_xlsx", "monthly_docx"]);

function finiteOrNull(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function shortMessages(values) {
  return (Array.isArray(values) ? values : [])
    .map((value) => String(value?.message || value || "").replace(/\s+/g, " ").trim().slice(0, 240))
    .filter(Boolean)
    .slice(0, 20);
}

function normalizeGradeCounts(runReport = {}, explicit = {}) {
  const grades = runReport?.counts?.grade_counts || {};
  const pick = (letter) => finiteOrNull(
    explicit?.[letter],
    grades?.[letter],
    grades?.[`${letter}课题相关`],
    grades?.[`${letter}专题相关`],
    grades?.[`${letter}领域相关`],
    grades?.[`${letter}无关`],
  );
  return { A: pick("A"), B: pick("B"), C: pick("C"), D: pick("D") };
}

function countCreatedGrades(items) {
  const counts = { A: 0, B: 0, C: 0, D: 0 };
  for (const item of items) {
    const grade = String(item?.final_grade || item?.grade || item?.effective_grade || "").trim().slice(0, 1).toUpperCase();
    if (grade in counts) counts[grade] += 1;
  }
  return counts;
}

export function validateRunSummary(summary) {
  if (!summary || summary.schemaVersion !== RUN_SUMMARY_SCHEMA_VERSION) throw new Error("RUN_SUMMARY_SCHEMA_INVALID");
  if (!PIPELINE_MODES.has(summary.pipelineMode)) throw new Error(`RUN_SUMMARY_MODE_INVALID:${summary.pipelineMode || "missing"}`);
  if (!String(summary.runId || "").trim()) throw new Error("RUN_SUMMARY_RUN_ID_REQUIRED");
  if (!summary.counts || !summary.counts.grades) throw new Error("RUN_SUMMARY_COUNTS_REQUIRED");
  if (!Array.isArray(summary.artifacts)) throw new Error("RUN_SUMMARY_ARTIFACTS_REQUIRED");
  return summary;
}

export function buildRunSummary({
  runId,
  pipelineMode,
  status,
  startedAt = null,
  finishedAt = null,
  durationMs = null,
  runReport = {},
  writebackSummary = {},
  translationSummary = {},
  localPersistence = {},
  createdItems = null,
  feedbackCount = null,
  humanReviewCount = null,
  pendingRuleCount = null,
  gradeCounts = {},
  warnings = [],
  errors = [],
  artifacts = [],
  outputRoot = "",
} = {}) {
  const writeback = writebackSummary?.writeback_side_effect_summary || {};
  const integrityWriteback = writebackSummary?.integrity || {};
  const integrityReport = runReport?.steps?.literature_integrity || {};
  const integrityResults = Array.isArray(integrityWriteback.results) ? integrityWriteback.results : [];
  return validateRunSummary({
    schemaVersion: RUN_SUMMARY_SCHEMA_VERSION,
    runId: String(runId || "").trim(),
    pipelineMode,
    status: String(status || "unknown"),
    startedAt: startedAt || runReport?.started_at || null,
    finishedAt: finishedAt || null,
    durationMs: finiteOrNull(durationMs),
    counts: {
      retrieved: finiteOrNull(runReport?.counts?.fetched_count),
      created: Array.isArray(createdItems) ? createdItems.length : finiteOrNull(localPersistence?.created, writebackSummary?.counters?.created, writeback?.items_succeeded_count),
      updated: finiteOrNull(localPersistence?.updated, writebackSummary?.counters?.updated),
      deduped: finiteOrNull(runReport?.counts?.duplicate_removed_count),
      feedback: finiteOrNull(feedbackCount, runReport?.steps?.med_query_learning?.feedback_samples_used),
      translated: finiteOrNull(translationSummary?.success_count, translationSummary?.api_translation_succeeded_count),
      grades: Array.isArray(createdItems) ? countCreatedGrades(createdItems) : normalizeGradeCounts(runReport, gradeCounts),
    },
    warnings: shortMessages(warnings.length ? warnings : runReport?.warnings),
    errors: shortMessages(errors.length ? errors : runReport?.failures),
    attention: {
      humanReviewCount: finiteOrNull(humanReviewCount, runReport?.steps?.semantic_grading?.items_needing_human_review),
      pendingRuleCount: finiteOrNull(pendingRuleCount, runReport?.steps?.standards_rule_suggestions?.standards_rule_suggestions_pending_count),
    },
    integrity: {
      newlyConfirmedRetractions: finiteOrNull(integrityReport.newly_confirmed_retraction_count) ?? 0,
      newCorrections: finiteOrNull(integrityReport.new_correction_count) ?? 0,
      newExpressionsOfConcern: finiteOrNull(integrityReport.new_expression_of_concern_count) ?? 0,
      appliedRetractions: integrityResults.filter((item) => item.targetStatus === "retraction" && item.status === "applied").length,
      pendingDelete: integrityResults.filter((item) => item.targetStatus === "retraction" && item.status === "pending_delete").length,
      confirmedNotApplied: integrityResults.filter((item) => item.status === "confirmed_not_applied" || item.status === "blocked").length,
      unresolvedConflicts: finiteOrNull(integrityReport.conflict_count) ?? 0,
    },
    artifacts: artifacts.filter((artifact) => MAIL_ARTIFACT_KINDS.has(artifact?.kind)),
    outputRoot: path.resolve(String(outputRoot || ".")),
  });
}

async function artifact(kind, filePath, displayName, fsApi) {
  const resolved = path.resolve(filePath);
  const stat = await fsApi.stat(resolved);
  if (!stat.isFile()) throw new Error(`EXPORT_ARTIFACT_NOT_FILE:${kind}`);
  return { kind, path: resolved, displayName: displayName || path.basename(resolved), sizeBytes: stat.size };
}

export async function buildExportManifest(exportAudit = {}, { outputRoot = "", fsApi = fs } = {}) {
  const artifacts = [];
  const weeklyPath = String(exportAudit.actual_output_path || "").trim();
  if (weeklyPath) artifacts.push(await artifact("weekly_xlsx", weeklyPath, path.basename(weeklyPath), fsApi));
  const monthlyPath = String(exportAudit.monthly_docx_report_path || "").trim();
  if (monthlyPath) artifacts.push(await artifact("monthly_docx", monthlyPath, path.basename(monthlyPath), fsApi));
  return {
    schemaVersion: 1,
    outputRoot: path.resolve(String(outputRoot || exportAudit.export_root || ".")),
    artifacts,
  };
}

export function pipelineModeFromBackend(backend) {
  return String(backend || "").toLowerCase() === "web_api" ? "web" : "desktop";
}
