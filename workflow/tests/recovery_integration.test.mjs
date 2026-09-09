import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalQueryHash } from "../tools/stage1/source_state.mjs";
import { OperationLedgerStore } from "../tools/recovery/operation_ledger.mjs";
import { reconcileOperationLedger } from "../tools/recovery/reconciliation.mjs";
import { createRunRecoveryCoordinator, resumeRunFromLedger } from "../tools/recovery/run_recovery.mjs";
import { buildZoteroRecoveryReconcilers } from "../tools/recovery/zotero_reconciliation.mjs";
import { createNotificationReceipt, writeNotificationReceipt } from "../tools/stage5/email_receipt.mjs";

const HASH = canonicalQueryHash({ config: "stable" });

async function context(t, items = [{ title: "Paper A", doi: "10.1000/a", source_channel: "rss", grade: "A" }]) {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-recovery-integration-"));
  t.after(() => fs.rm(runRoot, { recursive: true, force: true }));
  const runId = "zlf-integration-1";
  const coordinator = await createRunRecoveryCoordinator({ runRoot, runId, mode: "web", profile: "standard", launcherId: "web-fixed-launcher/runner", configHash: HASH, inputHash: HASH, artifactPath: path.join(runRoot, runId, "input_artifact.json") });
  await coordinator.persistArtifact(items, items);
  return { runRoot, runId, coordinator, store: coordinator.store, items };
}

function mockBackend(initialItems = []) {
  const items = new Map(initialItems.map((item) => [item.key, item]));
  const calls = { search: 0, create: 0, metadata: 0, add: 0, remove: 0 };
  return {
    calls,
    items,
    async searchLibrary({ q }) { calls.search += 1; return [...items.values()].filter((item) => JSON.stringify(item).toLowerCase().includes(String(q).toLowerCase())); },
    async getItems(keys) { return keys.map((key) => items.get(key)).filter(Boolean); },
    async createItems(values) {
      calls.create += 1;
      const key = `NEW${calls.create}`;
      const value = values[0];
      items.set(key, { key, ...value, DOI: value.DOI, version: 1 });
      return [{ key }];
    },
    async addItemsToCollection(keys, collectionId) { calls.add += 1; for (const key of keys) items.get(key).collections = [...new Set([...(items.get(key).collections || []), collectionId])]; return { added: keys }; },
    async removeItemsFromCollection(keys, collectionId) { calls.remove += 1; for (const key of keys) items.get(key).collections = (items.get(key).collections || []).filter((value) => value !== collectionId); return { removed: keys }; },
    async writeMetadata(key, fields) { calls.metadata += 1; Object.assign(items.get(key), fields, { version: Number(items.get(key).version || 0) + 1 }); },
  };
}

test("Stage2 plans create and stable-ID memberships before its first item side effect", async (t) => {
  const { coordinator, items } = await context(t);
  await coordinator.prepareStage2({ items, sourceKeys: { RSS订阅: "SOURCE-ID" }, gradeKeys: { A课题相关: "GRADE-ID" }, resolveSourceName: () => "RSS订阅", resolveGradeName: () => "A课题相关", indexPath: path.join(path.dirname(coordinator.store.filePath), "index.json") });
  const operations = coordinator.store.ledger.operations;
  assert.deepEqual(operations.map((item) => item.type), ["zotero_item_create", "zotero_collection_add", "zotero_collection_add", "shared_index"]);
  assert.equal(operations.every((item) => item.status === "started"), true);
  assert.deepEqual(operations.filter((item) => item.type === "zotero_collection_add").map((item) => item.target.collectionId), ["SOURCE-ID", "GRADE-ID"]);
});

test("targeted discovery adopts a remotely-created run item without duplicate creation", async (t) => {
  const { store, items } = await context(t);
  const operation = await store.planOperation({ type: "zotero_item_create", identity: "doi:10.1000/a", target: { id: "zotero-library:web" }, input: items[0] });
  await store.transition(operation.idempotencyKey, "started");
  const backend = mockBackend([{ key: "REMOTE1", title: "Paper A", DOI: "10.1000/a", tags: [{ tag: "run:zlf-integration-1" }], collections: [], version: 1 }]);
  const reconcilers = await buildZoteroRecoveryReconcilers({ store, artifact: items, backend });
  const result = await reconcileOperationLedger({ store, reconcilers });
  assert.equal(result.status, "completed");
  assert.equal(store.ledger.operations[0].target.itemKey, "REMOTE1");
  assert.equal(backend.calls.create, 0);
  assert.ok(backend.calls.search > 0);
});

test("multiple targeted run candidates conflict instead of choosing one", async (t) => {
  const { store, items } = await context(t);
  const operation = await store.planOperation({ type: "zotero_item_create", identity: "doi:10.1000/a", target: { id: "zotero-library:web" }, input: items[0] });
  await store.transition(operation.idempotencyKey, "started");
  const tagged = { title: "Paper A", DOI: "10.1000/a", tags: [{ tag: "run:zlf-integration-1" }], collections: [], version: 1 };
  const backend = mockBackend([{ key: "REMOTE1", ...tagged }, { key: "REMOTE2", ...tagged }]);
  await reconcileOperationLedger({ store, reconcilers: await buildZoteroRecoveryReconcilers({ store, artifact: items, backend }) });
  assert.equal(store.ledger.operations[0].status, "conflict");
  assert.equal(backend.calls.create, 0);
});

