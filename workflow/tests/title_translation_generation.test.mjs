import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateLiteratureTitleTranslations } from "../tools/lib/title_translation_generation.mjs";
import { translateTitlesBatch } from "../tools/lib/title_translation_support.mjs";

test("Desktop, Web, and Local share title cache without Zotero identifiers", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-title-generation-"));
  const cachePath = path.join(root, "translation_cache.json");
  let calls = 0;
  const batch = (titles, concurrency, options) => translateTitlesBatch(titles, concurrency, {
    ...options,
    translateOneImpl: async () => { calls += 1; return { ok: true, zh: "共享中文标题" }; },
    runtime: { concurrencyLimit: 1, providerConcurrencyLimit: 1, batchSize: 1, model: "mock", temperature: 0, top_p: 1, stream: false, rateLimit: {} },
  });
  const desktop = await generateLiteratureTitleTranslations([{ title: "Shared English title", itemKey: "Z1" }], { cachePath, translateTitlesBatchImpl: batch });
  const local = await generateLiteratureTitleTranslations([{ title: "Shared English title", local_id: "lp_1" }], { cachePath, translateTitlesBatchImpl: batch });
  const web = await generateLiteratureTitleTranslations([{ title: "Shared English title" }], { cachePath, translateTitlesBatchImpl: batch });
  assert.equal(calls, 1);
  assert.equal(desktop.items[0].translatedTitle, "共享中文标题");
  assert.equal(local.items[0].translatedTitle, "共享中文标题");
  assert.equal(web.items[0].translatedTitle, "共享中文标题");
  assert.equal(local.items[0].itemKey, undefined);
});

test("English fallback and provider failure remain explicitly untranslated", async () => {
  for (const result of [
    { ok: true, zh: "Original English title" },
    { ok: false, zh: "Original English title", reason: "HTTP_402" },
  ]) {
    const generated = await generateLiteratureTitleTranslations([
      { title: "Original English title", translatedTitle: "Original English title", "中文标题": "Original English title" },
    ], {
      translateTitlesBatchImpl: async () => ({ map: new Map([["Original English title", result]]), usage: null }),
    });
    assert.equal(generated.items[0].translatedTitle, "");
    assert.equal(generated.items[0]["标题翻译"], "");
    assert.equal(generated.items[0]["中文标题"], "");
    assert.equal(generated.items[0].hasTranslation, false);
    assert.equal(generated.generated_count, 0);
  }
});

test("a meaningful Chinese translation is accepted after an untranslated item is retried", async () => {
  let calls = 0;
  const generated = await generateLiteratureTitleTranslations([
    { title: "Original English title", "中文标题": "Original English title" },
  ], {
    translateTitlesBatchImpl: async (titles) => {
      calls += 1;
      return { map: new Map(titles.map((title) => [title, { ok: true, zh: "真正的中文标题" }])), usage: null };
    },
  });
  assert.equal(calls, 1);
  assert.equal(generated.items[0].translatedTitle, "真正的中文标题");
  assert.equal(generated.items[0]["中文标题"], "真正的中文标题");
  assert.equal(generated.items[0].hasTranslation, true);
});
