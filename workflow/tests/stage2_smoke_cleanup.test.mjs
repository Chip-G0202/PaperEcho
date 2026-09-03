import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildStage2SmokeCleanupManifest,
  buildStage2SmokeCleanupPlan,
  runStage2SmokeCleanup,
  verifyExactResourceResiduals,
  validateStage2SmokeCleanupManifest,
} from "../tools/maintenance/stage2_smoke_cleanup.mjs";

function manifest(overrides = {}) {
  return buildStage2SmokeCleanupManifest({
    runId: "smoke-run-1",
    backend: "web_api",
    createdItemKeys: ["I1", "I1", "I2"],
    createdCollections: [
      { key: "MONTH", createdByRun: true, role: "month" },
      { key: "DAY", createdByRun: true, parentKey: "MONTH", role: "day" },
      { key: "SRC", createdByRun: false, parentKey: "DAY", role: "source" },
      { key: "ROOT", createdByRun: true, role: "root_pool", name: "文献池" },
      { key: "UNKNOWN", role: "grade" },
    ],
    reusedCollectionKeys: ["SRC"],
    ...overrides,
  });
}

test("manifest validation rejects missing run id, unsupported version, and run mismatch", () => {
  assert.equal(validateStage2SmokeCleanupManifest(manifest({ runId: "" })).ok, false);
  assert.equal(validateStage2SmokeCleanupManifest({ ...manifest(), version: 2 }).ok, false);
  assert.equal(validateStage2SmokeCleanupManifest(manifest(), { expectedRunId: "other" }).ok, false);
});

test("cleanup plan only permits explicit created resources and protects root or unknown ownership", () => {
  const plan = buildStage2SmokeCleanupPlan(manifest(), { expectedRunId: "smoke-run-1" });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.itemKeys, ["I1", "I2"]);
  assert.deepEqual(plan.collectionKeys, ["DAY", "MONTH"]);
  assert.deepEqual(
    new Set(plan.skipped.map((entry) => entry.reason)),
    new Set(["collection_ownership_unknown", "collection_marked_reused", "root_pool_protected"]),
  );
});

test("empty or dry-run manifests are not applyable", () => {
  const empty = buildStage2SmokeCleanupManifest({ runId: "empty", backend: "web_api" });
  assert.equal(validateStage2SmokeCleanupManifest(empty).ok, false);
  const dryRun = buildStage2SmokeCleanupManifest({ runId: "dry", backend: "web_api", realRun: false });
  assert.equal(validateStage2SmokeCleanupManifest(dryRun).ok, false);
});

test("dry-run does not call deletion methods", async () => {
  let deletes = 0;
  const result = await runStage2SmokeCleanup({
    manifest: manifest(),
    backend: { deleteItems: async () => { deletes++; }, deleteCollections: async () => { deletes++; } },
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.external_write_performed, false);
  assert.equal(deletes, 0);
});

test("apply deletes only manifest eligible keys and reports partial failures or residuals", async () => {
  const calls = [];
  const result = await runStage2SmokeCleanup({
    manifest: manifest(),
    expectedRunId: "smoke-run-1",
    apply: true,
    backend: {
      deleteItems: async (keys) => {
        calls.push(["items", keys]);
        return { deleted: ["I1"], failed: [{ itemKey: "I2", error: "blocked" }] };
      },
      deleteCollections: async (keys) => {
        calls.push(["collections", keys]);
        return { deleted: ["DAY"], failed: [{ collectionKey: "MONTH", error: "blocked" }] };
      },
      getCollectionItems: async (key, options) => {
        if (options?.stage === "stage2_smoke_cleanup_preflight" || key === "MONTH") return [];
        throw new Error("HTTP 404");
      },
      getItems: async ([key], options) => options?.stage === "stage2_smoke_cleanup_preflight" || key === "I2" ? [{ key }] : [],
      getCollections: async () => [{ key: "MONTH" }],
    },
  });
  assert.deepEqual(calls, [["items", ["I1", "I2"]], ["collections", ["DAY", "MONTH"]]]);
  assert.equal(result.ok, false);
  assert.equal(result.failed_item_deletes.length, 1);
  assert.equal(result.failed_collection_deletes.length, 1);
  assert.equal(result.residual.items, 1);
  assert.equal(result.residual.collections, 1);
});

test("apply rebuilds local fingerprints after removing created items", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "stage2-cleanup-index-"));
  const indexPath = path.join(dir, "current_library_index.json");
  await fs.writeFile(indexPath, JSON.stringify({
    schema_version: 1,
    live_items: { I1: { itemKey: "I1", title: "Cleanup target" } },
    tombstones: {},
    fingerprints: { title: { "cleanup target": { itemKey: "I1" } } },
    collections: {},
    stats: {},
  }));
  const result = await runStage2SmokeCleanup({
    manifest: manifest({ createdItemKeys: ["I1"], createdCollections: [], localIndexPath: indexPath }),
    expectedRunId: "smoke-run-1",
    apply: true,
    backend: {
      deleteItems: async () => ({ deleted: ["I1"], failed: [] }),
      deleteCollections: async () => ({ deleted: [], failed: [] }),
      getItems: async () => [],
      getCollections: async () => [],
    },
  });
  const index = JSON.parse(await fs.readFile(indexPath, "utf8"));
  assert.equal(result.ok, true);
  assert.deepEqual(index.live_items, {});
  assert.deepEqual(index.fingerprints.title, {});
});

