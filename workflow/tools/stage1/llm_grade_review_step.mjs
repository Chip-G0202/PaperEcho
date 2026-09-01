import path from "node:path";
import { buildLlmReviewExecutionSummary } from "./llm_review_execution_summary.mjs";
import { buildLlmReviewApplicationSummary } from "./llm_review_application_summary.mjs";
import { reviewGradesWithLlm } from "./llm_grade_reviewer.mjs";
import { buildLlmRuleContextSummary } from "./llm_rule_context.mjs";

/**
 * Run the LLM grade review step.
 * NOTE: This function mutates triagedAll items in place to add semantic grading fields.
 * @param {Object} params
 * @param {Array} params.triagedAll - Array of triaged items (will be mutated in place)
 * @param {Array} params.llmReviewItems - Items eligible for LLM review
 * @param {number} params.llmReviewCandidateCount - Number of LLM review candidates
 * @param {Object} params.preLlmExistingDedupe - Pre-LLM dedupe diagnostics
 * @param {Object} params.llmReviewConfig - LLM review configuration
 * @param {Object} params.llmRuntime - LLM runtime configuration
 * @param {string} params.llmCachePath - Path to LLM cache file
 * @param {string} params.pipeDir - Path to pipeline directory
 * @param {Object} params.report - Report object (will be mutated)
 * @param {Function} params.recordTiming - Function to record timing
 * @param {Object} params.reviewConfig - Review configuration
 * @param {number} params.reviewConfig.effectiveMaxGradeReviewItems - Max items to review
 * @param {string} params.reviewConfig.maxGradeReviewItemsSource - Source of max items config
 * @param {number} params.reviewConfig.effectiveGradeReviewBatchSize - Batch size for review
 * @param {string} params.reviewConfig.gradeReviewBatchSizeSource - Source of batch size config
 * @param {string} params.root - Project root path
 * @param {string} params.reviewRoot - Review root path
 * @param {number} params.mergedCount - Total merged item count
 * @returns {Promise<{llmGradeReport: Object, semanticGradingReport: Object}>}
 */
