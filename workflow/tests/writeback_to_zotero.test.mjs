import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  addItemToWorthyCollectionWithGuard,
  migrateRatedItems,
  removeItemFromCollectionWithGuard,
  runGuardedBulkWritebackMutation,
  writeTagSetWithGuard,
} from "../tools/stage2/main.mjs";
import { cleanupSignatureTags, readSubcollections } from "../tools/lib/writeback_support.mjs";
import { writeZoteroLibraryIndex } from "../tools/lib/zotero_library_index_store.mjs";
import { buildWritebackDedupeContext } from "../tools/stage2/writeback_dedupe_context.mjs";
import {
  buildPoolIndex,
  buildCollectionDuplicateIndex,
  verifyCachedDuplicateMatch,
} from "../tools/stage2/duplicate_scan.mjs";
import { runWritebackExecution } from "../tools/stage2/writeback_execution.mjs";
import { buildCreateItemRequest } from "../tools/stage2/item_payload.mjs";
import { runCollectionAttachStep } from "../tools/stage2/collection_attach_step.mjs";

test("buildCreateItemRequest includes run marker when orchestrator run id is set", async () => {
  const originalRunId = process.env.review_results_RUN_ID;
  try {
    process.env.review_results_RUN_ID = "zlf-test-run";
    const request = await buildCreateItemRequest({
      title: "Run marker item",
      grade: "A",
      final_grade: "A",
      source_channel: "rss",
    });

    assert.ok(request.tags.some(t => t.tag === "run:zlf-test-run"));
    assert.match(request.fields.extra, /run_id: zlf-test-run/);
  } finally {
    if (originalRunId === undefined) delete process.env.review_results_RUN_ID;
    else process.env.review_results_RUN_ID = originalRunId;
  }
});