test("apply refuses to delete a manifest collection that is not empty after item cleanup", async () => {
  const deletedCollections = [];
  const result = await runStage2SmokeCleanup({
    manifest: manifest({ createdCollections: [{ key: "CREATED", createdByRun: true, role: "day" }] }),
    expectedRunId: "smoke-run-1",
    apply: true,
    backend: {
      deleteItems: async (keys) => ({ deleted: keys, failed: [] }),
      getCollectionItems: async () => [{ key: "USER_ITEM_WITH_SAME_TITLE" }],
      deleteCollections: async (keys) => { deletedCollections.push(...keys); return { deleted: keys, failed: [] }; },
      getItems: async () => [],
      getCollections: async () => [{ key: "CREATED", name: "same-name" }, { key: "USER_COLLECTION", name: "same-name" }],
    },
  });
  assert.deepEqual(deletedCollections, []);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed_collection_deletes, [{ collectionKey: "CREATED", error: "collection_not_empty_after_item_cleanup" }]);
});

test("apply treats a Web API 404 for one deleted manifest item as zero residual", async () => {
  const result = await runStage2SmokeCleanup({
    manifest: manifest({ createdItemKeys: ["I1"], createdCollections: [] }),
    expectedRunId: "smoke-run-1",
    apply: true,
    backend: {
      deleteItems: async () => ({ deleted: ["I1"], failed: [] }),
      deleteCollections: async () => ({ deleted: [], failed: [] }),
      getItems: async () => { throw new Error("Zotero API GET /items/I1 failed: HTTP 404 - Item does not exist"); },
      getCollections: async () => [],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.residual.items, 0);
  assert.deepEqual(result.errors, []);
});

test("apply chunks large exact-key item cleanup to at most 50", async () => {
  const keys = Array.from({ length: 121 }, (_, index) => `I${index + 1}`);
  const batches = [];
  const deleted = new Set();
  const result = await runStage2SmokeCleanup({
    manifest: manifest({ createdItemKeys: keys, createdCollections: [] }),
    expectedRunId: "smoke-run-1",
    apply: true,
    backend: {
      deleteItems: async (batch) => { batches.push(batch); batch.forEach((key) => deleted.add(key)); return { deleted: batch, failed: [] }; },
      deleteCollections: async () => ({ deleted: [], failed: [] }),
      getItems: async ([key]) => deleted.has(key) ? [] : [{ key }],
      getCollections: async () => [],
    },
  });
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 21]);
  assert.equal(result.deleted_items, 121);
  assert.equal(result.ok, true);
});

