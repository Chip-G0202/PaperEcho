import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertProfileCapability, runtimeProfile } from "../lib/profile_capabilities.mjs";

import "../lib/env_file_bootstrap.mjs";
import { ensureZoteroBackendReady } from "../lib/ensure_zotero_backend_ready.mjs";
import { buildRuntimeConfig } from "../lib/runtime_config.mjs";
import { getDefaultZoteroLibraryIndexPath, updateZoteroLibraryIndexItems } from "../lib/zotero_library_index_store.mjs";
import { createZoteroBackendClient } from "../lib/zotero_backend_client.mjs";
import { fmtDateRfc, isoWeek, yyMd } from "../lib/date_label_support.mjs";
import { createStage3WriteMetadata, createStage3WriteMetadataBatch, createStage3WriteMetadataBatchTool } from "./metadata_write_guard.mjs";
import { prepareStage3BackfillInput } from "./translation_input_step.mjs";
import { runStage3TranslationExecution } from "./translation_execution_step.mjs";
import { writeStage3TranslationReports } from "./translation_report_step.mjs";

export { createStage3WriteMetadata, createStage3WriteMetadataBatch, createStage3WriteMetadataBatchTool } from "./metadata_write_guard.mjs";
export {
  collectRecentDateCollectionNodes,
  parseDateNameToDate,
  parseMonthDayCollectionDate,
} from "../lib/zotero_date_collections.mjs";

const RUNTIME = buildRuntimeConfig();
const RESEARCH_ROOT = RUNTIME.researchRoot;
const TODAY = RUNTIME.now;
const RUNTIME_STATE_PATH = path.join(RESEARCH_ROOT, "runtime_state.json");
const ZOTERO_LIBRARY_INDEX_PATH = getDefaultZoteroLibraryIndexPath(RUNTIME.projectRoot);
let zoteroBackendClientPromise = null;

function getZoteroBackendClient() {
  if (!zoteroBackendClientPromise) {
    zoteroBackendClientPromise = createZoteroBackendClient();
  }
  return zoteroBackendClientPromise;
}

async function zoteroBackendToolCall(name, args, id) {
  const client = await getZoteroBackendClient();
  return client.callTool(name, args, id);
}

async function ensureZoteroBackendReadyForBackfill() {
  return ensureZoteroBackendReady();
}

