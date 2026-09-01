import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertProfileCapability, runtimeProfile } from "../lib/profile_capabilities.mjs";
import {
  cleanupSignatureTags,
} from "../lib/writeback_support.mjs";
import { LABELS } from "../lib/grade_primitives.mjs";
import { ensureZoteroBackendReady } from "../lib/ensure_zotero_backend_ready.mjs";
import { buildRuntimeConfig, buildRuntimeSafetyConfig } from "../lib/runtime_config.mjs";
import { createZoteroBackendClient } from "../lib/zotero_backend_client.mjs";
import { getDefaultZoteroLibraryIndexPath } from "../lib/zotero_library_index_store.mjs";
import { dayLabel as monthlyDayLabel, monthLabel } from "../lib/report_period_support.mjs";
import { fmtDateRfc, isoWeek, yyMd } from "../lib/date_label_support.mjs";
import { migrateRatedItems as runStarMigration } from "./star_migration.mjs";
import {
  addItemToWorthyCollectionWithGuard,
  removeItemFromCollectionWithGuard,
  runGuardedBulkWritebackMutation,
  writeTagSetWithGuard,
} from "./mutation_guard.mjs";
import { parseStarMigrationConfig, resolveWritebackMcpReadyOptions } from "./runtime_options.mjs";
import { buildWritebackSideEffectSummary } from "./side_effect_summary.mjs";
import {
  getCollectionItemKeys,
} from "./duplicate_scan.mjs";
import { resolveGradeName } from "./item_payload.mjs";
import { runCollectionAttachStep } from "./collection_attach_step.mjs";
import { createStage2ItemWriter, runWritebackExecution } from "./writeback_execution.mjs";
import { markWritebackFailureReport } from "./writeback_failure_report.mjs";
import {
  GRADE_COLLECTIONS,
  SOURCE_COLLECTIONS,
  prepareManagedCollections,
  prepareWritebackTargetCollections,
} from "./collection_preparation_step.mjs";
import { buildWritebackDedupeContext } from "./writeback_dedupe_context.mjs";
import {
  applyStarMigrationToLiveIndex,
  refreshStage2LibraryIndex,
} from "./library_index_refresh_step.mjs";
import { writeStage2WritebackReports } from "./writeback_report_step.mjs";
import { writeAtomicJson } from "../lib/atomic_json.mjs";

export {
  collectRecentDateCollectionNodes,
  parseDateNameToDate,
  parseMonthDayCollectionDate,
} from "../lib/zotero_date_collections.mjs";
export { createItemWithDedupeRetry } from "./item_create_retry.mjs";
export {
  addItemToWorthyCollectionWithGuard,
  removeItemFromCollectionWithGuard,
  runGuardedBulkWritebackMutation,
  writeTagSetWithGuard,
} from "./mutation_guard.mjs";
export { parseStarMigrationConfig, resolveWritebackMcpReadyOptions } from "./runtime_options.mjs";
export { buildWritebackSideEffectSummary } from "./side_effect_summary.mjs";

const RUNTIME = buildRuntimeConfig();
const ROOT = RUNTIME.projectRoot;
const RESEARCH_ROOT = RUNTIME.researchRoot;
const TODAY = RUNTIME.now;
const ZOTERO_LIBRARY_INDEX_PATH = getDefaultZoteroLibraryIndexPath(ROOT);
const zoteroBackendCallCounters = new Map();
let zoteroBackendClientPromise = null;

function getZoteroBackendClient() {
  if (!zoteroBackendClientPromise) {
    zoteroBackendClientPromise = createZoteroBackendClient({
      onToolCall: (name) => {
        zoteroBackendCallCounters.set(name, (zoteroBackendCallCounters.get(name) || 0) + 1);
      },
    });
  }
  return zoteroBackendClientPromise;
}

const HISTORY_COLLECTION_MODIFICATION_FORBIDDEN = false;

async function zoteroBackendToolCall(name, args, id) {
  const client = await getZoteroBackendClient();
  zoteroBackendToolCall.adapter = client.callTool.adapter;
  zoteroBackendToolCall.backendType = client.callTool.backendType;
  return client.callTool(name, args, id);
}

