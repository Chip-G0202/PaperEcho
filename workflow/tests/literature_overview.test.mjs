import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { batchOverviewLiterature, generateLiteratureOverview, overviewArtifactPath, selectOverviewLiterature } from "../tools/stage5/literature_overview.mjs";
import { hashInput } from "../tools/lib/llm_json_support.mjs";

function summary(root, created = 4) { return { runId: "overview-run", outputRoot: root, counts: { created } }; }
function runtime() { return { llm_mode: "real", apiKeyConfigured: true, model: "mock-overview", max_retries: 9 }; }
async function tempRoot(label) { return fs.mkdtemp(path.join(os.tmpdir(), `paperflow-${label}-`)); }

function mockOverviewHttp(t, output) {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://overview.invalid/v1/chat/completions");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    requests.push(body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ overview: output(body, requests.length) }) } }] }) };
  });
  return requests;
}
const httpRuntime = () => ({ ...runtime(), endpoint: "https://overview.invalid/v1/chat/completions", apiKey: "HTTP_TEST_TOKEN" });
function requestInput(body) {
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, "user");
  return JSON.parse(body.messages[0].content.split("\n\ninput:\n")[1]);
}

test("real HTTP overview messages contain minimal input and change with titles or grades", async (t) => {
  const requests = mockOverviewHttp(t, () => "合成文献概况");
  const roots = await Promise.all(["http-original", "http-title", "http-grade"].map(tempRoot));
  t.after(() => Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))));
  const variants = [[{ grade: "A", title: "Synthetic α study", abstract: "PRIVATE_ABSTRACT", translated_title: "PRIVATE_TRANSLATION", source: "PRIVATE_SOURCE", venue: "PRIVATE_VENUE", secret: "PRIVATE_SECRET", config: { apiKey: "PRIVATE_CONFIG_KEY" } }, { grade: "D", title: "EXCLUDED_D" }], [{ grade: "A", title: "Synthetic β study" }], [{ grade: "B", title: "Synthetic α study" }]];
  for (const [index, literatureItems] of variants.entries()) {
    const result = await generateLiteratureOverview({ runSummary: summary(roots[index]), literatureItems, runtime: httpRuntime() });
    assert.equal(result.status, "generated");
    assert.deepEqual(requestInput(requests[index]), { items: selectOverviewLiterature(literatureItems).items });
    assert.doesNotMatch(JSON.stringify(requests[index]), /PRIVATE_|EXCLUDED_D|HTTP_TEST_TOKEN|apiKey|abstract|translated_title|"config"/);
  }
  assert.equal(requests.length, 3);
  assert.equal(requests[0].messages[0].content.split("\n\ninput:\n")[0], requests[1].messages[0].content.split("\n\ninput:\n")[0]);
  assert.notDeepEqual(requests[0], requests[1]);
  assert.notDeepEqual(requests[0], requests[2]);
});

test("real HTTP batches contain only their own items and merge receives actual summaries", async (t) => {
  const batchSummaries = [];
  const requests = mockOverviewHttp(t, body => {
    const input = requestInput(body);
    if (input.items) { const overview = `合成批次概况 ${batchSummaries.length + 1}`; batchSummaries.push(overview); return overview; }
    assert.deepEqual(input, { summaries: batchSummaries });
    return "合成合并概况";
  });
  const root = await tempRoot("http-batches");
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const items = Array.from({ length: 8 }, (_, index) => ({ grade: ["A", "B", "C"][index % 3], title: `Synthetic batch ${index} ${"x".repeat(35)}`, abstract: "PRIVATE_BATCH_ABSTRACT" }));
  const selected = selectOverviewLiterature(items).items;
  const batches = batchOverviewLiterature(selected, 200);
  assert.ok(batches.length > 1);
  const result = await generateLiteratureOverview({ runSummary: summary(root, items.length), literatureItems: items, runtime: httpRuntime(), maxInputChars: 200 });
  assert.equal(result.status, "generated");
  assert.equal(requests.length, batches.length + 1);
  for (const [index, batch] of batches.entries()) assert.deepEqual(requestInput(requests[index]), { items: batch });
  assert.deepEqual(requestInput(requests.at(-1)), { summaries: batchSummaries });
  assert.doesNotMatch(JSON.stringify(requests), /PRIVATE_|HTTP_TEST_TOKEN|abstract/);
});

