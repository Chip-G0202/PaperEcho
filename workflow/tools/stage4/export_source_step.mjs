import fs from "node:fs/promises";
import path from "node:path";

import { buildSkillAlignmentMatrix } from "../lib/research_os_exports.mjs";
import { buildFinalExportPayload, buildStage4StandaloneExportSource } from "./finalize_exports_support.mjs";
import { loadTranslationCache } from "../lib/title_translation_support.mjs";
import {
  buildNoWriteBackfillFallback,
  buildNoWriteWritebackSummaryFallback,
  buildStage4NoWriteFallbackAudit,
  isNoWriteExportMode,
} from "./no_write_fallback.mjs";
import { readJsonIfPresent } from "./export_io.mjs";

export async function prepareStage4ExportSource({
  dateStr,
  paths,
  runtime,
} = {}) {
  const runReport = JSON.parse(await fs.readFile(paths.runReportPath, "utf8"));
  const noWriteExportMode = isNoWriteExportMode(runReport);
  const failures = Array.isArray(runReport?.failures) ? runReport.failures : [];
  const isBackendReadinessFailure = (failure) => /MCP_NOT_READY|ZOTERO_BACKEND_NOT_READY/i.test(String(failure?.reason || ""));
  const hasStage2Failure = failures.some((f) => String(f?.stage || "").includes("stage2") || isBackendReadinessFailure(f));
  const hasStage3Failure = failures.some((f) => String(f?.stage || "").includes("stage3") || isBackendReadinessFailure(f));
  if ((hasStage2Failure || hasStage3Failure) && !noWriteExportMode) {
    throw new Error(`UPSTREAM_STAGE_FAILED: stage2_failed=${hasStage2Failure} stage3_failed=${hasStage3Failure}`);
  }

  const writebackReady = JSON.parse(await fs.readFile(paths.writebackReadyPath, "utf8"));
  const backfillRead = await readJsonIfPresent(paths.backfillPath);
  let writebackSummaryRead = await readJsonIfPresent(paths.writebackSummaryPath);
  if (writebackSummaryRead.missing && paths.legacyWritebackSummaryPath) {
    const legacyWritebackSummaryRead = await readJsonIfPresent(paths.legacyWritebackSummaryPath);
    if (legacyWritebackSummaryRead.ok) {
      writebackSummaryRead = legacyWritebackSummaryRead;
    }
  }
  if (backfillRead.missing && !noWriteExportMode) {
    throw backfillRead.error;
  }
  if (writebackSummaryRead.missing && !noWriteExportMode) {
    throw writebackSummaryRead.error;
  }
  const backfillReport = backfillRead.ok ? backfillRead.value : buildNoWriteBackfillFallback(runReport);
  const writebackSummary = writebackSummaryRead.ok ? writebackSummaryRead.value : buildNoWriteWritebackSummaryFallback(runReport);
  const stage4NoWriteFallback = buildStage4NoWriteFallbackAudit({
    runReport,
    translationBackfillMissing: backfillRead.missing,
    writebackSummaryMissing: writebackSummaryRead.missing,
  });
  const fallbackExportFields = {
    no_write_stage4_fallback: stage4NoWriteFallback,
    translation_backfill_missing: stage4NoWriteFallback.translation_backfill_missing,
    writeback_summary_missing: stage4NoWriteFallback.writeback_summary_missing,
    fallback_used: stage4NoWriteFallback.fallback_used,
    fallback_reason: stage4NoWriteFallback.reason,
    skip_zotero_backend: stage4NoWriteFallback.skip_zotero_mcp,
    skip_zotero_mcp: stage4NoWriteFallback.skip_zotero_mcp,
    no_formal_rule_apply: stage4NoWriteFallback.no_formal_rule_apply,
    zotero_probe_attempted: stage4NoWriteFallback.zotero_probe_attempted,
    zotero_writeback_attempted: stage4NoWriteFallback.zotero_writeback_attempted,
  };

  let preferenceLearningAudit = {};
  try {
    preferenceLearningAudit = JSON.parse(await fs.readFile(paths.preferenceAuditPath, "utf8"));
  } catch {
    preferenceLearningAudit = {};
  }
  const translationCache = await loadTranslationCache(runtime.translationCachePath);

  let desktopSource = { triaged: [] };
  try {
    const stage1Source = JSON.parse(await fs.readFile(paths.sourcePath, "utf8"));
    if (Array.isArray(stage1Source?.triaged)) {
      desktopSource = stage1Source;
    }
  } catch {
    // Stage 1 source not available; fall back inside the writeback-summary filter.
  }

  const stage4Source = buildStage4StandaloneExportSource({
    desktopSource,
    writebackReady,
    writebackSummary,
  });
  const sourceFilterAudit = {
    ...stage4Source.filter,
    source: undefined,
    no_write_source_fallback: stage4NoWriteFallback.fallback_used,
    fallback_source: stage4NoWriteFallback.fallback_used ? "writeback_ready_items" : null,
    no_write_stage4_fallback: stage4NoWriteFallback,
  };

  const finalPayload = buildFinalExportPayload({
    writebackReady,
    writebackSummary,
    backfillReport,
    translationCache,
    allAbcItems: stage4Source.allAbcItems,
    reportContext: {
      triggerMode: runReport.triggerMode || runReport.trigger_mode || "",
      feedbackLearning: runReport.steps.feedback_learning,
      preferenceLearningAudit,
      connector: runReport.steps.connector,
      counts: runReport.counts,
      failures: runReport.failures,
      translation: runReport.steps.translation,
      stage4SourceFilter: sourceFilterAudit,
      stage4NoWriteFallback,
      skillAlignment: buildSkillAlignmentMatrix({
        feedbackLearning: runReport.steps.feedback_learning,
        dailyExport: {
          rssCount: runReport.counts.rss_raw,
          databaseCount: runReport.counts.db_raw,
          mergedCount: runReport.counts.merged,
          exportedCount: runReport.counts.daily_export,
          excludesD: true,
          translationFailuresTracked: true,
        },
        weeklyAssets: { updated: false },
        zoteroWriteback: { backendOnly: true, tagCleanupUsesWriteTag: true, migrationTracked: true },
      }),
    },
  });

  await fs.mkdir(paths.reviewDayDir, { recursive: true });
  await fs.writeFile(paths.sourcePath, JSON.stringify({
    date: dateStr,
    triaged: finalPayload.triaged,
    reportContext: finalPayload.reportContext,
    stage4_source_filter: sourceFilterAudit,
  }, null, 2), "utf8");

  return {
    runReport,
    writebackSummary,
    backfillReport,
    finalPayload,
    sourceFilterAudit,
    fallbackExportFields,
  };
}

