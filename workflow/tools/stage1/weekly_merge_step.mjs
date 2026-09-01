import fs from "node:fs/promises";

import { getLiteratureIdentityKeys } from "../lib/literature_identity.mjs";
import {
  findLiteratureRecord,
  getDefaultZoteroLibraryIndexPath,
  readZoteroLibraryIndex,
} from "../lib/zotero_library_index_store.mjs";
import {
  claimRadarQueueItems,
  loadRadarBacklog,
  loadRadarUrgentQueue,
  mergeRadarCandidates,
  radarStatePaths,
  resolveRadarBacklog,
  settleRadarQueueClassification,
} from "../radar/state.mjs";
import {
  applyClassificationSnapshot,
  buildClassificationFingerprintRecord,
  classificationSnapshotComplete,
  hasReliableLlmClassification,
} from "./classification_fingerprint.mjs";

function clean(value) { return String(value || "").trim(); }
function grade(value) { return clean(value).slice(0, 1).toUpperCase(); }

function identityFields(aliases = []) {
  const result = {};
  for (const alias of aliases) {
    const separator = String(alias).indexOf(":");
    if (separator <= 0) continue;
    const type = String(alias).slice(0, separator);
    const value = String(alias).slice(separator + 1);
    if (["doi", "pmid", "pmcid", "arxiv", "openalex", "url"].includes(type) && value && !result[type]) result[type] = value;
  }
  return result;
}

function fillMissing(target, source = {}) {
  for (const [key, value] of Object.entries(source || {})) {
    const present = value != null && value !== "" && (!Array.isArray(value) || value.length > 0);
    const missing = target[key] == null || target[key] === "" || (Array.isArray(target[key]) && target[key].length === 0);
    if (present && missing) target[key] = value;
  }
  return target;
}

function recordCandidate(record = {}) {
  record = record || {};
  return {
    ...identityFields(Object.entries(record.identity || {}).map(([type, value]) => value ? `${type}:${value}` : "").filter(Boolean)),
    ...(record.radar_metadata || {}),
    title: record.title || record.radar_metadata?.title || "",
  };
}

function runtimeCanClassify(runtime = {}) {
  const mode = clean(runtime.llm_mode || "real").toLowerCase();
  if (mode === "disabled") return false;
  if (mode === "mock") return true;
  return runtime.apiKeyConfigured === true || typeof runtime.llmClient === "function";
}

export async function prepareWeeklyCandidatePool({
  projectRoot,
  runId,
  currentCandidates = [],
  llmRuntime = {},
  llmAvailable = runtimeCanClassify(llmRuntime),
  fsApi = fs,
  indexPath = getDefaultZoteroLibraryIndexPath(projectRoot),
} = {}) {
  const paths = radarStatePaths(projectRoot);
  const [queue, backlog, indexRead] = await Promise.all([
    loadRadarUrgentQueue(paths.urgentQueue, { fsApi }),
    loadRadarBacklog(paths.backlog, { fsApi }),
    readZoteroLibraryIndex(indexPath),
  ]);
  const index = indexRead.usable ? indexRead.index : { records: {} };
  const entries = [];

  for (const [queueKey, item] of Object.entries(queue.items || {})) {
    if (item.state !== "queued" && !(item.state === "claimed" && item.claimedByWeeklyRunId === runId)) continue;
    const base = { ...identityFields(item.aliases), ...(item.metadata || {}), ...(item.reviewMetadata || {}) };
    const record = findLiteratureRecord(index, base);
    entries.push({
      kind: "radar_urgent",
      priority: 1,
      item: fillMissing(fillMissing({ ...base }, recordCandidate(record)), identityFields(item.aliases)),
      queueKey,
      queue: item,
      indexMatched: Boolean(record),
    });
  }
  if (llmAvailable) {
    for (const [backlogKey, item] of Object.entries(backlog.items || {})) {
      const base = { ...identityFields(item.aliases), ...(item.metadata || {}), ...(item.reviewMetadata || {}) };
      const record = findLiteratureRecord(index, base);
      entries.push({
        kind: "radar_backlog",
        priority: 1,
        item: fillMissing(fillMissing({ ...base }, recordCandidate(record)), identityFields(item.aliases)),
        backlogKey,
        backlog: item,
        indexMatched: Boolean(record),
      });
    }
  }
  for (const item of currentCandidates) {
    const record = findLiteratureRecord(index, item);
    const enriched = fillMissing({ ...item }, recordCandidate(record));
    entries.push({ kind: "weekly_retrieval", priority: 3, item: enriched, indexMatched: Boolean(record) });
  }

  const mergedGroups = mergeRadarCandidates(entries.map((entry) => entry.item));
  const candidates = mergedGroups.map((group) => {
    const aliases = new Set(group.aliases || []);
    const matches = entries.filter((entry) => getLiteratureIdentityKeys(entry.item).some((alias) => aliases.has(alias)));
    const preferred = {};
    for (const entry of matches.slice().sort((left, right) => right.priority - left.priority)) fillMissing(preferred, entry.item);
    const urgent = matches.find((entry) => entry.kind === "radar_urgent");
    const backlogMatch = matches.find((entry) => entry.kind === "radar_backlog");
    return {
      ...group.metadata,
      ...preferred,
      weekly_canonical_identity: group.canonicalIdentity,
      weekly_identity_aliases: group.aliases,
      weekly_merge_provenance: [...new Set([
        ...matches.map((entry) => entry.kind),
        ...(matches.some((entry) => entry.indexMatched) ? ["existing_index"] : []),
      ])],
      ...(urgent ? {
        weekly_radar_queue: {
          key: urgent.queueKey,
          canonicalIdentity: urgent.queue.canonicalIdentity || urgent.queueKey,
          aliases: urgent.queue.aliases || [],
          classificationFingerprint: urgent.queue.classificationFingerprint || "",
          classificationFingerprintComplete: urgent.queue.classificationFingerprintComplete === true,
          classificationContext: urgent.queue.classificationContext || null,
          classificationSnapshot: urgent.queue.classificationSnapshot || null,
          sourceRunId: urgent.queue.sourceRunId || "",
          queuePath: paths.urgentQueue,
        },
      } : {}),
      ...(backlogMatch ? {
        weekly_radar_backlog: {
          key: backlogMatch.backlogKey,
          canonicalIdentity: backlogMatch.backlog.canonicalIdentity || backlogMatch.backlogKey,
          aliases: backlogMatch.backlog.aliases || [],
          sourceRunId: backlogMatch.backlog.sourceRunId || "",
          backlogPath: paths.backlog,
        },
      } : {}),
    };
  });

  return {
    candidates,
    paths,
    audit: {
      weeklyRetrievalCount: currentCandidates.length,
      urgentInputCount: entries.filter((entry) => entry.kind === "radar_urgent").length,
      backlogEligible: Boolean(llmAvailable),
      backlogInputCount: entries.filter((entry) => entry.kind === "radar_backlog").length,
      mergedCandidateCount: candidates.length,
      indexUsable: indexRead.usable,
    },
  };
}

