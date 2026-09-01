import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadSourceSelectionConfig, loadOpenAlexConfig, resolveRetrievalPlan } from "../tools/lib/literature_config.mjs";
import { buildOpenAlexSearchParams, normalizeOpenAlexItem, runSelectedRetrievalSources } from "../tools/stage1/retrieval_step.mjs";
import { buildStage1SourceSummary } from "../tools/stage1/source_summary.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function fixturePath(name) {
  return path.join(__dirname, "fixtures", name);
}

test("source_selection — biomedical domain enables pubmed_pmc and rss, not openalex", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_biomedical") });
  assert.equal(cfg.research_domain, "biomedical");
  assert.deepEqual(cfg.primary_sources, ["pubmed_pmc"]);
  assert.deepEqual(cfg.supplemental_sources, ["rss"]);
  assert.ok(cfg.enabled_sources.includes("pubmed_pmc"));
  assert.ok(cfg.enabled_sources.includes("rss"));
  assert.ok(!cfg.enabled_sources.includes("openalex"));
});

test("source_selection — non_biomedical_stem domain enables openalex and rss, not pubmed_pmc", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_non_biomedical") });
  assert.equal(cfg.research_domain, "non_biomedical_stem");
  assert.deepEqual(cfg.primary_sources, ["openalex"]);
  assert.deepEqual(cfg.supplemental_sources, ["rss"]);
  assert.ok(cfg.enabled_sources.includes("openalex"));
  assert.ok(cfg.enabled_sources.includes("rss"));
  assert.ok(!cfg.enabled_sources.includes("pubmed_pmc"));
});

test("source_selection — mixed_biomedical_technical domain enables both pubmed_pmc and openalex", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_mixed") });
  assert.equal(cfg.research_domain, "mixed_biomedical_technical");
  assert.deepEqual(cfg.primary_sources, ["pubmed_pmc", "openalex"]);
  assert.deepEqual(cfg.supplemental_sources, ["rss"]);
  assert.ok(cfg.enabled_sources.includes("pubmed_pmc"));
  assert.ok(cfg.enabled_sources.includes("openalex"));
  assert.ok(cfg.enabled_sources.includes("rss"));
});

test("source_selection — unknown domain with manual confirmation enables only rss", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_unknown") });
  assert.equal(cfg.research_domain, "unknown");
  assert.deepEqual(cfg.primary_sources, []);
  assert.deepEqual(cfg.supplemental_sources, ["rss"]);
  assert.ok(cfg.enabled_sources.includes("rss"));
  assert.ok(!cfg.enabled_sources.includes("pubmed_pmc"));
  assert.ok(!cfg.enabled_sources.includes("openalex"));
  assert.equal(cfg.require_manual_confirmation, true);
  assert.ok(cfg.warnings.includes("manual_confirmation_required_unknown_domain"));
});

test("openalex_config — disabled returns safe empty config", () => {
  const cfg = loadOpenAlexConfig({ root: fixturePath("openalex_disabled") });
  assert.equal(cfg.enabled, false);
  assert.ok(cfg.warnings.includes("openalex_disabled"));
});

test("openalex_config — enabled with empty query warns", () => {
  const cfg = loadOpenAlexConfig({ root: fixturePath("openalex_empty_query") });
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.query, "");
  assert.ok(cfg.warnings.includes("openalex_enabled_but_empty_query"));
});

test("buildOpenAlexSearchParams — constructs correct URL", () => {
  const cfg = {
    enabled: true,
    query: "example research term example method term",
    days_back: 10,
    per_page: 50,
    mailto: "",
    filters: { type: "article", is_oa: null, from_publication_date: null, to_publication_date: null, concepts: [], default_search: "example topic term 010" },
    sort: "relevance_score:desc",
    select: "id,doi,title",
  };
  const url = buildOpenAlexSearchParams(cfg);
  assert.ok(url.startsWith("https://api.openalex.org/works?"));
  assert.ok(url.includes("search=example+research+term+example+method+term"));
  assert.ok(url.includes("per_page=50"));
  assert.ok(url.includes("type%3Aarticle"));
  assert.ok(url.includes("from_publication_date%3A"));
});

