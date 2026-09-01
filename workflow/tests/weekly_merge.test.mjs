import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClassificationContext,
  buildClassificationFingerprintRecord,
  buildClassificationSnapshot,
} from "../tools/stage1/classification_fingerprint.mjs";
import { gradeReviewPromptContractHash } from "../tools/stage1/llm_grade_reviewer.mjs";
import {
  applyWeeklyClassificationReuse,
  claimWeeklyRadarWritebackCandidates,
  ensureWeeklyRadarClassificationCoverage,
  finalizeWeeklyRadarReview,
  prepareWeeklyCandidatePool,
} from "../tools/stage1/weekly_merge_step.mjs";
import {
  claimRadarQueueItems,
  enqueueRadarUrgent,
  loadRadarBacklog,
  loadRadarUrgentQueue,
  radarStatePaths,
  storeRadarBacklog,
  transitionRadarQueueItem,
} from "../tools/radar/state.mjs";

async function sandbox(t, prefix = "paperecho-weekly-merge-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function classificationContext(overrides = {}) {
  return buildClassificationContext({
    workflowRules: overrides.workflowRules || { config: { triage: { version: "rules-v1", terms: ["x"] }, llm_review: { enabled: true } } },
    screeningStandards: overrides.screeningStandards || { topic_definition: "topic", positive_preferences: ["mechanism"] },
    feedbackLearning: overrides.feedbackLearning || { hardPositiveTerms: ["target"], hardNegativeTerms: [], signals: [] },
    promptHash: overrides.promptHash || gradeReviewPromptContractHash(),
    ruleContextHash: overrides.ruleContextHash || "1".repeat(64),
    runtime: overrides.runtime || { provider: "openai-compatible", endpoint: "https://llm.example/v1", model: "model-a", llm_mode: "real", temperature: 0, top_p: 1, max_output_tokens: 3000 },
    classifierCodeVersion: overrides.classifierCodeVersion || "triage-v1",
  });
}

function urgent(overrides = {}) {
  return {
    title: "Radar urgent paper",
    doi: "10.1000/radar-weekly",
    journal: "Old Journal",
    source_channel: "database",
    grade: "A",
    rule_grade: "A",
    llm_review_grade: "A",
    semantic_grade: "A",
    final_grade: "A",
    semantic_source: "llm_title_review_grade",
    semantic_reason: "directly relevant",
    ...overrides,
  };
}

test("Weekly keeps its own retrieval and merges an overlapping Radar urgent item once", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  await enqueueRadarUrgent(paths.urgentQueue, [urgent()], { runId: "radar-1", classificationContext: classificationContext() });
  const prepared = await prepareWeeklyCandidatePool({
    projectRoot: root,
    runId: "weekly-1",
    currentCandidates: [{ title: "Weekly current title", doi: "10.1000/radar-weekly", journal: "Current Journal", source_channel: "database" }],
    llmAvailable: true,
  });
  assert.equal(prepared.audit.weeklyRetrievalCount, 1);
  assert.equal(prepared.audit.urgentInputCount, 1);
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].title, "Weekly current title");
  assert.deepEqual(new Set(prepared.candidates[0].weekly_merge_provenance), new Set(["weekly_retrieval", "radar_urgent"]));
});

test("DOI obtained by Weekly bridges a PMID-only Radar identity and becomes canonical", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  await enqueueRadarUrgent(paths.urgentQueue, [urgent({ doi: "", pmid: "123456" })], { runId: "radar-pmid", classificationContext: classificationContext() });
  const prepared = await prepareWeeklyCandidatePool({
    projectRoot: root,
    runId: "weekly-alias",
    currentCandidates: [{ title: "Resolved paper", doi: "10.1000/resolved", pmid: "123456", source_channel: "database" }],
    llmAvailable: true,
  });
  assert.equal(prepared.candidates.length, 1);
  assert.equal(prepared.candidates[0].weekly_canonical_identity, "doi:10.1000/resolved");
  assert.ok(prepared.candidates[0].weekly_identity_aliases.includes("pmid:123456"));
});

test("older Radar metadata cannot overwrite higher-priority Weekly metadata", async (t) => {
  const root = await sandbox(t);
  await enqueueRadarUrgent(radarStatePaths(root).urgentQueue, [urgent({ title: "Old title", abstract: "old abstract" })], { runId: "radar-old", classificationContext: classificationContext() });
  const prepared = await prepareWeeklyCandidatePool({
    projectRoot: root,
    runId: "weekly-new",
    currentCandidates: [{ title: "New title", abstract: "new abstract", doi: "10.1000/radar-weekly", journal: "New Journal", source_channel: "rss" }],
    llmAvailable: true,
  });
  assert.equal(prepared.candidates[0].title, "New title");
  assert.equal(prepared.candidates[0].abstract, "new abstract");
  assert.equal(prepared.candidates[0].journal, "New Journal");
  assert.equal(prepared.candidates[0].source_channel, "rss");
});