test("runGuardedBulkWritebackMutation dry-run does not call writer", async () => {
  let writerCalls = 0;
  const result = await runGuardedBulkWritebackMutation({
    operations: [{ action: "add_items_to_collection", collectionKey: "POOL", itemKeys: ["K1"] }],
    writer: async () => { writerCalls++; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.writer_called, false);
  assert.equal(result.planned_operation_count, 1);
  assert.equal(result.write_success_count, 0);
  assert.equal(writerCalls, 0);
});

test("buildWritebackDedupeContext skips full collection scan for CLI backend", async () => {
  const originalBackend = process.env.ZOTERO_BACKEND;
  const originalApiKey = process.env.ZOTERO_API_KEY;
  try {
    process.env.ZOTERO_BACKEND = "cli";
    delete process.env.ZOTERO_API_KEY;
    const calls = [];
    const context = await buildWritebackDedupeContext({
      indexPath: "workflow/tests/fixtures/missing-zotero-index.json",
      root: { key: "POOL" },
      trashKey: "TRASH",
      worthy: { key: "WORTHY" },
      mcpToolCall: async (name) => {
        calls.push(name);
        if (name === "get_collection_items") throw new Error("full scan should be skipped");
        return { content: [{ text: "[]" }] };
      },
    });

    assert.equal(context.localIndexStats.full_collection_scan_skipped, true);
    assert.equal(context.poolIndex.meta.size, 0);
    assert.equal(context.skipBackendExactDedupe, false);
    assert.equal(calls.includes("get_collection_items"), false);
  } finally {
    if (originalBackend === undefined) delete process.env.ZOTERO_BACKEND;
    else process.env.ZOTERO_BACKEND = originalBackend;
    if (originalApiKey === undefined) delete process.env.ZOTERO_API_KEY;
    else process.env.ZOTERO_API_KEY = originalApiKey;
  }
});

test("buildWritebackDedupeContext skips collection scans for Web API unless reconciliation is explicit", async () => {
  const previousBackend = process.env.ZOTERO_BACKEND;
  const previousReconcile = process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS;
  process.env.ZOTERO_BACKEND = "web_api";
  delete process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS;
  try {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-web-dedup-"));
    const indexPath = path.join(tempDir, "current_library_index.json");
    await writeZoteroLibraryIndex(indexPath, {
      coverage: { zotero: { complete: true, scope: "test_fixture" } },
      live_items: {
        K1: { itemKey: "K1", title: "Indexed item", collection_roles: ["grade"] },
      },
      tombstones: {},
    });
    const context = await buildWritebackDedupeContext({
      indexPath,
      root: { key: "ROOT" },
      trashKey: "TRASH",
      worthy: { key: "WORTHY" },
      mcpToolCall: async (name) => {
        if (name === "get_collection_items") throw new Error("normal dedupe must not scan collections");
        return { content: [{ text: "[]" }] };
      },
    });
    assert.equal(context.localIndexStats.full_collection_scan_skipped, true);
    assert.equal(context.localIndexStats.backend_exact_dedupe_skipped, true);
  } finally {
    if (previousBackend === undefined) delete process.env.ZOTERO_BACKEND;
    else process.env.ZOTERO_BACKEND = previousBackend;
    if (previousReconcile === undefined) delete process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS;
    else process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS = previousReconcile;
  }
});

test("buildWritebackDedupeContext keeps collection scans behind explicit reconciliation", async () => {
  const previous = process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS;
  process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS = "true";
  let collectionScans = 0;
  try {
    const context = await buildWritebackDedupeContext({
      indexPath: "workflow/tests/fixtures/missing-zotero-index.json",
      root: { key: "POOL" },
      trashKey: "TRASH",
      worthy: { key: "WORTHY" },
      mcpToolCall: async (name) => {
        if (name === "get_collection_items") collectionScans++;
        return { content: [{ text: "[]" }] };
      },
    });
    assert.equal(context.localIndexStats.full_collection_scan_skipped, false);
    assert.equal(collectionScans, 3);
  } finally {
    if (previous === undefined) delete process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS;
    else process.env.ZOTERO_DEDUP_RECONCILE_COLLECTIONS = previous;
  }
});

test("verifyCachedDuplicateMatch rejects stale cached local-index matches", async () => {
  const result = await verifyCachedDuplicateMatch(
    { title: "Deleted cached paper", doi: "10.0000/example.024" },
    { itemKey: "STALE1", type: "doi", fromCache: true },
    {
      idBase: 1,
      mcpToolCall: async () => {
        throw new Error("Item not found: STALE1");
      },
    },
  );

  assert.equal(result, false);
});

test("buildPoolIndex reads collection items and details through contract methods before compat fallback", async () => {
  const calls = [];
  const cacheStats = { fingerprint_cache_hit_count: 0, fingerprint_cache_miss_count: 0, live_get_item_details_count: 0 };
  const mcpToolCall = async (name, args) => {
    calls.push({ name, args });
    throw new Error(`unexpected Zotero call: ${name}`);
  };

  const index = await buildPoolIndex("POOL", {
    mcpToolCall,
    zoteroBackend: {
      async getCollectionItems(collectionKey, options) {
        calls.push({ name: "getCollectionItems", collectionKey, options });
        return [{ key: "OLD1" }];
      },
      async getItems(keys, options) {
        calls.push({ name: "getItems", keys, options });
        return keys.map((itemKey) => ({ key: itemKey, itemKey, data: { key: itemKey, title: "Indexed paper", DOI: "10.0000/example.014" } }));
      },
    },
    cacheStats,
  });

  assert.equal(index.byDoi.get("10.0000/example.014"), "OLD1");
  assert.deepEqual(calls.map((call) => call.name), ["getCollectionItems", "getItems"]);
  assert.equal(calls[0].options.stage, "stage2_collection_items");
  assert.equal(calls[1].options.stage, "stage2_duplicate_index");
  assert.equal(cacheStats.live_get_item_details_count, 1);
});

test("buildCollectionDuplicateIndex falls back to compat get_item_details", async () => {
  const calls = [];
  const result = await buildCollectionDuplicateIndex({
    collectionKey: "TRASH",
    collectionName: "待删除",
    collectionRole: "trash",
    idBase: 535000,
    mcpToolCall: async (name, args) => {
      calls.push({ name, args });
      if (name === "get_collection_items") return { content: [{ text: JSON.stringify([{ key: "OLD1" }]) }] };
      if (name === "get_item_details") return { content: [{ text: JSON.stringify({ key: args.itemKey, data: { key: args.itemKey, title: "Trash paper", DOI: "10.0000/example.025" } }) }] };
      throw new Error(`unexpected Zotero call: ${name}`);
    },
  });

  assert.equal(result.itemCount, 1);
  assert.equal(result.index.byDoi.get("10.0000/example.025"), "OLD1");
  assert.deepEqual(calls.map((call) => call.name), ["get_collection_items", "get_item_details"]);
});

test("buildPoolIndex skips failed contract item reads without changing duplicate index shape", async () => {
  const calls = [];
  const index = await buildPoolIndex("POOL", {
    mcpToolCall: async (name) => {
      calls.push({ name });
      if (name === "get_collection_items") return { content: [{ text: JSON.stringify([{ key: "OLD1" }]) }] };
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    zoteroBackend: {
      async getItems(keys) {
        calls.push({ name: "getItems", keys });
        return { items: [], failed: [{ itemKey: "OLD1", error: "not_found" }] };
      },
    },
  });

  assert.equal(index.byDoi.size, 0);
  assert.equal(index.byPmid.size, 0);
  assert.equal(index.byPmcid.size, 0);
  assert.equal(index.byArxiv.size, 0);
  assert.equal(index.byTitle.size, 0);
  assert.equal(index.meta.size, 0);
  assert.deepEqual(calls.map((call) => call.name), ["get_collection_items", "getItems"]);
});

test("buildPoolIndex surfaces contract collection listing failures", async () => {
  await assert.rejects(
    () => buildPoolIndex("POOL", {
      mcpToolCall: async (name) => {
        throw new Error(`unexpected Zotero call: ${name}`);
      },
      zoteroBackend: {
        async getCollectionItems() {
          return { items: [], failed: [{ collectionKey: "POOL", error: "missing_collection" }] };
        },
      },
    }),
    /get_collection_items_failed:missing_collection/,
  );
});

test("buildWritebackDedupeContext uses local Zotero index as duplicate source for CLI backend", async () => {
  const originalBackend = process.env.ZOTERO_BACKEND;
  const originalApiKey = process.env.ZOTERO_API_KEY;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zotero-local-index-"));
  const indexPath = path.join(dir, "current_library_index.json");
  try {
    process.env.ZOTERO_BACKEND = "cli";
    delete process.env.ZOTERO_API_KEY;
    await writeZoteroLibraryIndex(indexPath, {
      schema_version: 1,
      coverage: { zotero: { complete: true, scope: "test_fixture" } },
      live_items: {
        P1: {
          itemKey: "P1",
          title: "Pool indexed item",
          doi: "10.0000/example.020",
          collections: [{ key: "POOL", name: "文献池" }],
          collection_roles: ["pool"],
        },
        T1: {
          itemKey: "T1",
          title: "Trash indexed item",
          doi: "10.0000/example.025",
          collections: [{ key: "TRASH", name: "待删除" }],
          collection_roles: ["trash"],
        },
        W1: {
          itemKey: "W1",
          title: "Worthy indexed item",
          doi: "10.0000/example.026",
          collections: [{ key: "WORTHY", name: "值得精读" }],
          collection_roles: ["worthy"],
        },
        S1: {
          itemKey: "S1",
          title: "Source grade indexed item",
          doi: "10.0000/example.023",
          collections: [
            { key: "SRC", name: "RSS订阅" },
            { key: "GRADE", name: "B专题相关" },
          ],
          collection_roles: ["source", "grade"],
        },
      },
      tombstones: {},
    });

    const calls = [];
    const context = await buildWritebackDedupeContext({
      indexPath,
      root: { key: "POOL" },
      trashKey: "TRASH",
      worthy: { key: "WORTHY" },
      mcpToolCall: async (name) => {
        calls.push(name);
        throw new Error(`unexpected Zotero call: ${name}`);
      },
    });

    assert.equal(context.localIndexStats.local_zotero_index_used, true);
    assert.equal(context.localIndexStats.local_index_direct_duplicate_index_used, true);
    assert.equal(context.skipBackendExactDedupe, true);
    assert.equal(context.poolIndex.byDoi.get("10.0000/example.020"), "P1");
    assert.equal(context.poolIndex.byDoi.get("10.0000/example.023"), "S1");
    assert.equal(context.trashIndex.byDoi.get("10.0000/example.025"), "T1");
    assert.equal(context.worthyIndex.byDoi.get("10.0000/example.026"), "W1");
    assert.equal(Object.keys(context.currentLiveItems).length, 4);
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
    if (originalBackend === undefined) delete process.env.ZOTERO_BACKEND;
    else process.env.ZOTERO_BACKEND = originalBackend;
    if (originalApiKey === undefined) delete process.env.ZOTERO_API_KEY;
    else process.env.ZOTERO_API_KEY = originalApiKey;
  }
});

test("runWritebackExecution skips backend exact dedupe when local index is trusted", async () => {
  const calls = [];
  const item = { title: "Brand new cached-flow item", doi: "10.0000/example.018", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const currentLiveItems = {};
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const writebackItems = [];

  await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems,
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    mcpToolCall: async (name) => {
      calls.push(name);
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => "NEW1",
    skipBackendExactDedupe: true,
  });

  assert.equal(counters.created, 1);
  assert.equal(writebackItems[0].itemKey, "NEW1");
  assert.equal(writebackItems[0].pool_collection_key, "");
  assert.equal(writebackItems[0].root_pool_attach_skipped, true);
  assert.deepEqual(item._target_collections, [
    { key: "SRC", name: "RSS订阅" },
    { key: "GRADE", name: "A课题相关" },
  ]);
  assert.deepEqual(currentLiveItems.NEW1.collection_roles, ["source", "grade"]);
  assert.deepEqual(currentLiveItems.NEW1.collections.map((collection) => collection.key), ["SRC", "GRADE"]);
  assert.deepEqual(calls, []);
});

test("runWritebackExecution batch-verifies cached duplicate matches", async () => {
  const calls = [];
  const item = { title: "Existing cached-flow item", doi: "10.0000/example.012", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = {
    byDoi: new Map([["10.0000/example.012", "OLD1"]]),
    byPmid: new Map(),
    byPmcid: new Map(),
    byArxiv: new Map(),
    byTitle: new Map(),
    meta: new Map([["OLD1", { title: "Existing cached-flow item", fromCache: true }]]),
  };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const writebackItems = [];
  const result = await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    mcpToolCall: async (name, args) => {
      calls.push(name);
      if (name === "get_items_details") {
        return { content: [{ text: JSON.stringify(args.itemKeys.map((itemKey) => ({ key: itemKey, itemKey, data: { key: itemKey, title: "Existing cached-flow item", DOI: "10.0000/example.012" } }))) }] };
      }
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => {
      throw new Error("create should be skipped for verified duplicate");
    },
    skipBackendExactDedupe: true,
  });

  assert.equal(counters.created, 0);
  assert.equal(counters.skipped_duplicate_in_pool, 1);
  assert.equal(writebackItems.length, 0);
  assert.equal(result.duplicateVerificationStats.duplicate_verification_batch_request_count, 1);
  assert.equal(result.duplicateVerificationStats.duplicate_verification_batch_item_count, 1);
  assert.deepEqual(calls, ["get_items_details"]);
});

test("runWritebackExecution batch-verifies cached duplicate matches through contract getItems", async () => {
  const calls = [];
  const item = { title: "Existing cached-flow item", doi: "10.0000/example.012", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = {
    byDoi: new Map([["10.0000/example.012", "OLD1"]]),
    byPmid: new Map(),
    byPmcid: new Map(),
    byArxiv: new Map(),
    byTitle: new Map(),
    meta: new Map([["OLD1", { title: "Existing cached-flow item", fromCache: true }]]),
  };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };

  const result = await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems: [],
    zoteroBackend: {
      async getItems(keys, options) {
        calls.push({ name: "getItems", keys, options });
        return keys.map((itemKey) => ({ key: itemKey, itemKey, data: { key: itemKey, title: "Existing cached-flow item", DOI: "10.0000/example.012" } }));
      },
    },
    mcpToolCall: async (name) => {
      calls.push({ name });
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => {
      throw new Error("create should be skipped for verified duplicate");
    },
    skipBackendExactDedupe: true,
  });

  assert.equal(counters.created, 0);
  assert.equal(counters.skipped_duplicate_in_pool, 1);
  assert.equal(result.duplicateVerificationStats.duplicate_verification_batch_request_count, 1);
  assert.equal(result.duplicateVerificationStats.duplicate_verification_batch_item_count, 1);
  assert.deepEqual(calls.map((call) => call.name), ["getItems"]);
  assert.deepEqual(calls[0].keys, ["OLD1"]);
  assert.equal(calls[0].options.mode, "preview");
  assert.equal(calls[0].options.stage, "stage2_duplicate_verification");
});

test("runWritebackExecution falls back to compat get_items_details when contract getItems is absent", async () => {
  const calls = [];
  const item = { title: "Existing cached-flow item", doi: "10.0000/example.012", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = {
    byDoi: new Map([["10.0000/example.012", "OLD1"]]),
    byPmid: new Map(),
    byPmcid: new Map(),
    byArxiv: new Map(),
    byTitle: new Map(),
    meta: new Map([["OLD1", { title: "Existing cached-flow item", fromCache: true }]]),
  };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };

  await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems: [],
    mcpToolCall: async (name, args) => {
      calls.push({ name, args });
      if (name === "get_items_details") {
        return { content: [{ text: JSON.stringify(args.itemKeys.map((itemKey) => ({ key: itemKey, itemKey, data: { key: itemKey, title: "Existing cached-flow item", DOI: "10.0000/example.012" } }))) }] };
      }
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => {
      throw new Error("create should be skipped for verified duplicate");
    },
    skipBackendExactDedupe: true,
  });

  assert.equal(counters.skipped_duplicate_in_pool, 1);
  assert.deepEqual(calls.map((call) => call.name), ["get_items_details"]);
  assert.deepEqual(calls[0].args.itemKeys, ["OLD1"]);
});

test("runWritebackExecution treats contract getItems partial failures as unverified cached duplicates", async () => {
  const calls = [];
  const item = { title: "Missing cached-flow item", doi: "10.0000/example.017", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = {
    byDoi: new Map([["10.0000/example.017", "OLD1"]]),
    byPmid: new Map(),
    byPmcid: new Map(),
    byArxiv: new Map(),
    byTitle: new Map(),
    meta: new Map([["OLD1", { title: "Missing cached-flow item", fromCache: true }]]),
  };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const writebackItems = [];

  const result = await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    zoteroBackend: {
      async getItems(keys) {
        calls.push({ name: "getItems", keys });
        return { items: [], failed: [{ itemKey: "OLD1", error: "not_found" }] };
      },
    },
    mcpToolCall: async (name) => {
      calls.push({ name });
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => "NEW1",
    skipBackendExactDedupe: true,
  });

  assert.equal(counters.skipped_duplicate_in_pool, 0);
  assert.equal(counters.created, 1);
  assert.equal(writebackItems[0].itemKey, "NEW1");
  assert.equal(result.duplicateVerificationStats.duplicate_verification_batch_request_count, 1);
  assert.equal(result.duplicateVerificationStats.duplicate_verification_batch_fallback_count, 0);
  assert.deepEqual(calls.map((call) => call.name), ["getItems"]);
});

test("runWritebackExecution exact dedupe searches through backend wrapper before compat fallback", async () => {
  const calls = [];
  const item = { title: "Existing exact item", doi: "10.0000/example.010", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const writebackItems = [];

  await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    zoteroBackend: {
      async searchLibrary(options) {
        calls.push({ name: "searchLibrary", options });
        return [{ key: "OLD1", DOI: "10.0000/example.010", title: "Existing exact item" }];
      },
    },
    mcpToolCall: async (name) => {
      calls.push({ name });
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => {
      throw new Error("create should be skipped for exact dedupe hit");
    },
    skipBackendExactDedupe: false,
  });

  assert.equal(counters.failed, 0);
  assert.equal(counters.created, 1);
  assert.equal(writebackItems[0].itemKey, "OLD1");
  assert.deepEqual(calls.map((call) => call.name), ["searchLibrary"]);
  assert.deepEqual(calls[0].options, { q: "10.0000/example.010", limit: 8, mode: "preview", relevanceScoring: true, stage: "stage2_exact_dedupe" });
});

test("runWritebackExecution exact dedupe falls back to compat search_library", async () => {
  const calls = [];
  const item = { title: "Existing exact item", doi: "10.0000/example.010", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const writebackItems = [];

  await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    mcpToolCall: async (name, args) => {
      calls.push({ name, args });
      if (name === "search_library") return { content: [{ text: JSON.stringify([{ key: "OLD1", DOI: "10.0000/example.010", title: "Existing exact item" }]) }] };
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => {
      throw new Error("create should be skipped for exact dedupe hit");
    },
    skipBackendExactDedupe: false,
  });

  assert.equal(counters.failed, 0);
  assert.equal(counters.created, 1);
  assert.equal(writebackItems[0].itemKey, "OLD1");
  assert.deepEqual(calls.map((call) => call.name), ["search_library"]);
  assert.deepEqual(calls[0].args, { q: "10.0000/example.010", limit: 8, mode: "preview", relevanceScoring: true });
});

test("runWritebackExecution exact dedupe surfaces backend search partial failure", async () => {
  const calls = [];
  const item = { title: "Read failure exact item", doi: "10.0000/example.021", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const failures = [];
  const writebackItems = [];

  await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures,
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    zoteroBackend: {
      async searchLibrary(options) {
        calls.push({ name: "searchLibrary", options });
        return { items: [], failed: [{ error: "backend_read_failed" }] };
      },
    },
    mcpToolCall: async (name) => {
      calls.push({ name });
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => {
      throw new Error("create should not run after exact dedupe read failure");
    },
    skipBackendExactDedupe: false,
  });

  assert.equal(counters.created, 0);
  assert.equal(counters.failed, 1);
  assert.equal(writebackItems.length, 0);
  assert.match(failures[0].error, /search_library_failed:backend_read_failed/);
  assert.deepEqual(calls.map((call) => call.name), ["searchLibrary"]);
});

test("runWritebackExecution exact dedupe surfaces backend search read errors", async () => {
  const calls = [];
  const item = { title: "Thrown read failure exact item", doi: "10.0000/example.022", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const failures = [];

  await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures,
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems: [],
    zoteroBackend: {
      async searchLibrary(options) {
        calls.push({ name: "searchLibrary", options });
        throw new Error("backend_search_unavailable");
      },
    },
    mcpToolCall: async (name) => {
      calls.push({ name });
      throw new Error(`unexpected Zotero call: ${name}`);
    },
    createItem: async () => {
      throw new Error("create should not run after exact dedupe read error");
    },
    skipBackendExactDedupe: false,
  });

  assert.equal(counters.created, 0);
  assert.equal(counters.failed, 1);
  assert.match(failures[0].error, /backend_search_unavailable/);
  assert.deepEqual(calls.map((call) => call.name), ["searchLibrary"]);
});