export function buildLocalStage4ExportSource({ papers = [], runReport = {}, preferenceLearningAudit = {} } = {}) {
  const triaged = (Array.isArray(papers) ? papers : []).filter((paper) => {
    const grade = String(paper?.final_grade || paper?.grade || paper?.rule_grade || "").slice(0, 1).toUpperCase();
    return grade && grade !== "D";
  }).map((paper) => ({ ...paper }));
  for (const paper of triaged) {
    delete paper.itemKey;
    delete paper.item_key;
    delete paper.collections;
    delete paper.attachments;
    delete paper.rating;
  }
  const payload = {
    schema_version: 1,
    source_type: "local",
    triaged,
    reportContext: {
      feedbackLearning: runReport.steps?.feedback_learning || {},
      preferenceLearningAudit,
      counts: runReport.counts || {},
      failures: runReport.failures || [],
      local: { zotero_backend_used: false, stage2_used: false, stage3_used: false },
    },
  };
  return {
    runReport,
    writebackSummary: { writeback_items: [], failures: [] },
    backfillReport: { updated_items: [], failures: [], failure_count: 0 },
    finalPayload: payload,
    sourceFilterAudit: { source_type: "local", input_count: papers.length, kept_count: triaged.length },
    fallbackExportFields: { local_export_mode: true, fallback_used: false, zotero_probe_attempted: false, zotero_writeback_attempted: false },
  };
}

export async function prepareLocalStage4ExportSource({ sourcePath, ...options } = {}) {
  const result = buildLocalStage4ExportSource(options);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, `${JSON.stringify(result.finalPayload, null, 2)}\n`, "utf8");
  return result;
}