test("review backlog is eligible only when Weekly classification is available and is never urgent by itself", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  await storeRadarBacklog(paths.backlog, [{ title: "Needs review", doi: "10.1000/backlog", abstract: "review me" }], { runId: "radar-backlog" });
  const unavailable = await prepareWeeklyCandidatePool({ projectRoot: root, runId: "weekly-off", currentCandidates: [], llmAvailable: false });
  assert.equal(unavailable.audit.backlogInputCount, 0);
  const available = await prepareWeeklyCandidatePool({ projectRoot: root, runId: "weekly-on", currentCandidates: [], llmAvailable: true });
  assert.equal(available.candidates.length, 1);
  assert.ok(available.candidates[0].weekly_radar_backlog);
  assert.equal(available.candidates[0].weekly_radar_queue, undefined);
});

test("classification reuse requires every canonical fingerprint factor", async (t) => {
  const baseItem = urgent();
  const baseContext = classificationContext();
  const stored = buildClassificationFingerprintRecord(baseItem, baseContext);
  const queue = {
    classificationFingerprint: stored.fingerprint,
    classificationFingerprintComplete: true,
    classificationSnapshot: buildClassificationSnapshot(baseItem),
  };
  await t.test("all factors equal reuses", () => {
    const candidate = { ...baseItem, weekly_canonical_identity: "doi:10.1000/radar-weekly", weekly_radar_queue: structuredClone(queue) };
    const result = applyWeeklyClassificationReuse([candidate], baseContext);
    assert.equal(result.reusedCount, 1);
    assert.equal(candidate.weekly_classification_reused, true);
  });
  const changes = [
    ["metadata hash", { item: { ...baseItem, journal: "Changed Journal" }, context: baseContext }],
    ["rules hash", { item: baseItem, context: classificationContext({ workflowRules: { config: { triage: { version: "rules-v2" } } } }) }],
    ["criteria feedback hash", { item: baseItem, context: classificationContext({ feedbackLearning: { hardPositiveTerms: ["different"], signals: [] } }) }],
    ["prompt hash", { item: baseItem, context: classificationContext({ promptHash: "f".repeat(64) }) }],
    ["LLM rule context hash", { item: baseItem, context: classificationContext({ ruleContextHash: "2".repeat(64) }) }],
    ["model provider config hash", { item: baseItem, context: classificationContext({ runtime: { provider: "other", endpoint: "https://other.example/v1", model: "model-b", llm_mode: "real" } }) }],
    ["classifier code version", { item: baseItem, context: classificationContext({ classifierCodeVersion: "triage-v2" }) }],
    ["model parameters", { item: baseItem, context: classificationContext({ runtime: { provider: "openai-compatible", endpoint: "https://llm.example/v1", model: "model-a", llm_mode: "real", temperature: 0.7 } }) }],
  ];
  for (const [name, change] of changes) {
    await t.test(`${name} change regrades`, () => {
      const candidate = { ...change.item, weekly_canonical_identity: "doi:10.1000/radar-weekly", weekly_radar_queue: structuredClone(queue) };
      const result = applyWeeklyClassificationReuse([candidate], change.context);
      assert.equal(result.regradeCount, 1);
      assert.equal(candidate.weekly_classification_regrade_required, true);
    });
  }
  await t.test("missing stored factor regrades", () => {
    const candidate = { ...baseItem, weekly_radar_queue: { ...structuredClone(queue), classificationFingerprintComplete: false } };
    assert.equal(applyWeeklyClassificationReuse([candidate], baseContext).regradeCount, 1);
  });
  await t.test("request telemetry does not invalidate a semantic fingerprint", () => {
    const telemetryContext = classificationContext({ runtime: {
      provider: "openai-compatible", endpoint: "https://llm.example/v1", model: "model-a", llm_mode: "real",
      temperature: 0, top_p: 1, max_output_tokens: 3000, request_id: "different", latency_ms: 999, usage_tokens: 123,
    } });
    const candidate = { ...baseItem, weekly_radar_queue: structuredClone(queue) };
    assert.equal(applyWeeklyClassificationReuse([candidate], telemetryContext).reusedCount, 1);
  });
});

