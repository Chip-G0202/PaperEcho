import assert from "node:assert/strict";
import { test } from "node:test";

import { createStage3WriteMetadata, createStage3WriteMetadataBatch, createStage3WriteMetadataBatchTool } from "../tools/stage3/main.mjs";
import {
  backfillShortTitles,
  buildStage3TranslationSummary,
} from "../tools/stage3/translation_backfill_support.mjs";

function batchTranslator(titles) {
  return {
    map: new Map(titles.map((title) => [title, { ok: true, zh: `ZH ${title}` }])),
    usage: { cache_hits: 0, cache_misses: titles.length, api_items: titles.length, api_calls: titles.length },
  };
}

test("createStage3WriteMetadata defaults to dry-run and does not call writer", async () => {
  let writerCalls = 0;
  const writeMetadata = createStage3WriteMetadata({
    admittedMetadataItemKeys: new Set(["K1"]),
    writeMetadataTool: async () => { writerCalls++; },
  });

  const result = await writeMetadata("K1", { shortTitle: "ZH Title" });

  assert.equal(result.dry_run, true);
  assert.equal(result.apply, false);
  assert.equal(result.writer_called, false);
  assert.equal(writerCalls, 0);
});

test("createStage3WriteMetadata writes only when apply and admitted guard pass", async () => {
  const writes = [];
  const writeMetadata = createStage3WriteMetadata({
    admittedMetadataItemKeys: new Set(["K1"]),
    apply: true,
    dryRun: false,
    writeMetadataTool: async (itemKey, fields) => writes.push({ itemKey, fields }),
  });

  const result = await writeMetadata("K1", { shortTitle: "ZH Title" });

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 1);
  assert.deepEqual(writes, [{ itemKey: "K1", fields: { shortTitle: "ZH Title" } }]);
});

test("createStage3WriteMetadata blocks non-admitted itemKeys without calling writer", async () => {
  let writerCalls = 0;
  const metadataScopeBlocks = [];
  const writeMetadata = createStage3WriteMetadata({
    admittedMetadataItemKeys: new Set(["K1"]),
    metadataScopeBlocks,
    apply: true,
    dryRun: false,
    writeMetadataTool: async () => { writerCalls++; },
  });

  await assert.rejects(
    () => writeMetadata("K2", { shortTitle: "ZH Title" }),
    /collection_scope_blocked:write_metadata_item_not_admitted/,
  );
  assert.equal(writerCalls, 0);
  assert.equal(metadataScopeBlocks.length, 1);
  assert.equal(metadataScopeBlocks[0].itemKey, "K2");
});

test("translation backfill reports partial write_metadata failure without losing summary fields", async () => {
  const writeMetadata = createStage3WriteMetadata({
    admittedMetadataItemKeys: new Set(["K1", "K2"]),
    apply: true,
    dryRun: false,
    writeMetadataTool: async (itemKey) => {
      if (itemKey === "K2") throw new Error("write_metadata_failed:mock");
    },
  });
  const report = await backfillShortTitles({
    writeback_items: [
      { itemKey: "K1", title: "Title 1", grade: "A", backfill_short_title: true },
      { itemKey: "K2", title: "Title 2", grade: "B", backfill_short_title: true },
    ],
  }, {
    translateTitlesBatch: async (titles) => batchTranslator(titles),
    writeMetadata,
    metadataRetry: 0,
  });
  const summary = buildStage3TranslationSummary({
    report,
    translationConfig: { apiKeyConfigured: true },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
    dryRunBlocked: false,
  });

  assert.equal(report.total, 2);
  assert.equal(report.success_count, 1);
  assert.equal(report.failure_count, 1);
  assert.match(report.failures[0].reason, /write_metadata_failed:mock/);
  assert.equal(summary.zotero_updates_attempted_count, 2);
  assert.equal(summary.zotero_updates_succeeded_count, 1);
  assert.equal(summary.zotero_updates_failed_count, 1);
  assert.equal(summary.degraded, true);
});

test("createStage3WriteMetadataBatch writes admitted shortTitles in one call", async () => {
  const writes = [];
  const writeMetadataBatch = createStage3WriteMetadataBatch({
    admittedMetadataItemKeys: new Set(["K1", "K2"]),
    apply: true,
    dryRun: false,
    writeMetadataBatchTool: async (updates) => {
      writes.push(updates);
      return { updated: updates.map((update) => update.itemKey), failed: [] };
    },
  });

  const result = await writeMetadataBatch([
    { itemKey: "K1", fields: { shortTitle: "ZH 1" } },
    { itemKey: "K2", fields: { shortTitle: "ZH 2" } },
  ]);

  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 2);
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].map((update) => update.itemKey), ["K1", "K2"]);
});

test("createStage3WriteMetadataBatch acknowledges unchanged without counting it as modified", async () => {
  const writeMetadataBatch = createStage3WriteMetadataBatch({
    admittedMetadataItemKeys: new Set(["K1"]),
    apply: true,
    dryRun: false,
    writeMetadataBatchTool: async () => ({ updated: [], unchanged: ["K1"], failed: [] }),
  });
  const result = await writeMetadataBatch([{ itemKey: "K1", fields: { shortTitle: "same" } }]);
  assert.equal(result.ok, true);
  assert.equal(result.write_success_count, 0);
  assert.equal(result.write_unchanged_count, 1);
});