export function applyWeeklyClassificationReuse(items = [], classificationContext = {}) {
  const decisions = [];
  for (const item of items) {
    const queued = item.weekly_radar_queue;
    if (!queued) continue;
    const current = buildClassificationFingerprintRecord(item, classificationContext);
    const reusable = queued.classificationFingerprintComplete === true
      && current.complete
      && queued.classificationFingerprint === current.fingerprint
      && classificationSnapshotComplete(queued.classificationSnapshot);
    if (reusable) {
      applyClassificationSnapshot(item, queued.classificationSnapshot);
      item.weekly_classification_reused = true;
      item.weekly_classification_regrade_required = false;
    } else {
      item.weekly_classification_reused = false;
      item.weekly_classification_regrade_required = true;
    }
    item.weekly_classification_fingerprint = current.fingerprint;
    item.weekly_classification_fingerprint_complete = current.complete;
    decisions.push({ identity: item.weekly_canonical_identity, decision: reusable ? "reuse" : "regrade", reason: reusable ? "all_fingerprint_factors_match" : "fingerprint_missing_or_changed" });
  }
  return { decisions, reusedCount: decisions.filter((item) => item.decision === "reuse").length, regradeCount: decisions.filter((item) => item.decision === "regrade").length };
}

export function ensureWeeklyRadarClassificationCoverage({ items = [], llmReviewItems = [] } = {}) {
  const selected = [...llmReviewItems];
  const seen = new Set(selected);
  let restoredExistingCount = 0;
  let forcedReviewCount = 0;
  for (const item of items) {
    const hasQueue = Boolean(item.weekly_radar_queue);
    const hasBacklog = Boolean(item.weekly_radar_backlog);
    if (!hasQueue && !hasBacklog) continue;
    const requiresReview = hasBacklog || item.weekly_classification_regrade_required === true;
    const eligible = new Set(["A", "B", "C"]).has(grade(item.rule_grade || item.grade));
    if (item.pre_llm_skip_writeback === true) {
      item.pre_llm_skip_writeback = false;
      item.weekly_existing_state_requires_reconciliation = true;
      restoredExistingCount += 1;
    }
    if (requiresReview && eligible && !seen.has(item)) {
      selected.push(item);
      seen.add(item);
      forcedReviewCount += 1;
    }
  }
  const reviewItems = selected.filter((item) => item.weekly_classification_reused !== true);
  return { llmReviewItems: reviewItems, restoredExistingCount, forcedReviewCount };
}