test("normalizeOpenAlexItem — normalizes work to item structure", () => {
  const work = {
    id: "https://openalex.org/W12345",
    doi: "https://doi.org/10.0000/example.004",
    title: "Test Article Title",
    publication_year: 2024,
    publication_date: "2024-01-15",
    authorships: [
      { author: { display_name: "John Doe" } },
      { author: { display_name: "Jane Smith" } },
    ],
    primary_location: {
      landing_page_url: "https://example.com/article",
      source: { display_name: "Test Journal" },
    },
    abstract_inverted_index: { example: [0], fictional: [1], study: [2] },
    open_access: { is_oa: true, oa_url: "https://example.com/oa" },
  };
  const item = normalizeOpenAlexItem(work);
  assert.equal(item.source_channel, "openalex");
  assert.equal(item.source_platform, "openalex");
  assert.equal(item.title, "Test Article Title");
  assert.equal(item.doi, "10.0000/example.004");
  assert.equal(item.publication_year, 2024);
  assert.equal(item.publication_date, "2024-01-15");
  assert.equal(item.authors, "John Doe, Jane Smith");
  assert.equal(item.journal, "Test Journal");
  assert.equal(item.url, "https://example.com/article");
  assert.equal(item.abstract, "example fictional study");
  assert.equal(item.openalex_id, "W12345");
  assert.equal(item.is_open_access, true);
  assert.equal(item.oa_url, "https://example.com/oa");
});

test("normalizeOpenAlexItem — handles missing abstract gracefully", () => {
  const work = {
    id: "https://openalex.org/W99999",
    doi: null,
    title: "No Abstract Article",
    publication_year: 2023,
    authorships: [],
    primary_location: null,
    abstract_inverted_index: null,
    open_access: { is_oa: false },
  };
  const item = normalizeOpenAlexItem(work);
  assert.equal(item.abstract, "");
  assert.equal(item.doi, "");
  assert.equal(item.url, "");
  assert.equal(item.journal, "");
});

test("buildStage1SourceSummary — includes openalex source", () => {
  const summary = buildStage1SourceSummary({
    sources: [
      { name: "rss", enabled: true, triggered: true, itemsCollectedCount: 10, enteredPreDedupCollection: true, skippedReason: null, failureReason: null, degraded: false, warningsCount: 0 },
      { name: "pubmed_pmc", enabled: false, triggered: false, itemsCollectedCount: 0, enteredPreDedupCollection: false, skippedReason: "disabled_by_source_selection", failureReason: null, degraded: false, warningsCount: 0 },
      { name: "openalex", enabled: true, triggered: true, itemsCollectedCount: 25, enteredPreDedupCollection: true, skippedReason: null, failureReason: null, degraded: false, warningsCount: 0 },
    ],
    preDedupItemsCount: 35,
  });
  assert.equal(summary.sources_count, 3);
  assert.equal(summary.enabled_sources_count, 2);
  assert.equal(summary.triggered_sources_count, 2);
  assert.equal(summary.succeeded_sources_count, 2);
  assert.equal(summary.total_collected_items_count, 35);
  assert.equal(summary.sources[2].name, "openalex");
  assert.equal(summary.sources[2].items_collected_count, 25);
  assert.equal(summary.sources[1].skipped_reason, "disabled_by_source_selection");
});

test("buildStage1SourceSummary — openalex degraded by network error", () => {
  const summary = buildStage1SourceSummary({
    sources: [
      { name: "rss", enabled: true, triggered: true, itemsCollectedCount: 5, enteredPreDedupCollection: true, skippedReason: null, failureReason: null, degraded: false, warningsCount: 0 },
      { name: "openalex", enabled: true, triggered: true, itemsCollectedCount: 0, enteredPreDedupCollection: false, skippedReason: null, failureReason: "HTTP_503", degraded: true, warningsCount: 2 },
    ],
    preDedupItemsCount: 5,
  });
  assert.equal(summary.degraded, true);
  assert.equal(summary.failed_sources_count, 1);
  assert.equal(summary.failure_reasons[0].source, "openalex");
  assert.equal(summary.failure_reasons[0].reason, "HTTP_503");
});

