import { it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { backfillShortTitles, buildStage3TranslationSummary } from "../tools/stage3/translation_backfill_support.mjs";
import { prepareStage3BackfillInput } from "../tools/stage3/translation_input_step.mjs";

it("separates translation and metadata write timing in backfill diagnostics", async () => {
  const summary = {
    writeback_items: [
      { itemKey: "K1", title: "Title 1", grade: "A", backfill_short_title: true },
      { itemKey: "K2", title: "Title 2", grade: "B", backfill_short_title: true },
    ],
  };
  const writes = [];

  const result = await backfillShortTitles(summary, {
    translateTitlesBatch: async (titles) => ({
      map: new Map(titles.map((title) => [title, { ok: true, zh: `中文 ${title}` }])),
      usage: {
        cache_hits: 0,
        cache_misses: titles.length,
        request_timing: {
          total_requests: titles.length,
          slowest_top5: titles.map((title, index) => ({ index: index + 1, title_hash: `h${index}`, duration_ms: 1 })),
        },
      },
    }),
    writeMetadata: async (itemKey, fields) => {
      writes.push([itemKey, fields.shortTitle]);
    },
  });

  assert.equal(result.success_count, 2);
  assert.equal(writes.length, 2);
  assert.ok(result.timings.translation_request_ms >= 0);
  assert.ok(result.timings.metadata_write_ms >= 0);
  assert.ok(result.timings.total_ms >= result.timings.translation_request_ms);
});

it("uses documented 14-day defaults for translation pool scan cadence", async () => {
  const previousInterval = process.env.ZOTERO_TRANSLATION_POOL_SCAN_INTERVAL_DAYS;
  const previousWindow = process.env.ZOTERO_TRANSLATION_POOL_SCAN_WINDOW_DAYS;
  delete process.env.ZOTERO_TRANSLATION_POOL_SCAN_INTERVAL_DAYS;
  delete process.env.ZOTERO_TRANSLATION_POOL_SCAN_WINDOW_DAYS;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zotero-stage3-defaults-"));
  try {
    const summaryPath = path.join(dir, "zotero_writeback_summary.json");
    const runtimeStatePath = path.join(dir, "runtime_state.json");
    await fs.writeFile(summaryPath, JSON.stringify({ writeback_items: [] }), "utf8");
    const result = await prepareStage3BackfillInput({
      summaryPath,
      runtimeStatePath,
      now: new Date("2026-07-07T00:00:00Z"),
    });
    assert.equal(result.poolScanIntervalDays, 14);
    assert.equal(result.poolScanWindowDays, 14);
  } finally {
    if (previousInterval === undefined) delete process.env.ZOTERO_TRANSLATION_POOL_SCAN_INTERVAL_DAYS;
    else process.env.ZOTERO_TRANSLATION_POOL_SCAN_INTERVAL_DAYS = previousInterval;
    if (previousWindow === undefined) delete process.env.ZOTERO_TRANSLATION_POOL_SCAN_WINDOW_DAYS;
    else process.env.ZOTERO_TRANSLATION_POOL_SCAN_WINDOW_DAYS = previousWindow;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("accepts legacy Stage 2 writeback summary when the current summary is absent", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "zotero-stage3-legacy-summary-"));
  try {
    const summaryPath = path.join(dir, "zotero_writeback_summary.json");
    const legacySummaryPath = path.join(dir, "mcp_writeback_summary.json");
    const runtimeStatePath = path.join(dir, "runtime_state.json");
    await fs.writeFile(legacySummaryPath, JSON.stringify({
      writeback_items: [{ itemKey: "K1", title: "Legacy title", grade: "A", backfill_short_title: true }],
    }), "utf8");

    const result = await prepareStage3BackfillInput({
      summaryPath,
      legacySummaryPath,
      runtimeStatePath,
      now: new Date("2026-07-07T00:00:00Z"),
    });

    assert.equal(result.summaryForRun.writeback_items[0].itemKey, "K1");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("summarizes Stage 3 all-cache-hit runs without marking API calls", () => {
  const summary = buildStage3TranslationSummary({
    report: {
      total: 2,
      success_count: 2,
      failure_count: 0,
      usage: { cache_hits: 2, cache_misses: 0, api_items: 0, api_calls: 0 },
      writeback: {},
      failures: [],
    },
    translationConfig: { apiKeyConfigured: true },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
  });

  assert.equal(summary.cache_hits_count, 2);
  assert.equal(summary.cache_misses_count, 0);
  assert.equal(summary.api_translation_attempted_count, 0);
  assert.equal(summary.skipped_reason, "all_cache_hits");
  assert.equal(summary.triggered, false);
});

it("summarizes Stage 3 cache misses translated through the API", () => {
  const summary = buildStage3TranslationSummary({
    report: {
      total: 2,
      success_count: 2,
      failure_count: 0,
      usage: { cache_hits: 1, cache_misses: 1, api_items: 1, api_calls: 1 },
      writeback: {},
      failures: [],
    },
    translationConfig: { apiKeyConfigured: true },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
  });

  assert.equal(summary.triggered, true);
  assert.equal(summary.api_translation_attempted_count, 1);
  assert.equal(summary.api_translation_succeeded_count, 1);
  assert.equal(summary.cache_writes_count, 1);
  assert.equal(summary.skipped_reason, "");
});

it("summarizes Stage 3 API attempts from request timing when legacy counters are zero", () => {
  const summary = buildStage3TranslationSummary({
    report: {
      total: 1,
      success_count: 1,
      failure_count: 0,
      usage: {
        cache_hits: 0,
        cache_misses: 1,
        api_items: 0,
        api_calls: 0,
        request_timing: { total_requests: 1 },
      },
      writeback: {},
      failures: [],
    },
    translationConfig: { apiKeyConfigured: true },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
  });

  assert.equal(summary.triggered, true);
  assert.equal(summary.api_translation_attempted_count, 1);
  assert.equal(summary.api_translation_succeeded_count, 1);
  assert.equal(summary.cache_writes_count, 1);
});

it("summarizes Stage 3 missing API key as skipped", () => {
  const summary = buildStage3TranslationSummary({
    report: {
      total: 1,
      success_count: 0,
      failure_count: 1,
      usage: { cache_hits: 0, cache_misses: 1, api_items: 0, api_calls: 0 },
      writeback: {},
      failures: [{ reason: "missing_api_key" }],
    },
    translationConfig: { apiKeyConfigured: false },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
  });

  assert.equal(summary.api_key_present, false);
  assert.equal(summary.triggered, false);
  assert.equal(summary.skipped_reason, "missing_api_key");
});

it("summarizes Stage 3 translation failures as degraded continuation", () => {
  const summary = buildStage3TranslationSummary({
    report: {
      total: 2,
      success_count: 1,
      failure_count: 1,
      usage: { cache_hits: 0, cache_misses: 2, api_items: 1, api_calls: 2 },
      writeback: {},
      failures: [{ reason: "HTTP_500 provider unavailable with a very long backend message that should not be copied in full" }],
    },
    translationConfig: { apiKeyConfigured: true },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
  });

  assert.equal(summary.degraded, true);
  assert.equal(summary.api_translation_failed_count, 1);
  assert.deepEqual(summary.failure_reasons, ["http_5xx"]);
});

it("summarizes Stage 3 no-item runs without API calls", () => {
  const summary = buildStage3TranslationSummary({
    report: {
      total: 0,
      success_count: 0,
      failure_count: 0,
      usage: { cache_hits: 0, cache_misses: 0, api_items: 0, api_calls: 0 },
      writeback: {},
      failures: [],
    },
    translationConfig: { apiKeyConfigured: true },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
  });

  assert.equal(summary.items_scanned_count, 0);
  assert.equal(summary.skipped_reason, "no_items");
  assert.equal(summary.api_translation_attempted_count, 0);
  assert.equal(summary.triggered, false);
});

it("summarizes Stage 3 Zotero metadata write results", () => {
  const summary = buildStage3TranslationSummary({
    report: {
      total: 2,
      success_count: 1,
      failure_count: 1,
      usage: { cache_hits: 0, cache_misses: 2, api_items: 2, api_calls: 2 },
      writeback: {},
      failures: [{ reason: "write_metadata_failed: timeout" }],
    },
    translationConfig: { apiKeyConfigured: true },
    poolScan: { candidates: [], scanStats: { items_scanned: 0 } },
  });

  assert.equal(summary.zotero_updates_attempted_count, 2);
  assert.equal(summary.zotero_updates_succeeded_count, 1);
  assert.equal(summary.zotero_updates_failed_count, 1);
  assert.equal(summary.degraded, true);
  assert.deepEqual(summary.failure_reasons, ["write_metadata_failed"]);
});