test("existing-item dedupe cannot bypass Radar regrade or queue reconciliation", () => {
  const reusedQueue = { ...urgent({ doi: "10.1000/reused" }), pre_llm_skip_writeback: true, weekly_radar_queue: {}, weekly_classification_reused: true };
  const regradeQueue = { ...urgent({ doi: "10.1000/regrade" }), pre_llm_skip_writeback: true, weekly_radar_queue: {}, weekly_classification_regrade_required: true };
  const backlog = { ...urgent({ doi: "10.1000/backlog-existing" }), pre_llm_skip_writeback: true, weekly_radar_backlog: {} };
  const ordinary = { ...urgent({ doi: "10.1000/ordinary" }), pre_llm_skip_writeback: true };
  const result = ensureWeeklyRadarClassificationCoverage({ items: [reusedQueue, regradeQueue, backlog, ordinary], llmReviewItems: [] });
  assert.equal(reusedQueue.pre_llm_skip_writeback, false);
  assert.equal(result.llmReviewItems.includes(reusedQueue), false);
  assert.equal(result.llmReviewItems.includes(regradeQueue), true);
  assert.equal(result.llmReviewItems.includes(backlog), true);
  assert.equal(ordinary.pre_llm_skip_writeback, true);
  assert.equal(result.restoredExistingCount, 3);
  assert.equal(result.forcedReviewCount, 2);
});

test("atomic item claim prevents two Weekly runs from owning one queue item", async (t) => {
  const root = await sandbox(t);
  const queuePath = radarStatePaths(root).urgentQueue;
  await enqueueRadarUrgent(queuePath, [urgent()], { runId: "radar-claim", classificationContext: classificationContext() });
  const claim = { identity: "doi:10.1000/radar-weekly", aliases: ["doi:10.1000/radar-weekly"], classificationFingerprint: "a".repeat(64) };
  const [first, second] = await Promise.all([
    claimRadarQueueItems(queuePath, [claim], { weeklyRunId: "weekly-a" }),
    claimRadarQueueItems(queuePath, [claim], { weeklyRunId: "weekly-b" }),
  ]);
  assert.equal((first.result.claimed.length + second.result.claimed.length), 1);
  assert.equal((first.result.conflicts.length + second.result.conflicts.length), 1);
  const item = Object.values((await loadRadarUrgentQueue(queuePath)).items)[0];
  assert.ok(["weekly-a", "weekly-b"].includes(item.claimedByWeeklyRunId));
});

test("claimed is not consumed without explicit verified evidence", async (t) => {
  const root = await sandbox(t);
  const queuePath = radarStatePaths(root).urgentQueue;
  await enqueueRadarUrgent(queuePath, [urgent()], { runId: "radar-evidence", classificationContext: classificationContext() });
  await transitionRadarQueueItem(queuePath, "doi:10.1000/radar-weekly", "claimed", { weeklyRunId: "weekly-evidence" });
  await assert.rejects(
    transitionRadarQueueItem(queuePath, "doi:10.1000/radar-weekly", "consumed", { weeklyRunId: "weekly-evidence", verifiedWriteEvidence: { verified: false } }),
    /REQUIRES_VERIFIED_EVIDENCE/,
  );
  assert.equal(Object.values((await loadRadarUrgentQueue(queuePath)).items)[0].state, "claimed");
});

test("backlog review success removes active work with an audit outcome; continued LLM failure retains it", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  await storeRadarBacklog(paths.backlog, [{ title: "Backlog lifecycle", doi: "10.1000/backlog-life" }], { runId: "radar-life" });
  const prepared = await prepareWeeklyCandidatePool({ projectRoot: root, runId: "weekly-life", currentCandidates: [], llmAvailable: true });
  const unresolved = prepared.candidates[0];
  unresolved.grade = "A";
  unresolved.rule_grade = "A";
  unresolved.final_grade = "A";
  await finalizeWeeklyRadarReview({ items: [unresolved], classificationContext: classificationContext(), runId: "weekly-life", paths });
  assert.equal(Object.keys((await loadRadarBacklog(paths.backlog)).items).length, 1);
  assert.equal(unresolved.pre_llm_skip_writeback, true);

  const recovered = { ...unresolved, pre_llm_skip_writeback: false, llm_review_grade: "B", semantic_grade: "B", final_grade: "B", semantic_source: "llm_title_review_grade" };
  await finalizeWeeklyRadarReview({ items: [recovered], classificationContext: classificationContext(), runId: "weekly-life", paths });
  const state = await loadRadarBacklog(paths.backlog);
  assert.equal(Object.keys(state.items).length, 0);
  assert.equal(Object.values(state.resolved)[0].outcome, "weekly_review_completed");
  assert.equal(Object.keys((await loadRadarUrgentQueue(paths.urgentQueue)).items).length, 0);
});