// --- Orchestration-level routing tests ---

test("resolveRetrievalPlan — biomedical: pubmed_pmc+rss enabled, openalex disabled", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_biomedical") });
  const plan = resolveRetrievalPlan(cfg);
  assert.equal(plan.pubmedEnabled, true);
  assert.equal(plan.rssEnabled, true);
  assert.equal(plan.openalexEnabled, false);
  assert.equal(plan.manualConfirmationRequired, false);
});

test("resolveRetrievalPlan — non_biomedical_stem: openalex+rss enabled, pubmed_pmc disabled", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_non_biomedical") });
  const plan = resolveRetrievalPlan(cfg);
  assert.equal(plan.pubmedEnabled, false);
  assert.equal(plan.rssEnabled, true);
  assert.equal(plan.openalexEnabled, true);
  assert.equal(plan.manualConfirmationRequired, false);
});

test("resolveRetrievalPlan — mixed: pubmed_pmc+openalex+rss all enabled", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_mixed") });
  const plan = resolveRetrievalPlan(cfg);
  assert.equal(plan.pubmedEnabled, true);
  assert.equal(plan.rssEnabled, true);
  assert.equal(plan.openalexEnabled, true);
  assert.equal(plan.manualConfirmationRequired, false);
});

test("resolveRetrievalPlan — unknown: only rss enabled, manual confirmation required", () => {
  const cfg = loadSourceSelectionConfig({ root: fixturePath("source_selection_unknown") });
  const plan = resolveRetrievalPlan(cfg);
  assert.equal(plan.pubmedEnabled, false);
  assert.equal(plan.rssEnabled, true);
  assert.equal(plan.openalexEnabled, false);
  assert.equal(plan.manualConfirmationRequired, true);
});

test("resolveRetrievalPlan — empty config defaults to all disabled", () => {
  const plan = resolveRetrievalPlan({ enabled_sources: [] });
  assert.equal(plan.pubmedEnabled, false);
  assert.equal(plan.rssEnabled, false);
  assert.equal(plan.openalexEnabled, false);
  assert.equal(plan.manualConfirmationRequired, false);
});

test("resolveRetrievalPlan — null input safe fallback", () => {
  const plan = resolveRetrievalPlan(null);
  assert.equal(plan.pubmedEnabled, false);
  assert.equal(plan.rssEnabled, false);
  assert.equal(plan.openalexEnabled, false);
  assert.equal(plan.manualConfirmationRequired, false);
});

test("fetchOpenAlex — disabled config returns safe empty without network call", async () => {
  const { fetchOpenAlex } = await import("../tools/stage1/retrieval_step.mjs");
  const result = await fetchOpenAlex({ enabled: false, query: "", days_back: 10, per_page: 50, mailto: "", filters: {}, sort: "", select: "" });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.skipped_reason, "openalex_disabled");
});

test("fetchOpenAlex — empty query returns safe empty without network call", async () => {
  const { fetchOpenAlex } = await import("../tools/stage1/retrieval_step.mjs");
  const result = await fetchOpenAlex({ enabled: true, query: "", days_back: 10, per_page: 50, mailto: "", filters: {}, sort: "", select: "" });
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.failed, []);
  assert.equal(result.skipped_reason, "empty_query");
});