export async function runZoteroTranslationBackfill({ argv = process.argv, recovery = null } = {}) {
  assertProfileCapability(runtimeProfile(), "zoteroWrite");
  const stageStarted = Date.now();
  await ensureZoteroBackendReadyForBackfill();
  const dateStr = fmtDateRfc(TODAY);
  const week = isoWeek(TODAY);
  const day = yyMd(TODAY);
  const pipelineDir = RUNTIME.pipelineDir;
  const paths = {
    runtimeStatePath: RUNTIME_STATE_PATH,
    summaryPath: path.join(pipelineDir, "zotero_writeback_summary.json"),
    legacySummaryPath: path.join(pipelineDir, "mcp_writeback_summary.json"),
    backfillPath: path.join(pipelineDir, "abc_translation_backfill.json"),
    failuresPath: path.join(pipelineDir, "abc_translation_failures.json"),
    usagePath: path.join(pipelineDir, "translation_usage_report.json"),
    runReportPath: path.join(pipelineDir, "run_report.json"),
  };

  const input = await prepareStage3BackfillInput({
    argv,
    summaryPath: paths.summaryPath,
    legacySummaryPath: paths.legacySummaryPath,
    runtimeStatePath: paths.runtimeStatePath,
    now: TODAY,
    zoteroBackendCall: zoteroBackendToolCall,
    localIndexPath: ZOTERO_LIBRARY_INDEX_PATH,
  });

  const admittedMetadataItemKeys = new Set((input.summaryForRun.writeback_items || []).map((it) => it.itemKey).filter(Boolean));
  const metadataScopeBlocks = [];
  const writeMetadata = createStage3WriteMetadata({
    admittedMetadataItemKeys,
    metadataScopeBlocks,
    apply: true,
    dryRun: false,
    writeMetadataTool: async (itemKey, fields) => {
      const operations = typeof recovery?.prepareMetadata === "function" ? await recovery.prepareMetadata([{ itemKey, fields }]) : [];
      await zoteroBackendToolCall("write_metadata", { itemKey, fields }, 980000 + Math.floor(Math.random() * 10000));
      if (operations.length) await recovery.completeMetadata(operations, { updated: [itemKey], failed: [], versions: {} });
    },
  });
  const writeMetadataBatch = createStage3WriteMetadataBatch({
    admittedMetadataItemKeys,
    metadataScopeBlocks,
    apply: true,
    dryRun: false,
    writeMetadataBatchTool: async (updates) => {
      const operations = typeof recovery?.prepareMetadata === "function" ? await recovery.prepareMetadata(updates) : [];
      const client = await getZoteroBackendClient();
      const result = await createStage3WriteMetadataBatchTool({ zoteroBackendCall: client.callTool })(updates);
      if (operations.length) await recovery.completeMetadata(operations, result);
      return result;
    },
  });

  const execution = await runStage3TranslationExecution({
    summaryForRun: input.summaryForRun,
    poolScan: input.poolScan,
    translationCachePath: RUNTIME.translationCachePath,
    writeMetadata,
    writeMetadataBatch,
  });

  const indexUpdates = {};
  for (const item of execution.report?.updated_items || []) {
    if (item?.itemKey) indexUpdates[item.itemKey] = {
      shortTitle: item.shortTitle,
      ...(Number(item.version || 0) > 0 ? { version: Number(item.version) } : {}),
    };
  }
  const indexOperation = Object.keys(indexUpdates).length && typeof recovery?.prepareFileOperation === "function"
    ? await recovery.prepareFileOperation({ type: "shared_index", targetId: ZOTERO_LIBRARY_INDEX_PATH, targetPath: ZOTERO_LIBRARY_INDEX_PATH, input: indexUpdates, intent: { updates: indexUpdates } })
    : null;
  const localIndexUpdate = await updateZoteroLibraryIndexItems(ZOTERO_LIBRARY_INDEX_PATH, indexUpdates);
  if (indexOperation) await recovery.completeFileOperation(indexOperation, ZOTERO_LIBRARY_INDEX_PATH, { itemCount: Object.keys(indexUpdates).length });
  const output = await writeStage3TranslationReports({
    dateStr,
    stageStarted,
    paths,
    runtime: RUNTIME,
    metadataScopeBlocks,
    localIndexUpdate,
    ...input,
    ...execution,
  });
  if (recovery?.store) await recovery.store.setStage("stage3_translation", "verified", { updated: execution.report?.updated_items?.length || 0 });

  console.log(JSON.stringify(output, null, 2));
  return { dateStr, week, day, output };
}

export async function markBackfillFailure(err) {
  try {
    const pipelineDir = RUNTIME.pipelineDir;
    const runReportPath = path.join(pipelineDir, "run_report.json");
    const runReport = JSON.parse(await fs.readFile(runReportPath, "utf8"));
    runReport.failures = Array.isArray(runReport.failures) ? runReport.failures : [];
    const reason = String(err?.message || err);
    const details = err?.details || null;
    runReport.failures.push({
      stage: "stage3_translation_backfill",
      reason,
      details,
      at: new Date().toISOString(),
    });
    runReport.steps = runReport.steps || {};
    runReport.steps.abc_translation_backfill = {
      ok: false,
      completed: false,
      downgrade_reason: reason,
      downgrade_details: details,
      fallback: "stage4_use_english_title_when_missing_translation",
    };
    runReport.stage_timings = runReport.stage_timings || {};
    runReport.stage_timings.translation = {
      status: "failed",
      reason,
      details,
    };
    await fs.writeFile(runReportPath, JSON.stringify(runReport, null, 2), "utf8");
  } catch {}
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runZoteroTranslationBackfill().catch((e) => {
    markBackfillFailure(e).finally(() => {
      console.error(e);
      process.exit(1);
    });
  });
}
