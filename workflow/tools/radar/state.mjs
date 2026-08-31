import fs from "node:fs/promises";
import path from "node:path";

import { withAtomicJsonLock, writeAtomicJson } from "../lib/atomic_json.mjs";
import { getLiteratureIdentityKeys } from "../lib/literature_identity.mjs";
import { canonicalQueryHash } from "../stage1/source_state.mjs";
import {
  findLiteratureRecord,
  readZoteroLibraryIndex,
  updateSharedLiteratureRecordState,
} from "../lib/zotero_library_index_store.mjs";

export const RADAR_STATE_SCHEMA_VERSION = 1;
export const RADAR_QUEUE_STATES = new Set(["queued", "claimed", "consumed", "conflict"]);

function nowIso(clock) { return (clock ? clock() : new Date()).toISOString(); }
function clean(value) { return String(value || "").trim(); }

export function radarStatePaths(projectRoot = process.cwd()) {
  const root = path.join(path.resolve(projectRoot), "review_results", "radar");
  return {
    root,
    backlog: path.join(root, "review_backlog.json"),
    urgentQueue: path.join(root, "urgent_queue.json"),
    scheduleDecisions: path.join(root, "schedule_decisions"),
  };
}

export function canonicalRadarIdentity(item = {}) {
  const identity = getLiteratureIdentityKeys(item)[0];
  if (!identity) throw new Error("RADAR_CANONICAL_IDENTITY_MISSING");
  return identity;
}

export function radarCoreMetadata(item = {}) {
  return {
    title: clean(item.title),
    journal: clean(item.journal || item.publicationTitle || item.source_title),
    doi: clean(item.doi || item.DOI).toLowerCase(),
    pmid: clean(item.pmid),
    pmcid: clean(item.pmcid),
    arxiv: clean(item.arxiv || item.arxiv_id),
    openalex: clean(item.openalex || item.openalex_id),
    url: clean(item.url || item.URL),
    source: clean(item.source || item.source_channel),
  };
}

export function radarMetadataFingerprint(item = {}) {
  return canonicalQueryHash(radarCoreMetadata(item));
}

export function radarClassificationFingerprint(item = {}) {
  return canonicalQueryHash({
    canonicalIdentity: canonicalRadarIdentity(item),
    finalGrade: clean(item.final_grade || item.finalGrade || item.grade).toUpperCase(),
    ruleGrade: clean(item.rule_grade || item.ruleGrade || item.grade).toUpperCase(),
    llmGrade: clean(item.llm_review_grade || item.llmGrade || item.semantic_grade).toUpperCase(),
    ruleEvidence: item.matched_signals || item.matched_standard_rules || item.grade_reason || "",
    llmEvidence: item.llm_review || { reason: item.semantic_reason || "", confidence: item.semantic_confidence ?? null },
    metadataFingerprint: radarMetadataFingerprint(item),
  });
}

export function isUrgentA(item = {}) {
  const finalGrade = clean(item.final_grade || item.finalGrade || item.grade).toUpperCase();
  const ruleGrade = clean(item.rule_grade || item.ruleGrade || item.grade).toUpperCase();
  const llmGrade = clean(item.llm_review_grade || item.llmGrade || item.semantic_grade).toUpperCase();
  return finalGrade === "A" && ruleGrade === "A" && llmGrade === "A";
}

export function minimalRadarCandidate(item = {}, { sourceRunId = "", observedAt = new Date().toISOString() } = {}) {
  const aliases = getLiteratureIdentityKeys(item);
  const canonicalIdentity = aliases[0];
  if (!canonicalIdentity) throw new Error("RADAR_CANONICAL_IDENTITY_MISSING");
  const metadata = radarCoreMetadata(item);
  return {
    canonicalIdentity,
    aliases,
    metadata,
    metadataFingerprint: canonicalQueryHash(metadata),
    sourceRunId: clean(sourceRunId),
    observedAt,
  };
}

function mergeMetadata(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) if (clean(value)) merged[key] = value;
  return merged;
}

