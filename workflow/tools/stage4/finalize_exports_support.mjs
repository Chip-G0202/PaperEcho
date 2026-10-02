import { resolveCachedTranslation } from "../lib/title_translation_support.mjs";
import { classifyLiterature } from '../stage1/semantic_grade_synthesis.mjs';
import { feedbackIdentity } from '../lib/control_feedback_service.mjs';
import { matchPendingPaperRecord, manualDecisionForRecord } from '../lib/pending_paper_review.mjs';
import {
  buildStage1WritebackCorrelationKey,
  buildWritebackReadyItems,
  filterDesktopReviewSourceByWritebackSummary,
  resolveVerifiedWritebackItems,
} from "../lib/pipeline_stage_support.mjs";

export function buildReviewProjectionContext(report = {}, options = {}) {
  const stage = report.steps?.llm_grade_review || report.steps?.semantic_grading;
  const failed = stage && (Number(stage.failed_batch_count || 0) > 0 || (stage.ok === false && stage.skipped !== true));
  return { ...options, workflowValid: !report.skipped && report.profile !== 'radar' && report.runtime_profile !== 'radar', semanticStageStatus: failed ? 'failed' : stage?.ok === true && stage.skipped !== true ? 'completed' : undefined };
}

// Current artifact selection belongs to the caller. A safety hold alone does
// not grant reachability, and automatic writeback eligibility is not required.
export function isManualReviewReachable(item, context = {}) {
  if (context.workflowValid === false || context.semanticStageStatus === 'failed' || classifyLiterature(item, context).reviewBucket !== 'manual'
    || (context.currentRunId && item.last_run_id !== context.currentRunId)
    || item.pre_llm_zotero_existing_duplicate === true) return false;
  let keys;
  try { keys = feedbackIdentity(item); } catch { return false; }
  // An untitled item needs a real paper identifier for later replay, not only
  // a syntactically valid review UUID with no recoverable paper evidence.
  if (!String(item.title || '').trim() && !keys.some(key => !key.startsWith('review:'))) return false;
  return !manualDecisionForRecord({ id: item.pending_review_id || '', keys }, context.current || []);
}

// Feedback comes from normal final admission. Manual can also come from the
// same run's Stage1 evidence, after its independent reachability checks.
export function buildFinalReviewMembership(items = [], context = {}) {
  const membership = { feedback: [], manual: [], excluded: [], blocked: [] };
  const seen = new Set();
  const addManual = (original) => {
    const record = matchPendingPaperRecord(original, context.pendingRecords || []);
    const item = record && original.pending_review_id !== record.id ? { ...original, pending_review_id: record.id } : original;
    if (!isManualReviewReachable(item, context)) return;
    const keys = feedbackIdentity(item);
    if (keys.some(key => seen.has(key))) return;
    keys.forEach(key => seen.add(key));
    membership.manual.push(item);
  };
  for (const item of items) {
    if (context.semanticStageStatus === 'failed') { membership.blocked.push(item); continue; }
    const decision = classifyLiterature(item, context);
    if (decision.reviewBucket === 'manual') addManual(item);
    else {
      membership[decision.reviewBucket || 'blocked'].push(item);
      try { feedbackIdentity(item).forEach(key => seen.add(key)); } catch {}
    }
  }
  for (const item of context.manualCandidates || []) addManual(item);
  return membership;
}

export function buildProspectiveStage4ExportSource(items = [], reviewContext = {}) {
  return buildFinalExportPayload({ allAbcItems: buildWritebackReadyItems(items), manualCandidates: items, reviewContext }).triaged;
}

export function buildStage4StandaloneExportSource({
  desktopSource = null,
  writebackReady = [],
  writebackSummary = null,
} = {}) {
  const candidateSource = desktopSource && Array.isArray(desktopSource.triaged)
    ? desktopSource
    : { triaged: Array.isArray(writebackReady) ? writebackReady : [] };
  const filter = filterDesktopReviewSourceByWritebackSummary(candidateSource, writebackSummary);
  return {
    source: filter.source,
    allAbcItems: Array.isArray(filter.source?.triaged) ? filter.source.triaged : [],
    filter,
  };
}

