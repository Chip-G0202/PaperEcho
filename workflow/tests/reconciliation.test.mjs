import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { OperationLedgerStore } from "../tools/recovery/operation_ledger.mjs";
import { createFileReconciler, createWorkbookReconciler, reconcileOperationLedger } from "../tools/recovery/reconciliation.mjs";
import { canonicalQueryHash } from "../tools/stage1/source_state.mjs";

const HASH = canonicalQueryHash({ stable: true });

async function setup(t) {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-reconcile-"));
  t.after(() => fs.rm(runRoot, { recursive: true, force: true }));
  const artifactPath = path.join(runRoot, "artifact.json");
  await fs.writeFile(artifactPath, "[]\n");
  const store = await OperationLedgerStore.create({ runRoot, runId: "run-reconcile", mode: "web", profile: "standard", launcherId: "web-fixed-launcher/runner", configHash: HASH, inputHash: HASH, artifactPath });
  await store.bindArtifact({ artifactPath, identities: ["doi:a", "doi:b"] });
  return { runRoot, store };
}

function remoteReconciler(remote, counters, { ambiguous = new Set(), conflict = new Set() } = {}) {
  return {
    async observe(operation) {
      if (ambiguous.has(operation.identity)) return { state: "ambiguous", evidence: { candidateCount: 2 } };
      if (conflict.has(operation.identity)) return { state: "conflict", evidence: { reason: "object_version_changed" } };
      return remote.has(operation.idempotencyKey) ? { state: "match", evidence: { targeted: true } } : { state: "absent", evidence: { targeted: true } };
    },
    async execute(operation) {
      counters.set(operation.type, (counters.get(operation.type) || 0) + 1);
      remote.add(operation.idempotencyKey);
      return { evidence: { accepted: true } };
    },
    async verify(operation) { return this.observe(operation); },
  };
}

test("crash after started before request resumes exactly once", async (t) => {
  const { store } = await setup(t);
  await store.planOperation({ type: "zotero_item_create", identity: "doi:a", target: { id: "library:1" }, input: { title: "A" } });
  const remote = new Set();
  const counters = new Map();
  await assert.rejects(() => reconcileOperationLedger({ store, reconcilers: { zotero_item_create: remoteReconciler(remote, counters) }, hooks: { afterStarted() { throw new Error("crash_after_started"); } } }), /crash_after_started/);
  assert.equal(store.ledger.operations[0].status, "started");
  const resumed = await reconcileOperationLedger({ store, reconcilers: { zotero_item_create: remoteReconciler(remote, counters) } });
  assert.equal(resumed.status, "completed");
  assert.equal(counters.get("zotero_item_create"), 1);
});

test("remote success before ledger update is adopted without duplicate create", async (t) => {
  const { store } = await setup(t);
  const operation = await store.planOperation({ type: "zotero_item_create", identity: "doi:a", target: { id: "library:1" }, input: { title: "A" } });
  const remote = new Set();
  const counters = new Map();
  await assert.rejects(() => reconcileOperationLedger({ store, reconcilers: { zotero_item_create: remoteReconciler(remote, counters) }, hooks: { afterExecute() { throw new Error("crash_after_remote_success"); } } }), /crash_after_remote_success/);
  assert.equal(remote.has(operation.idempotencyKey), true);
  const resumed = await reconcileOperationLedger({ store, reconcilers: { zotero_item_create: remoteReconciler(remote, counters) } });
  assert.equal(resumed.outcomes[0].action, "adopted_observed");
  assert.equal(counters.get("zotero_item_create"), 1);
});

test("metadata, collection, index, and export crash windows reconcile without a second side effect", async (t) => {
  for (const type of ["zotero_metadata", "zotero_collection_add", "zotero_collection_remove", "shared_index", "export"]) {
    const { store } = await setup(t);
    const operation = await store.planOperation({ type, identity: "doi:a", target: { id: `${type}:target` }, input: { version: 1 } });
    const remote = new Set();
    const counters = new Map();
    const reconciler = remoteReconciler(remote, counters);
    await assert.rejects(() => reconcileOperationLedger({ store, reconcilers: { [type]: reconciler }, hooks: { afterExecute() { throw new Error(`crash_after_${type}`); } } }), new RegExp(`crash_after_${type}`));
    assert.equal(remote.has(operation.idempotencyKey), true);
    await reconcileOperationLedger({ store, reconcilers: { [type]: reconciler } });
    assert.equal(store.ledger.operations[0].status, "verified");
    assert.equal(counters.get(type), 1);
  }
});

test("crash after remote_observed before verified resumes with verification only", async (t) => {
  const { store } = await setup(t);
  await store.planOperation({ type: "zotero_metadata", identity: "doi:a", target: { id: "ITEM1" }, input: { shortTitle: "A" } });
  const remote = new Set();
  const counters = new Map();
  const reconciler = remoteReconciler(remote, counters);
  await assert.rejects(() => reconcileOperationLedger({ store, reconcilers: { zotero_metadata: reconciler }, hooks: { afterObserved() { throw new Error("crash_before_verified"); } } }), /crash_before_verified/);
  assert.equal(store.ledger.operations[0].status, "remote_observed");
  await reconcileOperationLedger({ store, reconcilers: { zotero_metadata: reconciler } });
  assert.equal(store.ledger.operations[0].status, "verified");
  assert.equal(counters.get("zotero_metadata"), 1);
});

