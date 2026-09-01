import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { emptyZoteroLibraryIndex, readZoteroLibraryIndex, writeZoteroLibraryIndex } from "../tools/lib/zotero_library_index_store.mjs";
import { createRunRecoveryCoordinator } from "../tools/recovery/run_recovery.mjs";
import { buildZoteroRecoveryReconcilers } from "../tools/recovery/zotero_reconciliation.mjs";
import { reconcileOperationLedger } from "../tools/recovery/reconciliation.mjs";
import { runIntegrityMutationStep } from "../tools/stage2/integrity_mutation_step.mjs";

function clone(value) { return structuredClone(value); }

function fakeBackend({ failRemoval = false } = {}) {
  const item = { key: "ITEM1", version: 7, data: { key: "ITEM1", version: 7, collections: ["POOL", "USER"], tags: [{ tag: "UserTag" }] } };
  return {
    item,
    async getItems(keys) { return keys.includes("ITEM1") ? [clone(item)] : []; },
    async addItemsToCollections(operations) {
      for (const operation of operations) if (!item.data.collections.includes(operation.collectionKey)) item.data.collections.push(operation.collectionKey);
      return { added: operations.map((operation) => ({ itemKey: operation.itemKeys[0], collectionKey: operation.collectionKey })), already: [], failed: [] };
    },
    async addItemsToCollection(keys, collectionKey) {
      if (keys.includes("ITEM1") && !item.data.collections.includes(collectionKey)) item.data.collections.push(collectionKey);
      return { added: keys };
    },
    async removeItemsFromCollections(operations) {
      if (failRemoval) return { applied: [], failed: operations.map((operation) => ({ itemKey: operation.itemKeys[0], collectionKey: operation.collectionKey, error: "fixture_remove_failure" })) };
      for (const operation of operations) item.data.collections = item.data.collections.filter((key) => key !== operation.collectionKey);
      return { applied: operations.map((operation) => ({ itemKey: operation.itemKeys[0], collectionKey: operation.collectionKey })), failed: [] };
    },
    async removeItemsFromCollection(keys, collectionKey) {
      if (failRemoval) throw new Error("fixture_remove_failure");
      if (keys.includes("ITEM1")) item.data.collections = item.data.collections.filter((key) => key !== collectionKey);
      return { removed: keys };
    },
    async writeTagsBatch(operations) {
      for (const operation of operations) for (const tag of operation.tags || []) if (!item.data.tags.some((entry) => entry.tag === tag)) item.data.tags.push({ tag });
      return { applied: operations.map((operation) => ({ itemKey: operation.itemKey })), failed: [] };
    },
  };
}

