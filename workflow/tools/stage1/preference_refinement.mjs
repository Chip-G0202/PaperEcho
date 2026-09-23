import fs from "node:fs";
import { nowIso, normalizeFeedback, directionFromFeedback, feedbackProfile, clamp, uniq, splitList, normalizeList, slugify, stableHash, sortByOrder } from "./preference_utils.mjs";
import { buildFeedbackSemanticSamples, summarizeNeighbors, pickTopicLabels, pickScopeLabels } from "./preference_feedback_samples.mjs";
import { buildClusterSeed, buildConflictClusterId, createClusterFromSeed, mergeEvidenceIntoCluster, finalizeCluster, buildPreferenceRule, detectConflictGroups, buildAmbiguousClusters } from "./preference_cluster_builder.mjs";
import { buildPreferenceStoreSheets, normalizeExistingStore } from "./preference_store_sheets.mjs";
import { normalizeSummaryFeedback, tokenizeForMatch, chooseCorrectionDirection, chooseAffectedSummarySection, pickCandidateClusters, scoreClusterMatch, buildMetaEvidenceId, buildMetaPreferenceEvidence, applyMetaPreferenceEvidence } from "./preference_meta_evidence.mjs";
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";

const TOPIC_PATTERNS = [
  { tag: "sglt2", label: "SGLT2", pattern: /\bsglt-?2\b/i },
  { tag: "glp-1", label: "GLP-1", pattern: /\bglp-?1\b/i },
  { tag: "diabetes", label: "diabetes", pattern: /\bdiabet/i },
  { tag: "obesity", label: "obesity", pattern: /\bobes/i },
  { tag: "heart_failure", label: "heart failure", pattern: /heart failure|心衰/i },
  { tag: "cardiovascular", label: "cardiovascular disease", pattern: /cardiovascular|心血管/i },
  { tag: "ckd", label: "CKD", pattern: /\bckd\b|chronic kidney disease|慢性肾病/i },
  { tag: "renal", label: "renal outcomes", pattern: /\brenal\b|kidney|肾/i },
  { tag: "hypertension", label: "hypertension", pattern: /hypertension|blood pressure|高血压/i },
  { tag: "mortality", label: "mortality", pattern: /mortality|death|死亡/i },
  { tag: "hospitalization", label: "hospitalization", pattern: /hospitali[sz]ation|住院/i },
  { tag: "safety", label: "safety outcomes", pattern: /safety|adverse|不良反应|安全性/i },
];

const STUDY_PATTERNS = [
  { tag: "randomized_trial", label: "randomized trial", pattern: /randomi[sz]ed|clinical trial|试验/i },
  { tag: "meta_analysis", label: "meta-analysis", pattern: /meta-analysis|systematic review|系统综述|荟萃/i },
  { tag: "cohort", label: "cohort", pattern: /cohort|registry|队列/i },
  { tag: "guideline", label: "guideline", pattern: /guideline|consensus|指南|共识/i },
  { tag: "case_report", label: "case report", pattern: /case report|病例/i },
  { tag: "animal_study", label: "animal study", pattern: /animal|mouse|mice|rat|rats|zebrafish|小鼠|大鼠|斑马鱼/i },
  { tag: "in_vitro", label: "体外细胞实验", pattern: /in vitro|cell line|细胞实验|细胞系/i },
  { tag: "mechanistic_study", label: "mechanistic study", pattern: /mechanis|pathway|signaling|通路|机制/i },
  { tag: "human_outcome", label: "human clinical outcome", pattern: /patient|human|clinical outcome|hard endpoint|人群|临床结局|硬终点/i },
];