export function buildFinalExportPayload({
  writebackReady = [],
  writebackSummary = {},
  backfillReport = {},
  reportContext = {},
  translationCache = null,
  allAbcItems = null,
  manualCandidates = [],
  reviewContext = {},
} = {}) {
  const verifiedResolution = resolveVerifiedWritebackItems(writebackSummary);
  const successfulWritebackItems = verifiedResolution.ok ? verifiedResolution.items : [];
  // Uses the same correlation key as filterDesktopReviewSourceByWritebackSummary
  // to ensure consistency across orchestrator (Stage 2→desktop source) and Stage 4 export.
  const itemKeyByStage1Key = new Map();
  for (const item of successfulWritebackItems) {
    const key = buildStage1WritebackCorrelationKey(item);
    if (key && key !== "||" && !itemKeyByStage1Key.has(key)) {
      itemKeyByStage1Key.set(key, item.itemKey);
    }
  }
  const translatedByKey = new Map(
    (backfillReport.updated_items || []).map((item) => [item.itemKey, item.shortTitle]),
  );
  const writebackItemKeys = new Set(successfulWritebackItems.map((it) => it.itemKey).filter(Boolean));

  // allAbcItems is expected to be pre-filtered by the orchestrator to only include
  // items backed by Stage 2 verified execution evidence. An explicitly empty array
  // must remain empty; only a missing value uses writebackReady for legacy callers.
  const baseItems = (Array.isArray(allAbcItems) ? allAbcItems : writebackReady).filter((item) => {
    const grade = String(item?.final_grade || item?.grade || item?.rule_grade || item?.["推荐等级"] || "");
    return grade && grade !== "D" && grade !== "D无关";
  });
  const normalItems = baseItems.map((item) => {
    const record = matchPendingPaperRecord(item, reviewContext.pendingRecords || []);
    const itemKey = item.itemKey || itemKeyByStage1Key.get(buildStage1WritebackCorrelationKey(item));
    const cacheTranslation = resolveCachedTranslation(translationCache, item.title);
    const translatedTitle = translatedByKey.get(itemKey) || cacheTranslation || item["标题翻译"] || item["中文标题"] || item.title || "";
    const wasWrittenBack = itemKey ? writebackItemKeys.has(itemKey) : false;
    return {
      ...item,
      ...(record ? { pending_review_id: record.id } : {}),
      semantic_stage_status: item.semantic_stage_status || reviewContext.semanticStageStatus,
      itemKey,
      标题翻译: translatedTitle,
      中文标题: translatedTitle,
      写回状态: wasWrittenBack ? "已写回" : (itemKey ? "待核对" : "未写回"),
    };
  });
  const membership = buildFinalReviewMembership(normalItems, { ...reviewContext, manualCandidates });
  const normalKeys = new Set(normalItems.flatMap(item => { try { return feedbackIdentity(item); } catch { return []; } }));
  const admittedManualKeys = new Set(membership.manual.flatMap(feedbackIdentity));
  const triaged = normalItems.filter(item => {
    if (reviewContext.semanticStageStatus === 'failed') return false;
    if (classifyLiterature(item, reviewContext).reviewBucket !== 'manual') return true;
    try { return feedbackIdentity(item).some(key => admittedManualKeys.has(key)); } catch { return false; }
  });
  triaged.push(...membership.manual.filter(item => !feedbackIdentity(item).some(key => normalKeys.has(key)))
    .map(item => ({ ...item, semantic_stage_status: item.semantic_stage_status || reviewContext.semanticStageStatus, 写回状态: '未写回' })));

  return {
    triaged,
    reportContext: {
      ...reportContext,
      translation: {
        failed_count: backfillReport.failure_count || 0,
        failed_samples: backfillReport.failures || [],
        stage: "completed_after_writeback",
        ...(reportContext.translation || {}),
      },
    },
  };
}
