import fs from "node:fs/promises";
import path from "node:path";
import { createServiceConcurrencyController } from "../lib/adaptive_concurrency.mjs";
import { readZoteroLibraryIndex, updateIntegrityMonitoringState } from "../lib/zotero_library_index_store.mjs";
import { fetchCrossrefIntegrity, fetchPubMedIntegrityBatch } from "./providers.mjs";
import { buildIntegrityMutationPlan } from "./mutation_plan.mjs";
import { advanceIntegrityBootstrap, mergeIntegrityProviderResults, selectIntegrityCheckBatch } from "./state.mjs";

function asInt(value, fallback, min, max) { const number = Number(value); return Number.isInteger(number) && number >= min && number <= max ? number : fallback; }

export async function runWeeklyIntegrityMonitor({
  enabled = process.env.PAPERECHO_INTEGRITY_ENABLED === "true",
  profile = "standard",
  indexPath,
  pipeDir = "",
  now = new Date(),
  maxRecords = asInt(process.env.PAPERECHO_INTEGRITY_BOOTSTRAP_BATCH_SIZE, 50, 1, 500),
  pubmedBatchSize = asInt(process.env.PAPERECHO_INTEGRITY_PUBMED_BATCH_SIZE, 180, 1, 200),
  crossrefConcurrency = asInt(process.env.PAPERECHO_INTEGRITY_CROSSREF_CONCURRENCY, 2, 1, 4),
  cacheTtlDays = asInt(process.env.PAPERECHO_INTEGRITY_CACHE_TTL_DAYS, 7, 1, 365),
  fetchCrossref = fetchCrossrefIntegrity,
  fetchPubmedBatch = fetchPubMedIntegrityBatch,
  fsApi = fs,
} = {}) {
  if (!enabled) return { status: "disabled", checkedCount: 0, plan: [] };
  if (profile === "radar") return { status: "skipped", reason: "weekly_only", checkedCount: 0, plan: [] };
  const read = await readZoteroLibraryIndex(indexPath);
  if (!read.usable) return { status: "degraded", reason: read.reason, checkedCount: 0, plan: [] };
  const selection = selectIntegrityCheckBatch(read.index, { maxRecords, dueDays: cacheTtlDays, now });
  const controller = createServiceConcurrencyController("integrity_crossref", { minConcurrency: 1, initialConcurrency: crossrefConcurrency, maxConcurrency: 4 });
  const crossrefResults = new Map(await Promise.all(selection.selected.filter((record) => record.identity?.doi).map(async (record) => [record.canonical_id, await fetchCrossref(record.identity.doi, { controller })])));
  const pmidRecords = selection.selected.filter((record) => record.identity?.pmid);
  const pubmedResults = await fetchPubmedBatch(pmidRecords.map((record) => record.identity.pmid), { batchSize: pubmedBatchSize });
  const outcomes = [];
  const recordUpdates = [];
  for (const record of selection.selected) {
    const providers = [];
    if (record.identity?.doi) providers.push(crossrefResults.get(record.canonical_id));
    if (record.identity?.pmid) providers.push(pubmedResults.get(String(record.identity.pmid)));
    const merged = mergeIntegrityProviderResults(record.integrity || {}, providers.filter(Boolean), { now });
    outcomes.push({ canonicalId: record.canonical_id, ...merged });
    recordUpdates.push({ canonicalId: record.canonical_id, integrity: merged.state });
  }
  const bootstrap = advanceIntegrityBootstrap(selection.bootstrap, outcomes, { now });
  const update = await updateIntegrityMonitoringState(indexPath, { recordUpdates, monitoring: { last_run_at: new Date(now).toISOString(), bootstrap } }, { generatedAt: new Date(now).toISOString() });
  if (!update.ok) return { status: "degraded", reason: update.reason, checkedCount: 0, plan: [] };
  const changedIds = outcomes.filter((outcome) => outcome.statusChanged || outcome.state.application?.targetFingerprint !== outcome.state.evidenceFingerprint).map((outcome) => outcome.canonicalId);
  const plan = buildIntegrityMutationPlan(update.index, changedIds);
  const audit = {
    schemaVersion: 1, status: "completed", checkedAt: new Date(now).toISOString(), eligibleCount: selection.eligible.length,
    checkedCount: selection.selected.length, successfulRecordCount: outcomes.filter((item) => item.anySuccessful).length,
    fullyCheckedRecordCount: outcomes.filter((item) => item.allRequiredSuccessful).length, bootstrapComplete: bootstrap.bootstrap_complete,
    newlyConfirmedRetractionCount: outcomes.filter((item) => item.newlyConfirmed).length,
    changedCount: outcomes.filter((item) => item.statusChanged).length,
    conflictCount: outcomes.reduce((sum, item) => sum + item.state.conflicts.length, 0), plan,
    changes: outcomes.filter((item) => item.statusChanged).map((item) => ({ canonicalId: item.canonicalId, fromStatus: item.fromStatus, toStatus: item.toStatus })),
  };
  if (pipeDir) {
    await fsApi.mkdir(pipeDir, { recursive: true });
    await fsApi.writeFile(path.join(pipeDir, "integrity_monitoring_audit.json"), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    await fsApi.writeFile(path.join(pipeDir, "integrity_plan.json"), `${JSON.stringify({ schemaVersion: 1, generatedAt: audit.checkedAt, operations: plan }, null, 2)}\n`, "utf8");
  }
  return { ...audit, plan, updatedIndex: update.index };
}
