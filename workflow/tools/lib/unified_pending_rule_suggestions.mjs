import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeAtomicJson, withAtomicJsonLock } from './atomic_json.mjs';

export const PENDING_SUGGESTION_STATUSES = new Set([
  "candidate",
  "pending",
  "accepted",
  "revised",
  "rejected",
  "superseded",
  "expired",
]);

const SOURCE_ALLOWLIST = new Set([
  "llm_preference_learning",
  "legacy_feedback_aggregator",
  "docx_manual_evaluation",
  "manual_pending_table",
]);

const TARGET_ALLOWLIST = new Set([
  "screening_standards.md",
  "review-workflow-rules.json",
  "pubmed_pmc_search.json",
  "unknown",
]);

const CHANGE_TYPE_ALLOWLIST = new Set([
  "add_rule",
  "revise_rule",
  "delete_rule",
  "add_keyword",
  "remove_keyword",
  "add_downgrade_signal",
  "other",
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value, length = 16) {
  return crypto.createHash("sha256").update(stableJson(value)).digest("hex").slice(0, length);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    .replace(/[.,;:·。、；：]+$/g, "")
    .trim();
}

function uniq(values) {
  return Array.from(new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean)));
}

function normalizeConfidence(value) {
  const raw = String(value || "").toLowerCase();
  return ["low", "medium", "high"].includes(raw) ? raw : "low";
}

function normalizeRiskLevel(value, target) {
  const raw = String(value || "").toLowerCase();
  if (["low", "medium", "high"].includes(raw)) return raw;
  return target === "pubmed_pmc_search.json" ? "high" : "low";
}

export function normalizePendingSuggestionStatus(value) {
  const raw = String(value || "").trim().toLowerCase();
  return PENDING_SUGGESTION_STATUSES.has(raw) ? raw : "candidate";
}

function inferChangeType(candidate = {}) {
  const explicit = String(candidate.change_type || "").trim();
  if (CHANGE_TYPE_ALLOWLIST.has(explicit)) return explicit;
  const type = String(candidate.type || candidate.action || "").toLowerCase();
  if (type.includes("hard_exclude") || type.includes("downgrade") || type.includes("negative")) return "add_downgrade_signal";
  if (type.includes("keyword")) return "add_keyword";
  if (type.includes("delete") || type.includes("remove")) return "delete_rule";
  if (type.includes("revise")) return "revise_rule";
  if (type.includes("add") || type.includes("prefer") || type.includes("positive")) return "add_rule";
  return "other";
}

function inferTarget(candidate = {}) {
  const explicit = String(candidate.target || "").trim();
  if (TARGET_ALLOWLIST.has(explicit)) return explicit;
  if (candidate.keyword_group || candidate.keyword || inferChangeType(candidate).includes("keyword")) return "pubmed_pmc_search.json";
  return "screening_standards.md";
}

function normalizeSource(candidate = {}) {
  const source = String(candidate.source || candidate.feedback_source || "legacy_feedback_aggregator").trim();
  return SOURCE_ALLOWLIST.has(source) ? source : "legacy_feedback_aggregator";
}

function evidenceTitles(candidate = {}) {
  return uniq(candidate.evidence_titles || candidate.example_items || candidate.titles || []).slice(0, 8);
}

function evidenceFeedbackTypes(candidate = {}) {
  return uniq(candidate.evidence_feedback_types || candidate.feedback_types || []).filter((value) => (
    ["keep", "drop", "upgrade", "downgrade"].includes(value)
  ));
}

function normalizedRuleText(candidate = {}) {
  return String(candidate.rule_text || candidate.suggested_rule || candidate.revised_rule || "").trim();
}

function hardDuplicateKeys(entry = {}) {
  const target = entry.target || inferTarget(entry);
  const changeType = entry.change_type || inferChangeType(entry);
  const ruleText = normalizedRuleText(entry);
  const canonicalTheme = String(entry.canonical_theme || entry.theme || "").trim();
  const titlesHash = hash(evidenceTitles(entry).map(normalizeText).sort(), 12);
  const keys = [];
  if (ruleText) keys.push(`${target}|${changeType}|rule|${normalizeText(ruleText)}`);
  if (canonicalTheme) keys.push(`${target}|${changeType}|theme|${normalizeText(canonicalTheme)}|${titlesHash}`);
  if (entry.hard_duplicate_key) keys.push(String(entry.hard_duplicate_key));
  return keys.filter(Boolean);
}

