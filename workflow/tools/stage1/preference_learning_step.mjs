/**
 * Preference learning step.
 *
 * Handles manual standard evaluation, feedback learning, and LLM preference learning.
 */
import { processManualStandardEvaluation, applyScreeningStandardsLearningUpdate, ruleSuggestionsLogPath } from "./screening_standards_file.mjs";
import { buildPreferenceLearningAudit } from "./preference_refinement.mjs";
import { buildPreferenceLearningInputs, runLlmPreferenceLearning } from "./llm_preference_learning.mjs";
import { resolveLlmRuntime } from "../lib/llm_json_support.mjs";
import { buildPreferenceLearningExecutionSummary } from "./preference_learning_execution_summary.mjs";
import { runFeedbackLearningDiagnostic } from "../lib/feedback_learning_support.mjs";
import fs from "node:fs/promises";
import path from "node:path";

/**
 * Load previous feedback preferences.
 */
function loadPreviousFeedbackPrefs(now, { reviewRoot, desktopRoot, projectRoot, researchRoot }) {
  const diag = runFeedbackLearningDiagnostic(now, {
    reviewRoot,
    desktopRoot,
    projectRoot,
    researchRoot,
    lookbackDays: 7,
  });
  const learningPayload = diag.learning_payload || {};
  return {
    ok: Boolean(diag.ok && diag.preference_learning?.would_update_preference),
    path: diag.selected_feedback_file || "",
    selected_date: diag.selected_feedback_date || "",
    checked_files: diag.checked_files || [],
    rows_used: Number(learningPayload.rows_used || 0),
    rows_with_comment: Number(diag.counts?.rows_with_comment || 0),
    rows_missing_title_translation: Number(diag.counts?.rows_missing_title_translation || 0),
    rows_ambiguous: Number(diag.preference_learning?.ambiguous_samples || 0),
    hardPositiveTerms: Array.isArray(learningPayload.hardPositiveTerms) ? learningPayload.hardPositiveTerms : [],
    hardNegativeTerms: Array.isArray(learningPayload.hardNegativeTerms) ? learningPayload.hardNegativeTerms : [],
    signals: Array.isArray(learningPayload.signals) ? learningPayload.signals : [],
    metaPreferenceSignals: Array.isArray(learningPayload.meta_preference_signals) ? learningPayload.meta_preference_signals : [],
    standardSummaryFeedback: diag.standard_summary_feedback || {},
    screeningStandards: diag.screening_standards || {},
    diagnostics: diag,
  };
}

export function buildNormalizedFeedbackLearning(normalizedFeedbackRows = [], feedbackSource = "") {
  const rows = Array.isArray(normalizedFeedbackRows) ? normalizedFeedbackRows : [];
  const normalizeAction = (row) => String(row?.feedback || row?.action || "").trim().toLowerCase();
  const feedbackColumnDetected = rows.some((row) => Object.hasOwn(row || {}, "feedback") || Object.hasOwn(row || {}, "action"));
  const commentColumnDetected = rows.some((row) => Object.hasOwn(row || {}, "comment") || Object.hasOwn(row || {}, "user_comment"));
  const supported = rows.filter((row) => ["keep", "drop", "upgrade", "downgrade"].includes(normalizeAction(row)));
  const headers = ["title", feedbackColumnDetected ? "feedback" : "", commentColumnDetected ? "comment" : ""].filter(Boolean);
  return {
    ok: supported.length > 0,
    path: feedbackSource || "local_feedback_jsonl",
    selected_date: "",
    checked_files: feedbackSource ? [feedbackSource] : [],
    rows_used: supported.length,
    rows_with_comment: supported.filter((row) => row.comment || row.user_comment).length,
    rows_missing_title_translation: 0,
    rows_ambiguous: 0,
    hardPositiveTerms: [],
    hardNegativeTerms: [],
    signals: supported.map((row, index) => ({ ...row, id: row.id || row.event_id || `local-feedback-${index + 1}`, feedback: normalizeAction(row) })),
    metaPreferenceSignals: [],
    standardSummaryFeedback: {},
    screeningStandards: {},
    diagnostics: {
      ok: true,
      lookup_paths: feedbackSource ? [feedbackSource] : [],
      selected_feedback_file: feedbackSource,
      selected_feedback_file_source: "local_jsonl",
      selected_feedback_file_exists: true,
      workbook_unreadable: false,
      sheet: { name: "local_feedback_jsonl", headers },
      columns: { feedback: feedbackColumnDetected, comment: commentColumnDetected, english_title: true, title_translation: false, chinese_title: false },
      counts: { total_rows: rows.length, rows_with_feedback: supported.length, rows_with_comment: supported.filter((row) => row.comment || row.user_comment).length },
      preference_learning: {
        ignored_samples: rows.length - supported.length,
        positive_samples: supported.filter((row) => ["keep", "upgrade"].includes(normalizeAction(row))).length,
        negative_samples: supported.filter((row) => ["drop", "downgrade"].includes(normalizeAction(row))).length,
        ambiguous_samples: 0,
        blockers: feedbackColumnDetected ? [] : ["required_feedback_columns_missing"],
      },
    },
  };
}