async function ensureZoteroBackendReadyForWriteback({ launchDesktop } = {}) {
  return ensureZoteroBackendReady({
    ...resolveWritebackMcpReadyOptions(),
    ...(typeof launchDesktop === "boolean" ? { launchDesktop } : {}),
  });
}

export { applyStarMigrationToLiveIndex } from "./library_index_refresh_step.mjs";

export function resolveWritebackCollectionNames(now, env = process.env) {
  const prefix = String(env.PAPERFLOW_BENCHMARK_COLLECTION_PREFIX || "").trim();
  return {
    monthName: prefix ? `${prefix}-month` : monthLabel(now),
    dayName: prefix ? `${prefix}-day` : monthlyDayLabel(now),
  };
}

export async function migrateRatedItems({ rootKey, worthyKey, now, zoteroBackendCall, mcpToolCall, starMigrationConfig, collectionGuard = null, collectionScopeBlocks = null, localLibraryIndex = null, recovery = null }) {
  return runStarMigration({
    rootKey,
    worthyKey,
    now,
    zoteroBackendCall: zoteroBackendCall || mcpToolCall,
    starMigrationConfig,
    collectionGuard,
    collectionScopeBlocks,
    localLibraryIndex,
    getCollectionItemKeys,
    addItemToWorthyCollectionWithGuard,
    removeItemFromCollectionWithGuard,
    recovery,
  });
}
export async function runZoteroWriteback({ argv = process.argv, recovery = null, launchDesktop } = {}) {
  assertProfileCapability(runtimeProfile(), "zoteroWrite");
  // Rebuild runtime config to pick up any env var changes (e.g., ZOTERO_PROJECT_ROOT)
  const RUNTIME = buildRuntimeConfig({ argv });
  const ROOT = RUNTIME.projectRoot;
  const RESEARCH_ROOT = RUNTIME.researchRoot;
  const TODAY = RUNTIME.now;
  const stageStarted = Date.now();
  const collectionSetupStarted = Date.now();
  const runtimeSafety = buildRuntimeSafetyConfig({ argv, runtime: RUNTIME });
  const dryRun = Boolean(runtimeSafety.dry_run);
  const dateStr = fmtDateRfc(TODAY);
  const week = isoWeek(TODAY);
  const day = yyMd(TODAY);
  const { monthName: zoteroMonthName, dayName: zoteroDayName } = resolveWritebackCollectionNames(TODAY);
  const pipelineDir = RUNTIME.pipelineDir;
  const triagedPath = path.join(pipelineDir, "writeback_ready_items.json");
  const summaryPath = path.join(pipelineDir, "zotero_writeback_summary.json");
  const dryRunSummaryPath = path.join(pipelineDir, "zotero_writeback_dry_run_summary.json");
  const runReportPath = path.join(pipelineDir, "run_report.json");

  const limitArg = argv.find((x) => x.startsWith("--limit="));
  const limit = limitArg ? Number(limitArg.split("=")[1]) : null;
  const offsetArg = argv.find((x) => x.startsWith("--offset="));
  const offset = offsetArg ? Number(offsetArg.split("=")[1]) : 0;
  const inputFileArg = argv.find((x) => x.startsWith("--input-file="));
  const inputFile = inputFileArg ? inputFileArg.split("=")[1] : null;
  const starMigrationConfig = parseStarMigrationConfig();
  const collectionScopeBlocks = [];

  const triaged = inputFile
    ? JSON.parse(await fs.readFile(inputFile, "utf8"))
    : JSON.parse(await fs.readFile(triagedPath, "utf8"));
  let stage1RunReport = {};
  try {
    stage1RunReport = JSON.parse(await fs.readFile(runReportPath, "utf8"));
  } catch {}
  const itemsAll = (limit ? triaged.slice(offset, offset + limit) : triaged.slice(offset));
  const items = itemsAll.filter((x) => x.grade !== "D");
  console.log("[Stage2] Items to writeback:", items.length);
  if (items.length === 0) {
    console.log("[Stage2] No ABC items to writeback, skipping writeback");
    const emptySummary = {
      status: "skipped",
      reason: "no_abc_items",
      items_attempted: 0,
      items_succeeded: 0,
      items_failed: 0,
      writeback_items: [],
      generated_at: new Date().toISOString(),
    };
    await fs.writeFile(summaryPath, JSON.stringify(emptySummary, null, 2), "utf8");
    if (recovery?.store) await recovery.store.setStage("stage2_writeback", "verified", { skipped: true, reason: "no_abc_items" });
    return { ok: true, skipped: true, reason: "no_abc_items" };
  }


  if (dryRun) {
    const writebackSideEffectSummary = buildWritebackSideEffectSummary({
      itemsPlannedCount: items.length,
      counters: { total: items.length, created: 0, failed: 0 },
      dryRun: true,
      mcpReady: "not_attempted_dry_run",
      executionStatus: "dry_run",
    });
    const summary = {
      date: dateStr,
      status: "dry_run",
      dry_run: true,
      dry_run_source: runtimeSafety.dry_run_source,
      formal_summary_path_skipped: summaryPath,
      dry_run_summary_path: dryRunSummaryPath,
      items_planned_count: items.length,
      would_write_items_count: items.length,
      actual_write_items_count: 0,
      external_write_performed: false,
      mcp_probe_attempted: false,
      zotero_write_attempted: false,
      writeback_side_effect_summary: writebackSideEffectSummary,
      would_write_items: items.map((it, i) => ({
        idx: i,
        title: it?.title || "",
        source_channel: it?.source_channel || "",
        grade: resolveGradeName(it),
        final_grade: it?.final_grade || it?.grade || "",
      })),
    };
    await fs.mkdir(pipelineDir, { recursive: true });
    await fs.writeFile(dryRunSummaryPath, JSON.stringify(summary, null, 2), "utf8");
    if (recovery?.store) await recovery.store.setStage("stage2_writeback", "verified", { skipped: true, reason: "dry_run" });
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  const collectionSetupOperation = typeof recovery?.prepareCollectionSetup === "function"
    ? await recovery.prepareCollectionSetup(["文献池", "待删除", "值得精读", zoteroMonthName, zoteroDayName, ...Object.values(SOURCE_COLLECTIONS), ...Object.values(GRADE_COLLECTIONS)])
    : null;
  await ensureZoteroBackendReadyForWriteback({ launchDesktop });
  const zoteroBackend = (await getZoteroBackendClient()).callTool.adapter;

  const managedCollections = await prepareManagedCollections({ zoteroBackendCall: zoteroBackendToolCall, collectionScopeBlocks });
  const {
    root,
    trashKey,
    worthy,
    currentCollections,
  } = managedCollections;
  let { collectionGuard } = managedCollections;
  const dedupeContext = await buildWritebackDedupeContext({
    indexPath: ZOTERO_LIBRARY_INDEX_PATH,
    root,
    trashKey,
    worthy,
    zoteroBackendCall: zoteroBackendToolCall,
  });
  const {
    localIndexStats,
    currentLiveItems,
    poolIndex,
    trashIndex,
    trashItemCount,
    mergedTombstones,
    tombstoneIndexCount,
    worthyIndex,
    worthyItemCount,
    skipBackendExactDedupe,
    localLibraryIndex,
  } = dedupeContext;

  const writebackCollections = await prepareWritebackTargetCollections({
    root,
    zoteroMonthName,
    zoteroDayName,
    zoteroBackend,
    zoteroBackendCall: zoteroBackendToolCall,
    collectionGuard,
    collectionScopeBlocks,
    currentCollections,
  });
  const {
    monthKey,
    dateKey,
    sourceKeys,
    gradeKeys,
    collectionRecords,
    reusedCollectionKeys,
  } = writebackCollections;
  collectionGuard = writebackCollections.collectionGuard;
  const collectionSetupMs = Date.now() - collectionSetupStarted;
  if (collectionSetupOperation) await recovery.completeCollectionSetup(collectionSetupOperation, collectionRecords);
  if (typeof recovery?.prepareStage2 === "function") {
    await recovery.prepareStage2({
      items,
      sourceKeys,
      gradeKeys,
      resolveSourceName: (item) => SOURCE_COLLECTIONS[item?.source_channel] || SOURCE_COLLECTIONS.rss,
      resolveGradeName,
      indexPath: ZOTERO_LIBRARY_INDEX_PATH,
    });
  } else if (recovery) await recovery.recordCollections(collectionRecords);
  const createItem = createStage2ItemWriter({
    zoteroBackend,
    zoteroBackendCall: zoteroBackendToolCall,
    onCreatedKeys: async (itemKeys) => recovery?.recordItems(itemKeys),
  });

  const counters = {
    total: items.length,
    created: 0,
    added_to_pool: 0,
    added_to_daily_collection: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { [LABELS.A]: 0, [LABELS.B]: 0, [LABELS.C]: 0, other: 0 },
    reused_existing: 0, // backward compatibility
    skipped_historical_duplicate: 0, // backward compatibility
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const failures = [];
  const skippedDuplicatesInPool = [];
  const skippedDuplicatesInTrash = [];
  const duplicateRecords = [];
  const writebackItems = [];
  const attachBatchSize = Math.max(1, Number(process.env.ZOTERO_COLLECTION_ATTACH_BATCH_SIZE || 50));
  const writebackExecution = await runWritebackExecution({
    items,
    root,
    sourceKeys,
    gradeKeys,
    sourceCollections: SOURCE_COLLECTIONS,
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems,
    counters,
    failures,
    localIndexStats,
    skippedDuplicatesInPool,
    skippedDuplicatesInTrash,
    duplicateRecords,
    writebackItems,
    zoteroBackendCall: zoteroBackendToolCall,
    zoteroBackend,
    createItem,
    skipBackendExactDedupe,
  });
  const {
    configuredConcurrency,
    writebackConcurrency,
    concurrencyWarning,
    concurrencyClamped,
    concurrencySource,
    autoDowngrade,
    stopForHighRisk,
    stopReason,
    retryCount,
    writebackRetryLimit,
    observationMode,
    duplicatePreventedCount,
    duplicateDetectedCount,
    wrongCollectionDetectedCount,
    uncertainCreateStateCount,
    inFlightDedupeWaitCount,
    batchObservations,
    itemWritebackMs,
    duplicateVerificationStats,
    batchCreateStats,
  } = writebackExecution;
  if (createItem.recoveryError) throw createItem.recoveryError;
  const {
    attachStats,
    dailyAttachFailureKeys,
    collectionAttachMs,
  } = await runCollectionAttachStep({
    writebackItems,
    rootKey: root.key,
    stopForHighRisk,
    stopReason,
    attachBatchSize,
    zoteroBackendCall: zoteroBackendToolCall,
    collectionGuard,
    collectionScopeBlocks,
  });
  counters.added_to_pool = 0;
  counters.added_to_daily_collection = writebackItems.filter((x) => x.itemKey && !dailyAttachFailureKeys.has(x.itemKey)).length;
  const poolAddFailed = 0;
  const currentDateAddFailed = Math.max(0, writebackItems.length - counters.added_to_daily_collection);

  const tagCleanupStarted = Date.now();
  const tagCleanupStats = await cleanupSignatureTags(root.key, worthy?.key || null, {
    now: TODAY,
    localLibraryIndex,
    candidateItems: writebackItems.map((item) => currentLiveItems[item.itemKey]).filter(Boolean),
    fullScan: /^(1|true|yes)$/i.test(String(process.env.ZOTERO_SIGNATURE_TAG_CLEANUP_FULL_SCAN || "")),
    zoteroBackendCall: zoteroBackendToolCall,
    writeTagSet: (operation) => writeTagSetWithGuard({ ...operation, zoteroBackendCall: zoteroBackendToolCall, apply: true, dryRun: false }),
  });
  for (const record of tagCleanupStats.cleaned_item_records || []) {
    if (record?.itemKey && currentLiveItems[record.itemKey]) {
      currentLiveItems[record.itemKey] = {
        ...currentLiveItems[record.itemKey],
        tags: (record.tags || []).map((tag) => ({ tag })),
      };
    }
  }
  const tagCleanupMs = Date.now() - tagCleanupStarted;
  const migrationStarted = Date.now();
  const migrationStats = await migrateRatedItems({ rootKey: root.key, worthyKey: worthy?.key || null, now: TODAY, zoteroBackendCall: zoteroBackendToolCall, starMigrationConfig, collectionGuard, collectionScopeBlocks, localLibraryIndex, recovery });
  const migratedIndexItemCount = applyStarMigrationToLiveIndex(currentLiveItems, migrationStats, { rootKey: root.key, worthyKey: worthy?.key || "" });
  localIndexStats.star_migration_index_items_updated = migratedIndexItemCount;
  const migrationMs = Date.now() - migrationStarted;
  await refreshStage2LibraryIndex({
    indexPath: ZOTERO_LIBRARY_INDEX_PATH,
    currentLiveItems,
    currentCollections,
    mergedTombstones,
    localIndexStats,
    workflowDay: day,
    mcpUrl: RUNTIME.mcpUrl,
  });
  const zoteroBackendCallsByTool = Object.fromEntries(zoteroBackendCallCounters);
  const summary = await writeStage2WritebackReports({
    summaryPath,
    runReportPath,
    stageStarted,
    dateStr,
    root,
    trashKey,
    worthy,
    zoteroMonthName,
    zoteroDayName,
    monthKey,
    dateKey,
    sourceKeys,
    gradeKeys,
    collectionRecords,
    reusedCollectionKeys,
    counters,
    failures,
    collectionGuard,
    collectionScopeBlocks,
    poolIndex,
    worthyIndex,
    localIndexStats,
    skippedDuplicatesInPool,
    skippedDuplicatesInTrash,
    duplicateRecords,
    stage1RunReport,
    poolAddFailed,
    currentDateAddFailed,
    writebackItems,
    migrationStats,
    starMigrationConfig,
    tagCleanupStats,
    attachStats,
    collectionAttachMs,
    configuredConcurrency,
    writebackConcurrency,
    concurrencyWarning,
    concurrencyClamped,
    concurrencySource,
    autoDowngrade,
    stopForHighRisk,
    stopReason,
    retryCount,
    writebackRetryLimit,
    observationMode,
    duplicatePreventedCount,
    duplicateDetectedCount,
    wrongCollectionDetectedCount,
    uncertainCreateStateCount,
    inFlightDedupeWaitCount,
    batchObservations,
    itemWritebackMs,
    duplicateVerificationStats,
    batchCreateStats,
    collectionSetupMs,
    tagCleanupMs,
    migrationMs,
    mcpCallsByTool: zoteroBackendCallsByTool,
    trashItemCount,
    tombstoneIndexCount,
    worthyItemCount,
    historyCollectionModificationForbidden: HISTORY_COLLECTION_MODIFICATION_FORBIDDEN,
  });
  if (typeof recovery?.completeStage2 === "function") {
    const verified = await recovery.completeStage2({
      summary,
      indexPath: ZOTERO_LIBRARY_INDEX_PATH,
      failedCollectionItemKeys: [...dailyAttachFailureKeys],
      onVerifiedWrites: async ({ verifiedWriteItems, verifiedBusinessWriteIdentities }) => {
        summary.verified_write_evidence_required = true;
        summary.verified_write_items = verifiedWriteItems;
        summary.verified_business_write_identities = verifiedBusinessWriteIdentities;
        summary.verified_write_identity_set_match = true;
        await writeAtomicJson(summaryPath, summary);
      },
    });
    summary.verified_write_evidence_required = true;
    summary.verified_write_items = verified.verifiedWriteItems;
    summary.verified_business_write_identities = verified.verifiedBusinessWriteIdentities;
    summary.verified_write_identity_set_match = true;
    summary.radar_queue_results = verified.queueResults;
    await writeAtomicJson(summaryPath, summary);
  }
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

export async function markWritebackFailure(err) {
  try {
    await markWritebackFailureReport({
      err,
      runtime: RUNTIME,
      mcpCallsByTool: Object.fromEntries(zoteroBackendCallCounters),
      historyCollectionModificationForbidden: HISTORY_COLLECTION_MODIFICATION_FORBIDDEN,
    });
  } catch {}
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runZoteroWriteback().catch((e) => {
    markWritebackFailure(e).finally(() => {
      console.error(e);
      process.exit(1);
    });
  });
}