test("new overview prompt version invalidates legacy artifacts without rewriting them", async (t) => {
  const requests = mockOverviewHttp(t, () => "新版合成概况");
  const roots = await Promise.all(["http-legacy", "http-current"].map(tempRoot));
  t.after(() => Promise.all(roots.map(root => fs.rm(root, { recursive: true, force: true }))));
  const items = [{ grade: "A", title: "Synthetic versioned study" }];
  const legacyHash = hashInput({ schemaVersion: 2, promptVersion: "title-overview-v2", items });
  const legacy = JSON.stringify({ schemaVersion: 2, runId: "old-run", inputHash: legacyHash, status: "generated", overview: "旧版未携带标题的概况" });
  const legacyPath = overviewArtifactPath(roots[0]);
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, legacy);
  const options = { runSummary: summary(roots[1]), literatureItems: items, runtime: httpRuntime(), legacyStateRoot: roots[0] };
  const generated = await generateLiteratureOverview(options);
  assert.equal(generated.cacheHit, false);
  assert.equal(generated.status, "generated");
  assert.equal(generated.inputHash, hashInput({ schemaVersion: 2, promptVersion: "title-overview-v3", items }));
  assert.notEqual(generated.inputHash, legacyHash);
  assert.equal(requests.length, 1);
  assert.deepEqual(requestInput(requests[0]), { items });
  assert.equal((await generateLiteratureOverview(options)).cacheHit, true);
  assert.equal(requests.length, 1);
  assert.equal(await fs.readFile(legacyPath, "utf8"), legacy);
});

test("selection uses every normalized unique ABC title in stable grade order", () => {
  const items = Array.from({ length: 21 }, (_, index) => ({ title: `Title ${index}`, abstract: `SECRET-${index}`, grade: ["C", "B", "A"][index % 3] }));
  items.push(
    { title: "  Same\u0000   Title  ", grade: "C" },
    { title: "Same Title", grade: "A" },
    { title: "D title", grade: "D" },
    { title: "Ungraded", grade: "" },
    { title: "   ", grade: "A" },
  );
  const selected = selectOverviewLiterature(items);
  assert.equal(selected.items.length, 22);
  assert.deepEqual(selected.gradeCounts, { A: 8, B: 7, C: 7 });
  assert.equal(selected.items.find((item) => item.title === "Same Title").grade, "A");
  assert.deepEqual([...selected.items].sort((a, b) => ({ A: 0, B: 1, C: 2 }[a.grade] - { A: 0, B: 1, C: 2 }[b.grade])), selected.items);
  assert.equal(JSON.stringify(selected).includes("SECRET"), false);
  assert.equal(JSON.stringify(selected).includes("D title"), false);
  assert.equal(JSON.stringify(selected).includes("Ungraded"), false);
});

