import { resolveCachedTranslation } from "../lib/title_translation_support.mjs";
import { classifyLiterature } from '../stage1/semantic_grade_synthesis.mjs';
import {
  buildStage1WritebackCorrelationKey,
  buildWritebackReadyItems,
  filterDesktopReviewSourceByWritebackSummary,
  resolveVerifiedWritebackItems,
} from "../lib/pipeline_stage_support.mjs";

// Input is the existing final source (or the existing prospective eligibility
// builder's output), never all Stage1 holds or historical pending records.
export function buildFinalReviewMembership(items = [], context = {}) {
  const membership = { feedback: [], manual: [], excluded: [], blocked: [] };
  for (const item of items) {
    const decision = classifyLiterature(item, context);
    membership[decision.reviewBucket || 'blocked'].push(item);
  }
  return membership;
}

// Stage1 safety holds are not user tasks. Before an export exists, derive only
// the prospective final source through the pipeline's existing pure owners.
export function buildProspectiveStage4ExportSource(items = []) {
  return buildFinalExportPayload({ allAbcItems: buildWritebackReadyItems(items) }).triaged;
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
  const triaged = baseItems.map((item) => {
    const itemKey = item.itemKey || itemKeyByStage1Key.get(buildStage1WritebackCorrelationKey(item));
    const cacheTranslation = resolveCachedTranslation(translationCache, item.title);
    const translatedTitle = translatedByKey.get(itemKey) || cacheTranslation || item["标题翻译"] || item["中文标题"] || item.title || "";
    const wasWrittenBack = itemKey ? writebackItemKeys.has(itemKey) : false;
    return {
      ...item,
      itemKey,
      标题翻译: translatedTitle,
      中文标题: translatedTitle,
      写回状态: wasWrittenBack ? "已写回" : (itemKey ? "待核对" : "未写回"),
    };
  });

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