test("runWritebackExecution recovers temporary CLI item keys through contract collection item read", async () => {
  const calls = [];
  const item = { title: "Recovered CLI Key Paper Long Title", doi: "10.0000/example.008", grade: "A", final_grade: "A", source_channel: "rss" };
  const poolIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 1,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const writebackItems = [];
  const mcpToolCall = async (name) => {
    calls.push({ name });
    throw new Error(`unexpected Zotero call: ${name}`);
  };
  mcpToolCall.adapter = {
    async getCollectionItems(collectionKey, options) {
      calls.push({ name: "getCollectionItems", collectionKey, options });
      return [{ key: "REAL1", title: "Recovered CLI Key Paper Long Title" }];
    },
  };

  await runWritebackExecution({
    items: [item],
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC" },
    gradeKeys: { "A课题相关": "GRADE" },
    sourceCollections: { rss: "RSS订阅" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    mcpToolCall,
    createItem: async () => "cli-temp-key",
    skipBackendExactDedupe: true,
  });

  assert.equal(counters.created, 1);
  assert.equal(writebackItems[0].itemKey, "REAL1");
  assert.deepEqual(calls.map((call) => call.name), ["getCollectionItems"]);
  assert.equal(calls[0].collectionKey, "GRADE");
  assert.equal(calls[0].options.stage, "stage2_create_key_recovery");
});

test("runWritebackExecution batches new item creation through backend contract createItems", async () => {
  const calls = [];
  const items = [
    { title: "Batch create one", doi: "10.0000/example.006", grade: "A", final_grade: "A", source_channel: "rss" },
    { title: "Batch create two", doi: "10.0000/example.007", grade: "B", final_grade: "B", source_channel: "database" },
  ];
  const poolIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const trashIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const worthyIndex = { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byTitle: new Map(), meta: new Map() };
  const counters = {
    total: 2,
    created: 0,
    failed: 0,
    by_source: { rss: 0, database: 0, other: 0 },
    by_grade: { "A课题相关": 0, "B专题相关": 0, "C领域相关": 0, other: 0 },
    reused_existing: 0,
    skipped_historical_duplicate: 0,
    skipped_duplicate_in_pool: 0,
    skipped_duplicate_in_trash: 0,
    skipped_duplicate_in_deleted_trash_index: 0,
    skipped_duplicate_in_worthy: 0,
  };
  const writebackItems = [];
  const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
  const createItem = createStage2ItemWriter({
    zoteroBackend: {
      async createItems(itemsData) {
        calls.push({ name: "createItems", itemsData });
        return {
          created: itemsData.map((item) => ({ inputIndex: item.inputIndex, key: `K${item.inputIndex}`, itemKey: `K${item.inputIndex}` })),
          failed: [],
        };
      },
    },
    zoteroBackendCall: async (name, args) => {
      calls.push({ name, args });
      if (name === "write_items") {
        return {
          content: [{
            text: JSON.stringify({
              created: args.items.map((item) => ({ inputIndex: item.inputIndex, key: `K${item.inputIndex}`, itemKey: `K${item.inputIndex}` })),
              failed: [],
            }),
          }],
        };
      }
      throw new Error(`unexpected Zotero call: ${name}`);
    },
  });

  const result = await runWritebackExecution({
    items,
    root: { key: "POOL" },
    sourceKeys: { "RSS订阅": "SRC", "数据库检索": "DB" },
    gradeKeys: { "A课题相关": "GA", "B专题相关": "GB" },
    sourceCollections: { rss: "RSS订阅", database: "数据库检索" },
    poolIndex,
    trashIndex,
    worthyIndex,
    currentLiveItems: {},
    counters,
    failures: [],
    localIndexStats: { skipped_duplicate_in_deleted_trash_index: 0 },
    skippedDuplicatesInPool: [],
    skippedDuplicatesInTrash: [],
    duplicateRecords: [],
    writebackItems,
    mcpToolCall: async () => {
      throw new Error("unexpected mcpToolCall");
    },
    createItem,
    skipBackendExactDedupe: true,
  });

  assert.equal(counters.created, 2);
  assert.equal(counters.failed, 0);
  assert.deepEqual(writebackItems.map((item) => item.itemKey), ["K0", "K1"]);
  assert.equal(calls.filter((call) => call.name === "createItems").length, 1);
  assert.equal(calls.filter((call) => call.name === "write_items").length, 0);
  assert.equal(calls.some((call) => call.name === "write_item"), false);
  assert.equal(result.batchCreateStats.batch_create_request_count, 1);
  assert.equal(result.batchCreateStats.batch_create_item_count, 2);
  assert.equal(result.batchCreateStats.batch_create_success_count, 2);
});

test("createStage2ItemWriter surfaces backend contract createItems partial failures", async () => {
  const persisted = [];
  const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
  const createItem = createStage2ItemWriter({
    zoteroBackend: {
      async createItems(itemsData) {
        return {
          created: [{ inputIndex: itemsData[0].inputIndex, key: "K0", itemKey: "K0" }],
          failed: [{ inputIndex: itemsData[1].inputIndex, error: "contract_partial_failure" }],
        };
      },
    },
    onCreatedKeys: async (keys) => { persisted.push(...keys); },
  });

  const results = await Promise.allSettled([
    createItem({ title: "Partial one", grade: "A", final_grade: "A", source_channel: "rss" }, 0),
    createItem({ title: "Partial two", grade: "A", final_grade: "A", source_channel: "rss" }, 1),
  ]);

  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[0].value, "K0");
  assert.equal(results[1].status, "rejected");
  assert.match(results[1].reason.message, /contract_partial_failure/);
  assert.equal(createItem.batchCreateStats.batch_create_success_count, 1);
  assert.equal(createItem.batchCreateStats.batch_create_failed_count, 1);
  assert.deepEqual(persisted, ["K0"]);
});

