import { createHash } from "node:crypto";

export const INTEGRITY_STATUS = Object.freeze({
  unknown: "unknown",
  correction: "correction",
  expressionOfConcern: "expression_of_concern",
  retraction: "retraction",
});

const PRECEDENCE = new Map([["unknown", 0], ["correction", 1], ["expression_of_concern", 2], ["retraction", 3]]);

function clean(value) { return String(value ?? "").trim(); }
function list(value) { return value == null ? [] : Array.isArray(value) ? value : [value]; }
export function normalizeIntegrityDoi(value) { return clean(value).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").toLowerCase(); }
function normalizePmid(value) { return clean(value).replace(/^pmid:\s*/i, "").replace(/\D/g, ""); }
function normalizedType(value) { return clean(value).toLowerCase().replace(/[\s_-]+/g, " "); }

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).filter((key) => !["observedAt", "checkedAt", "requestId"].includes(key)).sort().map((key) => [key, canonical(value[key])]));
}

export function integrityEvidenceFingerprint(evidence = []) {
  return createHash("sha256").update(JSON.stringify(canonical(evidence))).digest("hex");
}

function evidence({ source, kind, direction, targetDoi = "", targetPmid = "", noticeId = "", recordId = "", assertedBy = "", manualReview = false, rawType = "" }) {
  const result = { source, kind, direction, targetDoi: normalizeIntegrityDoi(targetDoi), targetPmid: normalizePmid(targetPmid), noticeId: clean(noticeId), recordId: clean(recordId), assertedBy: clean(assertedBy), manualReview: Boolean(manualReview), rawType: clean(rawType) };
  return { ...result, fingerprint: integrityEvidenceFingerprint([result]) };
}

function crossrefKind(value) {
  const type = normalizedType(value);
  if (type.includes("retract")) return "retraction";
  if (type.includes("expression") && type.includes("concern")) return "expression_of_concern";
  if (type.includes("correct") || type.includes("erratum")) return "correction";
  return "";
}

function crossrefSource(entry = {}) {
  const asserted = normalizedType(entry["asserted-by"] || entry.assertedBy || entry.source || "");
  return asserted.includes("retraction watch") || clean(entry["record-id"] || entry.recordId) ? "crossref_retraction_watch" : "crossref_publisher";
}

function crossrefEntry(raw = {}, fallbackType = "", direction = "updated-by") {
  const kind = crossrefKind(raw.type || raw["update-type"] || raw.label || fallbackType);
  if (!kind) return null;
  return evidence({
    source: crossrefSource(raw), kind, direction,
    targetDoi: raw.DOI || raw.doi || raw.id || "",
    noticeId: raw.DOI || raw.doi || raw.id || raw.url || "",
    recordId: raw["record-id"] || raw.recordId,
    assertedBy: raw["asserted-by"] || raw.assertedBy,
    rawType: raw.type || raw["update-type"] || fallbackType,
  });
}