export async function finalizeWeeklyRadarReview({
  items = [],
  classificationContext = {},
  runId,
  paths,
  fsApi = fs,
  clock = () => new Date(),
} = {}) {
  const backlogResolved = [];
  const backlogNotAdmitted = [];
  const backlogRetained = [];
  const queueClaimIntents = [];
  const queueClassificationResolved = [];
  const queueDeferred = [];

  for (const item of items) {
    const reliable = hasReliableLlmClassification(item);
    const finalGrade = grade(item.final_grade || item.grade);
    if (item.weekly_radar_backlog) {
      if (reliable) backlogResolved.push(item);
      else if (!new Set(["A", "B", "C"]).has(finalGrade)) backlogNotAdmitted.push(item);
      else {
        item.pre_llm_skip_writeback = true;
        item.weekly_backlog_status = "retained_llm_unavailable";
        backlogRetained.push(item.weekly_radar_backlog.key);
      }
    }
    if (!item.weekly_radar_queue) continue;
    const reusable = item.weekly_classification_reused === true;
    if (!reusable && !reliable && new Set(["A", "B", "C"]).has(finalGrade)) {
      item.pre_llm_skip_writeback = true;
      item.weekly_queue_status = "regrade_deferred";
      queueDeferred.push(item.weekly_radar_queue.key);
      continue;
    }
    const current = buildClassificationFingerprintRecord(item, classificationContext);
    if (!["A", "B", "C"].includes(finalGrade)) {
      await settleRadarQueueClassification(paths.urgentQueue, item.weekly_radar_queue.canonicalIdentity, {
        weeklyRunId: runId,
        finalGrade,
        reason: "weekly_regraded_not_admitted",
        classificationFingerprint: current.fingerprint,
        fsApi,
        clock,
      });
      item.weekly_queue_status = "consumed_classification_resolution";
      queueClassificationResolved.push(item.weekly_radar_queue.key);
      continue;
    }
    item.weekly_radar_queue_claim_intent = {
      identity: item.weekly_radar_queue.canonicalIdentity,
      aliases: item.weekly_radar_queue.aliases,
      queuePath: paths.urgentQueue,
      priorClassificationFingerprint: item.weekly_radar_queue.classificationFingerprint,
      classificationFingerprint: current.fingerprint,
      finalGrade,
      outcome: reusable ? "weekly_reused_radar_classification" : "weekly_regraded",
    };
    item.weekly_queue_status = "claim_pending";
    queueClaimIntents.push(item.weekly_radar_queue.key);
  }

  if (backlogResolved.length) {
    await resolveRadarBacklog(paths.backlog, backlogResolved, {
      weeklyRunId: runId,
      outcome: "weekly_review_completed",
      fsApi,
      clock,
    });
    for (const item of backlogResolved) item.weekly_backlog_status = "review_completed";
  }
  if (backlogNotAdmitted.length) {
    await resolveRadarBacklog(paths.backlog, backlogNotAdmitted, {
      weeklyRunId: runId,
      outcome: "weekly_review_completed_not_admitted",
      fsApi,
      clock,
    });
    for (const item of backlogNotAdmitted) item.weekly_backlog_status = "review_completed_not_admitted";
  }
  return {
    backlogResolvedCount: backlogResolved.length,
    backlogNotAdmittedCount: backlogNotAdmitted.length,
    backlogRetainedCount: backlogRetained.length,
    queueClaimIntentCount: queueClaimIntents.length,
    queueClassificationResolvedCount: queueClassificationResolved.length,
    queueDeferredCount: queueDeferred.length,
  };
}

export async function claimWeeklyRadarWritebackCandidates({ items = [], runId, fsApi = fs, clock = () => new Date() } = {}) {
  const claims = items.map((item) => item.weekly_radar_queue_claim_intent).filter(Boolean);
  if (!claims.length) return { items, claimedCount: 0, conflictCount: 0, conflicts: [] };
  const queuePaths = [...new Set(claims.map((claim) => claim.queuePath).filter(Boolean))];
  if (queuePaths.length !== 1) throw new Error("WEEKLY_RADAR_QUEUE_PATH_AMBIGUOUS");
  const result = await claimRadarQueueItems(queuePaths[0], claims, { weeklyRunId: runId, fsApi, clock });
  const conflicts = result.result?.conflicts || [];
  const conflictIdentities = new Set(conflicts.map((entry) => entry.identity).filter(Boolean));
  const filtered = items.filter((item) => {
    const intent = item.weekly_radar_queue_claim_intent;
    if (!intent || !conflictIdentities.has(intent.identity)) return true;
    item.weekly_queue_status = "claim_conflict";
    return false;
  });
  for (const item of filtered) {
    if (item.weekly_radar_queue_claim_intent) {
      item.weekly_radar_queue_claim = { ...item.weekly_radar_queue_claim_intent, weeklyRunId: runId, claimed: true };
      item.weekly_queue_status = "claimed";
    }
  }
  return {
    items: filtered,
    claimedCount: result.result?.claimed?.length || 0,
    conflictCount: conflicts.length,
    conflicts,
  };
}