test("serial write_item persists the exact compat key before the next create or attach", async () => {
  const previous = process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED;
  const events = [];
  try {
    process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED = "1";
    const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
    const createItem = createStage2ItemWriter({
      zoteroBackendCall: async (name, _args, id) => {
        events.push(`create:${id}`);
        return { content: [{ text: JSON.stringify({ ok: true, data: { itemKey: `DESK${id}` } }) }] };
      },
      onCreatedKeys: async (keys) => { events.push(`persist:${keys[0]}`); },
    });

    const first = await createItem({ title: "Serial one", grade: "A", final_grade: "A", source_channel: "rss" }, 0);
    const second = await createItem({ title: "Serial two", grade: "A", final_grade: "A", source_channel: "rss" }, 1);
    await runCollectionAttachStep({
      writebackItems: [
        { itemKey: first, source_collection_key: "SRC", grade_collection_key: "GRADE" },
        { itemKey: second, source_collection_key: "SRC", grade_collection_key: "GRADE" },
      ],
      rootKey: "ROOT",
      collectionGuard: { checkCollectionKey: () => ({ ok: true }) },
      zoteroBackend: { addItemsToCollections: async () => { events.push("attach"); return { added: [], already: [], failed: [] }; } },
    });

    assert.deepEqual(events, ["create:10000", "persist:DESK10000", "create:10003", "persist:DESK10003", "attach"]);
  } finally {
    if (previous === undefined) delete process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED;
    else process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED = previous;
  }
});