/**
 * Run preference learning phase.
 *
 * @param {Object} options
 * @param {string} options.reviewRoot - Review root path
 * @param {string} options.root - Project root
 * @param {string} options.pipeDir - Pipeline directory
 * @param {string} options.now - Current date
 * @param {Object} options.workflowRules - Workflow rules
 * @returns {Promise<Object>} Preference learning results
 */
export async function runPreferenceLearningPhase({ reviewRoot, desktopRoot, researchRoot, root, pipeDir, now, workflowRules, normalizedFeedbackRows = null, feedbackSource = "" }) {
  const pubmedPmcConfigPath = path.join(root, "config", "pubmed_pmc_search.json");

  // Manual standard evaluation
  const manualStandardEvaluation = await processManualStandardEvaluation({
    reviewRoot,
    pubmedConfigPath: pubmedPmcConfigPath,
    auditPath: path.join(pipeDir, "manual_standard_evaluation_audit.json"),
  });

  // Feedback learning
  let feedbackLearning = loadPreviousFeedbackPrefs(now, {
    reviewRoot,
    desktopRoot,
    projectRoot: root,
    researchRoot,
  });
  if (Array.isArray(normalizedFeedbackRows)) {
    feedbackLearning = buildNormalizedFeedbackLearning(normalizedFeedbackRows, feedbackSource);
  }
  const feedbackDiag = feedbackLearning.diagnostics || {};

  // Med query learning
  const medQueryLearning = {
    ok: Boolean(feedbackLearning.ok),
    feedback_file_used: feedbackLearning.path || "",
    feedback_file_selected_date: feedbackLearning.selected_date || "",
    feedback_files_checked: feedbackLearning.checked_files || [],
    feedback_rows_count: Number(feedbackLearning.rows_used || 0),
    feedback_used_for_item_actions: false,
    feedback_item_actions_default_enabled: true,
    feedback_item_actions_entry: "workflow/tools/maintenance/zotero_feedback_collection_corrections.mjs (default pipeline apply unless APPLY_FEEDBACK_ITEM_ACTIONS=false)",
    feedback_item_actions_status: "not_attempted",
    feedback_used_for_rule_learning: false,
    previous_feedback_lookup_paths: feedbackDiag.lookup_paths || [],
    feedback_review_root: reviewRoot,
    feedback_lookup_paths: feedbackDiag.lookup_paths || [],
    selected_previous_feedback_file: feedbackDiag.selected_feedback_file || "",
    selected_feedback_file_source: feedbackDiag.selected_feedback_file_source || "",
    fallback_reason: feedbackDiag.fallback_reason || "",
    previous_feedback_file_found: Boolean(feedbackDiag.selected_feedback_file_exists),
    workbook_unreadable: Boolean(feedbackDiag.workbook_unreadable),
    previous_feedback_sheet_name: feedbackDiag.sheet?.name || "",
    previous_feedback_headers: feedbackDiag.sheet?.headers || [],
    feedback_column_detected: Boolean(feedbackDiag.columns?.feedback),
    comment_column_detected: Boolean(feedbackDiag.columns?.comment),
    title_columns_detected: {
      english_title: Boolean(feedbackDiag.columns?.english_title),
      title_translation: Boolean(feedbackDiag.columns?.title_translation),
      chinese_title: Boolean(feedbackDiag.columns?.chinese_title),
    },
    rows_used: feedbackLearning.rows_used || 0,
    rows_with_comment: feedbackLearning.rows_with_comment || 0,
    rows_missing_title_translation: feedbackLearning.rows_missing_title_translation || 0,
    rows_ambiguous: feedbackLearning.rows_ambiguous || 0,
    rows_with_feedback: Number(feedbackDiag.counts?.rows_with_feedback || 0),
    rows_total: Number(feedbackDiag.counts?.total_rows || feedbackDiag.counts?.rows_total || 0),
    feedback_samples_used: Number(feedbackLearning.rows_used || 0),
    feedback_samples_ignored: Number(feedbackDiag.preference_learning?.ignored_samples || 0),
    positive_feedback_samples: Number(feedbackDiag.preference_learning?.positive_samples || 0),
    negative_feedback_samples: Number(feedbackDiag.preference_learning?.negative_samples || 0),
    ambiguous_feedback_samples: Number(feedbackDiag.preference_learning?.ambiguous_samples || 0),
    preference_learning_executed: Boolean(feedbackLearning.ok),
    preferences_added: 0,
    preferences_updated: 0,
    preferences_reinforced: 0,
    preferences_marked_ambiguous: 0,
    preferences_needing_more_feedback: 0,
    evidence_total: 0,
    evidence_positive: 0,
    evidence_negative: 0,
    evidence_ambiguous: 0,
    evidence_ignored: 0,
    new_evidence_count: 0,
    historical_evidence_count: 0,
    clusters_total: 0,
    clusters_existing_matched: 0,
    clusters_created: 0,
    clusters_updated: 0,
    clusters_stable: 0,
    clusters_tentative: 0,
    clusters_ambiguous: 0,
    clusters_needing_more_feedback: 0,
    clustering_executed: false,
    clustering_warning: "",
    evidence_to_cluster_map_available: false,
    standard_summary_generated: false,
    standard_summary_feedback_read: Boolean(feedbackLearning.standardSummaryFeedback?.sheet_present),
    standard_summary_feedback_used: false,
    standard_summary_feedback_rows: 0,
    meta_preference_evidence_count: 0,
    primary_rationale_source: "daily_feedback_comment_or_title",
    standard_summary_my_evaluation_rows: 0,
    clusters_adjusted_by_summary_feedback: 0,
    global_meta_feedback_count: 0,
    clusters_reinforced_by_summary_feedback: 0,
    clusters_weakened_by_summary_feedback: 0,
    clusters_scope_narrowed_by_summary_feedback: 0,
    clusters_scope_broadened_by_summary_feedback: 0,
    clusters_marked_ambiguous_by_summary_feedback: 0,
    clusters_retired_by_summary_feedback: 0,
    summary_feedback_mapping_failures: 0,
    standard_summary_sheet_exported: false,
    standard_summary_sheet_schema: "zh_two_column",
    current_standard_summary_excerpt: "",
    positive_terms: feedbackLearning.hardPositiveTerms || [],
    negative_terms: feedbackLearning.hardNegativeTerms || [],
    standard_summary_feedback_sheet_present: Boolean(feedbackLearning.standardSummaryFeedback?.sheet_present),
    signals: {
      previous_feedback_missing: !feedbackDiag.selected_feedback_file_exists,
      feedback_columns_missing: Boolean((feedbackDiag.sheet?.headers || []).length > 0 && !feedbackDiag.columns?.feedback),
      no_feedback_rows: Number(feedbackDiag.counts?.rows_with_feedback || 0) === 0,
      preference_not_updated: !Boolean(feedbackLearning.ok),
    },
  };

  // LLM preference learning
  const semanticPreferenceCompatibilityPath = path.join(pipeDir, "semantic_preference_refinement.json");
  const llmPreferenceReportPath = path.join(pipeDir, "llm_preference_learning.json");
  const llmCachePath = path.join(pipeDir, "llm_cache.json");
  const llmRuntime = resolveLlmRuntime();
  const workflowRulesForLlm = workflowRules;
  const llmReviewConfig = { ...(workflowRulesForLlm?.config?.llm_review || {}) };
  const preferenceLearningInputs = buildPreferenceLearningInputs({
    feedbackLearning,
    config: llmReviewConfig,
  });
  const llmPreferenceReport = await runLlmPreferenceLearning({
    feedbackRows: preferenceLearningInputs.feedbackRows,
    outputPath: llmPreferenceReportPath,
    cachePath: llmCachePath,
    config: llmReviewConfig,
    runtime: llmRuntime,
    generatedAt: new Date().toISOString(),
    feedbackSource: preferenceLearningInputs.feedbackSource,
  });

  // Write compatibility file
  await fs.writeFile(semanticPreferenceCompatibilityPath, JSON.stringify({
    enabled: false,
    method: "llm_preference_learning",
    replaced_semantic_search: true,
    replaced_by: "llm_preference_learning",
    compatibility_only: true,
    compatibility_reason: "removed_llm_workflow",
    generated_at: new Date().toISOString(),
    semantic_search: {
      enabled: false,
      skipped_reason: "replaced_by_llm_preference_learning",
      compatibility_only: true,
      compatibility_reason: "removed_llm_workflow",
    },
    llm_preference_learning_path: llmPreferenceReportPath,
    llm_preference_learning_ok: Boolean(llmPreferenceReport.ok),
    llm_preference_learning_skipped: Boolean(llmPreferenceReport.skipped),
    warnings: llmPreferenceReport.warnings || [],
  }, null, 2), "utf8");

  // Update med query learning with LLM results
  const updatedMedQueryLearning = {
    ...medQueryLearning,
    compatibility_only: true,
    compatibility_reason: "removed_llm_workflow",
    semantic_preference_enabled: false,
    semantic_search_used: false,
    semantic_search: {
      enabled: false,
      skipped_reason: "replaced_by_llm_preference_learning",
      compatibility_only: true,
      compatibility_reason: "removed_llm_workflow",
    },
    semantic_adapter: "",
    zotero_backend_endpoint: "",
    semantic_status_checked: false,
    semantic_status_ok: null,
    semantic_status_degraded: false,
    semantic_status_degrade_reason: null,
    semantic_degraded: false,
    semantic_degrade_reason: "",
    semantic_queries_attempted: 0,
    semantic_queries_succeeded: 0,
    semantic_queries_failed: 0,
    feedback_samples_total: Number(preferenceLearningInputs.summary.feedback_rows_total || 0),
    feedback_samples_used: Number(llmPreferenceReport.feedback_rows_used || 0),
    feedback_samples_ignored: Math.max(0, Number(preferenceLearningInputs.summary.feedback_rows_total || 0) - Number(llmPreferenceReport.feedback_rows_used || 0)),
    llm_preference_learning_enabled: Boolean(llmPreferenceReport.enabled),
    llm_preference_learning_ok: Boolean(llmPreferenceReport.ok),
    llm_preference_learning_skipped: Boolean(llmPreferenceReport.skipped),
    llm_preference_learning_path: llmPreferenceReportPath,
    llm_preference_learning_warnings: llmPreferenceReport.warnings || [],
    pending_rule_suggestions_count: Number(llmPreferenceReport.pending_rule_suggestions?.length || 0),
    llm_pending_rule_suggestions_count: Number(llmPreferenceReport.pending_rule_suggestions?.length || 0),
    llm_suggestion_candidates_count: Number(llmPreferenceReport.suggestion_candidates?.length || 0),
    mock_response_used: Boolean(llmPreferenceReport.mock_response_used),
    real_request_sent: Boolean(llmPreferenceReport.real_request_sent),
    signals: {
      ...medQueryLearning.signals,
      semantic_unavailable: false,
      llm_preference_learning_unavailable: !llmPreferenceReport.ok,
    },
  };

  // Preference audit
  const refined = { preferences: [], evidence: [], conflicts: [], stats: {}, cluster_changes: [], clusters: [] };
  const feedbackSamples = [];
  const preferenceAuditPath = path.join(pipeDir, "preference_learning_audit.json");
  const preferenceLearningInitialAuditPath = path.join(pipeDir, "preference_learning_initial_audit.json");
  let preferenceAudit = buildPreferenceLearningAudit({
    medQueryLearning: updatedMedQueryLearning,
    feedbackLearning,
    samples: feedbackSamples,
    refined,
    triagedItems: [],
    auditPath: preferenceAuditPath,
  });

  // Apply screening standards learning update
  const standardsUpdate = await applyScreeningStandardsLearningUpdate(reviewRoot, preferenceAudit, { generatedAt: new Date().toISOString(), suggestionsLogPath: ruleSuggestionsLogPath(reviewRoot) });
  updatedMedQueryLearning.screening_standards_path = standardsUpdate.path;
  updatedMedQueryLearning.screening_standards_loaded = standardsUpdate.loaded;
  updatedMedQueryLearning.screening_standards_cleaned = standardsUpdate.cleaned;
  updatedMedQueryLearning.screening_standards_primary_rationale_source = standardsUpdate.used_as_primary_rationale_source;
  updatedMedQueryLearning.screening_standards_change_markup_applied = standardsUpdate.change_markup_applied;
  updatedMedQueryLearning.screening_standards_additions_count = standardsUpdate.additions_count;
  updatedMedQueryLearning.screening_standards_deletions_count = standardsUpdate.deletions_count;
  updatedMedQueryLearning.screening_standards_docx_path = standardsUpdate.docx_path;
  updatedMedQueryLearning.screening_standards_docx_synced = Boolean(standardsUpdate.docx_synced);

  preferenceAudit = {
    ...preferenceAudit,
    screening_standards_path: standardsUpdate.path,
    screening_standards_loaded: standardsUpdate.loaded,
    screening_standards_cleaned: standardsUpdate.cleaned,
    screening_standards_primary_rationale_source: standardsUpdate.used_as_primary_rationale_source,
    screening_standards_change_markup_applied: standardsUpdate.change_markup_applied,
    screening_standards_additions_count: standardsUpdate.additions_count,
    screening_standards_deletions_count: standardsUpdate.deletions_count,
    screening_standards_docx_path: standardsUpdate.docx_path,
    screening_standards_docx_synced: Boolean(standardsUpdate.docx_synced),
    summary: {
      ...preferenceAudit.summary,
      screening_standards_path: standardsUpdate.path,
      screening_standards_loaded: standardsUpdate.loaded,
      screening_standards_cleaned: standardsUpdate.cleaned,
      screening_standards_primary_rationale_source: standardsUpdate.used_as_primary_rationale_source,
      screening_standards_change_markup_applied: standardsUpdate.change_markup_applied,
      screening_standards_additions_count: standardsUpdate.additions_count,
      screening_standards_deletions_count: standardsUpdate.deletions_count,
      screening_standards_docx_path: standardsUpdate.docx_path,
      screening_standards_docx_synced: Boolean(standardsUpdate.docx_synced),
    },
  };
  updatedMedQueryLearning.preference_learning_audit_path = preferenceAuditPath;
  updatedMedQueryLearning.preference_learning_summary_exported = true;
  updatedMedQueryLearning.current_standard_summary_excerpt = preferenceAudit.current_standard_summary?.one_sentence_summary || "";
  updatedMedQueryLearning.preference_learning_sheets_exported = ["每日反馈"];
  updatedMedQueryLearning.ignored_feedback_samples = Number(updatedMedQueryLearning.feedback_samples_ignored || 0);
  updatedMedQueryLearning.triage_impact_available = preferenceAudit.triage_impact_available;
  updatedMedQueryLearning.score_delta_available = preferenceAudit.score_delta_available;
  updatedMedQueryLearning.detected_headers = updatedMedQueryLearning.previous_feedback_headers || [];
  updatedMedQueryLearning.expected_feedback_aliases = ["feedback", "Feedback", "反馈", "用户反馈"];
  updatedMedQueryLearning.expected_comment_aliases = ["comment", "Comment", "备注", "评价备注"];
  updatedMedQueryLearning.missing_columns = [
    updatedMedQueryLearning.feedback_column_detected ? null : "feedback",
  ].filter(Boolean);
  updatedMedQueryLearning.blocker = "";
  if (updatedMedQueryLearning.workbook_unreadable) {
    updatedMedQueryLearning.blocker = "workbook_unreadable";
  } else if (updatedMedQueryLearning.missing_columns.length && updatedMedQueryLearning.detected_headers.length > 0) {
    updatedMedQueryLearning.blocker = "required_feedback_columns_missing";
  } else if ((updatedMedQueryLearning.rows_with_feedback || 0) === 0) {
    updatedMedQueryLearning.blocker = "no_supported_feedback_rows";
  }
  updatedMedQueryLearning.blockers = feedbackDiag.preference_learning?.blockers || (updatedMedQueryLearning.blocker ? [updatedMedQueryLearning.blocker] : []);
  updatedMedQueryLearning.degraded_reason = updatedMedQueryLearning.blocker || updatedMedQueryLearning.semantic_degrade_reason || "";
  updatedMedQueryLearning.signals.score_delta_unavailable = !preferenceAudit.score_delta_available;
  await fs.writeFile(preferenceLearningInitialAuditPath, JSON.stringify(preferenceAudit, null, 2), "utf8");

  const preferenceLearningExecutionSummary = buildPreferenceLearningExecutionSummary({
    inputRowsCount: Number(preferenceLearningInputs?.summary?.feedback_rows_total || 0),
    enabled: Boolean(llmPreferenceReport?.enabled ?? true),
    triggered: Boolean(!llmPreferenceReport?.skipped && (preferenceLearningInputs?.summary?.feedback_rows_total || 0) > 0),
    processedRowsCount: Number(llmPreferenceReport?.feedback_rows_used || 0),
    succeededCount: Number(llmPreferenceReport?.suggestion_candidates?.length || llmPreferenceReport?.feedback_rows_used || 0),
    failedCount: Number(llmPreferenceReport?.failed_batch_count || 0),
    skippedReason: llmPreferenceReport?.skip_reason || (preferenceLearningInputs?.skip_reason) || null,
    failureReasons: llmPreferenceReport?.failed_batch_details || [],
    degraded: Boolean(llmPreferenceReport?.failed_batch_count > 0 && llmPreferenceReport?.feedback_rows_used > 0),
    resultItemsCount: Number(llmPreferenceReport?.suggestion_candidates?.length || 0),
    auditWritePlanned: true,
    auditWriteAttempted: true,
    auditWriteSucceeded: Boolean(updatedMedQueryLearning?.preference_learning_summary_exported),
    initialAuditPath: preferenceLearningInitialAuditPath,
    auditPath: preferenceAuditPath,
    auditOverwriteRisk: false,
  });

  return {
    manualStandardEvaluation,
    feedbackLearning,
    medQueryLearning: updatedMedQueryLearning,
    llmPreferenceReport,
    preferenceAudit,
    preferenceLearningExecutionSummary,
    preferenceLearningInputs,
    preferenceAuditPath,
    preferenceLearningInitialAuditPath,
  };
}