test("exact verification treats single and multi-key 404 as missing without stopping later keys", async () => {
  const keys = Array.from({ length: 121 }, (_, index) => `I${index + 1}`);
  let calls = 0;
  const result = await verifyExactResourceResiduals({
    getItemDetails: async () => { calls++; throw new Error("HTTP 404 - Item does not exist"); },
    getCollectionItems: async () => { throw new Error("HTTP 404 - Collection not found"); },
  }, keys, ["C1", "C2"]);
  assert.equal(calls, 121);
  assert.deepEqual(result.items, { requested: 121, present: 0, missing: 121, unknown: 0, request_errors: [] });
  assert.equal(result.collections.present, 0);
  assert.equal(result.collections.missing, 2);
});

test("exact verification reports only actual present resources and is idempotent", async () => {
  const backend = {
    getItemDetails: async (key) => {
      if (key === "PRESENT") return { key };
      throw new Error("HTTP 404");
    },
    getCollectionItems: async (key) => {
      if (key === "COL_PRESENT") return [];
      throw new Error("HTTP 404");
    },
  };
  for (let run = 0; run < 2; run++) {
    const result = await verifyExactResourceResiduals(backend, ["PRESENT", "MISSING"], ["COL_PRESENT", "COL_MISSING"]);
    assert.equal(result.items.present, 1);
    assert.equal(result.items.missing, 1);
    assert.equal(result.collections.present, 1);
    assert.equal(result.collections.missing, 1);
  }
});

test("auth, throttling, server, timeout, and network errors remain unknown", async () => {
  for (const message of ["HTTP 401", "HTTP 403", "HTTP 429", "HTTP 500", "request timed out", "network failed"]) {
    const result = await verifyExactResourceResiduals({
      getItemDetails: async () => { throw new Error(message); },
      getCollectionItems: async () => { throw new Error(message); },
    }, ["I1"], ["C1"]);
    assert.equal(result.items.unknown, 1, message);
    assert.equal(result.collections.unknown, 1, message);
    assert.equal(result.items.missing, 0, message);
  }
});

test("exact verification bounds concurrency, handles empty input, and redacts key headers", async () => {
  let active = 0, peak = 0, calls = 0;
  const check = async () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    throw new Error("HTTP 500 Zotero-API-Key: secret-value");
  };
  const empty = await verifyExactResourceResiduals({ getItemDetails: check, getCollectionItems: check }, [], []);
  assert.equal(calls, 0);
  assert.equal(empty.items.requested + empty.collections.requested, 0);
  const result = await verifyExactResourceResiduals({ getItemDetails: check, getCollectionItems: check }, Array.from({ length: 60 }, (_, i) => `I${i}`), [], { concurrency: 4 });
  assert.equal(peak, 4);
  assert.equal(result.items.unknown, 60);
  assert.doesNotMatch(JSON.stringify(result), /secret-value/);
});

test("Web collection setup reports created and reused ownership for manifest inputs", async () => {
  const { ZoteroWebApiBackend } = await import("../tools/lib/zotero_web_api_backend.mjs");
  const backend = new ZoteroWebApiBackend({ userId: "test", apiKey: "test" });
  const children = new Map([["ROOT", [{ key: "MONTH", name: "26.07" }]], ["MONTH", []]]);
  let nextKey = 0;
  backend.getSubcollections = async (key) => children.get(key) || [];
  backend.createCollection = async (name, parentCollection) => {
    const key = `NEW${++nextKey}`;
    const collection = { key, name, parentCollection };
    children.set(parentCollection, [...(children.get(parentCollection) || []), collection]);
    children.set(key, []);
    return collection;
  };

  const result = await backend.ensureWritebackCollections({
    rootKey: "ROOT",
    monthName: "26.07",
    dayName: "07.10",
    sourceNames: ["RSS订阅"],
    gradeNames: ["A课题相关"],
  });

  assert.equal(result.month.created, false);
  assert.equal(result.date.created, true);
  assert.deepEqual(result.created.map((entry) => entry.key), ["NEW1", "NEW2", "NEW3"]);
  assert.deepEqual(result.existing.map((entry) => entry.key), ["MONTH"]);
});