test("runSelectedRetrievalSources — enabled sources start concurrently", async () => {
  const started = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const makeFetcher = (name, item) => async () => {
    started.push(name);
    await gate;
    return { items: [item], failed: [], config: { path: name, warnings: [] } };
  };
  const pending = runSelectedRetrievalSources({
    root: fixturePath("source_selection_mixed"),
    pubmedPmcConfig: { databases: ["pubmed"], warnings: [] },
    openAlexConfig: { enabled: true, query: "x", filters: {}, warnings: [] },
    plan: { rssEnabled: true, pubmedEnabled: true, openalexEnabled: true },
    fetchers: {
      fetchRssAll: makeFetcher("rss", { title: "rss" }),
      fetchPubMed: makeFetcher("pubmed", { title: "pubmed" }),
      fetchOpenAlex: makeFetcher("openalex", { title: "openalex" }),
    },
  });
  await Promise.resolve();
  assert.deepEqual(started.sort(), ["openalex", "pubmed", "rss"]);
  release();
  const result = await pending;
  assert.equal(result.rss.items[0].title, "rss");
  assert.equal(result.db.items[0].title, "pubmed");
  assert.equal(result.openalex.items[0].title, "openalex");
});

test("runSelectedRetrievalSources — each retrieval source receives an independent concurrency controller", async () => {
  const controllers = {};
  const result = await runSelectedRetrievalSources({
    root: fixturePath("source_selection_mixed"),
    pubmedPmcConfig: { databases: ["pubmed"], warnings: [] },
    openAlexConfig: { enabled: true, query: "graphene", filters: {}, warnings: [] },
    searchIntent: { expression: { type: "term", value: "graphene", exact: false }, parseErrors: [], dateRange: {} },
    semanticScholarConfig: { enabled: true },
    plan: { rssEnabled: true, pubmedEnabled: true, openalexEnabled: true, semanticScholarEnabled: true },
    fetchers: {
      fetchRssAll: async (options) => { controllers.rss = options.sourceConcurrencyController; return { items: [], failed: [], config: { warnings: [] } }; },
      fetchPubMed: async (_config, options) => { controllers.pubmed = options.sourceConcurrencyController; return { items: [], failed: [], config: { warnings: [] } }; },
      fetchOpenAlex: async (_config, options) => { controllers.openalex = options.sourceConcurrencyController; return { items: [], failed: [], config: { warnings: [] } }; },
      fetchSemanticScholar: async (_intent, _config, options) => { controllers.semanticScholar = options.controller; return { items: [], failed: [], config: { warnings: [] } }; },
    },
  });
  assert.ok(result.semanticScholar);
  assert.equal(new Set(Object.values(controllers)).size, 4);
});

test("dedupe — openalex items included without ReferenceError", async () => {
  const { dedupWithDiagnostics } = await import("../tools/stage1/dedupe_step.mjs");
  const rssItems = [{ title: "RSS Article", doi: "10.0000/example.003", source_channel: "rss" }];
  const dbItems = [{ title: "PubMed Article", doi: "10.0000/example.005", source_channel: "pubmed" }];
  const openalexItems = [{ title: "OpenAlex Article", doi: "10.0000/example.006", source_channel: "openalex" }];
  const result = dedupWithDiagnostics([...rssItems, ...dbItems, ...openalexItems]);
  assert.equal(result.items.length, 3);
  assert.equal(result.diagnostics.fetched_count, 3);
});

test("main.mjs — no undefined openalex variable reference (syntax check)", async () => {
  // node --check verifies no syntax errors; runtime ReferenceError would require actual execution
  // This test verifies the import and resolveRetrievalPlan are present
  const { readFileSync } = await import("node:fs");
  const mainContent = readFileSync("workflow/tools/stage1/source_selection_step.mjs", "utf8");
  assert.ok(mainContent.includes("resolveRetrievalPlan"), "source_selection_step.mjs should import resolveRetrievalPlan");
  assert.ok(mainContent.includes("loadSourceSelectionConfig"), "source_selection_step.mjs should import loadSourceSelectionConfig");
  assert.ok(mainContent.includes("runSelectedRetrievalSources"), "source_selection_step.mjs should run selected retrieval sources");
  assert.ok(mainContent.includes("openalexEnabled"), "source_selection_step.mjs should check openalexEnabled flag");
  // Verify openalex is always assigned before use in dedupe
  const openalexDeclIdx = mainContent.indexOf("const { rss, db, openalex }");
  const dedupeIdx = mainContent.indexOf("openalex.items");
  assert.ok(openalexDeclIdx < dedupeIdx, "openalex must be declared before dedupe reference");
});
