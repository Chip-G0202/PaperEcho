import { createHash } from "node:crypto";
import { integrityEvidenceFingerprint, resolveIntegrityStatus } from "./evidence.mjs";

function iso(value) { return new Date(value || Date.now()).toISOString(); }
function hash(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function isIntegrityEligibleRecord(record = {}) {
  return Boolean(record.presence?.zotero?.itemKey && (record.identity?.doi || record.identity?.pmid));
}

export function integrityEligibleRecords(index = {}) {
  return Object.values(index.records || {}).filter(isIntegrityEligibleRecord).sort((a, b) => String(a.canonical_id).localeCompare(String(b.canonical_id)));
}

export function selectIntegrityCheckBatch(index = {}, { maxRecords = 50, dueDays = 7, now = new Date() } = {}) {
  const eligible = integrityEligibleRecords(index);
  const ids = eligible.map((record) => record.canonical_id);
  const scopeFingerprint = hash(ids);
  const previous = index.integrity_monitoring?.bootstrap || {};
  const eligibleSet = new Set(ids);
  const completed = new Set((previous.completed_identities || []).filter((id) => eligibleSet.has(id)));
  const pending = eligible.filter((record) => !completed.has(record.canonical_id));
  const dueBefore = new Date(now).getTime() - Math.max(1, dueDays) * 86400000;
  const due = eligible.filter((record) => completed.has(record.canonical_id) && (!record.integrity?.lastCheckedAt || new Date(record.integrity.lastCheckedAt).getTime() <= dueBefore))
    .sort((a, b) => String(a.integrity?.lastCheckedAt || "").localeCompare(String(b.integrity?.lastCheckedAt || "")));
  const selected = [...pending, ...due].slice(0, Math.max(1, maxRecords));
  return {
    eligible, selected, scopeFingerprint,
    bootstrap: {
      ...previous,
      scope_fingerprint: scopeFingerprint,
      eligible_total: eligible.length,
      completed_identities: [...completed].sort(),
      bootstrap_complete: eligible.length > 0 && completed.size === eligible.length,
    },
  };
}

export function mergeIntegrityProviderResults(previous = {}, providerResults = [], { now = new Date() } = {}) {
  const attemptAt = iso(now);
  const evidenceMap = new Map((previous.evidence || []).map((item) => [item.fingerprint || integrityEvidenceFingerprint([item]), item]));
  const providerChecks = { ...(previous.providerChecks || {}) };
  const currentConflicts = [];
  let anySuccessful = false;
  let allRequiredSuccessful = providerResults.length > 0;
  for (const result of providerResults) {
    const provider = String(result.provider || "unknown");
    const successful = result.status === "success" && result.checked === true;
    anySuccessful ||= successful;
    allRequiredSuccessful &&= successful;
    if (successful) for (const item of result.evidence || []) evidenceMap.set(item.fingerprint || integrityEvidenceFingerprint([item]), item);
    currentConflicts.push(...(result.conflicts || []));
    providerChecks[provider] = {
      ...(providerChecks[provider] || {}),
      status: result.status || "provider_error",
      lastAttemptAt: attemptAt,
      ...(successful ? { lastCheckedAt: attemptAt, empty: result.empty === true, evidenceCount: (result.evidence || []).length } : {}),
      ...(successful ? { error: "" } : { error: String(result.error || result.status || "provider_error").slice(0, 200) }),
    };
  }
  const evidence = [...evidenceMap.values()].sort((a, b) => String(a.fingerprint).localeCompare(String(b.fingerprint)));
  const resolved = resolveIntegrityStatus(evidence, currentConflicts, previous.currentStatus || "unknown");
  const priorStatus = previous.currentStatus || "unknown";
  const statusChanged = resolved.status !== priorStatus;
  const newlyConfirmed = priorStatus !== "retraction" && resolved.status === "retraction";
  return {
    state: {
      schemaVersion: 1,
      currentStatus: resolved.status,
      lifecycle: newlyConfirmed ? "newly_confirmed" : (statusChanged ? "status_changed" : (previous.lifecycle || "observed")),
      evidence,
      evidenceFingerprint: integrityEvidenceFingerprint(evidence),
      conflicts: currentConflicts,
      manualReview: resolved.manualReview,
      confirmedBy: resolved.confirmedBy,
      firstObservedAt: previous.firstObservedAt || (evidence.length ? attemptAt : ""),
      lastAttemptAt: attemptAt,
      lastCheckedAt: anySuccessful ? attemptAt : (previous.lastCheckedAt || ""),
      lastChangedAt: statusChanged ? attemptAt : (previous.lastChangedAt || ""),
      providerChecks,
      application: previous.application || { targetFingerprint: "", state: "not_required", lastAppliedAt: "" },
    },
    anySuccessful,
    allRequiredSuccessful,
    statusChanged,
    newlyConfirmed,
    fromStatus: priorStatus,
    toStatus: resolved.status,
  };
}

export function advanceIntegrityBootstrap(bootstrap = {}, outcomes = [], { now = new Date() } = {}) {
  const completed = new Set(bootstrap.completed_identities || []);
  for (const outcome of outcomes) if (outcome.allRequiredSuccessful) completed.add(outcome.canonicalId);
  const eligibleTotal = Number(bootstrap.eligible_total || 0);
  return {
    ...bootstrap,
    started_at: bootstrap.started_at || iso(now),
    last_progress_at: iso(now),
    completed_identities: [...completed].sort(),
    bootstrap_complete: eligibleTotal === 0 || completed.size >= eligibleTotal,
    ...(eligibleTotal === 0 || completed.size >= eligibleTotal ? { completed_at: bootstrap.completed_at || iso(now) } : {}),
  };
}
