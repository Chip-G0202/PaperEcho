import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGetItemsDetailsJs,
  ZoteroCliBackend,
} from "../tools/lib/zotero_cli_backend.mjs";
import { createItemWithDedupeRetry } from "../tools/stage2/item_create_retry.mjs";
import {
  createStage2ItemWriter,
  createStage2RecoveryRecordItemsCallback,
} from "../tools/stage2/writeback_execution.mjs";

test("Stage2 recovery recorder is installed only for a callable recordItems", async () => {
  for (const recovery of [null, {}, { recordItems: true }]) {
    assert.equal(createStage2RecoveryRecordItemsCallback(recovery), undefined);
  }
  const recorded = [];
  const callback = createStage2RecoveryRecordItemsCallback({ recordItems: async (keys) => recorded.push(keys) });
  await callback(["K1"]);
  assert.deepEqual(recorded, [["K1"]]);

  for (const recovery of [null, {}, { recordItems: "invalid" }]) {
    const writer = createStage2ItemWriter({
      zoteroBackendCall: async () => ({ content: [{ text: JSON.stringify({ itemKey: "K1" }) }] }),
      onCreatedKeys: createStage2RecoveryRecordItemsCallback(recovery),
    });
    assert.equal(await writer({ title: "Safe callback fixture" }, 0), "K1");
  }
});

test("uncertain retry adopts an observed remote item and never creates twice", async () => {
  let creates = 0;
  const result = await createItemWithDedupeRetry({
    retryLimit: 2,
    createItem: async () => { creates += 1; throw new Error("timeout after request"); },
    findExisting: async () => "EXISTING",
  });
  assert.deepEqual(result, { itemKey: "EXISTING", retryCount: 0, duplicatePrevented: true });
  assert.equal(creates, 1);
});

test("uncertain retry without proof of absence fails closed before a second create", async () => {
  let creates = 0;
  await assert.rejects(() => createItemWithDedupeRetry({
    retryLimit: 2,
    createItem: async () => { creates += 1; throw new Error("timeout after request"); },
    findExisting: async () => null,
  }), /ZOTERO_CREATE_OUTCOME_UNCERTAIN_RECONCILE_REQUIRED/);
  assert.equal(creates, 1);
});

test("definite no-side-effect failure may use the bounded retry path", async () => {
  let creates = 0;
  const result = await createItemWithDedupeRetry({
    retryLimit: 1,
    createItem: async () => {
      creates += 1;
      if (creates === 1) throw Object.assign(new Error("database busy before request"), { definitelyFailedWithoutSideEffect: true });
      return "CREATED";
    },
    findExisting: async () => null,
    wait: async () => {},
  });
  assert.equal(result.itemKey, "CREATED");
  assert.equal(creates, 2);
});

test("CLI create reconciles one exact remote match and does not import", async () => {
  const calls = [];
  const backend = new ZoteroCliBackend({
    retries: 1,
    executeCli: async (_tool, args) => {
      calls.push(args);
      if (args[0] === "js") return { exitCode: 1, stdout: "", stderr: "transport lost", data: null };
      if (args[0] === "item" && args[1] === "find") {
        return { exitCode: 0, stdout: "", stderr: "", data: [{ key: "REMOTE1", title: "Exact title", DOI: "10.1/exact" }] };
      }
      throw new Error(`unexpected call:${args[0]}`);
    },
  });
  const result = await backend.createItem({ title: "Exact title", DOI: "10.1/exact" });
  assert.equal(result.itemKey, "REMOTE1");
  assert.equal(result.createMode, "reconciled_js_bridge");
  assert.equal(calls.some((args) => args[0] === "import"), false);
});

test("CLI uncertain create with no exact match requires reconciliation and does not import", async () => {
  const calls = [];
  const backend = new ZoteroCliBackend({
    retries: 1,
    executeCli: async (_tool, args) => {
      calls.push(args);
      if (args[0] === "js") return { exitCode: 1, stdout: "", stderr: "transport lost", data: null };
      if (args[0] === "item" && args[1] === "find") return { exitCode: 0, stdout: "", stderr: "", data: [] };
      throw new Error(`unexpected call:${args[0]}`);
    },
  });
  await assert.rejects(() => backend.createItem({ title: "Unknown outcome" }), /ZOTERO_CREATE_OUTCOME_UNCERTAIN_RECONCILE_REQUIRED/);
  assert.equal(calls.some((args) => args[0] === "import"), false);
});

test("CLI complete item normalization converts numeric and mixed memberships to stable keys", async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction("Zotero", buildGetItemsDetailsJs(["ITEM1"], "complete"));
  const item = {
    key: "ITEM1",
    itemType: "journalArticle",
    getField: () => "",
    getCreators: () => [],
    getTags: () => [],
    getCollections: () => [17, "STABLE", { key: "MIXED" }],
  };
  const result = await execute({
    Libraries: { userLibraryID: 1 },
    Items: { getByLibraryAndKey: () => item },
    Collections: { get: (id) => id === 17 ? { key: "NUMERIC" } : null },
  });
  assert.deepEqual(result.items[0].data.collections, ["NUMERIC", "STABLE", "MIXED"]);
});

test("uncertain batch failure does not fall back to per-item creates", async () => {
  const calls = [];
  const writer = createStage2ItemWriter({
    zoteroBackendCall: async (name) => {
      calls.push(name);
      if (name === "write_items") throw new Error("timeout after batch request");
      return { content: [{ text: JSON.stringify({ itemKey: "DUPLICATE" }) }] };
    },
  });
  const results = await Promise.allSettled([
    writer({ title: "One" }, 0),
    writer({ title: "Two" }, 1),
  ]);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.deepEqual(calls, ["write_items"]);
});