export function normalizeCrossrefIntegrity(work = {}, { targetDoi = "" } = {}) {
  const currentDoi = normalizeIntegrityDoi(targetDoi || work.DOI || work.doi);
  const accepted = [];
  const excluded = [];
  for (const raw of list(work["updated-by"])) {
    const item = crossrefEntry(raw, "", "updated-by");
    if (item) accepted.push({ ...item, targetDoi: currentDoi });
  }
  for (const raw of list(work["update-to"])) {
    const item = crossrefEntry(raw, "", "update-to");
    if (item) excluded.push({ ...item, targetDoi: normalizeIntegrityDoi(raw.DOI || raw.doi || raw.id), noticeId: currentDoi });
  }
  const relation = work.relation && typeof work.relation === "object" ? work.relation : {};
  const relationMap = {
    "is-retracted-by": "retraction", "is-corrected-by": "correction", "is-expression-of-concern-by": "expression_of_concern",
  };
  const reverseKeys = new Set(["has-retraction", "has-correction", "has-expression-of-concern", "retracts", "corrects"]);
  for (const [key, values] of Object.entries(relation)) {
    if (relationMap[key]) for (const raw of Array.isArray(values) ? values : [values]) {
      const item = crossrefEntry(raw || {}, relationMap[key], "updated-by");
      if (item) accepted.push({ ...item, targetDoi: currentDoi });
    }
    if (reverseKeys.has(key)) for (const raw of Array.isArray(values) ? values : [values]) {
      const item = crossrefEntry(raw || {}, key, "update-to");
      if (item) excluded.push({ ...item, noticeId: currentDoi });
    }
  }
  const byRecordId = new Map();
  for (const item of accepted.filter((entry) => entry.source === "crossref_retraction_watch" && entry.recordId)) {
    const signature = `${item.kind}:${item.targetDoi}`;
    if (!byRecordId.has(item.recordId)) byRecordId.set(item.recordId, new Set());
    byRecordId.get(item.recordId).add(signature);
  }
  const conflicts = [...byRecordId].filter(([, values]) => values.size > 1).map(([recordId, values]) => ({ source: "crossref_retraction_watch", recordId, signatures: [...values].sort(), reason: "same_record_id_conflict" }));
  return { evidence: accepted, directionalExclusions: excluded, conflicts };
}

function pubmedKind(refType) {
  const type = normalizedType(refType).replace(/\s/g, "");
  if (type === "retractionin") return "retraction";
  if (type === "erratumin" || type === "correctionin") return "correction";
  if (type === "expressionofconcernin") return "expression_of_concern";
  if (type.includes("correctedandrepublished")) return "retracted_and_republished";
  return "";
}

export function normalizePubMedIntegrity(record = {}, { targetPmid = "" } = {}) {
  const currentPmid = normalizePmid(targetPmid || record.pmid);
  const accepted = [];
  const excluded = [];
  for (const relation of record.relations || []) {
    const compact = normalizedType(relation.refType).replace(/\s/g, "");
    const kind = pubmedKind(relation.refType);
    if (kind === "retracted_and_republished") {
      accepted.push(evidence({ source: "pubmed", kind, direction: compact.endsWith("in") ? "updated-by" : "update-to", targetPmid: currentPmid, noticeId: relation.targetPmid, manualReview: true, rawType: relation.refType }));
    } else if (kind) {
      accepted.push(evidence({ source: "pubmed", kind, direction: "updated-by", targetPmid: currentPmid, noticeId: relation.targetPmid, rawType: relation.refType }));
    } else if (/(of|for|from)$/.test(compact)) {
      excluded.push(evidence({ source: "pubmed", kind: crossrefKind(relation.refType) || "notice_relation", direction: "update-to", targetPmid: relation.targetPmid, noticeId: currentPmid, rawType: relation.refType }));
    }
  }
  return { evidence: accepted, directionalExclusions: excluded, conflicts: [] };
}

export function resolveIntegrityStatus(evidenceItems = [], conflicts = [], previousStatus = "unknown") {
  const rwConflictIds = new Set(conflicts.filter((item) => item.source === "crossref_retraction_watch").map((item) => item.recordId));
  const applicable = evidenceItems.filter((item) => item.direction === "updated-by" && item.manualReview !== true && !(item.source === "crossref_retraction_watch" && rwConflictIds.has(item.recordId)));
  let status = "unknown";
  for (const item of applicable) if ((PRECEDENCE.get(item.kind) || 0) > (PRECEDENCE.get(status) || 0)) status = item.kind;
  if (previousStatus === "retraction") status = "retraction";
  const manualReview = evidenceItems.some((item) => item.manualReview) || (conflicts.length > 0 && status !== "retraction");
  return { status, manualReview, confirmedBy: [...new Set(applicable.filter((item) => item.kind === status).map((item) => item.source))].sort() };
}