test("serial write_item without an exact key stops later writes and attach", async () => {
  const previous = process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED;
  let createCalls = 0;
  let attachCalls = 0;
  try {
    process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED = "1";
    const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
    const createItem = createStage2ItemWriter({
      zoteroBackendCall: async () => {
        createCalls += 1;
        return { content: [{ text: JSON.stringify({ ok: true, data: {} }) }] };
      },
      onCreatedKeys: async () => { throw new Error("must_not_persist_missing_key"); },
    });

    await assert.rejects(() => createItem({ title: "Missing key", grade: "A", final_grade: "A", source_channel: "rss" }, 0), /stage2_create_item_key_missing/);
    await assert.rejects(() => createItem({ title: "Later write", grade: "A", final_grade: "A", source_channel: "rss" }, 1), /stage2_create_item_key_missing/);
    await runCollectionAttachStep({
      writebackItems: [],
      rootKey: "ROOT",
      collectionGuard: { checkCollectionKey: () => ({ ok: true }) },
      zoteroBackend: { addItemsToCollections: async () => { attachCalls += 1; return { added: [], already: [], failed: [] }; } },
    });
    assert.equal(createCalls, 1);
    assert.equal(attachCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED;
    else process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED = previous;
  }
});

test("serial recovery persistence failure stops later writes and attach", async () => {
  const previous = process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED;
  let createCalls = 0;
  let attachCalls = 0;
  try {
    process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED = "1";
    const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
    const createItem = createStage2ItemWriter({
      zoteroBackendCall: async () => {
        createCalls += 1;
        return { content: [{ text: JSON.stringify({ itemKey: "DESK1" }) }] };
      },
      onCreatedKeys: async () => { throw new Error("recovery_disk_failed"); },
    });

    await assert.rejects(() => createItem({ title: "Persist failure", grade: "A", final_grade: "A", source_channel: "rss" }, 0), /stage2_recovery_persistence_failed/);
    await assert.rejects(() => createItem({ title: "Later write", grade: "A", final_grade: "A", source_channel: "rss" }, 1), /stage2_recovery_persistence_failed/);
    await runCollectionAttachStep({
      writebackItems: [],
      rootKey: "ROOT",
      collectionGuard: { checkCollectionKey: () => ({ ok: true }) },
      zoteroBackend: { addItemsToCollections: async () => { attachCalls += 1; return { added: [], already: [], failed: [] }; } },
    });
    assert.equal(createCalls, 1);
    assert.equal(attachCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED;
    else process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED = previous;
  }
});

test("createStage2ItemWriter persists exact batch keys before resolving item creation", async () => {
  const persisted = [];
  const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
  const createItem = createStage2ItemWriter({
    zoteroBackend: {
      async createItems(itemsData) {
        return { created: itemsData.map((item) => ({ inputIndex: item.inputIndex, itemKey: `K${item.inputIndex}` })), failed: [] };
      },
    },
    onCreatedKeys: async (keys) => { persisted.push([...keys]); },
  });
  const created = await Promise.all([
    createItem({ title: "Persist one", grade: "A", final_grade: "A", source_channel: "rss" }, 0),
    createItem({ title: "Persist two", grade: "A", final_grade: "A", source_channel: "rss" }, 1),
  ]);
  assert.deepEqual(persisted, [["K0", "K1"]]);
  assert.deepEqual(created, ["K0", "K1"]);
});

test("createStage2ItemWriter stops later batch creates after recovery persistence fails", async () => {
  let createCalls = 0;
  const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
  const createItem = createStage2ItemWriter({
    zoteroBackend: {
      async createItems(itemsData) {
        createCalls += 1;
        return { created: itemsData.map((item) => ({ inputIndex: item.inputIndex, itemKey: `K${item.inputIndex}` })), failed: [] };
      },
    },
    onCreatedKeys: async () => { throw new Error("recovery_disk_failed"); },
  });
  const results = await Promise.allSettled(Array.from({ length: 51 }, (_, index) =>
    createItem({ title: `Persist failure ${index}`, grade: "A", final_grade: "A", source_channel: "rss" }, index),
  ));
  assert.equal(createCalls, 1);
  assert.equal(results.every((result) => result.status === "rejected"), true);
  assert.match(createItem.recoveryError.message, /stage2_recovery_persistence_failed/);
});

test("createStage2ItemWriter falls back to write_item when write_items fails", async () => {
  const calls = [];
  const { createStage2ItemWriter } = await import("../tools/stage2/writeback_execution.mjs");
  const createItem = createStage2ItemWriter({
    zoteroBackendCall: async (name, args) => {
      calls.push({ name, args });
      if (name === "write_items") throw Object.assign(new Error("batch unavailable"), { definitelyFailedWithoutSideEffect: true });
      if (name === "write_item") {
        return { content: [{ text: JSON.stringify({ itemKey: `ONE${calls.filter((call) => call.name === "write_item").length}` }) }] };
      }
      throw new Error(`unexpected Zotero call: ${name}`);
    },
  });

  const results = await Promise.all([
    createItem({ title: "Fallback one", grade: "A", final_grade: "A", source_channel: "rss" }, 0),
    createItem({ title: "Fallback two", grade: "A", final_grade: "A", source_channel: "rss" }, 1),
  ]);

  assert.deepEqual(results, ["ONE1", "ONE2"]);
  assert.equal(calls.filter((call) => call.name === "write_items").length, 1);
  assert.equal(calls.filter((call) => call.name === "write_item").length, 2);
  assert.equal(createItem.batchCreateStats.batch_create_fallback_count, 2);
});

test("runCollectionAttachStep sends source and grade memberships in one multi-collection batch", async () => {
  const calls = [];
  const result = await runCollectionAttachStep({
    writebackItems: [
      { itemKey: "K1", source_collection_key: "SRC", grade_collection_key: "GRADE_B", pool_collection_key: "" },
      { itemKey: "K2", source_collection_key: "SRC", grade_collection_key: "GRADE_C", pool_collection_key: "" },
    ],
    rootKey: "POOL",
    attachBatchSize: 50,
    collectionGuard: { checkCollectionKey: () => ({ ok: true }) },
    zoteroBackend: {
      async addItemsToCollections(operations, options) {
        calls.push({ tool: "addItemsToCollections", operations, options });
        return { added: [], already: [], failed: [] };
      },
    },
    zoteroBackendCall: async (tool, args, id) => {
      calls.push({ tool, args, id });
      return { content: [{ text: JSON.stringify({ added: [], already: [], failed: [] }) }] };
    },
  });

  assert.equal(result.attachStats.collection_attach_mode, "multi_collection_batch");
  assert.equal(result.attachStats.collection_attach_calls, 1);
  assert.equal(result.attachStats.fallback_to_per_item_count, 0);
  assert.deepEqual(calls.map((call) => call.tool), ["addItemsToCollections"]);
  assert.deepEqual(calls[0].operations.map((op) => op.collectionKey), ["SRC", "GRADE_B", "GRADE_C"]);
  assert.equal(calls[0].operations.some((op) => op.collectionKey === "POOL"), false);
});

test("runCollectionAttachStep falls back to compat add_items_to_collections when contract method is absent", async () => {
  const calls = [];
  const result = await runCollectionAttachStep({
    writebackItems: [
      { itemKey: "K1", source_collection_key: "SRC", grade_collection_key: "GRADE", pool_collection_key: "" },
    ],
    rootKey: "POOL",
    attachBatchSize: 50,
    collectionGuard: { checkCollectionKey: () => ({ ok: true }) },
    zoteroBackendCall: async (tool, args, id) => {
      calls.push({ tool, args, id });
      return { content: [{ text: JSON.stringify({ added: [], already: [], failed: [] }) }] };
    },
  });

  assert.equal(result.attachStats.collection_attach_calls, 1);
  assert.deepEqual(calls.map((call) => call.tool), ["add_items_to_collections"]);
  assert.deepEqual(calls[0].args.operations.map((op) => op.collectionKey), ["SRC", "GRADE"]);
  assert.equal(calls[0].args.operations.some((op) => op.collectionKey === "POOL"), false);
});

test("runCollectionAttachStep reports contract addItemsToCollections partial failures", async () => {
  const result = await runCollectionAttachStep({
    writebackItems: [
      { itemKey: "K1", source_collection_key: "SRC", grade_collection_key: "GRADE", pool_collection_key: "" },
    ],
    rootKey: "POOL",
    attachBatchSize: 50,
    collectionGuard: { checkCollectionKey: () => ({ ok: true }) },
    zoteroBackend: {
      async addItemsToCollections() {
        return { added: [], already: [], failed: [{ collectionKey: "GRADE", itemKey: "K1", error: "contract_attach_failed" }] };
      },
    },
  });

  assert.equal(result.attachStats.collection_attach_calls, 1);
  assert.equal(result.attachStats.collection_attach_failures.length, 1);
  assert.equal(result.attachStats.collection_attach_failures[0].collectionKey, "GRADE");
  assert.deepEqual(result.attachStats.collection_attach_failures[0].itemKeys, ["K1"]);
  assert.match(result.attachStats.collection_attach_failures[0].error, /contract_attach_failed/);
});

test("runGuardedBulkWritebackMutation writes only when apply and guard pass", async () => {
  const calls = [];
  const operation = { action: "write_tag", itemKey: "K1", tags: ["research-os"] };
  const result = await runGuardedBulkWritebackMutation({
    operations: [operation],
    apply: true,
    dryRun: false,
    guardCheck: { ok: true },
    writer: async (op) => calls.push(op),
  });

  assert.equal(result.ok, true);
  assert.equal(result.apply, true);
  assert.equal(result.write_success_count, 1);
  assert.equal(result.write_failure_count, 0);
  assert.deepEqual(calls, [operation]);
});

test("runGuardedBulkWritebackMutation blocks writer when guard fails", async () => {
  let writerCalls = 0;
  const result = await runGuardedBulkWritebackMutation({
    operations: [{ action: "add_items_to_collection", collectionKey: "OTHER", itemKeys: ["K1"] }],
    apply: true,
    dryRun: false,
    guardCheck: { ok: false, reason: "collection_out_of_allowed_scope" },
    writer: async () => { writerCalls++; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.guard_blocked_count, 1);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_failure_count, 1);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
  assert.match(result.write_failures[0].error, /collection_out_of_allowed_scope/);
});

test("runGuardedBulkWritebackMutation reports partial writer failure", async () => {
  const result = await runGuardedBulkWritebackMutation({
    operations: [
      { action: "write_tag", itemKey: "K1" },
      { action: "write_tag", itemKey: "K2" },
    ],
    apply: true,
    dryRun: false,
    guardCheck: { ok: true },
    writer: async (op) => {
      if (op.itemKey === "K2") throw new Error("mock write_tag failed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 1);
  assert.equal(result.write_failure_count, 1);
  assert.equal(result.writer_called, true);
  assert.equal(result.write_failures[0].operation.action, "write_tag");
  assert.match(result.write_failures[0].error, /mock write_tag failed/);
});

test("addItemToWorthyCollectionWithGuard dry-run does not call MCP writer", async () => {
  let writerCalls = 0;
  const result = await addItemToWorthyCollectionWithGuard({
    itemKey: "K1",
    worthyKey: "WORTHY",
    apply: false,
    dryRun: true,
    mcpToolCall: async () => { writerCalls++; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
});

test("addItemToWorthyCollectionWithGuard applies add_items_to_collection when guard passes", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args, id) => calls.push({ tool, args, id });
  mcpToolCall.adapter = {};
  const result = await addItemToWorthyCollectionWithGuard({
    itemKey: "K1",
    worthyKey: "WORTHY",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall,
    id: 700123,
  });

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 1);
  assert.deepEqual(calls, [{
    tool: "add_items_to_collection",
    args: { collectionKey: "WORTHY", itemKeys: ["K1"] },
    id: 700123,
  }]);
});

test("addItemToWorthyCollectionWithGuard prefers contract addItemsToCollections when available", async () => {
  const contractCalls = [];
  const mcpCalls = [];
  const mcpToolCall = async (tool, args, id) => mcpCalls.push({ tool, args, id });
  mcpToolCall.adapter = {
    async addItemsToCollections(operations, options) {
      contractCalls.push({ operations, options });
      return { added: [{ itemKey: "K1", collectionKey: "WORTHY" }], failed: [] };
    },
  };

  const result = await addItemToWorthyCollectionWithGuard({
    itemKey: "K1",
    worthyKey: "WORTHY",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall,
    id: 700123,
  });

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 1);
  assert.deepEqual(contractCalls, [{
    operations: [{ collectionKey: "WORTHY", itemKeys: ["K1"], role: "worthy_target", phase: "add_to_worthy" }],
    options: { verify: false, stage: "stage2_worthy_migration_add", id: 700123 },
  }]);
  assert.deepEqual(mcpCalls, []);
});

test("addItemToWorthyCollectionWithGuard surfaces contract partial and missing failures", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async addItemsToCollections() {
      return {
        added: [{ itemKey: "K1", collectionKey: "WORTHY" }],
        missing: [{ itemKey: "K2", collectionKey: "WORTHY", error: "item_missing" }],
        failed: [{ itemKey: "K3", collectionKey: "WORTHY", error: "add_failed" }],
      };
    },
  };

  const result = await addItemToWorthyCollectionWithGuard({
    itemKey: "K1",
    worthyKey: "WORTHY",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall,
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 1);
  assert.equal(result.write_failure_count, 2);
  assert.equal(result.write_failures[0].missing, true);
  assert.match(result.write_failures[1].error, /add_failed/);
});

test("addItemToWorthyCollectionWithGuard reports contract backend errors without fallback", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async addItemsToCollections() {
      throw new Error("contract_add_down");
    },
  };

  const result = await addItemToWorthyCollectionWithGuard({
    itemKey: "K1",
    worthyKey: "WORTHY",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall,
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_failure_count, 1);
  assert.match(result.write_failures[0].error, /contract_add_down/);
});

test("addItemToWorthyCollectionWithGuard blocks writer when collection guard fails", async () => {
  let writerCalls = 0;
  const collectionScopeBlocks = [];
  const result = await addItemToWorthyCollectionWithGuard({
    itemKey: "K1",
    worthyKey: "OTHER",
    apply: true,
    dryRun: false,
    collectionScopeBlocks,
    collectionGuard: {
      checkCollectionKey: () => ({
        ok: false,
        reason: "collection_out_of_allowed_scope",
        collectionKey: "OTHER",
      }),
    },
    mcpToolCall: async () => { writerCalls++; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.guard_blocked_count, 1);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
  assert.equal(collectionScopeBlocks.length, 1);
  assert.match(result.write_failures[0].error, /collection_out_of_allowed_scope/);
});

test("addItemToWorthyCollectionWithGuard reports writer failure", async () => {
  const result = await addItemToWorthyCollectionWithGuard({
    itemKey: "K1",
    worthyKey: "WORTHY",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall: async () => {
      throw new Error("mock add_items_to_collection failed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_failure_count, 1);
  assert.equal(result.writer_called, true);
  assert.match(result.write_failures[0].error, /mock add_items_to_collection failed/);
});

test("writeTagSetWithGuard dry-run does not call MCP writer", async () => {
  let writerCalls = 0;
  const result = await writeTagSetWithGuard({
    itemKey: "K1",
    tags: ["kept"],
    apply: false,
    dryRun: true,
    mcpToolCall: async () => { writerCalls++; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
});

test("writeTagSetWithGuard applies write_tag set when guard passes", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args, id) => calls.push({ tool, args, id });
  mcpToolCall.adapter = {};
  const result = await writeTagSetWithGuard({
    itemKey: "K1",
    tags: ["kept"],
    apply: true,
    dryRun: false,
    guardCheck: { ok: true },
    id: 650123,
    mcpToolCall,
  });

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 1);
  assert.deepEqual(calls, [{
    tool: "write_tag",
    args: { action: "set", itemKey: "K1", tags: ["kept"] },
    id: 650123,
  }]);
});

test("writeTagSetWithGuard blocks writer when guard fails", async () => {
  let writerCalls = 0;
  const result = await writeTagSetWithGuard({
    itemKey: "K1",
    tags: ["kept"],
    apply: true,
    dryRun: false,
    guardCheck: { ok: false, reason: "tag_cleanup_guard_blocked" },
    mcpToolCall: async () => { writerCalls++; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.guard_blocked_count, 1);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
  assert.match(result.write_failures[0].error, /tag_cleanup_guard_blocked/);
});

test("writeTagSetWithGuard reports writer failure", async () => {
  const result = await writeTagSetWithGuard({
    itemKey: "K1",
    tags: ["kept"],
    apply: true,
    dryRun: false,
    guardCheck: { ok: true },
    mcpToolCall: async () => {
      throw new Error("mock write_tag failed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_failure_count, 1);
  assert.equal(result.writer_called, true);
  assert.match(result.write_failures[0].error, /mock write_tag failed/);
});

test("cleanupSignatureTags uses guarded tag writer and preserves stats fields", async () => {
  const calls = [];
  const readCalls = [];
  const mcpToolCall = async (tool, args) => {
    if (tool === "get_subcollections") return { content: [{ text: "[]" }] };
    if (tool === "write_tag") {
      calls.push({ tool, args });
      return { content: [{ text: "{}" }] };
    }
    throw new Error(`unexpected MCP tool ${tool}`);
  };
  mcpToolCall.adapter = {
    async getCollectionItems(collectionKey, options) {
      readCalls.push({ name: "getCollectionItems", collectionKey, options });
      return [{ key: "K1" }];
    },
    async getItems(keys, options) {
      readCalls.push({ name: "getItems", keys, options });
      return keys.map((itemKey) => ({ key: itemKey, itemKey, data: { tags: [{ tag: "doi:10.1/bad" }, { tag: "kept" }] } }));
    },
  };

  const stats = await cleanupSignatureTags("ROOT", "WORTHY", {
    now: new Date("2026-06-30T00:00:00Z"),
    mcpToolCall,
    writeTagSet: (operation) => writeTagSetWithGuard({ ...operation, mcpToolCall, apply: true, dryRun: false }),
  });

  assert.equal(stats.scanned, 1);
  assert.equal(stats.cleaned_items, 1);
  assert.equal(stats.removed_tag_count, 1);
  assert.deepEqual(stats.failures, []);
  assert.deepEqual(readCalls.map((call) => call.name), ["getCollectionItems", "getItems"]);
  assert.equal(readCalls[0].options.stage, "stage2_collection_items");
  assert.equal(readCalls[1].options.stage, "stage2_tag_cleanup");
  assert.deepEqual(calls, [{
    tool: "write_tag",
    args: { action: "set", itemKey: "K1", tags: ["kept"] },
  }]);
});

test("writeTagSetWithGuard prefers contract writeTagsBatch when available", async () => {
  const contractCalls = [];
  const mcpCalls = [];
  const mcpToolCall = async (tool, args, id) => mcpCalls.push({ tool, args, id });
  mcpToolCall.adapter = {
    async writeTagsBatch(operations, options) {
      contractCalls.push({ operations, options });
      return { applied: [{ itemKey: "K1" }], failed: [] };
    },
  };

  const result = await writeTagSetWithGuard({
    itemKey: "K1",
    tags: ["kept"],
    apply: true,
    dryRun: false,
    guardCheck: { ok: true },
    id: 650123,
    mcpToolCall,
  });

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 1);
  assert.deepEqual(contractCalls, [{
    operations: [{ action: "set", itemKey: "K1", tags: ["kept"] }],
    options: { stage: "stage2_tag_cleanup", id: 650123 },
  }]);
  assert.deepEqual(mcpCalls, []);
});

test("writeTagSetWithGuard surfaces contract writeTagsBatch partial and missing failures", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async writeTagsBatch() {
      return {
        applied: [{ itemKey: "K1" }],
        missing: [{ itemKey: "K2", error: "item_missing" }],
        failed: [{ itemKey: "K3", error: "write_failed" }],
      };
    },
  };

  const result = await writeTagSetWithGuard({
    itemKey: "K1",
    tags: ["kept"],
    apply: true,
    dryRun: false,
    guardCheck: { ok: true },
    mcpToolCall,
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 1);
  assert.equal(result.write_failure_count, 2);
  assert.equal(result.write_failures[0].missing, true);
  assert.match(result.write_failures[1].error, /write_failed/);
});

test("writeTagSetWithGuard reports contract writeTagsBatch backend errors without fallback", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async writeTagsBatch() {
      throw new Error("contract_backend_down");
    },
  };

  const result = await writeTagSetWithGuard({
    itemKey: "K1",
    tags: ["kept"],
    apply: true,
    dryRun: false,
    guardCheck: { ok: true },
    mcpToolCall,
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_failure_count, 1);
  assert.match(result.write_failures[0].error, /contract_backend_down/);
});

test("cleanupSignatureTags falls back to compat get_item_details when contract getItems is absent", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "get_subcollections") return { content: [{ text: "[]" }] };
    if (tool === "get_collection_items") return { content: [{ text: JSON.stringify([{ key: "K1" }]) }] };
    if (tool === "get_item_details") return { content: [{ text: JSON.stringify({ data: { tags: [{ tag: "doi:10.1/bad" }, { tag: "kept" }] } }) }] };
    if (tool === "write_tag") return { content: [{ text: "{}" }] };
    throw new Error(`unexpected MCP tool ${tool}`);
  };

  const stats = await cleanupSignatureTags("ROOT", "WORTHY", {
    now: new Date("2026-06-30T00:00:00Z"),
    fullScan: true,
    mcpToolCall,
  });

  assert.equal(stats.cleaned_items, 1);
  assert.equal(stats.historical_fallback_used, true);
  assert.deepEqual(calls.map((call) => call.tool), ["get_subcollections", "get_collection_items", "get_item_details", "write_tag"]);
});

test("cleanupSignatureTags reads subcollection tree through contract getSubcollections when available", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "get_collection_items" && args.collectionKey === "SRC") return { content: [{ text: JSON.stringify([{ key: "K1" }]) }] };
    if (tool === "get_collection_items") return { content: [{ text: "[]" }] };
    if (tool === "get_item_details") return { content: [{ text: JSON.stringify({ data: { tags: [{ tag: "doi:10.1/bad" }, { tag: "kept" }] } }) }] };
    if (tool === "write_tag") return { content: [{ text: "{}" }] };
    throw new Error(`unexpected MCP tool ${tool}`);
  };
  mcpToolCall.adapter = {
    async getSubcollections(collectionKey, recursive) {
      calls.push({ tool: "getSubcollections", collectionKey, recursive });
      return [{
        key: "DAY",
        name: "2026-06-30",
        subcollections: [{ key: "SRC", name: "RSS订阅" }],
      }];
    },
  };

  const stats = await cleanupSignatureTags("ROOT", "WORTHY", {
    now: new Date("2026-06-30T00:00:00Z"),
    mcpToolCall,
  });

  assert.equal(stats.cleaned_items, 1);
  assert.equal(calls.some((call) => call.tool === "get_subcollections"), false);
  assert.deepEqual(calls[0], { tool: "getSubcollections", collectionKey: "ROOT", recursive: true });
});

test("readSubcollections falls back to compat get_subcollections when contract method is absent", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args, id) => {
    calls.push({ tool, args, id });
    if (tool === "get_subcollections") {
      return { content: [{ text: JSON.stringify([{ key: "DAY", name: "2026-06-30", subcollections: [] }]) }] };
    }
    throw new Error(`unexpected MCP tool ${tool}`);
  };
  mcpToolCall.adapter = {};

  const tree = await readSubcollections("ROOT", { mcpToolCall, recursive: true, id: 660000, stage: "test_tree" });

  assert.deepEqual(tree, [{ key: "DAY", name: "2026-06-30", subcollections: [] }]);
  assert.deepEqual(calls, [{
    tool: "get_subcollections",
    args: { collectionKey: "ROOT", recursive: true },
    id: 660000,
  }]);
});

test("readSubcollections surfaces contract backend errors without compat fallback", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async getSubcollections() {
      throw new Error("contract_tree_down");
    },
  };

  await assert.rejects(
    () => readSubcollections("ROOT", { mcpToolCall, recursive: true, id: 660000, stage: "test_tree" }),
    /get_subcollections_failed:contract_tree_down/,
  );
});

test("readSubcollections surfaces contract missing results", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async getSubcollections() {
      return { items: [], missing: [{ collectionKey: "ROOT", error: "missing_collection" }] };
    },
  };

  await assert.rejects(
    () => readSubcollections("ROOT", { mcpToolCall, recursive: true, id: 660000, stage: "test_tree" }),
    /get_subcollections_failed:missing_collection/,
  );
});

test("cleanupSignatureTags uses local index for item keys and tags when available", async () => {
  const calls = [];
  const localLibraryIndex = {
    live_items: {
      K1: {
        itemKey: "K1",
        title: "Tagged item",
        tags: [{ tag: "doi:10.1/bad" }, { tag: "kept" }],
        collections: [{ key: "GRADE", name: "A课题相关", path: "文献池/26.06/06.30/A课题相关" }],
        collection_roles: ["grade"],
      },
    },
  };
  const mcpToolCall = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "write_tag") return { content: [{ text: "{}" }] };
    throw new Error(`unexpected MCP tool ${tool}`);
  };

  const stats = await cleanupSignatureTags("ROOT", "WORTHY", {
    now: new Date("2026-06-30T00:00:00Z"),
    localLibraryIndex,
    mcpToolCall,
    writeTagSet: (operation) => writeTagSetWithGuard({ ...operation, mcpToolCall, apply: true, dryRun: false }),
  });

  assert.equal(stats.local_zotero_index_used, true);
  assert.equal(stats.local_tag_detail_hit_count, 1);
  assert.equal(stats.live_get_item_details_count, 0);
  assert.equal(stats.cleaned_items, 1);
  assert.deepEqual(calls, [{
    tool: "write_tag",
    args: { action: "set", itemKey: "K1", tags: ["kept"] },
  }]);
});

