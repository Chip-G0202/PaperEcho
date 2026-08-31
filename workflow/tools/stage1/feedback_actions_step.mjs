/**
 * Feedback actions step.
 *
 * Handles feedback item actions and writeback preparation.
 */
import { buildWritebackReadyArtifact } from "../lib/pipeline_stage_support.mjs";
import { buildStage1TriageSummary } from "./triage_summary.mjs";
import { runFeedbackItemActionsStep } from "./feedback_item_actions_step.mjs";
import { loadTranslationCache, getTranslationConfig } from "../lib/title_translation_support.mjs";

/**
 * Run feedback actions and writeback preparation.
 *
 * @param {Object} options
 * @param {Object} options.report - Report object
 * @param {Array} options.triagedAll - All triaged items
 * @param {Object} options.llmReviewCandidateSelection - LLM review candidate selection
 * @param {Object} options.connectorOk - Connector status
 * @param {string} options.researchRoot - Research root path
 * @param {string} options.reviewRoot - Review root path
 * @param {string} options.pipeDir - Pipeline directory
 * @param {string} options.startedAt - Start time
 * @param {Object} options.timingContext - Timing context
 * @param {number} options.exportLimit - Export limit
 * @returns {Promise<Object>} Feedback actions results
 */
export async function runFeedbackActionsAndWriteback({
  report,
  triagedAll,
  llmReviewCandidateSelection,
  connectorOk,
  researchRoot,
  reviewRoot,
  pipeDir,
  startedAt,
  timingContext,
  exportLimit,
  translationCachePath,
  feedbackActionSink = null,
  normalizedFeedbackRows = [],
  skipItemActions = false,
  noWriteback = false,
}) {
  const { recordTiming, flushTimingDiagnostics, lastKnownPhase } = timingContext;

  // Feedback item actions
  const applyItemActions = /^(1|true|yes)$/i.test(String(process.env.APPLY_FEEDBACK_ITEM_ACTIONS ?? "true"));
  const feedbackItemActionsResult = skipItemActions
    ? { feedbackItemActionsReport: { status: "skipped", reason: "radar_profile", planned_actions_count: 0, executed_actions_count: 0, feedback_used_for_item_actions: false, feedback_item_actions_default_enabled: false, feedback_item_actions_mode: "disabled", collection_scope_blocked_count: 0, collection_scope_blocked_samples: [] }, lastKnownPhase }
    : typeof feedbackActionSink === "function"
    ? {
        feedbackItemActionsReport: await feedbackActionSink(normalizedFeedbackRows),
        lastKnownPhase,
      }
    : await runFeedbackItemActionsStep({
    connectorOk,
    researchRoot,
    reviewRoot,
    pipeDir,
    startedAt,
    applyItemActions,
    timingContext: { recordTiming, flushTimingDiagnostics, lastKnownPhase },
      });
  const { feedbackItemActionsReport } = feedbackItemActionsResult;
  const updatedLastKnownPhase = feedbackItemActionsResult.lastKnownPhase;

  // Update report
  report.steps.feedback_item_actions = feedbackItemActionsReport;
  recordTiming("feedback_item_actions", startedAt, {
    status: feedbackItemActionsReport.status || "unknown",
    planned_actions_count: Number(feedbackItemActionsReport.planned_actions_count || 0),
    executed_actions_count: Number(feedbackItemActionsReport.executed_actions_count || 0),
  });
  report.steps.med_query_learning.feedback_used_for_item_actions = feedbackItemActionsReport.feedback_used_for_item_actions;
  report.steps.med_query_learning.feedback_item_actions_default_enabled = true;
  report.steps.med_query_learning.feedback_item_actions_mode = feedbackItemActionsReport.feedback_item_actions_mode;
  report.steps.med_query_learning.feedback_item_actions_status = feedbackItemActionsReport.status;
  report.collection_scope_blocked_count = Number(feedbackItemActionsReport.collection_scope_blocked_count || 0);
  report.collection_scope_blocked_samples = feedbackItemActionsReport.collection_scope_blocked_samples || [];

  // Writeback preparation
  const translationCache = await loadTranslationCache(translationCachePath);
  const writebackReadyArtifact = noWriteback
    ? { items: [] }
    : buildWritebackReadyArtifact(triagedAll, { translationCache, exportLimit });
  const writebackReady = writebackReadyArtifact.items;

  // Update triage summary
  const realLlmCandidateCount = llmReviewCandidateSelection.candidates.length;
  const realWritebackReadyCount = writebackReadyArtifact.items.length;
  const updatedTriageSummary = buildStage1TriageSummary({
    items: triagedAll,
    llmReviewCandidateCount: realLlmCandidateCount,
    writebackReadyItemsCount: realWritebackReadyCount,
  });
  report.steps.triage.triage_summary = updatedTriageSummary;

  const triaged = writebackReady;
  const abcAllItems = noWriteback ? [] : triagedAll.filter((it) => it && it.grade && it.grade !== "D" && it.pre_llm_skip_writeback !== true);
  const translationConfig = getTranslationConfig();

  return {
    feedbackItemActionsReport,
    writebackReady,
    triaged,
    abcAllItems,
    translationConfig,
    updatedTriageSummary,
    lastKnownPhase: updatedLastKnownPhase,
  };
}