test("Weekly rule D completes backlog review without requiring an LLM result", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  await storeRadarBacklog(paths.backlog, [{ title: "No longer eligible", doi: "10.1000/backlog-d" }], { runId: "radar-backlog-d" });
  const prepared = await prepareWeeklyCandidatePool({ projectRoot: root, runId: "weekly-backlog-d", currentCandidates: [], llmAvailable: true });
  const item = prepared.candidates[0];
  Object.assign(item, { grade: "D", rule_grade: "D", final_grade: "D", semantic_source: "" });
  const result = await finalizeWeeklyRadarReview({ items: [item], classificationContext: classificationContext(), runId: "weekly-backlog-d", paths });
  assert.equal(result.backlogNotAdmittedCount, 1);
  const state = await loadRadarBacklog(paths.backlog);
  assert.equal(Object.keys(state.items).length, 0);
  assert.equal(Object.values(state.resolved)[0].outcome, "weekly_review_completed_not_admitted");
});

test("Radar A regraded to Weekly B uses current B and creates one claim intent", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  const oldContext = classificationContext();
  await enqueueRadarUrgent(paths.urgentQueue, [urgent()], { runId: "radar-regrade", classificationContext: oldContext });
  const prepared = await prepareWeeklyCandidatePool({
    projectRoot: root,
    runId: "weekly-regrade",
    currentCandidates: [{ title: "Materially updated title", doi: "10.1000/radar-weekly", journal: "New Journal", source_channel: "database" }],
    llmAvailable: true,
  });
  const item = prepared.candidates[0];
  item.grade = "B";
  item.rule_grade = "B";
  assert.equal(applyWeeklyClassificationReuse([item], oldContext).regradeCount, 1);
  Object.assign(item, { llm_review_grade: "B", semantic_grade: "B", final_grade: "B", semantic_source: "llm_title_review_grade" });
  const lifecycle = await finalizeWeeklyRadarReview({ items: [item], classificationContext: oldContext, runId: "weekly-regrade", paths });
  assert.equal(lifecycle.queueClaimIntentCount, 1);
  assert.equal(item.weekly_radar_queue_claim_intent.finalGrade, "B");
  const claimed = await claimWeeklyRadarWritebackCandidates({ items: [item], runId: "weekly-regrade" });
  assert.equal(claimed.claimedCount, 1);
  assert.equal(claimed.items[0].weekly_radar_queue_claim.finalGrade, "B");
});

test("Radar A regraded to D reaches an audited terminal state without a write claim", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  const context = classificationContext();
  await enqueueRadarUrgent(paths.urgentQueue, [urgent()], { runId: "radar-d", classificationContext: context });
  const prepared = await prepareWeeklyCandidatePool({ projectRoot: root, runId: "weekly-d", currentCandidates: [{ ...urgent(), title: "Changed", final_grade: "D" }], llmAvailable: true });
  const item = prepared.candidates[0];
  Object.assign(item, { grade: "D", rule_grade: "D", llm_review_grade: "D", semantic_grade: "D", final_grade: "D", semantic_source: "llm_title_review_grade", weekly_classification_reused: false });
  const lifecycle = await finalizeWeeklyRadarReview({ items: [item], classificationContext: context, runId: "weekly-d", paths });
  assert.equal(lifecycle.queueClassificationResolvedCount, 1);
  assert.equal(item.weekly_radar_queue_claim_intent, undefined);
  const queueItem = Object.values((await loadRadarUrgentQueue(paths.urgentQueue)).items)[0];
  assert.equal(queueItem.state, "consumed");
  assert.equal(queueItem.verifiedWriteEvidence.kind, "classification_resolution");
  assert.equal(queueItem.verifiedWriteEvidence.finalGrade, "D");
});

test("Radar A regraded to rule D settles even when no Weekly LLM result exists", async (t) => {
  const root = await sandbox(t);
  const paths = radarStatePaths(root);
  const context = classificationContext();
  await enqueueRadarUrgent(paths.urgentQueue, [urgent()], { runId: "radar-rule-d", classificationContext: context });
  const prepared = await prepareWeeklyCandidatePool({ projectRoot: root, runId: "weekly-rule-d", currentCandidates: [{ ...urgent(), title: "Rule excludes now" }], llmAvailable: true });
  const item = prepared.candidates[0];
  Object.assign(item, { grade: "D", rule_grade: "D", final_grade: "D", llm_review_grade: "", semantic_grade: "", semantic_source: "", weekly_classification_reused: false });
  const result = await finalizeWeeklyRadarReview({ items: [item], classificationContext: context, runId: "weekly-rule-d", paths });
  assert.equal(result.queueClassificationResolvedCount, 1);
  assert.equal(result.queueDeferredCount, 0);
  const queueItem = Object.values((await loadRadarUrgentQueue(paths.urgentQueue)).items)[0];
  assert.equal(queueItem.state, "consumed");
  assert.equal(queueItem.verifiedWriteEvidence.kind, "classification_resolution");
});