export function mergeRadarCandidates(items = []) {
  const groups = [];
  const aliasToGroup = new Map();
  for (const raw of items) {
    const candidate = raw?.canonicalIdentity ? raw : minimalRadarCandidate(raw);
    const aliases = [...new Set([candidate.canonicalIdentity, ...(candidate.aliases || [])].filter(Boolean))];
    const matches = [...new Set(aliases.map((alias) => aliasToGroup.get(alias)).filter((index) => index !== undefined))];
    let index = matches.shift();
    if (index === undefined) {
      index = groups.length;
      groups.push({ ...candidate, aliases });
    } else {
      const target = groups[index];
      target.aliases = [...new Set([...(target.aliases || []), ...aliases])];
      target.metadata = mergeMetadata(target.metadata, candidate.metadata);
      target.metadataFingerprint = canonicalQueryHash(target.metadata);
      target.observedAt = candidate.observedAt || target.observedAt;
      for (const otherIndex of matches) {
        const other = groups[otherIndex];
        if (!other) continue;
        target.aliases = [...new Set([...target.aliases, ...(other.aliases || [])])];
        target.metadata = mergeMetadata(target.metadata, other.metadata);
        groups[otherIndex] = null;
      }
      target.canonicalIdentity = target.aliases[0];
      target.metadataFingerprint = canonicalQueryHash(target.metadata);
    }
    for (const alias of groups[index].aliases) aliasToGroup.set(alias, index);
  }
  return groups.filter(Boolean);
}

function emptyState(kind) {
  return { schemaVersion: RADAR_STATE_SCHEMA_VERSION, kind, items: {}, updatedAt: null };
}

