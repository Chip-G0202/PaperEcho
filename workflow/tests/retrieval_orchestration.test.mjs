import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { runSourceSelectionAndFetch } from "../tools/stage1/source_selection_step.mjs";
import { dedupWithDiagnostics } from "../tools/stage1/dedupe_step.mjs";

function sourceResult(source, items = [], { failed = [] } = {}) {
  return {
    items,
    failed,
    config: { enabled: true, warnings: [] },
    audit: [{ source, complete: failed.length === 0, itemCount: items.length }],
    stateUpdates: [],
    metrics: {
      source, queryVariantCount: 1, requestCount: 1, totalReported: items.length,
      fetched: items.length, normalized: items.length, uniqueAfterMerge: 0,
      duplicateCount: 0, errorCount: failed.length, "429Count": 0,
      zeroReason: items.length ? "" : failed.length ? "source_failure" : "healthy_zero",
      degraded: failed.length > 0,
    },
  };
}

async function project(t, { domain, primary, supplemental = [], retrieval = {} }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-retrieval-orchestration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "source_selection.json"), JSON.stringify({
    version: 1,
    research_domain: domain,
    domain_options: { [domain]: { primary_sources: primary, supplemental_sources: supplemental } },
    override_enabled_sources: null,
    require_manual_confirmation: false,
    retrieval: {
      diagnostics: { enabled: true, low_yield_threshold: 2, probe_budget: 3 },
      openalex: { request_budget: 3, semantic_rescue_enabled: false, semantic_rescue_max_results: 10 },
      semantic_scholar: { request_budget: 2, concurrency: 1 },
      crossref: { rescue_enabled: false, request_budget: 2, query_budget: 1 },
      europe_pmc: { rescue_enabled: false, validated_unique_recall: false, request_budget: 2, include_preprints: false, synonym: true },
      ...retrieval,
    },
  }), "utf8");
  await fs.writeFile(path.join(root, "config", "openalex_search.json"), JSON.stringify({
    version: 1,
    enabled: primary.includes("openalex") || supplemental.includes("openalex"),
    keyword_groups: { required: [["graph neural network", "graph convolutional network"], ["molecule", "drug"]] },
    days_back: 10,
    per_page: 10,
    filters: { type: "article" },
  }), "utf8");
  return root;
}

const pubmedConfig = {
  databases: ["pubmed"],
  query: "(cancer OR neoplasm) AND immunotherapy",
  effective_query: "(cancer OR neoplasm) AND immunotherapy",
  keyword_groups: { required: [["cancer", "neoplasm"], ["immunotherapy"]], optional: [], negative: [] },
  minDate: "2025/01/01",
  maxDate: "2026/01/01",
  warnings: [],
};

const emptyRss = async () => ({ items: [], failed: [], config: { warnings: [] }, audit: [], stateUpdates: [] });
const emptyDb = async () => ({ items: [], failed: [], config: { databases: ["pubmed"], warnings: [] }, audit: [{ source: "pubmed", complete: true, itemCount: 0 }], stateUpdates: [] });

test("general primary sources run independently and a healthy S2 result survives OpenAlex failure", async (t) => {
  const root = await project(t, { domain: "non_biomedical_stem", primary: ["openalex", "semantic_scholar"], retrieval: { diagnostics: { enabled: true, low_yield_threshold: 1, probe_budget: 3 } } });
  const result = await runSourceSelectionAndFetch({
    root, pubmedPmcConfig: pubmedConfig, now: new Date("2026-01-02T00:00:00Z"),
    fetchers: {
      fetchRssAll: emptyRss,
      fetchOpenAlex: async () => { throw new Error("OPENALEX_TIMEOUT"); },
      fetchSemanticScholar: async () => sourceResult("semantic_scholar", [{ title: "S2 survives", doi: "10.1000/s2", source: "semantic_scholar", retrieval_sources: ["semantic_scholar"] }]),
    },
  });
  assert.equal(result.openalex.failed.length, 1);
  assert.equal(result.semanticScholar.items.length, 1);
  assert.equal(result.crossref.skipped_reason, "not_enabled");
  assert.equal(result.retrievalHealth.unionCandidateCount, 1);
  assert.equal(result.retrievalHealth.primaryZeroRescued, false, "failed primary is degradation, not a healthy zero");
});