test("repeated resume skips verified create, metadata, collection, index, export, and notification", async (t) => {
  const { store } = await setup(t);
  const types = ["zotero_item_create", "zotero_metadata", "zotero_collection_add", "zotero_collection_remove", "shared_index", "export", "notification"];
  const remote = new Set();
  const counters = new Map();
  const reconcilers = {};
  for (const type of types) {
    const operation = await store.planOperation({ type, identity: type === "notification" ? "run" : "doi:a", target: { id: `${type}:target` }, input: { version: 1 }, retryable: type !== "notification" });
    remote.add(operation.idempotencyKey);
    await store.transition(operation.idempotencyKey, "started");
    await store.transition(operation.idempotencyKey, "remote_observed");
    await store.transition(operation.idempotencyKey, "verified", { verification: { targeted: true } });
    reconcilers[type] = remoteReconciler(remote, counters);
  }
  const result = await reconcileOperationLedger({ store, reconcilers });
  assert.equal(result.status, "completed");
  assert.equal(result.outcomes.every((item) => item.action === "skipped_verified"), true);
  assert.equal(counters.size, 0);
});

test("ambiguous Zotero candidates conflict and a single identity does not block another", async (t) => {
  const { store } = await setup(t);
  await store.planOperation({ type: "zotero_item_create", identity: "doi:a", target: { id: "library:1" }, input: { title: "A" } });
  await store.planOperation({ type: "zotero_item_create", identity: "doi:b", target: { id: "library:1" }, input: { title: "B" } });
  const remote = new Set();
  const counters = new Map();
  const result = await reconcileOperationLedger({ store, reconcilers: { zotero_item_create: remoteReconciler(remote, counters, { ambiguous: new Set(["doi:a"]) }) } });
  assert.equal(result.status, "completed_with_conflicts");
  assert.deepEqual(store.ledger.operations.map((item) => [item.identity, item.status]), [["doi:a", "conflict"], ["doi:b", "verified"]]);
  assert.equal(counters.get("zotero_item_create"), 1);
});

test("object version change conflicts without overwriting user metadata", async (t) => {
  const { store } = await setup(t);
  await store.planOperation({ type: "zotero_metadata", identity: "doi:a", target: { itemKey: "I1" }, input: { shortTitle: "expected" }, inputVersion: 7 });
  const counters = new Map();
  await reconcileOperationLedger({ store, reconcilers: { zotero_metadata: remoteReconciler(new Set(), counters, { conflict: new Set(["doi:a"]) }) } });
  assert.equal(store.ledger.operations[0].status, "conflict");
  assert.equal(counters.size, 0);
});

test("verified operations are terminal and skip observation even when the remote fixture changed", async (t) => {
  const { store } = await setup(t);
  const operation = await store.planOperation({ type: "shared_index", identity: "doi:a", target: { id: "index" }, input: { itemKey: "I1" } });
  await store.transition(operation.idempotencyKey, "started");
  await store.transition(operation.idempotencyKey, "remote_observed");
  await store.transition(operation.idempotencyKey, "verified");
  let observations = 0;
  const result = await reconcileOperationLedger({ store, reconcilers: { shared_index: { async observe() { observations += 1; return { state: "conflict" }; } } } });
  assert.equal(store.ledger.operations[0].status, "verified");
  assert.equal(result.outcomes[0].action, "skipped_verified");
  assert.equal(observations, 0);
});

test("local output crash after write is recovered by content hash without regeneration", async (t) => {
  const { runRoot, store } = await setup(t);
  const outputPath = path.join(runRoot, "weekly.xlsx");
  const outputHash = createHash("sha256").update("workbook bytes").digest("hex");
  const operation = await store.planOperation({ type: "export", target: { path: outputPath, outputHash }, identity: "run", input: { sourceHash: HASH } });
  await store.transition(operation.idempotencyKey, "started");
  await fs.writeFile(outputPath, "workbook bytes");
  const result = await reconcileOperationLedger({ store, reconcilers: { export: createFileReconciler() } });
  assert.equal(result.status, "completed");
  assert.equal(result.outcomes[0].action, "adopted_observed");
});

test("workbook completed before verified is adopted only after structural verification", async (t) => {
  const { runRoot, store } = await setup(t);
  const outputPath = path.join(runRoot, "周报.xlsx");
  const operation = await store.planOperation({ type: "export", target: { id: "weekly", path: outputPath }, identity: "run", input: { sourceHash: HASH }, inputVersion: "missing" });
  await store.transition(operation.idempotencyKey, "started");
  const exceljs = await import("exceljs");
  const Workbook = exceljs.Workbook || exceljs.default.Workbook;
  const workbook = new Workbook();
  workbook.addWorksheet("每日反馈");
  workbook.addWorksheet("需人工复核");
  await workbook.xlsx.writeFile(outputPath);
  let generations = 0;
  const result = await reconcileOperationLedger({ store, reconcilers: { export: createWorkbookReconciler({ execute: async () => { generations += 1; } }) } });
  assert.equal(result.status, "completed");
  assert.equal(generations, 0);
  assert.equal(store.ledger.operations[0].verification.sheets.length, 2);
});

test("unconfirmed notification stops conservatively without sending", async (t) => {
  const { store } = await setup(t);
  const operation = await store.planOperation({ type: "notification", identity: "run", target: { id: "recipient-hash" }, input: { message: "summary" }, retryable: false });
  await store.transition(operation.idempotencyKey, "started");
  let sends = 0;
  const reconciler = { async observe() { return { state: "absent" }; }, async execute() { sends += 1; } };
  const result = await reconcileOperationLedger({ store, reconcilers: { notification: reconciler } });
  assert.equal(result.status, "completed_with_conflicts");
  assert.equal(sends, 0);
  assert.match(store.ledger.operations[0].lastError, /RECEIPT_SEMANTICS_REQUIRED/);
});
