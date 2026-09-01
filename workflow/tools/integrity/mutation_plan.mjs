import { createHash } from "node:crypto";

export const INTEGRITY_TAGS = Object.freeze({
  correction: "PaperEcho:Correction",
  expression_of_concern: "PaperEcho:Expression of Concern",
  retraction: "PaperEcho:Retraction",
});

export function fingerprintIntegrityTarget(target) { return createHash("sha256").update(JSON.stringify(target)).digest("hex"); }
function collectionKey(value) { return String(value?.key || value?.id || value || "").trim(); }

export function managedCollectionIdsForRecord(index = {}, record = {}) {
  const registry = index.collections || {};
  const membership = (record.presence?.zotero?.collections || []).map(collectionKey).filter(Boolean);
  return membership.filter((key) => registry[key] && registry[key].role && registry[key].role !== "trash");
}

export function resolveIntegrityMutationTarget(index = {}, record = {}) {
  const status = record.integrity?.currentStatus || "unknown";
  const itemKey = String(record.presence?.zotero?.itemKey || "");
  if (!itemKey || !INTEGRITY_TAGS[status]) return { required: false, reason: "no_actionable_target" };
  const trash = Object.entries(index.collections || {}).filter(([, value]) => value?.role === "trash");
  if (status === "retraction") {
    if (trash.length > 1) return { required: true, blocked: true, reason: "trash_collection_ambiguous", itemKey, status };
    if (trash.length === 0) return { required: true, blocked: false, needsManagedTrashResolution: true, reason: "trash_collection_pending_ensure", itemKey, status, removeCollectionIds: managedCollectionIdsForRecord(index, record), addTags: [INTEGRITY_TAGS.retraction] };
    const target = { status, itemKey, addCollectionId: trash[0][0], removeCollectionIds: managedCollectionIdsForRecord(index, record).filter((key) => key !== trash[0][0]), addTags: [INTEGRITY_TAGS.retraction] };
    return { required: true, blocked: false, ...target, targetFingerprint: fingerprintIntegrityTarget(target) };
  }
  const target = { status, itemKey, addTags: [INTEGRITY_TAGS[status]] };
  return { required: true, blocked: false, ...target, targetFingerprint: fingerprintIntegrityTarget(target) };
}

export function buildIntegrityMutationPlan(index = {}, canonicalIds = []) {
  const selected = new Set(canonicalIds);
  return Object.values(index.records || {}).filter((record) => selected.has(record.canonical_id)).map((record) => ({
    canonicalId: record.canonical_id,
    evidenceFingerprint: record.integrity?.evidenceFingerprint || "",
    target: resolveIntegrityMutationTarget(index, record),
  })).filter((entry) => entry.target.required);
}

export function excludeConfirmedRetractionsFromWeekly(items = [], index = {}) {
  const retracted = new Set(Object.values(index.records || {}).filter((record) => record.integrity?.currentStatus === "retraction").flatMap((record) => [record.identity?.doi && `doi:${record.identity.doi}`, record.identity?.pmid && `pmid:${record.identity.pmid}`].filter(Boolean)));
  return items.filter((item) => !retracted.has(item.doi ? `doi:${String(item.doi).toLowerCase()}` : "") && !retracted.has(item.pmid ? `pmid:${String(item.pmid)}` : ""));
}
