import fs from "node:fs/promises";
import path from "node:path";

import { writeAtomicJson } from "../lib/atomic_json.mjs";
import { getLiteratureIdentityKeys } from "../lib/literature_identity.mjs";
import { getDefaultZoteroLibraryIndexPath, updateSharedLiteratureRecordState } from "../lib/zotero_library_index_store.mjs";
import {
  enqueueRadarUrgent,
  isUrgentA,
  loadRadarBacklog,
  mergeRadarCandidates,
  persistRadarCandidates,
  radarStatePaths,
  resolveRadarBacklog,
  storeRadarBacklog,
  radarCoreMetadata,
} from "../radar/state.mjs";
import { commitRetrievalTransaction } from "./source_state.mjs";

function clean(value) { return String(value || "").trim(); }

function mergePreferredCandidateFields(items = []) {
  const merged = {};
  for (const item of items) {
    for (const [key, value] of Object.entries(item || {})) {
      const missing = merged[key] == null || merged[key] === "";
      const present = value != null && value !== "";
      if (missing && present) merged[key] = value;
    }
  }
  return merged;
}

export function isRadarProfile(profile) {
  return clean(profile).toLowerCase() === "radar";
}

export function radarRunArtifactDir(reviewRoot, runId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(String(runId || ""))) throw new Error("RADAR_RUN_ID_INVALID");
  return path.join(path.resolve(reviewRoot), "runs", runId, "radar");
}

export async function prepareRadarCandidatePool({ projectRoot, reviewRoot, runId, currentCandidates = [], fsApi = fs, clock = () => new Date() } = {}) {
  const paths = radarStatePaths(projectRoot);
  const backlog = await loadRadarBacklog(paths.backlog, { fsApi });
  const backlogCandidates = Object.values(backlog.items || {}).map((entry) => ({
    ...(entry.metadata || {}),
    radar_provenance: ["radar_backlog"],
  }));
  const combined = [
    ...currentCandidates.map((item) => ({ ...item, radar_provenance: [...new Set([...(item.radar_provenance || []), "radar_current"])] })),
    ...backlogCandidates,
  ];
  const merged = mergeRadarCandidates(combined).map((candidate) => {
    const aliases = new Set(candidate.aliases || []);
    const matching = combined.filter((item) => getLiteratureIdentityKeys(item).some((alias) => aliases.has(alias)));
    const preferred = mergePreferredCandidateFields(matching);
    const provenance = [...new Set(matching.flatMap((item) => item.radar_provenance || []))];
    return {
      ...candidate.metadata,
      ...preferred,
      radar_canonical_identity: candidate.canonicalIdentity,
      radar_aliases: candidate.aliases,
      radar_metadata_fingerprint: candidate.metadataFingerprint,
      radar_provenance: provenance,
    };
  });
  const artifactDir = radarRunArtifactDir(reviewRoot, runId);
  await fsApi.mkdir(artifactDir, { recursive: true });
  const candidateArtifactPath = path.join(artifactDir, "candidates.json");
  const candidateArtifact = await persistRadarCandidates(candidateArtifactPath, merged, { runId, generatedAt: clock().toISOString(), fsApi });
  return { candidates: merged, paths, artifactDir, candidateArtifactPath, candidateArtifact, backlogInputCount: backlogCandidates.length };
}

function reliableLlmReview(item) {
  return Boolean(clean(item.llm_review_grade || item.semantic_grade))
    && new Set(["llm_title_review", "llm_title_review_grade"]).has(clean(item.semantic_source));
}

export async function finalizeRadarStage1({
  projectRoot,
  artifactDir,
  runId,
  triagedItems = [],
  llmGradeReport = {},
  retrievalTransaction = null,
  paths = radarStatePaths(projectRoot),
  fsApi = fs,
  atomicWriter = writeAtomicJson,
  clock = () => new Date(),
} = {}) {
  const eligible = triagedItems.filter((item) => ["A", "B", "C"].includes(clean(item.rule_grade || item.grade).toUpperCase()));
  await updateSharedLiteratureRecordState(getDefaultZoteroLibraryIndexPath(projectRoot), triagedItems.map((item) => ({ item, patch: { radar_metadata: radarCoreMetadata(item) } })), { generatedAt: clock().toISOString() });
  const resolved = eligible.filter(reliableLlmReview);
  const unresolved = eligible.filter((item) => !reliableLlmReview(item));
  if (unresolved.length) await storeRadarBacklog(paths.backlog, unresolved, { runId, reason: llmGradeReport.skipped_reason || "llm_unavailable", fsApi, clock });
  if (resolved.length) await resolveRadarBacklog(paths.backlog, resolved, { fsApi, clock });
  const urgentItems = resolved.filter(isUrgentA);
  const queueResult = await enqueueRadarUrgent(paths.urgentQueue, urgentItems, { runId, fsApi, clock });
  const auditPath = path.join(artifactDir, "radar_audit.json");
  const audit = {
    schemaVersion: 1,
    profile: "radar",
    runId,
    generatedAt: clock().toISOString(),
    candidateCount: triagedItems.length,
    llmEligibleCount: eligible.length,
    llmReliableCount: resolved.length,
    backlogCount: unresolved.length,
    urgentCount: urgentItems.length,
    urgentIdentities: urgentItems.map((item) => item.radar_canonical_identity || "").filter(Boolean),
    queueUpdates: queueResult.result?.queued || [],
    llmUnavailable: unresolved.length > 0,
    watermarkCommitted: false,
    xlsxWriteCount: 0,
    zoteroWriteCount: 0,
  };
  await atomicWriter(auditPath, audit, { fsApi });
  if (retrievalTransaction) await commitRetrievalTransaction(retrievalTransaction);
  audit.watermarkCommitted = Boolean(retrievalTransaction);
  await atomicWriter(auditPath, audit, { fsApi });
  return { audit, auditPath, urgentItems, unresolvedItems: unresolved };
}

export function radarPreferenceLearningPlaceholder() {
  return {
    manualStandardEvaluation: { status: "skipped", reason: "radar_profile" },
    feedbackLearning: { hardPositiveTerms: [], hardNegativeTerms: [], status: "skipped", reason: "radar_profile" },
    medQueryLearning: { status: "skipped", reason: "radar_profile" },
    preferenceLearningExecutionSummary: { enabled: false, triggered: false, degraded: false, skipped_reason: "radar_profile" },
    llmPreferenceReport: { ok: false, skipped: true, enabled: false, skipped_reason: "radar_profile", mock_response_used: false, real_request_sent: false },
  };
}