const EXCLUSION_PATTERNS = [
  { tag: "animal_only", label: "animal-only", pattern: /仅动物|animal only|animal study|动物实验|动物研究|动物|mouse|mice|rat|rats|zebrafish|小鼠|大鼠|斑马鱼/i },
  { tag: "in_vitro_only", label: "in-vitro only", pattern: /in vitro|cell line|细胞实验|细胞系/i },
  { tag: "basic_mechanism_only", label: "basic mechanism only", pattern: /基础机制|mechanis|pathway|signaling|通路|机制/i },
  { tag: "irrelevant_disease_context", label: "irrelevant disease context", pattern: /无关|不相关|irrelevant/i },
  { tag: "low_evidence", label: "low evidence", pattern: /low evidence|证据弱|证据不足/i },
  { tag: "non_medical", label: "non-medical", pattern: /architecture|social media|digital media|虚拟建筑|社交媒体|心理学/i },
];

const TOPIC_ORDER = ["sglt2", "glp-1", "diabetes", "obesity", "heart_failure", "cardiovascular", "ckd", "renal", "hypertension", "mortality", "hospitalization", "safety"];
const SCOPE_ORDER = ["clinical_outcome", "human_outcome", "randomized_trial", "meta_analysis", "cohort", "guideline", "case_report", "animal_only", "animal_study", "in_vitro_only", "in_vitro", "basic_mechanism_only", "mechanistic_study", "irrelevant_disease_context", "low_evidence", "non_medical"];

