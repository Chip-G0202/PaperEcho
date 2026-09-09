import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomicJson } from "../lib/atomic_json.mjs";
import { createCompatMcpToolCall } from "../lib/zotero_backend_compat.mjs";
import { getDefaultZoteroLibraryIndexPath, readZoteroLibraryIndex } from "../lib/zotero_library_index_store.mjs";
import { buildMovePlan, scanFeedbackRows, scanLiteratureRecords } from "../maintenance/archive_history_by_feedback.mjs";
import { applyCorrectionPlan, buildCorrectionPlan, enrichArchivePlanWithZoteroTitleMatches, readCollections } from "../maintenance/zotero_feedback_collection_corrections.mjs";
import { buildZoteroCollectionGuard, summarizeCollectionScopeBlocks } from "../lib/zotero_collection_guard.mjs";

/**
 * Build collections from local library index to avoid expensive API calls
 */
function buildCollectionsFromLocalIndex(localIndex) {
  if (!localIndex?.live_items) return [];

  const collectionsMap = new Map();

  for (const item of Object.values(localIndex.live_items)) {
    for (const collection of item.collections || []) {
      const key = collection.key || collection.collectionKey;
      if (key && !collectionsMap.has(key)) {
        collectionsMap.set(key, {
          key,
          name: collection.name || collection.collectionName || "",
          parentCollection: collection.parentCollection || collection.parent || false,
          path: collection.path || "",
        });
      }
    }
  }

  // Also extract from collections object if available
  if (localIndex.collections && typeof localIndex.collections === "object") {
    for (const [key, collection] of Object.entries(localIndex.collections)) {
      if (key && !collectionsMap.has(key)) {
        collectionsMap.set(key, {
          key,
          name: collection.name || collection.collectionName || "",
          parentCollection: collection.parentCollection || collection.parent || false,
          path: collection.path || "",
        });
      }
    }
  }

  return [...collectionsMap.values()];
}

/**
 * Run the feedback item actions step.
 * @param {Object} params
 * @param {boolean} params.connectorOk - Whether the Zotero connector is ready
 * @param {string} params.researchRoot - Path to review_results root
 * @param {string} params.reviewRoot - Path to review root (文献评价)
 * @param {string} params.pipeDir - Path to pipeline directory
 * @param {string} params.startedAt - ISO timestamp of when the run started
 * @param {boolean} params.applyItemActions - Whether to actually apply actions (vs dry-run)
 * @param {Object} params.timingContext - Timing helpers
 * @param {Function} params.timingContext.recordTiming - Function to record timing
 * @param {Function} params.timingContext.flushTimingDiagnostics - Function to flush timing diagnostics
 * @param {string} params.timingContext.lastKnownPhase - Current phase name (will be updated)
 * @returns {Promise<{feedbackItemActionsReport: Object, lastKnownPhase: string}>}
 */