async function fixture(t, { failRemoval = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-integrity-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const indexPath = path.join(root, "review_results", "shared", "current_literature_index.json");
  const index = emptyZoteroLibraryIndex();
  index.collections = { POOL: { role: "pool", name: "文献池" }, TRASH: { role: "trash", name: "待删除" } };
  index.live_items.ITEM1 = { itemKey: "ITEM1", title: "Original", doi: "10.1000/original", collections: ["POOL", "USER"], tags: [{ tag: "UserTag" }], version: 7 };
  index.records["doi:10.1000/original"] = {
    canonical_id: "doi:10.1000/original", identity: { doi: "10.1000/original" }, title: "Original",
    presence: { zotero: { itemKey: "ITEM1", collections: ["POOL", "USER"], tags: [{ tag: "UserTag" }], version: 7 } },
    integrity: { currentStatus: "retraction", evidenceFingerprint: "evidence-v1", application: { state: "not_required", targetFingerprint: "" } },
  };
  await writeZoteroLibraryIndex(indexPath, index);
  const artifactPath = path.join(root, "artifact.json");
  await fs.writeFile(artifactPath, "[]\n");
  const recovery = await createRunRecoveryCoordinator({
    runRoot: path.join(root, "runs"), runId: "integrity-fixture", mode: "desktop", profile: "standard", launcherId: "test",
    configHash: "a".repeat(64), inputHash: "b".repeat(64), artifactPath,
  });
  await recovery.bindArtifact(artifactPath, []);
  const plan = [{
    canonicalId: "doi:10.1000/original", evidenceFingerprint: "evidence-v1",
    target: { required: true, blocked: false, status: "retraction", itemKey: "ITEM1", itemVersion: 7, addCollectionId: "TRASH", removeCollectionIds: ["POOL"], addTags: ["PaperEcho:Retraction"], targetFingerprint: "target-v1" },
  }];
  return { root, indexPath, recovery, plan, backend: fakeBackend({ failRemoval }) };
}

const guard = { checkCollectionKey: () => ({ ok: true }) };

test("retraction mutation verifies trash before removing only managed IDs", async (t) => {
  const f = await fixture(t);
  const result = await runIntegrityMutationStep({ plan: f.plan, indexPath: f.indexPath, zoteroBackend: f.backend, collectionGuard: guard, recovery: f.recovery });
  assert.equal(result.status, "completed");
  assert.equal(result.appliedCount, 1);
  assert.equal(f.backend.item.data.collections.includes("TRASH"), true);
  assert.equal(f.backend.item.data.collections.includes("POOL"), false);
  assert.equal(f.backend.item.data.collections.includes("USER"), true);
  assert.equal(f.backend.item.data.tags.some((tag) => tag.tag === "UserTag"), true);
  assert.equal(f.backend.item.data.tags.some((tag) => tag.tag === "PaperEcho:Retraction"), true);
  assert.equal(f.recovery.store.ledger.operations.every((operation) => operation.status === "verified"), true);
  const read = await readZoteroLibraryIndex(f.indexPath);
  assert.equal(read.index.records["doi:10.1000/original"].integrity.application.state, "applied");
});

test("partial managed removal retains verified pending-delete state", async (t) => {
  const f = await fixture(t, { failRemoval: true });
  const result = await runIntegrityMutationStep({ plan: f.plan, indexPath: f.indexPath, zoteroBackend: f.backend, collectionGuard: guard, recovery: f.recovery });
  assert.equal(result.pendingDeleteCount, 1);
  assert.equal(f.backend.item.data.collections.includes("TRASH"), true);
  assert.equal(f.backend.item.data.collections.includes("POOL"), true);
  const read = await readZoteroLibraryIndex(f.indexPath);
  assert.equal(read.index.records["doi:10.1000/original"].integrity.application.state, "pending_delete");
  const remove = f.recovery.store.ledger.operations.find((operation) => operation.type === "zotero_collection_remove");
  assert.equal(remove.status, "failed");
});

test("missing operation ledger blocks every integrity mutation", async () => {
  const result = await runIntegrityMutationStep({ plan: [{ target: { required: true } }] });
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "operation_ledger_required");
});

test("resume reconciliation adopts remote facts and commits application state", async (t) => {
  const f = await fixture(t);
  const prepared = await f.recovery.prepareIntegrityOperations({ plan: f.plan, indexPath: f.indexPath });
  f.backend.item.data.collections.push("TRASH");
  f.backend.item.data.collections = f.backend.item.data.collections.filter((key) => key !== "POOL");
  f.backend.item.data.tags.push({ tag: "PaperEcho:Retraction" });
  assert.equal(prepared[0].operations.length, 3);
  const reconcilers = await buildZoteroRecoveryReconcilers({ store: f.recovery.store, artifact: [], backend: f.backend });
  const result = await reconcileOperationLedger({ store: f.recovery.store, reconcilers });
  assert.equal(result.status, "completed");
  assert.equal(f.recovery.store.ledger.operations.every((operation) => operation.status === "verified"), true);
  const read = await readZoteroLibraryIndex(f.indexPath);
  assert.equal(read.index.records["doi:10.1000/original"].integrity.application.targetFingerprint, "target-v1");
});

test("verified add is idempotent and duplicate retry does not duplicate membership", async (t) => {
  const f = await fixture(t);
  await runIntegrityMutationStep({ plan: f.plan, indexPath: f.indexPath, zoteroBackend: f.backend, collectionGuard: guard, recovery: f.recovery });
  assert.equal(f.backend.item.data.collections.filter((key) => key === "TRASH").length, 1);
  assert.equal(f.backend.item.data.tags.filter((tag) => tag.tag === "PaperEcho:Retraction").length, 1);
});
