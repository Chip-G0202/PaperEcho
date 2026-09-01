import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  claimRadarQueueItems,
  enqueueRadarUrgent,
  loadRadarUrgentQueue,
  radarStatePaths,
} from "../tools/radar/state.mjs";
import { reconcileOperationLedger } from "../tools/recovery/reconciliation.mjs";
import {
  createRunRecoveryCoordinator,
  resumeRunFromLedger,
  RunRecoveryCoordinator,
} from "../tools/recovery/run_recovery.mjs";
import { buildZoteroRecoveryReconcilers } from "../tools/recovery/zotero_reconciliation.mjs";
import { canonicalQueryHash } from "../tools/stage1/source_state.mjs";
import { buildStage4StandaloneExportSource } from "../tools/stage4/finalize_exports_support.mjs";

const CONFIG_HASH = canonicalQueryHash({ phase: "weekly-merge-transaction" });

function paper(number, overrides = {}) {
  return {
    title: `Weekly Radar paper ${number}`,
    doi: `10.2000/weekly-${number}`,
    source_channel: "rss",
    grade: "A",
    rule_grade: "A",
    llm_review_grade: "A",
    semantic_grade: "A",
    final_grade: "A",
    semantic_source: "llm_title_review_grade",
    ...overrides,
  };
}

async function setup(t, count = 1) {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-weekly-transaction-"));
  t.after(() => fs.rm(projectRoot, { recursive: true, force: true }));
  const runRoot = path.join(projectRoot, "runtime", "runs");
  const runId = "weekly-transaction-1";
  const queuePath = radarStatePaths(projectRoot).urgentQueue;
  const sourceItems = Array.from({ length: count }, (_, index) => paper(index + 1));
  for (const item of sourceItems) await enqueueRadarUrgent(queuePath, [item], { runId: `radar-${item.doi}` });
  const claims = sourceItems.map((item) => ({
    identity: `doi:${item.doi}`,
    aliases: [`doi:${item.doi}`],
    classificationFingerprint: canonicalQueryHash({ item: item.doi, version: 1 }),
  }));
  await claimRadarQueueItems(queuePath, claims, { weeklyRunId: runId });
  const items = sourceItems.map((item, index) => ({
    ...item,
    weekly_radar_queue_claim: {
      ...claims[index],
      queuePath,
      priorClassificationFingerprint: "",
      finalGrade: item.final_grade,
      outcome: "weekly_regraded",
      weeklyRunId: runId,
      claimed: true,
    },
  }));
  const coordinator = await createRunRecoveryCoordinator({
    runRoot,
    runId,
    mode: "web",
    profile: "standard",
    launcherId: "web-fixed-launcher/runner",
    configHash: CONFIG_HASH,
    inputHash: CONFIG_HASH,
    artifactPath: path.join(runRoot, runId, "input_artifact.json"),
  });
  await coordinator.persistArtifact(items, items);
  const indexPath = path.join(projectRoot, "shared-index.json");
  await fs.writeFile(indexPath, "{}\n", "utf8");
  return { projectRoot, runRoot, runId, queuePath, items, coordinator, indexPath };
}

async function prepare(ctx) {
  return ctx.coordinator.prepareStage2({
    items: ctx.items,
    sourceKeys: { RSS订阅: "SOURCE-ID" },
    gradeKeys: { A课题相关: "GRADE-A", B专题相关: "GRADE-B", C领域相关: "GRADE-C" },
    resolveSourceName: () => "RSS订阅",
    resolveGradeName: (item) => ({ A: "A课题相关", B: "B专题相关", C: "C领域相关" })[item.final_grade || item.grade],
    indexPath: ctx.indexPath,
  });
}

function summaryItems(items, keys) {
  return items.map((item, index) => ({ ...item, itemKey: keys[index] }));
}