test("cleanupSignatureTags fast path checks only current and known-signature candidates and is idempotent", async () => {
  const writes = [];
  const localLibraryIndex = {
    live_items: {
      KOLD_BAD: {
        itemKey: "KOLD_BAD",
        tags: [{ tag: "pmid:123" }, { tag: "keep-old" }],
        collections: [{ key: "GRADE", name: "A课题相关", path: "文献池/26.06/06.30/A课题相关" }],
      },
      KOLD_CLEAN: {
        itemKey: "KOLD_CLEAN",
        tags: [{ tag: "keep-clean" }],
        collections: [{ key: "GRADE", name: "A课题相关", path: "文献池/26.06/06.30/A课题相关" }],
      },
      KOLD_EMPTY: {
        itemKey: "KOLD_EMPTY",
        tags: [],
        collections: [{ key: "GRADE", name: "A课题相关", path: "文献池/26.06/06.30/A课题相关" }],
      },
      KOUTSIDE: {
        itemKey: "KOUTSIDE",
        tags: [{ tag: "doi:10.1/outside" }],
        collections: [{ key: "GRADE", name: "A课题相关", path: "文献池/26.05/05.01/A课题相关" }],
      },
    },
  };
  const candidateItems = [{ itemKey: "KNEW", tags: [{ tag: "url:https://bad" }, { tag: "keep-new" }] }];
  const writeTagSet = async (operation) => {
    writes.push(operation);
    return { ok: true };
  };
  const noExternalReads = async (tool) => { throw new Error(`unexpected external read ${tool}`); };

  const first = await cleanupSignatureTags("ROOT", "WORTHY", {
    now: new Date("2026-06-30T00:00:00Z"),
    localLibraryIndex,
    candidateItems,
    fullScan: false,
    mcpToolCall: noExternalReads,
    writeTagSet,
  });

  assert.equal(first.scanned, 2);
  assert.equal(first.live_get_item_details_count, 0);
  assert.equal(first.cleaned_items, 2);
  assert.equal(first.removed_tag_count, 2);
  assert.equal(first.skipped_non_candidate_count, 2);
  assert.deepEqual(writes.map(({ itemKey, tags }) => ({ itemKey, tags })), [
    { itemKey: "KNEW", tags: ["keep-new"] },
    { itemKey: "KOLD_BAD", tags: ["keep-old"] },
  ]);

  writes.length = 0;
  localLibraryIndex.live_items.KOLD_BAD.tags = [{ tag: "keep-old" }];
  candidateItems[0].tags = [{ tag: "keep-new" }];
  const second = await cleanupSignatureTags("ROOT", "WORTHY", {
    now: new Date("2026-06-30T00:00:00Z"),
    localLibraryIndex,
    candidateItems,
    fullScan: false,
    mcpToolCall: noExternalReads,
    writeTagSet,
  });

  assert.equal(second.scanned, 1);
  assert.equal(second.cleaned_items, 0);
  assert.equal(second.live_get_item_details_count, 0);
  assert.deepEqual(writes, []);
});