test("metadata object-version conflict does not call the writer", async (t) => {
  const { store, items } = await context(t);
  const operation = await store.planOperation({ type: "zotero_metadata", identity: "doi:10.1000/a", target: { id: "ITEM1", itemKey: "ITEM1" }, input: { shortTitle: "Expected" }, inputVersion: 7, intent: { fields: { shortTitle: "Expected" } } });
  await store.transition(operation.idempotencyKey, "started");
  const backend = mockBackend([{ key: "ITEM1", title: "Paper A", DOI: "10.1000/a", shortTitle: "User edit", version: 8, collections: [] }]);
  await reconcileOperationLedger({ store, reconcilers: await buildZoteroRecoveryReconcilers({ store, artifact: items, backend }) });
  assert.equal(store.ledger.operations[0].status, "conflict");
  assert.equal(backend.calls.metadata, 0);
});

test("metadata without a recorded object version stops instead of overwriting", async (t) => {
  const { store, items } = await context(t);
  const operation = await store.planOperation({ type: "zotero_metadata", identity: "doi:10.1000/a", target: { id: "ITEM1", itemKey: "ITEM1" }, input: { shortTitle: "Expected" }, inputVersion: "backend_version_unrecorded", retryable: false, intent: { fields: { shortTitle: "Expected" } } });
  await store.transition(operation.idempotencyKey, "started");
  const backend = mockBackend([{ key: "ITEM1", title: "Paper A", DOI: "10.1000/a", shortTitle: "Current", version: 8, collections: [] }]);
  await reconcileOperationLedger({ store, reconcilers: await buildZoteroRecoveryReconcilers({ store, artifact: items, backend }) });
  assert.equal(store.ledger.operations[0].status, "conflict");
  assert.equal(backend.calls.metadata, 0);
});

test("accepted receipt after SMTP but before ledger verification is adopted, while ambiguous states conflict", async (t) => {
  for (const receiptStatus of ["accepted", "unknown", "pending"]) {
    await t.test(receiptStatus, async (t) => {
      const { store, items, runRoot, runId } = await context(t);
      const receiptPath = path.join(runRoot, runId, `${receiptStatus}.json`);
      const receipt = createNotificationReceipt({ notificationType: "run_summary", runId, businessSubject: runId, eventEpoch: runId, payload: { subject: "safe" }, recipient: "reader@example.test" });
      receipt.status = receiptStatus;
      receipt.attempts = 1;
      receipt.lastSmtp = { outcome: receiptStatus, category: receiptStatus, responseCode: null, acceptedCount: receiptStatus === "accepted" ? 1 : 0, rejectedCount: 0 };
      await writeNotificationReceipt(receiptPath, receipt);
      const operation = await store.planOperation({ type: "notification", identity: "run", target: { id: receipt.receiptId, path: receiptPath }, input: { payloadHash: receipt.payloadHash }, retryable: false });
      await store.transition(operation.idempotencyKey, "started");
      await reconcileOperationLedger({ store, reconcilers: await buildZoteroRecoveryReconcilers({ store, artifact: items, backend: mockBackend() }) });
      assert.equal(store.ledger.operations[0].status, receiptStatus === "accepted" ? "verified" : "conflict");
      if (receiptStatus === "pending") assert.equal(JSON.parse(await fs.readFile(receiptPath, "utf8")).status, "unknown");
    });
  }
});

test("resume validates config, input, and artifact hashes before building reconcilers", async (t) => {
  const { runRoot, runId, store } = await context(t);
  await store.setRunStatus("failed");
  let built = 0;
  await assert.rejects(() => resumeRunFromLedger({ runRoot, runId, mode: "web", profile: "standard", configHash: "f".repeat(64), inputHash: store.ledger.inputHash, buildReconcilers: async () => { built += 1; return {}; } }), /CONFIG_HASH_MISMATCH/);
  assert.equal(built, 0);
  await fs.writeFile(store.ledger.artifact.path, "tampered\n");
  await assert.rejects(() => resumeRunFromLedger({ runRoot, runId, mode: "web", profile: "standard", configHash: HASH, inputHash: store.ledger.inputHash, buildReconcilers: async () => { built += 1; return {}; } }), /ARTIFACT_HASH_MISMATCH/);
  assert.equal(built, 0);
});

test("file input hash mismatch fails before reconciliation", async (t) => {
  const { runRoot, runId, store } = await context(t);
  await store.setRunStatus("failed");
  await assert.rejects(() => resumeRunFromLedger({ runRoot, runId, mode: "web", profile: "standard", configHash: HASH, inputHash: "e".repeat(64), buildReconcilers: async () => ({}) }), /INPUT_HASH_MISMATCH/);
});

test("empty ledger resume cannot complete a failed workflow and releases its lease", async (t) => {
  const { runRoot, runId, store } = await context(t);
  const manifestPath = path.join(runRoot, runId, "run_group.json");
  await fs.writeFile(manifestPath, JSON.stringify({ schemaVersion: 1, runId, pipelineMode: "web", status: "failed", artifacts: [] }));
  await store.setRunStatus("failed");
  const result = await resumeRunFromLedger({ runRoot, runId, mode: "web", profile: "standard", configHash: HASH, buildReconcilers: async () => ({}) });
  assert.equal(result.status, "incomplete");
  assert.equal(JSON.parse(await fs.readFile(manifestPath, "utf8")).status, "failed");
  await assert.rejects(fs.stat(path.join(runRoot, runId, "resume.lease.json")), { code: "ENOENT" });
});