export async function runFeedbackItemActionsStep({
  connectorOk,
  researchRoot,
  reviewRoot,
  pipeDir,
  startedAt,
  applyItemActions,
  timingContext,
  dependencies = {},
}) {
  const { recordTiming, flushTimingDiagnostics } = timingContext;
  let { lastKnownPhase } = timingContext;

  const feedbackItemActionsStarted = Date.now();
  const feedbackItemActionsReport = {
    feedback_used_for_item_actions: false,
    feedback_item_actions_default_enabled: true,
    feedback_item_actions_mode: applyItemActions ? "apply" : "dry_run",
    planned_actions_count: 0,
    executed_actions_count: 0,
    skipped_actions_count: 0,
    failed_actions_count: 0,
    feedback_item_actions_plan_path: "",
    collection_scope_guard_enabled: true,
    collection_scope_blocked_count: 0,
    collection_scope_blocked_samples: [],
    status: "not_attempted",
  };

  try {
    if (connectorOk) {
      lastKnownPhase = "feedback_item_actions.scanFeedbackRows";
      flushTimingDiagnostics("phase_started", { timing_name: lastKnownPhase });
      const scanFeedbackRowsStarted = Date.now();
      const feedbackRows = await (dependencies.scanFeedbackRows || scanFeedbackRows)(reviewRoot);
      recordTiming("feedback_item_actions.scanFeedbackRows", scanFeedbackRowsStarted, {
        rows_count: feedbackRows.length,
      });

      if (feedbackRows.length > 0) {
        const archiveRoot = path.join(researchRoot, "literature_archive");
        const manifestRoot = path.join(researchRoot, "run_manifests");

        lastKnownPhase = "feedback_item_actions.scanLiteratureRecords";
        flushTimingDiagnostics("phase_started", { timing_name: lastKnownPhase });
        const scanLiteratureRecordsStarted = Date.now();
        const records = await (dependencies.scanLiteratureRecords || scanLiteratureRecords)(researchRoot);
        recordTiming("feedback_item_actions.scanLiteratureRecords", scanLiteratureRecordsStarted, {
          records_count: records.length,
        });

        const planBuildStarted = Date.now();
        const archivePlan = (dependencies.buildMovePlan || buildMovePlan)({ records, feedbackRows, archiveRoot });
        recordTiming("feedback_item_actions.plan_build", planBuildStarted, {
          records_count: records.length,
          feedback_rows_count: feedbackRows.length,
          archive_plan_count: archivePlan.length,
        });

        feedbackItemActionsReport.feedback_used_for_item_actions = true;
        feedbackItemActionsReport.planned_actions_count = archivePlan.filter((e) => e.status === "planned").length;
        feedbackItemActionsReport.skipped_actions_count = archivePlan.filter((e) => e.status === "skipped" || e.status === "needs_review").length;
        feedbackItemActionsReport.status = "plan_generated";

        const enrichSearchTimings = [];
        const summarizeMcpSearchError = (error, args = {}) => {
          const raw = String(error?.message || error || "");
          const codeMatch = raw.match(/"code"\s*:\s*(-?\d+)/);
          const messageMatch = raw.match(/"message"\s*:\s*"([^"]+)"/);
          const title = String(args?.title || args?.query || "");
          return {
            code: codeMatch ? codeMatch[1] : "",
            message: messageMatch ? messageMatch[1] : raw.slice(0, 120),
            query_length: title.length,
            query_preview: title.slice(0, 80),
          };
        };

        const zoteroBackendCall = await (dependencies.createCompatMcpToolCall || createCompatMcpToolCall)();
        const trackedZoteroBackendCall = async (...args) => {
          const start = Date.now();
          try {
            return await zoteroBackendCall(...args);
          } finally {
            enrichSearchTimings.push({ duration_ms: Date.now() - start });
          }
        };

        const enrichStarted = Date.now();
        lastKnownPhase = "feedback_item_actions.enrichArchivePlanWithZoteroTitleMatches";
        await enrichArchivePlanWithZoteroTitleMatches(archivePlan, {
          ...dependencies.enrichmentOptions,
          mcpToolCall: trackedZoteroBackendCall,
          onProgress: async (progress) => {
            feedbackItemActionsReport.enrichment = progress;
            await writeAtomicJson(path.join(pipeDir, "feedback_item_actions_progress.json"), { ...progress, correction_mutation_started: false });
            await flushTimingDiagnostics(progress.status === "running" ? "phase_started_or_heartbeat" : "phase_finished", { timing_name: lastKnownPhase, last_known_phase: lastKnownPhase, status: progress.status, startedAt: progress.startedAt, progress });
            console.log(`[feedback title enrichment] ${progress.completed}/${progress.total}, remote queries ${progress.uniqueRemoteQueries}, requests ${progress.remoteRequests}, cache hits ${progress.cacheHits}, elapsed ${progress.elapsedMs}ms, ${progress.status}`);
          },
        });
        const enrichSearchSummary = {
          total_searches: enrichSearchTimings.length,
          successful_searches: enrichSearchTimings.filter((t) => t.duration_ms < 5000).length,
          failed_searches: enrichSearchTimings.filter((t) => t.duration_ms >= 5000).length,
          avg_duration_ms: enrichSearchTimings.length ? Math.round(enrichSearchTimings.reduce((sum, t) => sum + t.duration_ms, 0) / enrichSearchTimings.length) : 0,
          max_duration_ms: enrichSearchTimings.length ? Math.max(...enrichSearchTimings.map((t) => t.duration_ms)) : 0,
          p95_duration_ms: enrichSearchTimings.length ? enrichSearchTimings.sort((a, b) => a.duration_ms - b.duration_ms)[Math.floor(enrichSearchTimings.length * 0.95)]?.duration_ms || 0 : 0,
          total_duration_ms: enrichSearchTimings.reduce((sum, t) => sum + t.duration_ms, 0),
          top_5_slowest: enrichSearchTimings.sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5),
        };
        feedbackItemActionsReport.enrich_search_timing_summary = enrichSearchSummary;
        recordTiming("feedback_item_actions.enrichArchivePlanWithZoteroTitleMatches", enrichStarted, {
          archive_plan_count: archivePlan.length,
          total_searches: enrichSearchSummary.total_searches,
          successful_searches: enrichSearchSummary.successful_searches,
          failed_searches: enrichSearchSummary.failed_searches,
        });

        let collections = [];
        let collectionGuard = null;
        let collectionScopeBlocks = [];
        const readCollectionsStarted = Date.now();

        try {
          // Try to use local index first for better performance
          const indexPath = getDefaultZoteroLibraryIndexPath(researchRoot);
          const localIndexRead = await readZoteroLibraryIndex(indexPath);

          if (localIndexRead.usable && localIndexRead.index?.live_items) {
            // Use local index to build collections
            collections = buildCollectionsFromLocalIndex(localIndexRead.index);
            collectionGuard = buildZoteroCollectionGuard(collections);
            feedbackItemActionsReport.collection_scope_guard_enabled = true;
            feedbackItemActionsReport.collections_source = "local_index";
            recordTiming("feedback_item_actions.readCollections", readCollectionsStarted, {
              status: "ok",
              collections_count: collections.length,
              collection_guard_ready: Boolean(collectionGuard?.ready),
              source: "local_index",
            });
          } else {
            // Fallback to API calls
            const guardResult = await buildZoteroCollectionGuard(trackedZoteroBackendCall);
            collectionGuard = guardResult;
            collections = await readCollections(trackedZoteroBackendCall);
            collectionScopeBlocks = guardResult.scopeBlocks || [];
            feedbackItemActionsReport.collection_scope_guard_enabled = true;
            feedbackItemActionsReport.collections_source = "api";
            recordTiming("feedback_item_actions.readCollections", readCollectionsStarted, {
              status: "ok",
              collections_count: collections.length,
              collection_guard_ready: Boolean(collectionGuard?.ready),
              source: "api",
            });
          }
        } catch (collErr) {
          feedbackItemActionsReport.collections_fetch_error = String(collErr?.message || collErr);
          feedbackItemActionsReport.collections_source = "error";
          recordTiming("feedback_item_actions.readCollections", readCollectionsStarted, {
            status: "error",
            collections_count: collections.length,
            error: feedbackItemActionsReport.collections_fetch_error,
          });
        }

        const actionGenerationStarted = Date.now();
        const correctionPlan = buildCorrectionPlan({
          archivePlan,
          collections,
          dropMode: applyItemActions ? "quarantine" : "manual",
          includeArchiveCleanup: false,
          collectionGuard,
          collectionScopeBlocks,
        });
        const collectionScopeSummary = summarizeCollectionScopeBlocks(collectionScopeBlocks);
        feedbackItemActionsReport.collection_scope_blocked_count = collectionScopeSummary.collection_scope_blocked_count;
        feedbackItemActionsReport.collection_scope_blocked_samples = collectionScopeSummary.collection_scope_blocked_samples;
        feedbackItemActionsReport.planned_correction_actions = correctionPlan.actions.filter((a) => a.status === "planned").length;
        recordTiming("feedback_item_actions.action_generation", actionGenerationStarted, {
          archive_plan_count: archivePlan.length,
          collections_count: collections.length,
          planned_correction_actions: Number(feedbackItemActionsReport.planned_correction_actions || 0),
          collection_scope_blocked_count: Number(feedbackItemActionsReport.collection_scope_blocked_count || 0),
        });

        if (applyItemActions && !collectionGuard?.ready) {
          feedbackItemActionsReport.status = "skipped_collection_guard_not_ready";
          feedbackItemActionsReport.failed_actions_count = feedbackItemActionsReport.planned_correction_actions;
        } else if (applyItemActions) {
          await applyCorrectionPlan(correctionPlan, {
            mcpToolCall: trackedZoteroBackendCall,
            applyMovesAndCleanup: true,
            applyDropQuarantine: true,
            collectionGuard,
            collectionScopeBlocks,
          });
          Object.assign(feedbackItemActionsReport, summarizeCollectionScopeBlocks(collectionScopeBlocks));
          feedbackItemActionsReport.executed_actions_count = [
            ...correctionPlan.actions,
            ...correctionPlan.cleanup_actions,
          ].filter((a) => ["moved", "moved_to_delete_review", "deleted_collection_only"].includes(a.status)).length;
          feedbackItemActionsReport.status = "applied";
        } else {
          feedbackItemActionsReport.correction_plan_generated = true;
          feedbackItemActionsReport.status = "plan_generated";
        }

        const planPath = path.join(pipeDir, "feedback_item_actions_plan.json");
        await fs.writeFile(planPath, JSON.stringify({
          mode: feedbackItemActionsReport.feedback_item_actions_mode,
          feedback_item_actions_default_enabled: true,
          include_archive_cleanup: false,
          ...summarizeCollectionScopeBlocks(collectionScopeBlocks),
          planned_actions: archivePlan.filter((e) => e.status === "planned"),
          needs_review: archivePlan.filter((e) => e.status === "needs_review" || e.status === "conflict"),
          correction_plan: correctionPlan,
          generated_at: startedAt,
        }, null, 2), "utf8");
        feedbackItemActionsReport.feedback_item_actions_plan_path = planPath;
      } else {
        feedbackItemActionsReport.status = "no_feedback_rows";
      }
    } else {
      feedbackItemActionsReport.status = "skipped_mcp_not_ready";
    }
  } catch (error) {
    if (error?.code === "FEEDBACK_ENRICHMENT_INCOMPLETE") {
      feedbackItemActionsReport.status = error.status;
      error.feedbackItemActionsReport = feedbackItemActionsReport;
      throw error;
    }
    feedbackItemActionsReport.status = "error";
    feedbackItemActionsReport.error = String(error?.message || error);
  }

  const feedbackItemActionsMs = Date.now() - feedbackItemActionsStarted;
  feedbackItemActionsReport.duration_ms = feedbackItemActionsMs;
  recordTiming("feedback_item_actions", feedbackItemActionsStarted, {
    status: feedbackItemActionsReport.status,
    planned_actions_count: feedbackItemActionsReport.planned_actions_count,
    executed_actions_count: feedbackItemActionsReport.executed_actions_count,
  });

  return { feedbackItemActionsReport, lastKnownPhase };
}