test("createStage3WriteMetadataBatchTool prefers contract writeMetadataBatch", async () => {
  const calls = [];
  const updates = [{ itemKey: "K1", fields: { shortTitle: "ZH 1" } }];
  const callZotero = async (tool) => {
    calls.push({ tool });
    throw new Error("legacy fallback should not be called");
  };
  callZotero.adapter = {
    writeMetadataBatch: async (batch, options) => {
      calls.push({ tool: "writeMetadataBatch", batch, options });
      return { updated: ["K1"], failed: [] };
    },
  };

  const result = await createStage3WriteMetadataBatchTool({ zoteroBackendCall: callZotero })(updates);

  assert.deepEqual(result, { updated: ["K1"], failed: [] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "writeMetadataBatch");
  assert.equal(calls[0].options.stage, "stage3_translation");
});

test("createStage3WriteMetadataBatchTool falls back to compat write_metadata_batch", async () => {
  const calls = [];
  const updates = [{ itemKey: "K1", fields: { shortTitle: "ZH 1" } }];
  const callZotero = async (tool, args) => {
    calls.push({ tool, args });
    return { content: [{ text: JSON.stringify({ updated: ["K1"], failed: [] }) }] };
  };

  const result = await createStage3WriteMetadataBatchTool({ zoteroBackendCall: callZotero })(updates);

  assert.deepEqual(result, { updated: ["K1"], failed: [] });
  assert.deepEqual(calls.map((call) => call.tool), ["write_metadata_batch"]);
});

test("createStage3WriteMetadataBatchTool preserves contract partial failures", async () => {
  const updates = [
    { itemKey: "K1", fields: { shortTitle: "ZH 1" } },
    { itemKey: "K2", fields: { shortTitle: "ZH 2" } },
  ];
  const writeMetadataBatchTool = createStage3WriteMetadataBatchTool({
    zoteroBackend: {
      writeMetadataBatch: async () => ({
        updated: ["K1"],
        failed: [{ itemKey: "K2", error: "write_metadata_failed:mock" }],
      }),
    },
  });

  const result = await writeMetadataBatchTool(updates);

  assert.deepEqual(result.updated, ["K1"]);
  assert.deepEqual(result.failed, [{ itemKey: "K2", error: "write_metadata_failed:mock" }]);
});

test("Stage3 batch guard preserves item-level updated, unchanged, and failed results", async () => {
  const writeMetadataBatch = createStage3WriteMetadataBatch({
    admittedMetadataItemKeys: new Set(["K1", "K2", "K3"]),
    apply: true,
    dryRun: false,
    writeMetadataBatchTool: async () => ({
      updated: ["K1"],
      unchanged: ["K2"],
      failed: [{ itemKey: "K3", error: "mock_failure" }],
    }),
  });
  await assert.rejects(
    () => writeMetadataBatch(["K1", "K2", "K3"].map((itemKey) => ({ itemKey, fields: { shortTitle: itemKey } }))),
    (error) => {
      assert.deepEqual(error.result.updated, ["K1"]);
      assert.deepEqual(error.result.unchanged, ["K2"]);
      assert.deepEqual(error.result.failed, [{ itemKey: "K3", error: "mock_failure" }]);
      return true;
    },
  );
});

test("Stage3 mutation stage normalizes its one legacy identifier and rejects unknown stages", async () => {
  const stages = [];
  const legacy = createStage3WriteMetadataBatchTool({
    stage: "stage3_translation_backfill",
    zoteroBackend: { async writeMetadataBatch(_updates, options) { stages.push(options.stage); return { updated: [], unchanged: [], failed: [] }; } },
  });
  await legacy([]);
  assert.deepEqual(stages, ["stage3_translation"]);
  assert.throws(() => createStage3WriteMetadataBatchTool({ stage: "stage2" }), /stage3_metadata_stage_invalid/);
});

test("backfillShortTitles uses batch metadata writer when available", async () => {
  const batchCalls = [];
  const report = await backfillShortTitles({
    writeback_items: [
      { itemKey: "K1", title: "Title 1", grade: "A", backfill_short_title: true },
      { itemKey: "K2", title: "Title 2", grade: "B", backfill_short_title: true },
    ],
  }, {
    translateTitlesBatch: async (titles) => batchTranslator(titles),
    writeMetadata: async () => { throw new Error("per-item writer should not be called"); },
    writeMetadataBatch: async (updates) => {
      batchCalls.push(updates);
      return {
        ok: true,
        write_success_count: updates.length,
        write_failure_count: 0,
        write_failures: [],
      };
    },
  });

  assert.equal(report.success_count, 2);
  assert.equal(report.failure_count, 0);
  assert.equal(batchCalls.length, 1);
  assert.equal(report.writeback.metadata_batch_update_calls, 1);
  assert.equal(report.writeback.metadata_batch_update_count, 2);
});

test("backfillShortTitles reports partial batch metadata failure", async () => {
  const report = await backfillShortTitles({
    writeback_items: [
      { itemKey: "K1", title: "Title 1", grade: "A", backfill_short_title: true },
      { itemKey: "K2", title: "Title 2", grade: "B", backfill_short_title: true },
    ],
  }, {
    translateTitlesBatch: async (titles) => batchTranslator(titles),
    writeMetadataBatch: async () => ({
      ok: false,
      write_success_count: 1,
      write_failure_count: 1,
      write_failures: [{ itemKey: "K2", error: "write_metadata_failed:mock" }],
    }),
  });

  assert.equal(report.success_count, 1);
  assert.equal(report.failure_count, 1);
  assert.equal(report.updated_items[0].itemKey, "K1");
  assert.match(report.failures[0].reason, /write_metadata_failed:mock/);
});