function colRefToIndex(ref = "") {
  const letters = String(ref).match(/[A-Z]+/i)?.[0] || "";
  if (!letters) return -1;
  let out = 0;
  for (const ch of letters.toUpperCase()) out = out * 26 + (ch.charCodeAt(0) - 64);
  return out - 1;
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function parseZipEntries(buffer) {
  const entries = new Map();
  let pos = 0;
  while (pos + 30 <= buffer.length) {
    if (buffer.readUInt32LE(pos) !== 0x04034b50) break;
    const method = buffer.readUInt16LE(pos + 8);
    const compressedSize = buffer.readUInt32LE(pos + 18);
    const nameLength = buffer.readUInt16LE(pos + 26);
    const extraLength = buffer.readUInt16LE(pos + 28);
    const name = buffer.slice(pos + 30, pos + 30 + nameLength).toString("utf8");
    const dataStart = pos + 30 + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const compressed = buffer.slice(dataStart, dataEnd);
    const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : Buffer.alloc(0);
    entries.set(name, data.toString("utf8"));
    pos = dataEnd;
  }
  return entries;
}

function parseSharedStrings(sharedXml) {
  return Array.from(String(sharedXml || "").matchAll(/<si[^>]*>([\s\S]*?)<\/si>/g)).map((entry) => {
    return Array.from(String(entry[1] || "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g))
      .map((match) => escapeXml(match[1]))
      .join("");
  });
}

function parseRelationshipTargets(relsXml) {
  const relMap = new Map();
  for (const match of String(relsXml || "").matchAll(/<Relationship([^>]*)\/?>/g)) {
    const attrs = match[1] || "";
    const id = (attrs.match(/\bId="([^"]+)"/) || [])[1] || "";
    const target = (attrs.match(/\bTarget="([^"]+)"/) || [])[1] || "";
    if (id && target) relMap.set(id, target.replace(/^\//, ""));
  }
  return relMap;
}

function readWorkbookSheets(filePath) {
  const entries = parseZipEntries(fs.readFileSync(filePath));
  const workbook = entries.get("xl/workbook.xml");
  if (!workbook) throw new Error("workbook_xml_missing");
  const rels = entries.get("xl/_rels/workbook.xml.rels") || "";
  const sharedStrings = parseSharedStrings(entries.get("xl/sharedStrings.xml") || "");
  const sheetDefs = Array.from(workbook.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/?>/g))
    .map((match) => ({ name: match[1], rid: match[2] }));
  const relMap = new Map(Array.from(parseRelationshipTargets(rels).entries())
    .map(([id, target]) => [id, target.startsWith("xl/") ? target : `xl/${target}`]));
  const workbookRows = new Map();

  for (const sheet of sheetDefs) {
    const target = relMap.get(sheet.rid);
    if (!target) continue;
    const xml = entries.get(target);
    if (!xml) continue;
    const rows = [];
    for (const rowMatch of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const rowXml = rowMatch[1];
      const cells = [];
      for (const cell of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
        const attrs = cell[1] || cell[3] || "";
        const inner = cell[2] || "";
        const ref = (attrs.match(/\br="([^"]+)"/) || [])[1] || "";
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || "";
        const colIdx = colRefToIndex(ref);
        if (colIdx < 0) continue;
        const rawValue = (inner.match(/<v[^>]*>([\s\S]*?)<\/v>/) || [])[1] || "";
        let value = "";
        if (type === "s") value = sharedStrings[Number(rawValue) || 0] || "";
        else if (type === "inlineStr") value = Array.from(inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)).map((match) => escapeXml(match[1])).join("");
        else value = escapeXml(rawValue || (inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || "");
        cells[colIdx] = value;
      }
      rows.push(cells.map((entry) => entry == null ? "" : String(entry)));
    }
    workbookRows.set(sheet.name, rows);
  }

  return workbookRows;
}

function rowsToObjects(rows = []) {
  if (!rows.length) return [];
  const headers = (rows[0] || []).map((value) => String(value || "").trim());
  return rows.slice(1)
    .filter((row) => row.some((cell) => String(cell || "").trim()))
    .map((row) => Object.fromEntries(headers.map((header, idx) => [header, row[idx] ?? ""])));
}










function summarizeStats({
  store,
  previousStore,
  touchedExistingClusterIds,
  createdClusterIds,
  conflictClusters,
  metaAdjustment = { stats: {} },
  generatedAt,
}) {
  const currentPreferenceByCluster = new Map(store.preferences.map((entry) => [entry.cluster_id, entry]));
  const previousPreferenceByCluster = new Map((previousStore.preferences || []).map((entry) => [entry.cluster_id, entry]));
  let preferencesAdded = 0;
  let preferencesUpdated = 0;
  let preferencesReinforced = 0;
  let preferencesMarkedAmbiguous = 0;
  let preferencesNeedingMoreFeedback = 0;

  for (const pref of store.preferences) {
    const previous = previousPreferenceByCluster.get(pref.cluster_id);
    if (!previous) {
      preferencesAdded += 1;
    } else if (pref.status === "ambiguous" && previous.status !== "ambiguous") {
      preferencesMarkedAmbiguous += 1;
      preferencesUpdated += 1;
    } else if (pref.status === "needs_more_feedback") {
      preferencesNeedingMoreFeedback += 1;
      if (pref.evidence_count !== previous.evidence_count || pref.confidence !== previous.confidence) preferencesUpdated += 1;
    } else if (pref.evidence_count > Number(previous.evidence_count || 0) || pref.confidence > Number(previous.confidence || 0)) {
      preferencesReinforced += 1;
      preferencesUpdated += 1;
    } else if (pref.status !== previous.status || pref.statement !== previous.statement || pref.preference_type !== previous.preference_type) {
      preferencesUpdated += 1;
    }
    if (pref.status === "ambiguous" && !previous) preferencesMarkedAmbiguous += 1;
    if (pref.status === "needs_more_feedback" && !previous) preferencesNeedingMoreFeedback += 1;
  }

  const clusters = store.clusters;
  const summaryEvaluationEvidence = (store.meta_preference_evidence || []).filter((entry) => String(entry.user_evaluation_text || "").trim());
  const stats = {
    generated_at: nowIso(generatedAt),
    clustering_executed: true,
    evidence_total: store.evidence.length,
    evidence_positive: store.evidence.filter((entry) => entry.direction === "positive").length,
    evidence_negative: store.evidence.filter((entry) => entry.direction === "negative").length,
    evidence_ambiguous: store.evidence.filter((entry) => entry.direction === "ambiguous").length,
    evidence_ignored: store.evidence.filter((entry) => entry.direction === "ignored" || !entry.accepted_for_learning).length,
    evidence_positive_weight: Number(store.evidence.filter((entry) => entry.direction === "positive").reduce((sum, entry) => sum + Number(entry.feedback_weight || 1), 0).toFixed(2)),
    evidence_negative_weight: Number(store.evidence.filter((entry) => entry.direction === "negative").reduce((sum, entry) => sum + Number(entry.feedback_weight || 1), 0).toFixed(2)),
    new_evidence_count: store.evidence.filter((entry) => entry.created_at === nowIso(generatedAt)).length,
    historical_evidence_count: (previousStore.evidence || []).length,
    clusters_total: clusters.length,
    clusters_existing_matched: touchedExistingClusterIds.size,
    clusters_created: createdClusterIds.size,
    clusters_updated: touchedExistingClusterIds.size,
    clusters_stable: clusters.filter((entry) => entry.status === "stable").length,
    clusters_tentative: clusters.filter((entry) => entry.status === "tentative").length,
    clusters_ambiguous: clusters.filter((entry) => entry.status === "ambiguous").length,
    clusters_needing_more_feedback: clusters.filter((entry) => entry.status === "needs_more_feedback").length,
    preferences_added: preferencesAdded,
    preferences_updated: preferencesUpdated,
    preferences_reinforced: preferencesReinforced,
    preferences_marked_ambiguous: preferencesMarkedAmbiguous,
    preferences_needing_more_feedback: preferencesNeedingMoreFeedback,
    conflicts_detected: conflictClusters.length,
    standard_summary_feedback_read: store.meta_preference_evidence.length > 0,
    standard_summary_feedback_used: store.meta_preference_evidence.some((entry) => entry.accepted_for_learning),
    standard_summary_feedback_rows: store.meta_preference_evidence.length,
    meta_preference_evidence_count: store.meta_preference_evidence.length,
    primary_rationale_source: summaryEvaluationEvidence.length ? "standard_summary_my_evaluation" : "daily_feedback_comment_or_title",
    standard_summary_my_evaluation_rows: summaryEvaluationEvidence.length,
    global_meta_feedback_count: Number(metaAdjustment.stats.global_meta_feedback_count || 0),
    clusters_adjusted_by_summary_feedback: Number(metaAdjustment.stats.clusters_adjusted_by_summary_feedback || 0),
    clusters_reinforced_by_summary_feedback: Number(metaAdjustment.stats.clusters_reinforced_by_summary_feedback || 0),
    clusters_weakened_by_summary_feedback: Number(metaAdjustment.stats.clusters_weakened_by_summary_feedback || 0),
    clusters_scope_narrowed_by_summary_feedback: Number(metaAdjustment.stats.clusters_scope_narrowed_by_summary_feedback || 0),
    clusters_scope_broadened_by_summary_feedback: Number(metaAdjustment.stats.clusters_scope_broadened_by_summary_feedback || 0),
    clusters_marked_ambiguous_by_summary_feedback: Number(metaAdjustment.stats.clusters_marked_ambiguous_by_summary_feedback || 0),
    clusters_retired_by_summary_feedback: Number(metaAdjustment.stats.clusters_retired_by_summary_feedback || 0),
    summary_feedback_mapping_failures: Number(metaAdjustment.stats.summary_feedback_mapping_failures || 0),
    clustering_warning: "",
    evidence_to_cluster_map_available: store.evidence.some((entry) => entry.cluster_id),
    warnings: [...(store.warnings || [])],
  };

  if (stats.preferences_added === stats.evidence_total && stats.evidence_total > 1) {
    stats.warnings.push("preferences_equal_evidence_total");
  }
  if (stats.clusters_total === stats.new_evidence_count && stats.new_evidence_count > 1) {
    stats.warnings.push("clustering_insufficient");
  }
  stats.clustering_warning = stats.warnings.join(" | ");
  return stats;
}

function buildPreferenceChangeRows({ currentPreferences = [], previousPreferences = [] } = {}) {
  const previousByCluster = new Map((previousPreferences || []).map((entry) => [entry.cluster_id, entry]));
  const rows = [];
  for (const pref of currentPreferences) {
    const previous = previousByCluster.get(pref.cluster_id);
    let changeType = "added";
    if (previous) {
      if (pref.status === "ambiguous" && previous.status !== "ambiguous") changeType = "marked_ambiguous";
      else if (pref.evidence_count > Number(previous.evidence_count || 0) || pref.confidence > Number(previous.confidence || 0)) changeType = "reinforced";
      else changeType = "updated";
    }
    rows.push({
      cluster_id: pref.cluster_id,
      preference_id: pref.preference_id,
      change_type: changeType,
      preference_type: pref.preference_type,
      status: pref.status,
      statement: pref.statement,
      confidence_before: previous?.confidence ?? null,
      confidence_after: pref.confidence ?? null,
      evidence_count: pref.evidence_count,
      positive_evidence_count: pref.positive_evidence_count,
      negative_evidence_count: pref.negative_evidence_count,
      positive_evidence_weight: Number(pref.positive_evidence_weight || 0),
      negative_evidence_weight: Number(pref.negative_evidence_weight || 0),
      rationale: pref.rationale,
      caveat: pref.caveat,
    });
  }
  if (!rows.length) {
    rows.push({
      cluster_id: "",
      preference_id: "",
      change_type: "unchanged",
      preference_type: "needs_more_feedback",
      status: "needs_more_feedback",
      statement: "",
      confidence_before: null,
      confidence_after: null,
      evidence_count: 0,
      positive_evidence_count: 0,
      negative_evidence_count: 0,
      rationale: "no preference changes generated",
      caveat: "no_feedback_or_no_accepted_samples",
    });
  }
  return rows;
}

export { buildPreferenceLearningAudit, buildStandardSummary } from "./preference_refinement_audit.mjs";
export function refinePreferencesFromSemantic({
  samples = [],
  semanticResults = [],
  metaPreferenceSignals = [],
  existingStore = {},
  screeningPreferencePath = "",
  screeningStandards = {},
  generatedAt,
} = {}) {
  const timestamp = nowIso(generatedAt);
  const previousStore = normalizeExistingStore(existingStore, { workbookPath: screeningPreferencePath });
  const workingStore = normalizeExistingStore(previousStore);
  const previousPreferenceByCluster = new Map(workingStore.preferences.map((entry) => [entry.cluster_id, entry]));
  const clusterById = new Map(workingStore.clusters.map((entry) => [
    entry.cluster_id,
    {
      ...entry,
      source_rows: normalizeList(entry.source_rows),
      evidence_ids: normalizeList(entry.evidence_ids),
      representative_titles: normalizeList(entry.representative_titles),
      representative_comments: normalizeList(entry.representative_comments),
      key_terms: normalizeList(entry.key_terms),
    },
  ]));

  const semanticByRow = new Map((semanticResults || []).map((entry) => [entry?.source_sample?.row_index, entry]));
  const newEvidence = [];
  const evidenceToClusterMap = [];
  const touchedExistingClusterIds = new Set();
  const createdClusterIds = new Set();

  for (const sample of samples) {
    const semantic = semanticByRow.get(sample.row_index);
    const evidence = {
      ...sample,
      semantic_result_count: semantic?.results?.length || 0,
      semantic_summary: summarizeNeighbors(semantic?.results || []),
      created_at: timestamp,
    };
    newEvidence.push(evidence);
    if (!evidence.accepted_for_learning || evidence.direction === "ignored") {
      workingStore.evidence.push({ ...evidence, cluster_id: "" });
      continue;
    }

    const seed = buildClusterSeed(evidence);
    const existing = clusterById.get(seed.cluster_id);
    const cluster = existing ? { ...existing } : createClusterFromSeed(seed, timestamp);
    if (existing) touchedExistingClusterIds.add(seed.cluster_id);
    else createdClusterIds.add(seed.cluster_id);

    mergeEvidenceIntoCluster(cluster, evidence, timestamp);
    clusterById.set(seed.cluster_id, cluster);
    evidence.cluster_id = seed.cluster_id;
    evidenceToClusterMap.push({ evidence_id: evidence.evidence_id, cluster_id: seed.cluster_id });
    workingStore.evidence.push(evidence);
  }

  const finalizedClusters = Array.from(clusterById.values()).map((cluster) => finalizeCluster(cluster));
  const conflictClusters = buildAmbiguousClusters(detectConflictGroups(finalizedClusters), timestamp, clusterById);
  for (const cluster of conflictClusters) {
    clusterById.set(cluster.cluster_id, cluster);
    if (workingStore.clusters.some((entry) => entry.cluster_id === cluster.cluster_id)) touchedExistingClusterIds.add(cluster.cluster_id);
    else createdClusterIds.add(cluster.cluster_id);
  }

  workingStore.clusters = Array.from(clusterById.values()).map((cluster) => finalizeCluster(cluster));
  const metaEvidence = (metaPreferenceSignals || []).map((signal) => buildMetaPreferenceEvidence(signal, workingStore.clusters, timestamp));
  workingStore.meta_preference_evidence = uniq([...(workingStore.meta_preference_evidence || []).map((entry) => entry.meta_evidence_id), ...metaEvidence.map((entry) => entry.meta_evidence_id)])
    .map((id) => ([...(workingStore.meta_preference_evidence || []), ...metaEvidence].find((entry) => entry.meta_evidence_id === id)))
    .filter(Boolean);
  const metaAdjustment = applyMetaPreferenceEvidence(workingStore.clusters, metaEvidence, timestamp);
  workingStore.clusters = metaAdjustment.clusters;
  workingStore.preferences = workingStore.clusters.map((cluster) => buildPreferenceRule(cluster, previousPreferenceByCluster, timestamp));
  workingStore.loaded = previousStore.loaded;
  workingStore.source = previousStore.source;

  const stats = summarizeStats({
    store: workingStore,
    previousStore,
    touchedExistingClusterIds,
    createdClusterIds,
    conflictClusters,
    metaAdjustment,
    generatedAt: timestamp,
  });
  if (screeningStandards?.loaded) {
    stats.screening_standards_loaded = true;
    stats.screening_standards_path = screeningStandards.path || "";
    stats.screening_standards_cleaned = Boolean(screeningStandards.cleaned);
    stats.screening_standards_primary_rationale_source = true;
    stats.primary_rationale_source = "screening_standards_md";
  }

  const changeRows = buildPreferenceChangeRows({
    currentPreferences: workingStore.preferences,
    previousPreferences: previousStore.preferences || [],
  });

  return {
    store: workingStore,
    preferences: workingStore.preferences,
    evidence: workingStore.evidence,
    clusters: workingStore.clusters,
    cluster_changes: changeRows,
    summary_change_log: metaAdjustment.changeLog,
    meta_preference_evidence: workingStore.meta_preference_evidence,
    evidence_to_cluster_map: evidenceToClusterMap,
    conflicts: conflictClusters.map((cluster) => ({
      cluster_id: cluster.cluster_id,
      statement: cluster.statement,
      evidence_count: cluster.evidence_count,
    })),
    stats,
  };
}

// Re-export functions from helper modules
export { buildFeedbackSemanticSamples } from "./preference_feedback_samples.mjs";
export { buildPreferenceStoreSheets, normalizeExistingStore } from "./preference_store_sheets.mjs";