test("21+ titles all reach one normal LLM call without abstracts or D items", async () => {
  const root = await tempRoot("overview-all");
  const items = Array.from({ length: 80 }, (_, index) => ({ title: `ABC title ${String(index).padStart(3, "0")}`, abstract: `ABSTRACT-${index}`, grade: ["A", "B", "C"][index % 3] }));
  items.push({ title: "Excluded D", abstract: "D ABSTRACT", grade: "D" });
  const calls = [];
  const result = await generateLiteratureOverview({
    runSummary: summary(root, 81), literatureItems: items, runtime: runtime(),
    llmClient: async (input) => { calls.push(input); return { overview: "根据本轮文献标题，研究主要集中在多个相关主题及其研究方法。" }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].items.length, 80);
  assert.equal(JSON.stringify(calls).includes("ABSTRACT"), false);
  assert.equal(JSON.stringify(calls).includes("Excluded D"), false);
  assert.equal(result.sourceCount, 80);
  assert.equal(result.batchCount, 1);
});

test("hash ignores abstracts but changes with title or grade and cache prevents repeat calls", async () => {
  const roots = await Promise.all(["one", "two", "three"].map(tempRoot));
  let calls = 0;
  const llmClient = async () => { calls += 1; return { overview: "根据本轮文献标题，研究主要集中在示例主题。" }; };
  const first = await generateLiteratureOverview({ runSummary: summary(roots[0]), literatureItems: [{ title: "Study", abstract: "one", grade: "A" }], llmClient, runtime: runtime() });
  const cached = await generateLiteratureOverview({ runSummary: summary(roots[0]), literatureItems: [{ title: "Study", abstract: "changed", grade: "A" }], llmClient, runtime: runtime() });
  const changedGrade = await generateLiteratureOverview({ runSummary: summary(roots[1]), literatureItems: [{ title: "Study", grade: "B" }], llmClient, runtime: runtime() });
  const changedTitle = await generateLiteratureOverview({ runSummary: summary(roots[2]), literatureItems: [{ title: "Study 2", grade: "A" }], llmClient, runtime: runtime() });
  assert.equal(cached.cacheHit, true);
  assert.equal(first.inputHash, cached.inputHash);
  assert.notEqual(first.inputHash, changedGrade.inputHash);
  assert.notEqual(first.inputHash, changedTitle.inputHash);
  assert.equal(calls, 3);
});

test("oversized input is deterministically batched with complete exact coverage then merged", async () => {
  const root = await tempRoot("overview-batches");
  const items = Array.from({ length: 25 }, (_, index) => ({ title: `Long title ${String(index).padStart(2, "0")} ${"x".repeat(35)}`, grade: ["A", "B", "C"][index % 3] }));
  const selected = selectOverviewLiterature(items).items;
  const expectedBatches = batchOverviewLiterature(selected, 240);
  const calls = [];
  const result = await generateLiteratureOverview({
    runSummary: summary(root, 25), literatureItems: items, runtime: runtime(), maxInputChars: 240,
    llmClient: async (input) => { calls.push(input); return { overview: input.items ? "批次主题概况" : "根据本轮文献标题，研究主要集中在合并后的总体主题。" }; },
  });
  const submitted = calls.slice(0, -1).flatMap((call) => call.items);
  assert.ok(expectedBatches.length > 1);
  assert.deepEqual(submitted, selected);
  assert.equal(new Set(submitted.map((item) => `${item.grade}:${item.title}`)).size, selected.length);
  assert.equal(result.batchCount, expectedBatches.length);
  assert.equal(calls.length, expectedBatches.length + 1);
  assert.deepEqual(calls.at(-1), { summaries: Array(expectedBatches.length).fill("批次主题概况") });
});

test("fallbacks avoid network and artifact stores only metadata", async () => {
  const failedRoot = await tempRoot("overview-fallback");
  const failed = await generateLiteratureOverview({ runSummary: summary(failedRoot), literatureItems: [
    { title: "Alpha <topic>", abstract: "PRIVATE", grade: "A" }, { title: "Beta", grade: "B" }, { title: "Gamma", grade: "C" },
  ], llmClient: async () => { throw new Error("mock failure"); }, runtime: runtime() });
  assert.equal(failed.status, "fallback");
  assert.match(failed.overview, /《Alpha <topic>》/);
  const artifactText = await fs.readFile(overviewArtifactPath(failedRoot), "utf8");
  assert.equal(artifactText.includes("PRIVATE"), false);
  for (const key of ["prompt", "items", "titles", "abstract"]) assert.equal(key in JSON.parse(artifactText), false);

  let calls = 0;
  const noAbcRoot = await tempRoot("overview-no-abc");
  const noAbc = await generateLiteratureOverview({ runSummary: summary(noAbcRoot, 2), literatureItems: [{ title: "D only", grade: "D" }], llmClient: async () => { calls += 1; }, runtime: runtime() });
  assert.equal(noAbc.overview, "本轮新增文献中暂无可用于总体概括的 A、B 或 C 级标题，详细结果请查看附件。");
  const emptyRoot = await tempRoot("overview-empty");
  const empty = await generateLiteratureOverview({ runSummary: summary(emptyRoot, 0), literatureItems: [{ title: "Ignored", grade: "A" }], llmClient: async () => { calls += 1; }, runtime: runtime() });
  assert.equal(empty.overview, "本轮没有新增文献。");
  assert.equal(calls, 0);
});