test("general low-yield rescue retains Crossref unique candidates without replacing primary results", async (t) => {
  const root = await project(t, {
    domain: "non_biomedical_stem",
    primary: ["openalex", "semantic_scholar"],
    retrieval: { crossref: { rescue_enabled: true, request_budget: 2, query_budget: 1 } },
  });
  let crossrefCalls = 0;
  const result = await runSourceSelectionAndFetch({
    root, pubmedPmcConfig: pubmedConfig, now: new Date("2026-01-02T00:00:00Z"),
    fetchers: {
      fetchRssAll: emptyRss,
      fetchOpenAlex: async () => sourceResult("openalex", []),
      fetchSemanticScholar: async () => sourceResult("semantic_scholar", []),
      fetchCrossrefRescue: async () => {
        crossrefCalls += 1;
        return sourceResult("crossref", [{ title: "Crossref rescue", doi: "10.1000/rescue", source: "crossref", retrieval_sources: ["crossref"] }]);
      },
    },
  });
  assert.equal(crossrefCalls, 1);
  assert.equal(result.retrievalHealth.primaryZeroRescued, true);
  assert.equal(result.retrievalHealth.zeroReason, "single_source_zero_rescued");
  assert.equal(result.retrievalHealth.uniqueContributionBySource.crossref, 1);
});

test("Europe PMC stays production-disabled until unique-recall validation is explicit", async (t) => {
  const root = await project(t, {
    domain: "biomedical",
    primary: ["pubmed_pmc"],
    retrieval: { europe_pmc: { rescue_enabled: true, validated_unique_recall: false, request_budget: 2, include_preprints: false, synonym: true } },
  });
  let calls = 0;
  const result = await runSourceSelectionAndFetch({
    root, pubmedPmcConfig: pubmedConfig, now: new Date("2026-01-02T00:00:00Z"),
    fetchers: {
      fetchRssAll: emptyRss,
      fetchPubMed: emptyDb,
      fetchEuropePmcRescue: async () => { calls += 1; return sourceResult("europe_pmc", []); },
    },
  });
  assert.equal(calls, 0);
  assert.equal(result.europePmc.skipped_reason, "production_validation_required");
  assert.equal(result.retrievalHealth.europePmcProductionValidated, false);
});

test("validated Europe PMC rescue dedupes PubMed overlap and keeps only its unique contribution", async (t) => {
  const root = await project(t, {
    domain: "biomedical",
    primary: ["pubmed_pmc"],
    retrieval: { europe_pmc: { rescue_enabled: true, validated_unique_recall: true, request_budget: 2, include_preprints: false, synonym: true } },
  });
  const pubmedItem = { title: "Shared biomedical", doi: "10.1000/shared", pmid: "123", source_platform: "pubmed", source_channel: "database" };
  const result = await runSourceSelectionAndFetch({
    root, pubmedPmcConfig: pubmedConfig, now: new Date("2026-01-02T00:00:00Z"),
    fetchers: {
      fetchRssAll: emptyRss,
      fetchPubMed: async () => ({ items: [pubmedItem], failed: [], config: { databases: ["pubmed"], warnings: [] }, audit: [{ source: "pubmed", complete: true, itemCount: 1 }], stateUpdates: [] }),
      fetchEuropePmcRescue: async () => sourceResult("europe_pmc", [
        { title: "Shared biomedical", doi: "10.1000/shared", pmid: "123", source: "europe_pmc", retrieval_sources: ["europe_pmc"] },
        { title: "Unique life-science", doi: "10.1000/unique-epmc", source: "europe_pmc", retrieval_sources: ["europe_pmc"] },
      ]),
    },
  });
  const merged = dedupWithDiagnostics([...result.db.items, ...result.europePmc.items]);
  assert.equal(result.retrievalHealth.europePmcRescueTriggered, true);
  assert.equal(merged.items.length, 2);
  assert.equal(result.retrievalHealth.uniqueContributionBySource.europe_pmc, 1);
  assert.equal(result.retrievalHealth.uniqueContributionBySource.pubmed, 0);
});
