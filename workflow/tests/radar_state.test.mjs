import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  enqueueRadarUrgent,
  isUrgentA,
  loadRadarBacklog,
  loadRadarUrgentQueue,
  mergeRadarCandidates,
  radarClassificationFingerprint,
  radarStatePaths,
} from "../tools/radar/state.mjs";
import { finalizeRadarStage1, prepareRadarCandidatePool } from "../tools/stage1/radar_step.mjs";

const doubleA = (extra = {}) => ({ title: "Urgent paper", doi: "10.1000/urgent", grade: "A", rule_grade: "A", final_grade: "A", llm_review_grade: "A", semantic_grade: "A", semantic_source: "llm_title_review_grade", semantic_reason: "high priority", ...extra });

test("candidate/audit persistence failure prevents Radar watermark commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-watermark-fail-"));
  const artifactDir = path.join(root, "review_results", "文献评价", "runs", "radar-fail", "radar");
  await fs.mkdir(artifactDir, { recursive: true });
  const statePath = path.join(root, "source-state.json");
  const retrievalPath = path.join(artifactDir, "retrieval_audit.json");
  await assert.rejects(finalizeRadarStage1({
    projectRoot: root,
    artifactDir,
    runId: "radar-fail",
    triagedItems: [],
    retrievalTransaction: { artifactPath: retrievalPath, artifact: { schemaVersion: 1 }, stateUpdates: [{ path: statePath, state: { schemaVersion: 1 } }] },
    atomicWriter: async () => { throw new Error("audit_persistence_failed"); },
  }), /audit_persistence_failed/);
  await assert.rejects(fs.access(retrievalPath));
  await assert.rejects(fs.access(statePath));
});

test("ordinary Radar result never enters urgent queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-ordinary-"));
  const filePath = radarStatePaths(root).urgentQueue;
  await enqueueRadarUrgent(filePath, [{ ...doubleA(), final_grade: "B" }], { runId: "ordinary" });
  assert.equal(Object.keys((await loadRadarUrgentQueue(filePath)).items).length, 0);
});

test("LLM unavailable candidates enter review backlog", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-backlog-"));
  const artifactDir = path.join(root, "review_results", "文献评价", "runs", "radar-backlog", "radar");
  await fs.mkdir(artifactDir, { recursive: true });
  const item = { title: "Rule A only", doi: "10.1000/backlog", grade: "A", rule_grade: "A", final_grade: "A" };
  const result = await finalizeRadarStage1({ projectRoot: root, artifactDir, runId: "radar-backlog", triagedItems: [item], llmGradeReport: { skipped: true, skipped_reason: "llm_disabled" } });
  assert.equal(result.audit.backlogCount, 1);
  assert.equal(Object.keys((await loadRadarBacklog(radarStatePaths(root).backlog)).items).length, 1);
});

test("rule-only A is never urgent", () => {
  assert.equal(isUrgentA({ grade: "A", rule_grade: "A", final_grade: "A", llm_review_grade: "" }), false);
});

test("recovered LLM review consumes matching backlog evidence", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-backlog-recovery-"));
  const paths = radarStatePaths(root);
  const firstDir = path.join(root, "review_results", "文献评价", "runs", "radar-one", "radar");
  await fs.mkdir(firstDir, { recursive: true });
  await finalizeRadarStage1({ projectRoot: root, artifactDir: firstDir, runId: "radar-one", triagedItems: [{ title: "Recover", doi: "10.1000/recover", grade: "A", rule_grade: "A", final_grade: "A" }], llmGradeReport: { skipped: true } });
  const prepared = await prepareRadarCandidatePool({ projectRoot: root, reviewRoot: path.join(root, "review_results", "文献评价"), runId: "radar-two", currentCandidates: [{ title: "Recover newer", doi: "10.1000/recover" }] });
  assert.equal(prepared.candidates.length, 1);
  await finalizeRadarStage1({ projectRoot: root, artifactDir: prepared.artifactDir, runId: "radar-two", triagedItems: [doubleA({ title: "Recover newer", doi: "10.1000/recover" })], llmGradeReport: { ok: true } });
  assert.equal(Object.keys((await loadRadarBacklog(paths.backlog)).items).length, 0);
});

test("candidate persistence stays minimal without stripping fields needed by grading", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-candidate-fields-"));
  const prepared = await prepareRadarCandidatePool({
    projectRoot: root,
    reviewRoot: path.join(root, "review_results", "文献评价"),
    runId: "radar-fields",
    currentCandidates: [{
      title: "Complete current candidate",
      doi: "10.1000/fields",
      abstract: "Mechanistic evidence used by rule grading",
      source_platform: "pubmed",
      source_channel: "database",
    }],
  });
  assert.equal(prepared.candidates[0].abstract, "Mechanistic evidence used by rule grading");
  assert.equal(prepared.candidates[0].source_platform, "pubmed");
  assert.equal(prepared.candidateArtifact.candidates[0].metadata.abstract, undefined);
});

test("canonical identity dedupe happens before LLM candidate preparation", () => {
  const merged = mergeRadarCandidates([{ title: "One", doi: "10.1000/SAME", source: "rss" }, { title: "One updated", doi: "10.1000/same", source: "pubmed" }]);
  assert.equal(merged.length, 1);
  assert.ok(merged[0].aliases.includes("doi:10.1000/same"));
});

test("urgent A requires the strict double-A condition", () => {
  assert.equal(isUrgentA(doubleA()), true);
  assert.equal(isUrgentA(doubleA({ llm_review_grade: "B" })), false);
});

test("grade or core metadata change produces a new Radar fingerprint", () => {
  const first = radarClassificationFingerprint(doubleA());
  assert.notEqual(first, radarClassificationFingerprint(doubleA({ final_grade: "B" })));
  assert.notEqual(first, radarClassificationFingerprint(doubleA({ journal: "Updated journal" })));
});