export async function runLlmGradeReviewStep({
  triagedAll,
  llmReviewItems,
  llmReviewCandidateCount,
  preLlmExistingDedupe,
  llmReviewConfig,
  llmRuntime,
  llmCachePath,
  pipeDir,
  report,
  recordTiming,
  reviewConfig,
  root,
  reviewRoot,
  mergedCount,
  ruleContextSummary: providedRuleContextSummary = null,
}) {
  const {
    effectiveMaxGradeReviewItems,
    maxGradeReviewItemsSource,
    effectiveGradeReviewBatchSize,
    gradeReviewBatchSizeSource,
  } = reviewConfig;

  // ─── LLM Grade Review Pass ──────────────────────────────────────────
  const semanticGradingStarted = Date.now();
  for (const item of triagedAll) {
    item.rule_grade = item.rule_grade || item.grade;
    if (!item.final_grade) item.final_grade = item.rule_grade || item.grade;
    if (item.semantic_grade) item.semantic_source = "llm_title_review_grade";
  }

  const llmRuleContextStarted = Date.now();
  let ruleContextSummary = providedRuleContextSummary;
  try {
    ruleContextSummary ||= await buildLlmRuleContextSummary({ root, reviewRoot });
    report.steps.llm_rule_context = {
      ok: true,
      context_hash: ruleContextSummary.context_hash || "",
      warnings: ruleContextSummary.warnings || [],
    };
  } catch (err) {
    report.steps.llm_rule_context = { ok: false, error: String(err?.message || err) };
  }
  recordTiming("llm_rule_context", llmRuleContextStarted, {
    ok: Boolean(report.steps.llm_rule_context?.ok),
    context_hash: report.steps.llm_rule_context?.context_hash || "",
  });

  report.steps.ollama = {
    ok: false,
    skipped: true,
    required: false,
    backend_used: false,
    reason: "not_required_for_llm_grade_review",
    replaced_by: "llm_grade_review",
  };

  const llmGradeReportPath = path.join(pipeDir, "llm_grade_review.json");
  const llmGradeReviewStarted = Date.now();
  const llmGradeReport = await reviewGradesWithLlm({
    items: llmReviewItems,
    outputPath: llmGradeReportPath,
    cachePath: llmCachePath,
    config: llmReviewConfig,
    runtime: llmRuntime,
    ruleContextSummary,
    reviewInputDiagnostics: {
      pre_llm_zotero_duplicate_check_enabled: true,
      pre_llm_eligible_count: llmReviewCandidateCount,
      skipped_existing_before_review_count: Number(preLlmExistingDedupe.diagnostics.skipped_llm_review_existing_count || 0),
      duplicate_check_failed_reviewed_count: Number(preLlmExistingDedupe.diagnostics.duplicate_check_failed_reviewed_count || 0),
    },
    generatedAt: report.started_at,
  });

  for (const item of triagedAll) {
    item.rule_grade = item.rule_grade || item.grade;
    if (!item.final_grade) item.final_grade = item.rule_grade || item.grade;
    if (!item.semantic_grade) item.semantic_grade = "";
    if (!item.semantic_reason) item.semantic_reason = "";
    if (!item.semantic_confidence) item.semantic_confidence = 0;
    if (item.semantic_grade) item.semantic_source = "llm_title_review_grade";
    if (typeof item.needs_human_review !== "boolean") item.needs_human_review = false;
    if (!item.disagreement_type) item.disagreement_type = "";
  }

  recordTiming("llm_grade_review", llmGradeReviewStarted, {
    method: "llm_title_grade_review",
    ok: Boolean(llmGradeReport.ok),
    skipped: Boolean(llmGradeReport.skipped),
    max_grade_review_items: effectiveMaxGradeReviewItems,
    max_grade_review_items_source: maxGradeReviewItemsSource,
    batch_size: effectiveGradeReviewBatchSize,
    batch_size_source: gradeReviewBatchSizeSource,
    batch_concurrency: Number(llmGradeReport.batch_concurrency || llmReviewConfig.batch_concurrency || 1),
    items_reviewed: Number(llmGradeReport.items_reviewed || 0),
    mock_response_used: Boolean(llmGradeReport.mock_response_used),
    real_request_sent_count: Number(llmGradeReport.real_request_sent_count || 0),
    failed_batch_count: Number(llmGradeReport.failed_batch_count || 0),
    retry_batch_count: Number(llmGradeReport.retry_batch_count || 0),
    retry_success_count: Number(llmGradeReport.retry_success_count || 0),
    split_batch_count: Number(llmGradeReport.split_batch_count || 0),
    split_success_count: Number(llmGradeReport.split_success_count || 0),
    failed_batch_attempt_count: Number(llmGradeReport.failed_batch_attempt_count || 0),
    parse_failure_count: Number(llmGradeReport.parse_failure_count || 0),
    repair_attempt_count: Number(llmGradeReport.repair_attempt_count || 0),
    repair_success_count: Number(llmGradeReport.repair_success_count || 0),
    total_request_attempts: Number(llmGradeReport.timing_diagnostics?.total_request_attempts || 0),
    avg_response_length: llmGradeReport.avg_response_length ?? null,
    max_response_length: llmGradeReport.max_response_length ?? null,
    avg_prompt_length: llmGradeReport.timing_diagnostics?.avg_prompt_length ?? null,
    max_prompt_length: llmGradeReport.timing_diagnostics?.max_prompt_length ?? null,
    total_prompt_chars: llmGradeReport.timing_diagnostics?.total_prompt_chars ?? null,
    total_response_chars: llmGradeReport.timing_diagnostics?.total_response_chars ?? null,
    avg_batch_duration_ms: llmGradeReport.timing_diagnostics?.avg_duration_ms ?? null,
    max_batch_duration_ms: llmGradeReport.timing_diagnostics?.max_duration_ms ?? null,
    slowest_batches_top5: llmGradeReport.timing_diagnostics?.slowest_top5 || [],
  });

  const semanticGradingReport = {
    ...llmGradeReport,
    method: "llm_title_grade_review",
    compatibility_only: true,
    compatibility_reason: "removed_llm_workflow",
    semantic_search_used: false,
    ollama_required: false,
    semantic_backend_used: false,
    semantic_grade_source: "llm_title_review_grade",
    max_grade_review_items: effectiveMaxGradeReviewItems,
    max_grade_review_items_source: maxGradeReviewItemsSource,
    batch_size: effectiveGradeReviewBatchSize,
    batch_size_source: gradeReviewBatchSizeSource,
    batch_concurrency: Number(llmGradeReport.batch_concurrency || llmReviewConfig.batch_concurrency || 1),
    output_path: llmGradeReportPath,
    llm_grade_review_ok: Boolean(llmGradeReport.ok),
    llm_grade_review_skipped: Boolean(llmGradeReport.skipped),
    mock_response_used: Boolean(llmGradeReport.mock_response_used),
    real_request_sent_count: Number(llmGradeReport.real_request_sent_count || 0),
    failed_batch_count: Number(llmGradeReport.failed_batch_count || 0),
    retry_batch_count: Number(llmGradeReport.retry_batch_count || 0),
    retry_success_count: Number(llmGradeReport.retry_success_count || 0),
    split_batch_count: Number(llmGradeReport.split_batch_count || 0),
    split_success_count: Number(llmGradeReport.split_success_count || 0),
    failed_batch_attempt_count: Number(llmGradeReport.failed_batch_attempt_count || 0),
    parse_failure_count: Number(llmGradeReport.parse_failure_count || 0),
    repair_attempt_count: Number(llmGradeReport.repair_attempt_count || 0),
    repair_success_count: Number(llmGradeReport.repair_success_count || 0),
    avg_response_length: llmGradeReport.avg_response_length ?? null,
    max_response_length: llmGradeReport.max_response_length ?? null,
    avg_prompt_length: llmGradeReport.timing_diagnostics?.avg_prompt_length ?? null,
    max_prompt_length: llmGradeReport.timing_diagnostics?.max_prompt_length ?? null,
    total_prompt_chars: llmGradeReport.timing_diagnostics?.total_prompt_chars ?? null,
    total_response_chars: llmGradeReport.timing_diagnostics?.total_response_chars ?? null,
    timing_diagnostics: llmGradeReport.timing_diagnostics || null,
  };

  report.steps.semantic_grading = semanticGradingReport;
  recordTiming("semantic_grading", semanticGradingStarted, {
    method: "llm_title_grade_review",
    enabled: Boolean(semanticGradingReport.enabled),
    semantic_search_used: false,
    ollama_required: false,
    semantic_backend_used: false,
    semantic_grade_source: "llm_title_review_grade",
    max_grade_review_items: effectiveMaxGradeReviewItems,
    max_grade_review_items_source: maxGradeReviewItemsSource,
    batch_size: effectiveGradeReviewBatchSize,
    batch_size_source: gradeReviewBatchSizeSource,
    batch_concurrency: Number(semanticGradingReport.batch_concurrency || llmReviewConfig.batch_concurrency || 1),
    llm_grade_review_ok: Boolean(semanticGradingReport.llm_grade_review_ok),
    llm_grade_review_skipped: Boolean(semanticGradingReport.llm_grade_review_skipped),
    items_reviewed: Number(semanticGradingReport.items_reviewed || 0),
    failed_batch_count: Number(semanticGradingReport.failed_batch_count || 0),
    retry_batch_count: Number(semanticGradingReport.retry_batch_count || 0),
    retry_success_count: Number(semanticGradingReport.retry_success_count || 0),
    split_batch_count: Number(semanticGradingReport.split_batch_count || 0),
    split_success_count: Number(semanticGradingReport.split_success_count || 0),
    failed_batch_attempt_count: Number(semanticGradingReport.failed_batch_attempt_count || 0),
    parse_failure_count: Number(semanticGradingReport.parse_failure_count || 0),
    repair_attempt_count: Number(semanticGradingReport.repair_attempt_count || 0),
    repair_success_count: Number(semanticGradingReport.repair_success_count || 0),
    total_request_attempts: Number(semanticGradingReport.timing_diagnostics?.total_request_attempts || 0),
    avg_response_length: semanticGradingReport.avg_response_length ?? null,
    max_response_length: semanticGradingReport.max_response_length ?? null,
    avg_prompt_length: semanticGradingReport.timing_diagnostics?.avg_prompt_length ?? null,
    max_prompt_length: semanticGradingReport.timing_diagnostics?.max_prompt_length ?? null,
    total_prompt_chars: semanticGradingReport.timing_diagnostics?.total_prompt_chars ?? null,
    total_response_chars: semanticGradingReport.timing_diagnostics?.total_response_chars ?? null,
    avg_batch_duration_ms: semanticGradingReport.timing_diagnostics?.avg_duration_ms ?? null,
    max_batch_duration_ms: semanticGradingReport.timing_diagnostics?.max_duration_ms ?? null,
    skipped_reason: semanticGradingReport.skipped_reason || "",
  });

  report.llm_review_candidate_summary = {
    deduped_items_count: report.steps.dedupe?.deduped_count ?? mergedCount,
    abc_grade_items_count: llmReviewCandidateCount,
    llm_review_candidates_count: llmReviewItems.length,
    excluded_non_abc_count: report.steps.dedupe?.excluded_non_abc_count ?? 0,
    excluded_not_deduped_count: report.steps.dedupe?.excluded_not_deduped_count ?? 0,
    llm_review_enabled: Boolean(llmGradeReport?.enabled ?? true),
    llm_review_triggered: Boolean(!llmGradeReport?.skipped && llmReviewItems.length > 0),
    skip_reason: (() => {
      if (llmReviewItems.length === 0) return "no_candidates";
      if (llmGradeReport?.skipped === true) return llmGradeReport.skipped_reason || "unknown";
      return "";
    })(),
  };

  report.llm_review_execution_summary = buildLlmReviewExecutionSummary({
    candidateCount: llmReviewItems.length,
    enabled: Boolean(llmGradeReport?.enabled ?? true),
    triggered: Boolean(!llmGradeReport?.skipped && llmReviewItems.length > 0),
    reviewedCount: Number(llmGradeReport?.items_reviewed || 0),
    succeededCount: Number(llmGradeReport?.llm_review_grades?.length || llmGradeReport?.items_reviewed || 0),
    failedCount: Number(llmGradeReport?.failed_batch_count || 0),
    skippedReason: report.llm_review_candidate_summary.skip_reason || null,
    failureReasons: llmGradeReport?.failed_batch_details || [],
    degraded: Boolean(llmGradeReport?.failed_batch_count > 0 && llmGradeReport?.items_reviewed > 0),
    resultItemsCount: Number(llmGradeReport?.llm_review_grades?.length || 0),
    outputAppliedCount: Number(llmGradeReport?.llm_review_grades?.length || 0),
  });

  report.llm_review_application_summary = buildLlmReviewApplicationSummary({
    triagedItems: triagedAll,
    llmReport: llmGradeReport,
  });

  return { llmGradeReport, semanticGradingReport };
}