async function readState(filePath, kind, fsApi = fs) {
  try {
    const value = JSON.parse(await fsApi.readFile(filePath, "utf8"));
    if (value?.schemaVersion !== RADAR_STATE_SCHEMA_VERSION || value?.kind !== kind || !value.items || typeof value.items !== "object") {
      throw new Error(`RADAR_${kind.toUpperCase()}_STATE_INVALID`);
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState(kind);
    throw error;
  }
}

async function mutateState(filePath, kind, mutator, { fsApi = fs, atomicWriter = writeAtomicJson, clock = () => new Date() } = {}) {
  return withAtomicJsonLock(filePath, async () => {
    const state = await readState(filePath, kind, fsApi);
    const result = await mutator(state);
    state.updatedAt = nowIso(clock);
    await atomicWriter(filePath, state, { fsApi });
    return { state, result };
  }, { fsApi, clock });
}

export async function loadRadarBacklog(filePath, options = {}) {
  return readState(filePath, "review_backlog", options.fsApi || fs);
}

export async function loadRadarUrgentQueue(filePath, options = {}) {
  return readState(filePath, "urgent_queue", options.fsApi || fs);
}

function findByAliases(items, aliases) {
  const wanted = new Set(aliases || []);
  return Object.entries(items).find(([, item]) => (item.aliases || []).some((alias) => wanted.has(alias)));
}

export async function persistRadarCandidates(filePath, candidates, { runId = "", generatedAt = new Date().toISOString(), atomicWriter = writeAtomicJson, fsApi = fs } = {}) {
  const normalized = mergeRadarCandidates(candidates).map((item) => minimalRadarCandidate(item.metadata || item, { sourceRunId: runId, observedAt: generatedAt }));
  const artifact = { schemaVersion: 1, profile: "radar", runId, generatedAt, candidateCount: normalized.length, candidates: normalized };
  await atomicWriter(filePath, artifact, { fsApi });
  return artifact;
}

export async function storeRadarBacklog(filePath, candidates, { runId = "", reason = "llm_unavailable", ...options } = {}) {
  return mutateState(filePath, "review_backlog", (state) => {
    const saved = [];
    for (const candidate of mergeRadarCandidates(candidates)) {
      const minimal = candidate.metadata ? candidate : minimalRadarCandidate(candidate, { sourceRunId: runId, observedAt: nowIso(options.clock) });
      const found = findByAliases(state.items, minimal.aliases);
      const key = found?.[0] || minimal.canonicalIdentity;
      state.items[key] = {
        ...(found?.[1] || {}),
        ...minimal,
        reason,
        sourceRunId: runId || minimal.sourceRunId,
        lastSeenAt: nowIso(options.clock),
      };
      saved.push(key);
    }
    return { saved };
  }, options);
}

export async function resolveRadarBacklog(filePath, assessedItems, options = {}) {
  return mutateState(filePath, "review_backlog", (state) => {
    const removed = [];
    for (const item of assessedItems) {
      const aliases = getLiteratureIdentityKeys(item);
      const found = findByAliases(state.items, aliases);
      if (found) { delete state.items[found[0]]; removed.push(found[0]); }
    }
    return { removed };
  }, options);
}

export async function enqueueRadarUrgent(filePath, items, { runId = "", ...options } = {}) {
  return mutateState(filePath, "urgent_queue", (state) => {
    const queued = [];
    for (const item of items.filter(isUrgentA)) {
      const minimal = minimalRadarCandidate(item, { sourceRunId: runId, observedAt: nowIso(options.clock) });
      const classificationFingerprint = radarClassificationFingerprint(item);
      const found = findByAliases(state.items, minimal.aliases);
      const key = found?.[0] || minimal.canonicalIdentity;
      const previous = found?.[1];
      if (previous?.classificationFingerprint === classificationFingerprint && ["queued", "claimed"].includes(previous.state)) {
        queued.push({ key, duplicate: true });
        continue;
      }
      state.items[key] = {
        canonicalIdentity: minimal.canonicalIdentity,
        aliases: minimal.aliases,
        classificationFingerprint,
        metadataFingerprint: minimal.metadataFingerprint,
        queuedAt: nowIso(options.clock),
        sourceRunId: runId,
        claimedByWeeklyRunId: "",
        verifiedWriteEvidence: null,
        state: "queued",
      };
      queued.push({ key, duplicate: false });
    }
    return { queued };
  }, options);
}

export async function transitionRadarQueueItem(filePath, identity, nextState, {
  weeklyRunId = "",
  verifiedWriteEvidence = null,
  ...options
} = {}) {
  if (!RADAR_QUEUE_STATES.has(nextState)) throw new Error("RADAR_QUEUE_STATE_INVALID");
  return mutateState(filePath, "urgent_queue", (state) => {
    const found = findByAliases(state.items, [identity]);
    if (!found) throw new Error("RADAR_QUEUE_ITEM_MISSING");
    const [key, item] = found;
    const allowed = { queued: new Set(["claimed", "conflict"]), claimed: new Set(["consumed", "conflict", "queued"]), conflict: new Set(["claimed"]), consumed: new Set() };
    if (item.state !== nextState && !allowed[item.state]?.has(nextState)) throw new Error(`RADAR_QUEUE_TRANSITION_INVALID_${item.state}_TO_${nextState}`);
    if (nextState === "consumed" && !verifiedWriteEvidence) throw new Error("RADAR_QUEUE_CONSUME_REQUIRES_VERIFIED_WRITE");
    item.state = nextState;
    if (nextState === "claimed") item.claimedByWeeklyRunId = clean(weeklyRunId);
    if (nextState === "consumed") item.verifiedWriteEvidence = verifiedWriteEvidence;
    item.updatedAt = nowIso(options.clock);
    return { key, item: structuredClone(item) };
  }, options);
}

export async function selectRadarNotificationCandidates(indexPath, items = []) {
  const read = await readZoteroLibraryIndex(indexPath);
  const index = read.usable ? read.index : { records: {} };
  const selected = [];
  const suppressed = [];
  for (const item of items) {
    const fingerprint = radarClassificationFingerprint(item);
    const record = findLiteratureRecord(index, item);
    const notification = record?.radar_notification || {};
    if ([notification.deliveredFingerprint, notification.unknownFingerprint].includes(fingerprint)) {
      suppressed.push({ identity: canonicalRadarIdentity(item), fingerprint, reason: notification.deliveredFingerprint === fingerprint ? "already_delivered" : "unknown_held" });
    } else selected.push({ item, fingerprint });
  }
  return { selected, suppressed, indexUsable: read.usable, indexReason: read.reason || "" };
}

export async function recordRadarNotificationOutcome(indexPath, selected = [], outcome = {}, { generatedAt = new Date().toISOString() } = {}) {
  const status = String(outcome.status || "");
  if (!new Set(["accepted", "unknown", "failed"]).has(status)) return { ok: true, updated_count: 0, skipped: true };
  return updateSharedLiteratureRecordState(indexPath, selected.map(({ item, fingerprint }) => ({
    item,
    patch: {
      radar_notification: {
        ...(status === "accepted" ? { deliveredFingerprint: fingerprint, deliveredAt: generatedAt } : {}),
        ...(status === "unknown" ? { unknownFingerprint: fingerprint, unknownAt: generatedAt } : {}),
        lastDecisionFingerprint: fingerprint,
        lastOutcome: status,
        lastOutcomeAt: generatedAt,
      },
    },
  })), { generatedAt });
}