function possibleDuplicateKey(entry = {}) {
  const target = entry.target || inferTarget(entry);
  const changeType = entry.change_type || inferChangeType(entry);
  const theme = normalizeText(entry.canonical_theme || entry.theme || normalizedRuleText(entry).slice(0, 80));
  return theme ? `${target}|${changeType}|${theme}` : "";
}

export function normalizePendingRuleSuggestionCandidate(candidate = {}, {
  generatedAt = new Date().toISOString(),
  defaultStatus = "pending",
} = {}) {
  const source = normalizeSource(candidate);
  const target = inferTarget(candidate);
  const changeType = inferChangeType(candidate);
  const ruleText = normalizedRuleText(candidate);
  const titles = evidenceTitles(candidate);
  const status = normalizePendingSuggestionStatus(candidate.status || candidate.source_type || defaultStatus);
  const promotedStatus = status === "candidate" && defaultStatus === "pending" ? "pending" : status;
  const inputHash = String(candidate.input_hash || hash({
    source,
    target,
    changeType,
    ruleText,
    evidenceTitles: titles,
    rationale: candidate.rationale || candidate.reason || "",
  }, 24));
  const id = String(candidate.id || candidate.suggestion_id || `SUG-${generatedAt.slice(0, 10)}-${hash({ inputHash, source }, 8)}`).trim();
  const riskLevel = normalizeRiskLevel(candidate.risk_level, target);
  const entry = {
    id,
    suggestion_id: id,
    status: promotedStatus,
    source,
    source_ids: uniq(candidate.source_ids || [candidate.id, candidate.suggestion_id].filter(Boolean)),
    target,
    change_type: changeType,
    rule_text: ruleText,
    suggested_rule: ruleText,
    rationale: String(candidate.rationale || candidate.reason || "").trim(),
    evidence_feedback_types: evidenceFeedbackTypes(candidate),
    evidence_titles: titles,
    evidence_text_excerpt: String(candidate.evidence_text_excerpt || "").trim().slice(0, 500),
    confidence: normalizeConfidence(candidate.confidence),
    risk: String(candidate.risk || "").trim() || (target === "pubmed_pmc_search.json" ? "Search configuration changes can alter retrieval scope." : ""),
    risk_level: riskLevel,
    requires_human_approval: true,
    requires_manual_review: true,
    created_at: String(candidate.created_at || candidate.generated_at || generatedAt),
    updated_at: String(candidate.updated_at || generatedAt),
    input_hash: inputHash,
    possible_duplicate_of: candidate.possible_duplicate_of || null,
    previous_rejected_id: candidate.previous_rejected_id || null,
    regenerate_reason: candidate.regenerate_reason || "",
    canonical_theme: String(candidate.canonical_theme || candidate.theme || "").trim(),
    type: candidate.type || (changeType === "add_downgrade_signal" ? "negative_preference" : "positive_preference"),
    action: candidate.action || "add",
    evidence_count: Number(candidate.evidence_count || titles.length || 0),
    example_items: titles,
    revised_rule: String(candidate.revised_rule || ""),
    feedback_source: String(candidate.feedback_source || ""),
  };
  const keys = hardDuplicateKeys(entry);
  entry.hard_duplicate_key = keys[0] || `${target}|${changeType}|hash|${inputHash}`;
  entry.hard_duplicate_keys = keys.length ? keys : [entry.hard_duplicate_key];
  entry.possible_duplicate_key = possibleDuplicateKey(entry);
  return entry;
}

function addEvidence(target, incoming) {
  target.source_ids = uniq([...(target.source_ids || []), ...(incoming.source_ids || [])]);
  target.evidence_titles = uniq([...(target.evidence_titles || []), ...(incoming.evidence_titles || [])]).slice(0, 12);
  target.example_items = target.evidence_titles;
  target.evidence_feedback_types = uniq([...(target.evidence_feedback_types || []), ...(incoming.evidence_feedback_types || [])]);
  target.evidence_count = Math.max(Number(target.evidence_count || 0), target.evidence_titles.length);
  target.updated_at = incoming.updated_at;
}