test("removeItemFromCollectionWithGuard dry-run does not call MCP writer", async () => {
  let writerCalls = 0;
  const result = await removeItemFromCollectionWithGuard({
    itemKey: "K1",
    collectionKey: "ROOT",
    role: "root_pool",
    phase: "remove_from_root_pool",
    apply: false,
    dryRun: true,
    mcpToolCall: async () => { writerCalls++; },
  });

  assert.equal(result.ok, true);
  assert.equal(result.dry_run, true);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
});

test("removeItemFromCollectionWithGuard applies remove_items_from_collection when guard passes", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args, id) => calls.push({ tool, args, id });
  mcpToolCall.adapter = {};
  const result = await removeItemFromCollectionWithGuard({
    itemKey: "K1",
    collectionKey: "ROOT",
    role: "root_pool",
    phase: "remove_from_root_pool",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    id: 720123,
    mcpToolCall,
  });

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 1);
  assert.deepEqual(calls, [{
    tool: "remove_items_from_collection",
    args: { collectionKey: "ROOT", itemKeys: ["K1"] },
    id: 720123,
  }]);
});

test("removeItemFromCollectionWithGuard prefers contract removeItemsFromCollections when available", async () => {
  const contractCalls = [];
  const mcpCalls = [];
  const mcpToolCall = async (tool, args, id) => mcpCalls.push({ tool, args, id });
  mcpToolCall.adapter = {
    async removeItemsFromCollections(operations, options) {
      contractCalls.push({ operations, options });
      return { applied: [{ itemKey: "K1", collectionKey: "ROOT" }], failed: [] };
    },
  };

  const result = await removeItemFromCollectionWithGuard({
    itemKey: "K1",
    collectionKey: "ROOT",
    role: "root_pool",
    phase: "remove_from_root_pool",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    id: 720123,
    mcpToolCall,
  });

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 1);
  assert.deepEqual(contractCalls, [{
    operations: [{ collectionKey: "ROOT", itemKeys: ["K1"], role: "root_pool", phase: "remove_from_root_pool" }],
    options: { stage: "remove_from_root_pool", id: 720123 },
  }]);
  assert.deepEqual(mcpCalls, []);
});

test("removeItemFromCollectionWithGuard surfaces contract removeItemsFromCollections partial and missing failures", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async removeItemsFromCollections() {
      return {
        applied: [{ itemKey: "K1", collectionKey: "ROOT" }],
        missing: [{ itemKey: "K2", collectionKey: "ROOT", error: "item_missing" }],
        failed: [{ itemKey: "K3", collectionKey: "ROOT", error: "remove_failed" }],
      };
    },
  };

  const result = await removeItemFromCollectionWithGuard({
    itemKey: "K1",
    collectionKey: "ROOT",
    role: "root_pool",
    phase: "remove_from_root_pool",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall,
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 1);
  assert.equal(result.write_failure_count, 2);
  assert.equal(result.write_failures[0].missing, true);
  assert.match(result.write_failures[1].error, /remove_failed/);
});