test("Weekly and Radar overlap produces one mutation plan and consumes only after verified write", async (t) => {
  const ctx = await setup(t);
  await prepare(ctx);
  assert.deepEqual(
    ctx.coordinator.store.ledger.operations.map((operation) => operation.type),
    ["zotero_item_create", "zotero_collection_add", "zotero_collection_add", "shared_index", "radar_queue_consume"],
  );
  assert.equal((await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"].state, "claimed");
  const completed = await ctx.coordinator.completeStage2({
    summary: { writeback_items: summaryItems(ctx.items, ["ITEM-1"]), current_date_add_failed: 0 },
    indexPath: ctx.indexPath,
  });
  assert.deepEqual(completed.verifiedBusinessWriteIdentities, ["doi:10.2000/weekly-1"]);
  const queueItem = (await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"];
  assert.equal(queueItem.state, "consumed");
  assert.equal(queueItem.verifiedWriteEvidence.verified, true);
  assert.equal(ctx.coordinator.store.ledger.operations.find((operation) => operation.type === "radar_queue_consume").status, "verified");
});

test("one collection conflict leaves that queue item safe without blocking an independent item", async (t) => {
  const ctx = await setup(t, 2);
  await prepare(ctx);
  const completed = await ctx.coordinator.completeStage2({
    summary: { writeback_items: summaryItems(ctx.items, ["ITEM-1", "ITEM-2"]), current_date_add_failed: 1 },
    indexPath: ctx.indexPath,
    failedCollectionItemKeys: ["ITEM-1"],
  });
  const queue = await loadRadarUrgentQueue(ctx.queuePath);
  assert.equal(queue.items["doi:10.2000/weekly-1"].state, "conflict");
  assert.equal(queue.items["doi:10.2000/weekly-2"].state, "consumed");
  assert.deepEqual(completed.verifiedBusinessWriteIdentities, ["doi:10.2000/weekly-2"]);
  assert.deepEqual(completed.queueResults.map((item) => item.status), ["conflict", "consumed"]);
});

test("a verified existing Zotero item is adopted without a new business write before queue consume", async (t) => {
  const ctx = await setup(t);
  await prepare(ctx);
  const completed = await ctx.coordinator.completeStage2({
    summary: {
      writeback_items: [],
      duplicate_records: [{ ...ctx.items[0], matched_pool_item_key: "EXISTING-1" }],
    },
    indexPath: ctx.indexPath,
  });
  const create = ctx.coordinator.store.ledger.operations.find((operation) => operation.type === "zotero_item_create");
  assert.equal(create.status, "verified");
  assert.equal(create.verification.notApplicable, true);
  assert.deepEqual(completed.verifiedWriteItems, []);
  const queueItem = (await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"];
  assert.equal(queueItem.state, "consumed");
  assert.equal(queueItem.verifiedWriteEvidence.kind, "preexisting_zotero_state");
});

test("verified Zotero dependencies resume queue consume without repeating a mutation", async (t) => {
  const ctx = await setup(t);
  await prepare(ctx);
  const queueOperation = ctx.coordinator.store.ledger.operations.find((operation) => operation.type === "radar_queue_consume");
  for (const operation of ctx.coordinator.store.ledger.operations.filter((entry) => entry.idempotencyKey !== queueOperation.idempotencyKey)) {
    await ctx.coordinator.store.transition(operation.idempotencyKey, "remote_observed", { verification: { simulatedPostWrite: true } });
    await ctx.coordinator.store.transition(operation.idempotencyKey, "verified", { verification: { simulatedPostWrite: true } });
  }
  const match = { async observe() { return { state: "match", evidence: { simulatedPostWrite: true } }; }, async verify() { return { state: "match", evidence: { simulatedPostWrite: true } }; } };
  const built = await buildZoteroRecoveryReconcilers({ store: ctx.coordinator.store, artifact: ctx.items, backend: {} });
  const reconcilers = {
    ...built,
    zotero_item_create: match,
    zotero_collection_add: match,
    shared_index: match,
  };
  const first = await reconcileOperationLedger({ store: ctx.coordinator.store, reconcilers });
  assert.equal(first.status, "completed");
  assert.equal(first.outcomes.find((item) => item.idempotencyKey === queueOperation.idempotencyKey).action, "executed");
  assert.equal((await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"].state, "consumed");
  const second = await reconcileOperationLedger({ store: ctx.coordinator.store, reconcilers });
  assert.equal(second.outcomes.every((item) => item.action === "skipped_verified"), true);
});

test("crash after verified summary but before consume resumes queue and preserves the report identity set", async (t) => {
  const ctx = await setup(t);
  await prepare(ctx);
  const summaryPath = path.join(ctx.projectRoot, "zotero_writeback_summary.json");
  const summary = { writeback_items: summaryItems(ctx.items, ["ITEM-1"]), current_date_add_failed: 0 };
  await assert.rejects(ctx.coordinator.completeStage2({
    summary,
    indexPath: ctx.indexPath,
    onVerifiedWrites: async ({ verifiedWriteItems, verifiedBusinessWriteIdentities }) => {
      await fs.writeFile(summaryPath, JSON.stringify({
        ...summary,
        verified_write_evidence_required: true,
        verified_write_items: verifiedWriteItems,
        verified_business_write_identities: verifiedBusinessWriteIdentities,
        verified_write_identity_set_match: true,
      }), "utf8");
      throw new Error("crash_after_verified_summary");
    },
  }), /crash_after_verified_summary/);
  assert.equal((await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"].state, "claimed");
  const match = { async observe() { return { state: "match", evidence: { postWriteVerified: true } }; }, async verify() { return { state: "match", evidence: { postWriteVerified: true } }; } };
  const built = await buildZoteroRecoveryReconcilers({ store: ctx.coordinator.store, artifact: ctx.items, backend: {} });
  const resumed = await reconcileOperationLedger({
    store: ctx.coordinator.store,
    reconcilers: { ...built, zotero_item_create: match, zotero_collection_add: match, shared_index: match },
  });
  assert.equal(resumed.status, "completed");
  assert.equal((await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"].state, "consumed");
  const persisted = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  const stage4 = buildStage4StandaloneExportSource({ desktopSource: { triaged: ctx.items }, writebackReady: ctx.items, writebackSummary: persisted });
  assert.equal(stage4.filter.status, "ok");
  assert.deepEqual(stage4.filter.reportedBusinessWriteIdentities, stage4.filter.verifiedBusinessWriteIdentities);
});

test("a Stage4 evidence failure does not roll back an already consumed verified queue item", async (t) => {
  const ctx = await setup(t);
  await prepare(ctx);
  await ctx.coordinator.completeStage2({
    summary: { writeback_items: summaryItems(ctx.items, ["ITEM-1"]), current_date_add_failed: 0 },
    indexPath: ctx.indexPath,
  });
  const before = (await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"];
  assert.equal(before.state, "consumed");
  const stage4 = buildStage4StandaloneExportSource({
    desktopSource: { triaged: ctx.items },
    writebackReady: ctx.items,
    writebackSummary: {
      verified_write_evidence_required: true,
      verified_write_items: [{ ...ctx.items[0], itemKey: "ITEM-1", verified_identity: "doi:10.2000/weekly-1" }],
      verified_business_write_identities: ["doi:10.2000/different"],
      verified_write_identity_set_match: false,
    },
  });
  assert.equal(stage4.filter.status, "degraded_verified_write_identity_set_mismatch");
  assert.equal(stage4.allAbcItems.length, 0);
  const after = (await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"];
  assert.equal(after.state, "consumed");
  assert.equal(after.verifiedWriteEvidence.ledgerOperationId, before.verifiedWriteEvidence.ledgerOperationId);
});

test("claim-only crash resumes the same persisted artifact and does not create twice", async (t) => {
  const ctx = await setup(t);
  await fs.writeFile(path.join(ctx.runRoot, ctx.runId, "run_group.json"), JSON.stringify({
    schemaVersion: 1,
    runId: ctx.runId,
    pipelineMode: "web",
    status: "failed",
    artifacts: [],
  }), "utf8");
  await ctx.coordinator.store.setRunStatus("failed");
  const remote = new Set();
  let createCalls = 0;
  const mutation = {
    async observe(operation) { return remote.has(operation.idempotencyKey) ? { state: "match", evidence: { remote: true } } : { state: "absent", evidence: { remote: false } }; },
    async execute(operation) { if (operation.type === "zotero_item_create") createCalls += 1; remote.add(operation.idempotencyKey); return { evidence: { remote: true } }; },
    async verify(operation) { return this.observe(operation); },
  };
  const beforeReconcile = async ({ store, artifact }) => {
    if (!store.ledger.operations.some((operation) => operation.type === "zotero_item_create")) {
      const resumed = new RunRecoveryCoordinator(store);
      await resumed.prepareStage2({
        items: artifact,
        sourceKeys: { RSS订阅: "SOURCE-ID" },
        gradeKeys: { A课题相关: "GRADE-A" },
        resolveSourceName: () => "RSS订阅",
        resolveGradeName: () => "A课题相关",
        indexPath: ctx.indexPath,
      });
    }
    return { artifact };
  };
  const buildReconcilers = async ({ store, artifact }) => {
    const built = await buildZoteroRecoveryReconcilers({ store, artifact, backend: {} });
    return { ...built, zotero_item_create: mutation, zotero_collection_add: mutation, shared_index: mutation };
  };
  const first = await resumeRunFromLedger({
    runRoot: ctx.runRoot,
    runId: ctx.runId,
    mode: "web",
    profile: "standard",
    configHash: CONFIG_HASH,
    beforeReconcile,
    buildReconcilers,
  });
  assert.equal(first.status, "completed");
  assert.equal(createCalls, 1);
  assert.equal((await loadRadarUrgentQueue(ctx.queuePath)).items["doi:10.2000/weekly-1"].state, "consumed");
  const second = await resumeRunFromLedger({
    runRoot: ctx.runRoot,
    runId: ctx.runId,
    mode: "web",
    profile: "standard",
    configHash: CONFIG_HASH,
    beforeReconcile,
    buildReconcilers,
  });
  assert.equal(second.status, "completed");
  assert.equal(createCalls, 1);
});