export function generateUnifiedPendingRuleSuggestions({
  llmPreferenceCandidates = [],
  legacySuggestions = [],
  manualEvaluationCandidates = [],
  existingSuggestionsLog = null,
  generatedAt = new Date().toISOString(),
} = {}) {
  const log = {
    ...(existingSuggestionsLog || {}),
    suggestions: Array.isArray(existingSuggestionsLog?.suggestions)
      ? existingSuggestionsLog.suggestions.map((entry) => ({ ...entry }))
      : [],
  };
  const existingByHardKey = new Map();
  const existingByPossibleKey = new Map();
  for (const existing of log.suggestions) {
    const normalized = normalizePendingRuleSuggestionCandidate(existing, { generatedAt, defaultStatus: existing.status || "pending" });
    existing.hard_duplicate_key = existing.hard_duplicate_key || normalized.hard_duplicate_key;
    existing.hard_duplicate_keys = existing.hard_duplicate_keys || normalized.hard_duplicate_keys;
    existing.possible_duplicate_key = existing.possible_duplicate_key || normalized.possible_duplicate_key;
    for (const key of existing.hard_duplicate_keys || []) existingByHardKey.set(key, existing);
    if (existing.possible_duplicate_key && !existingByPossibleKey.has(existing.possible_duplicate_key)) {
      existingByPossibleKey.set(existing.possible_duplicate_key, existing);
    }
  }

  const rawCandidates = [
    ...llmPreferenceCandidates,
    ...legacySuggestions,
    ...manualEvaluationCandidates,
  ];
  let addedCount = 0;
  let mergedDuplicateCount = 0;
  let possibleDuplicateCount = 0;
  let rejectedDuplicateSkippedCount = 0;
  const added = [];

  for (const candidate of rawCandidates) {
    const normalized = normalizePendingRuleSuggestionCandidate(candidate, { generatedAt, defaultStatus: "pending" });
    if (!normalized.rule_text) continue;
    const hardMatch = (normalized.hard_duplicate_keys || []).map((key) => existingByHardKey.get(key)).find(Boolean);
    if (hardMatch) {
      if (hardMatch.status === "rejected" && !normalized.previous_rejected_id && normalized.input_hash === hardMatch.input_hash) {
        rejectedDuplicateSkippedCount += 1;
        continue;
      }
      addEvidence(hardMatch, normalized);
      mergedDuplicateCount += 1;
      continue;
    }
    const possibleMatch = normalized.possible_duplicate_key ? existingByPossibleKey.get(normalized.possible_duplicate_key) : null;
    if (possibleMatch) {
      normalized.possible_duplicate_of = possibleMatch.id || possibleMatch.suggestion_id || null;
      possibleDuplicateCount += 1;
    }
    log.suggestions.push(normalized);
    added.push(normalized);
    addedCount += 1;
    for (const key of normalized.hard_duplicate_keys || []) existingByHardKey.set(key, normalized);
    if (normalized.possible_duplicate_key && !existingByPossibleKey.has(normalized.possible_duplicate_key)) {
      existingByPossibleKey.set(normalized.possible_duplicate_key, normalized);
    }
  }

  log.updated_at = generatedAt;
  return {
    log,
    added,
    added_count: addedCount,
    merged_duplicate_count: mergedDuplicateCount,
    possible_duplicate_count: possibleDuplicateCount,
    rejected_duplicate_skipped_count: rejectedDuplicateSkippedCount,
    total_count: log.suggestions.length,
  };
}

export async function writeUnifiedPendingRuleSuggestions(logPath, log) {
  return withAtomicJsonLock(logPath, async () => {
    let current = { suggestions: [] };
    try { current = JSON.parse(await fs.readFile(logPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(current.suggestions) || !Array.isArray(log.suggestions)) throw new Error('SUGGESTION_LOG_INVALID');
    const terminal = new Set(current.suggestions.filter((entry) => ['accepted', 'revised', 'rejected', 'superseded', 'expired'].includes(entry.status)).map((entry) => entry.id || entry.suggestion_id));
    const candidates = log.suggestions.filter((entry) => !terminal.has(entry.id || entry.suggestion_id));
    const merged = generateUnifiedPendingRuleSuggestions({ existingSuggestionsLog: current, legacySuggestions: candidates, generatedAt: log.updated_at || new Date().toISOString() });
    await writeAtomicJson(logPath, merged.log);
    return merged.log;
  });
}