test("removeItemFromCollectionWithGuard reports contract removeItemsFromCollections backend errors without fallback", async () => {
  const mcpToolCall = async () => {
    throw new Error("compat_should_not_be_called");
  };
  mcpToolCall.adapter = {
    async removeItemsFromCollections() {
      throw new Error("contract_remove_down");
    },
  };

  const result = await removeItemFromCollectionWithGuard({
    itemKey: "K1",
    collectionKey: "ROOT",
    role: "root_pool",
    phase: "remove_from_root_pool",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall,
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_failure_count, 1);
  assert.match(result.write_failures[0].error, /contract_remove_down/);
});

test("removeItemFromCollectionWithGuard blocks writer when collection guard fails", async () => {
  let writerCalls = 0;
  const collectionScopeBlocks = [];
  const result = await removeItemFromCollectionWithGuard({
    itemKey: "K1",
    collectionKey: "OTHER",
    role: "root_pool",
    phase: "remove_from_root_pool",
    apply: true,
    dryRun: false,
    collectionScopeBlocks,
    collectionGuard: {
      checkCollectionKey: () => ({
        ok: false,
        reason: "collection_out_of_allowed_scope",
        collectionKey: "OTHER",
      }),
    },
    mcpToolCall: async () => { writerCalls++; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.guard_blocked_count, 1);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
  assert.equal(collectionScopeBlocks.length, 1);
  assert.match(result.write_failures[0].error, /collection_out_of_allowed_scope/);
});

test("removeItemFromCollectionWithGuard reports writer failure", async () => {
  const result = await removeItemFromCollectionWithGuard({
    itemKey: "K1",
    collectionKey: "ROOT",
    role: "root_pool",
    phase: "remove_from_root_pool",
    apply: true,
    dryRun: false,
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    mcpToolCall: async () => {
      throw new Error("mock remove_items_from_collection failed");
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_failure_count, 1);
  assert.equal(result.writer_called, true);
  assert.match(result.write_failures[0].error, /mock remove_items_from_collection failed/);
});

test("migrateRatedItems uses guarded root pool removal and preserves migration stats", async () => {
  const calls = [];
  const readCalls = [];
  const mcpToolCall = async (tool, args) => {
    if (tool === "get_subcollections") {
      return { content: [{ text: JSON.stringify([{
        name: "2026-06-30",
        key: "DAY",
        subcollections: [
          { name: "RSS订阅", key: "SRC" },
          { name: "A课题相关", key: "GRADE" },
        ],
      }]) }] };
    }
    if (tool === "add_items_to_collection" || tool === "remove_items_from_collection") {
      calls.push({ tool, args });
      return { content: [{ text: "{}" }] };
    }
    throw new Error(`unexpected MCP tool ${tool}`);
  };
  mcpToolCall.adapter = {
    async getCollectionItems(collectionKey, options) {
      readCalls.push({ name: "getCollectionItems", collectionKey, options });
      if (collectionKey === "GRADE") return [{ key: "K1" }];
      return [];
    },
    async getItems(keys, options) {
      readCalls.push({ name: "getItems", keys, options });
      return keys.map((itemKey) => ({ key: itemKey, itemKey, data: { key: itemKey, title: "Starred item", tags: [{ tag: "⭐⭐⭐⭐⭐" }] } }));
    },
  };

  const stats = await migrateRatedItems({
    rootKey: "ROOT",
    worthyKey: "WORTHY",
    now: new Date("2026-06-30T00:00:00Z"),
    mcpToolCall,
    starMigrationConfig: { enabled: true, mode: "legacy", expandAllGrades: false, windowDays: 7, starThreshold: 4 },
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    collectionScopeBlocks: [],
  });

  assert.equal(stats.removed_from_root_pool, 1);
  assert.equal(stats.removed_from_source_collections, 1);
  assert.equal(stats.removed_from_grade_collections, 1);
  assert.deepEqual(stats.removal_failures, []);
  assert.deepEqual(readCalls.map((call) => call.name), ["getCollectionItems", "getCollectionItems", "getItems"]);
  assert.deepEqual(readCalls.filter((call) => call.name === "getCollectionItems").map((call) => call.collectionKey), ["WORTHY", "GRADE"]);
  assert.equal(readCalls[0].options.stage, "stage2_collection_items");
  assert.equal(readCalls[2].options.stage, "stage2_star_migration");
  assert.deepEqual(calls.filter((call) => call.tool === "remove_items_from_collection").at(-1), {
    tool: "remove_items_from_collection",
    args: { collectionKey: "ROOT", itemKeys: ["K1"] },
  });
});

test("migrateRatedItems can use local index for starred candidate discovery", async () => {
  const calls = [];
  const localLibraryIndex = {
    live_items: {
      K1: {
        itemKey: "K1",
        title: "Local starred item",
        tags: [{ tag: "⭐⭐⭐⭐⭐" }],
        collections: [
          { key: "ROOT", name: "文献池", path: "文献池" },
          { key: "SRC", name: "RSS订阅", path: "文献池/26.06/06.30/RSS订阅" },
          { key: "GRADE", name: "A课题相关", path: "文献池/26.06/06.30/A课题相关" },
        ],
        collection_roles: ["pool", "source", "grade"],
      },
    },
  };
  const mcpToolCall = async (tool, args) => {
    if (tool === "add_items_to_collection" || tool === "remove_items_from_collection") {
      calls.push({ tool, args });
      return { content: [{ text: "{}" }] };
    }
    throw new Error(`unexpected MCP tool ${tool}`);
  };
  const stats = await migrateRatedItems({
    rootKey: "ROOT",
    worthyKey: "WORTHY",
    now: new Date("2026-06-30T00:00:00Z"),
    mcpToolCall,
    localLibraryIndex,
    starMigrationConfig: { enabled: true, mode: "legacy", expandAllGrades: false, windowDays: 7, starThreshold: 4 },
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    collectionScopeBlocks: [],
  });

  assert.equal(stats.local_zotero_index_used, true);
  assert.equal(stats.eligible_items, 1);
  assert.equal(stats.moved_to_worthy, 1);
  assert.deepEqual(calls.map((call) => call.tool), [
    "add_items_to_collection",
    "remove_items_from_collection",
    "remove_items_from_collection",
    "remove_items_from_collection",
  ]);
});

test("migrateRatedItems routes day source removal failure through guarded mutation without changing grade removal", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args) => {
    if (tool === "get_subcollections") {
      return { content: [{ text: JSON.stringify([{
        name: "2026-06-30",
        key: "DAY",
        subcollections: [
          { name: "RSS订阅", key: "SRC" },
          { name: "A课题相关", key: "GRADE" },
        ],
      }]) }] };
    }
    if (tool === "get_collection_items" && args.collectionKey === "WORTHY") return { content: [{ text: "[]" }] };
    if (tool === "get_collection_items" && args.collectionKey === "GRADE") return { content: [{ text: JSON.stringify([{ key: "K1" }]) }] };
    if (tool === "get_collection_items") return { content: [{ text: "[]" }] };
    if (tool === "get_item_details") {
      return { content: [{ text: JSON.stringify({ data: { key: "K1", title: "Starred item", tags: [{ tag: "⭐⭐⭐⭐⭐" }] } }) }] };
    }
    if (tool === "add_items_to_collection") {
      calls.push({ tool, args });
      return { content: [{ text: "{}" }] };
    }
    if (tool === "remove_items_from_collection") {
      calls.push({ tool, args });
      if (args.collectionKey === "SRC") throw new Error("mock source removal failed");
      return { content: [{ text: "{}" }] };
    }
    throw new Error(`unexpected MCP tool ${tool}`);
  };

  const stats = await migrateRatedItems({
    rootKey: "ROOT",
    worthyKey: "WORTHY",
    now: new Date("2026-06-30T00:00:00Z"),
    mcpToolCall,
    starMigrationConfig: { enabled: true, mode: "legacy", expandAllGrades: false, windowDays: 7, starThreshold: 4 },
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    collectionScopeBlocks: [],
  });

  assert.equal(stats.removed_from_source_collections, 0);
  assert.equal(stats.removed_from_grade_collections, 1);
  assert.equal(stats.removed_from_root_pool, 1);
  assert.equal(stats.removal_failures.length, 1);
  assert.equal(stats.removal_failures[0].phase, "remove_from_day_collections");
  assert.equal(stats.removal_failures[0].operation.role, "source");
  assert.deepEqual(calls.filter((call) => call.tool === "remove_items_from_collection").map((call) => call.args.collectionKey), ["SRC", "GRADE", "ROOT"]);
});

test("migrateRatedItems routes grade removal failure through guarded mutation without changing source or root removal", async () => {
  const calls = [];
  const mcpToolCall = async (tool, args) => {
    if (tool === "get_subcollections") {
      return { content: [{ text: JSON.stringify([{
        name: "2026-06-30",
        key: "DAY",
        subcollections: [
          { name: "RSS订阅", key: "SRC" },
          { name: "A课题相关", key: "GRADE" },
        ],
      }]) }] };
    }
    if (tool === "get_collection_items" && args.collectionKey === "WORTHY") return { content: [{ text: "[]" }] };
    if (tool === "get_collection_items" && args.collectionKey === "GRADE") return { content: [{ text: JSON.stringify([{ key: "K1" }]) }] };
    if (tool === "get_collection_items") return { content: [{ text: "[]" }] };
    if (tool === "get_item_details") {
      return { content: [{ text: JSON.stringify({ data: { key: "K1", title: "Starred item", tags: [{ tag: "⭐⭐⭐⭐⭐" }] } }) }] };
    }
    if (tool === "add_items_to_collection") {
      calls.push({ tool, args });
      return { content: [{ text: "{}" }] };
    }
    if (tool === "remove_items_from_collection") {
      calls.push({ tool, args });
      if (args.collectionKey === "GRADE") throw new Error("mock grade removal failed");
      return { content: [{ text: "{}" }] };
    }
    throw new Error(`unexpected MCP tool ${tool}`);
  };

  const stats = await migrateRatedItems({
    rootKey: "ROOT",
    worthyKey: "WORTHY",
    now: new Date("2026-06-30T00:00:00Z"),
    mcpToolCall,
    starMigrationConfig: { enabled: true, mode: "legacy", expandAllGrades: false, windowDays: 7, starThreshold: 4 },
    collectionGuard: {
      checkCollectionKey: () => ({ ok: true }),
    },
    collectionScopeBlocks: [],
  });

  assert.equal(stats.removed_from_source_collections, 1);
  assert.equal(stats.removed_from_grade_collections, 0);
  assert.equal(stats.removed_from_root_pool, 1);
  assert.equal(stats.removal_failures.length, 1);
  assert.equal(stats.removal_failures[0].phase, "remove_from_day_collections");
  assert.equal(stats.removal_failures[0].operation.role, "grade");
  assert.deepEqual(calls.filter((call) => call.tool === "remove_items_from_collection").map((call) => call.args.collectionKey), ["SRC", "GRADE", "ROOT"]);
});

test("migrateRatedItems blocks grade removal through guarded mutation while preserving source and root removal", async () => {
  const calls = [];
  const collectionScopeBlocks = [];
  const mcpToolCall = async (tool, args) => {
    if (tool === "get_subcollections") {
      return { content: [{ text: JSON.stringify([{
        name: "2026-06-30",
        key: "DAY",
        subcollections: [
          { name: "RSS订阅", key: "SRC" },
          { name: "A课题相关", key: "GRADE" },
        ],
      }]) }] };
    }
    if (tool === "get_collection_items" && args.collectionKey === "WORTHY") return { content: [{ text: "[]" }] };
    if (tool === "get_collection_items" && args.collectionKey === "GRADE") return { content: [{ text: JSON.stringify([{ key: "K1" }]) }] };
    if (tool === "get_collection_items") return { content: [{ text: "[]" }] };
    if (tool === "get_item_details") {
      return { content: [{ text: JSON.stringify({ data: { key: "K1", title: "Starred item", tags: [{ tag: "⭐⭐⭐⭐⭐" }] } }) }] };
    }
    if (tool === "add_items_to_collection" || tool === "remove_items_from_collection") {
      calls.push({ tool, args });
      return { content: [{ text: "{}" }] };
    }
    throw new Error(`unexpected MCP tool ${tool}`);
  };

  const stats = await migrateRatedItems({
    rootKey: "ROOT",
    worthyKey: "WORTHY",
    now: new Date("2026-06-30T00:00:00Z"),
    mcpToolCall,
    starMigrationConfig: { enabled: true, mode: "legacy", expandAllGrades: false, windowDays: 7, starThreshold: 4 },
    collectionGuard: {
      checkCollectionKey: (collectionKey, context) => {
        if (collectionKey === "GRADE" && context.role === "grade") {
          return { ok: false, reason: "mock_grade_scope_blocked", collectionKey };
        }
        return { ok: true };
      },
    },
    collectionScopeBlocks,
  });

  assert.equal(stats.removed_from_source_collections, 1);
  assert.equal(stats.removed_from_grade_collections, 0);
  assert.equal(stats.removed_from_root_pool, 1);
  assert.equal(stats.removal_failures.length, 1);
  assert.equal(stats.removal_failures[0].operation.role, "grade");
  assert.equal(collectionScopeBlocks.length, 1);
  assert.deepEqual(calls.filter((call) => call.tool === "remove_items_from_collection").map((call) => call.args.collectionKey), ["SRC", "ROOT"]);
});
