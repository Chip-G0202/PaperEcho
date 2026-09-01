import test from "node:test";
import assert from "node:assert/strict";

import { dedupWithDiagnostics } from "../tools/stage1/dedupe_step.mjs";
import {
  buildRetrievalSufficiencySummary,
  fetchCrossrefRescue,
  fetchEuropePmcRescue,
  fetchSemanticScholar,
} from "../tools/stage1/retrieval_sources.mjs";
import { buildSearchIntent } from "../tools/stage1/search_intent.mjs";

function jsonResponse(value, status = 200, headers = {}) {
  const body = JSON.stringify(value);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || "" },
    text: async () => body,
  };
}

const intent = buildSearchIntent({
  keywordGroups: {
    required: [["single-cell RNA sequencing", "scRNA-seq"], ["cancer", "tumor"]],
    negative: ["protocol"],
  },
  dateRange: { from: "2025-01-01", to: "2026-01-01" },
});

test("Semantic Scholar uses bulk Boolean syntax, token paging, minimal fields, and optional secret header", async () => {
  const calls = [];
  const result = await fetchSemanticScholar(intent, { enabled: true, request_budget: 2, concurrency: 1 }, {
    apiKey: "test-secret",
    fetchImpl: async (rawUrl, options) => {
      const url = new URL(rawUrl);
      calls.push({ url, headers: options.headers });
      return url.searchParams.has("token")
        ? jsonResponse({ total: 2, data: [{ paperId: "S2-2", title: "Second", externalIds: { DOI: "10.1000/s2-2" } }] })
        : jsonResponse({ total: 2, token: "next-token", data: [{ paperId: "S2-1", title: "First", externalIds: { DOI: "10.1000/s2-1" } }] });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.pathname, "/graph/v1/paper/search/bulk");
  assert.match(calls[0].url.searchParams.get("query"), /\|/);
  assert.match(calls[0].url.searchParams.get("query"), /\+/);
  assert.equal(calls[1].url.searchParams.get("token"), "next-token");
  assert.equal(calls[0].headers["x-api-key"], "test-secret");
  assert.equal(calls[0].url.searchParams.get("fields"), "paperId,externalIds,url,title,abstract,venue,year,publicationDate,authors,publicationTypes");
  assert.equal(result.items.length, 2);
  assert.equal(result.audit[0].complete, true);
  assert.equal(JSON.stringify(result).includes("test-secret"), false);
});

test("Semantic Scholar keeps partial candidates but never commits incomplete pagination", async () => {
  const result = await fetchSemanticScholar(intent, { enabled: true, request_budget: 1 }, {
    stateRoot: "",
    fetchImpl: async () => jsonResponse({ total: 2, token: "still-more", data: [{ paperId: "S2-1", title: "First", externalIds: { DOI: "10.1000/s2-1" } }] }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.audit[0].complete, false);
  assert.match(result.failed[0].error, /REQUEST_BUDGET_EXCEEDED/);
  assert.equal(result.metrics.degraded, true);
  assert.equal(result.stateUpdates.length, 0);
});

test("Semantic Scholar fails closed when total indicates more results but continuation token is missing", async () => {
  const result = await fetchSemanticScholar(intent, { enabled: true, request_budget: 4 }, {
    fetchImpl: async () => jsonResponse({ total: 2, token: null, data: [{ paperId: "S2-1", title: "First", externalIds: { DOI: "10.1000/s2-1" } }] }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.audit[0].complete, false);
  assert.match(result.failed[0].error, /PAGINATION_TOKEN_MISSING/);
});

test("Semantic Scholar records each 429 retry without exposing credentials", async () => {
  let calls = 0;
  const result = await fetchSemanticScholar(intent, { enabled: true, request_budget: 1 }, {
    apiKey: "never-print-me",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ message: "rate limited" }, 429, { "retry-after": "0" });
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.metrics["429Count"], 3);
  assert.equal(result.metrics.errorCount, 3);
  assert.equal(result.metrics.degraded, true);
  assert.equal(JSON.stringify(result).includes("never-print-me"), false);
});

test("Crossref rescue sends bounded high-information bibliographic anchors and distinguishes natural completion from budget exhaustion", async () => {
  const calls = [];
  const complete = await fetchCrossrefRescue(intent, { enabled: true, query_budget: 1, request_budget: 1, per_page: 10 }, {
    fetchImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      calls.push(url);
      return jsonResponse({ message: { "total-results": 1, items: [{ DOI: "10.1000/crossref-1", title: ["Crossref candidate"], published: { "date-parts": [[2025, 2, 3]] } }] } });
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].searchParams.get("query.bibliographic"));
  assert.equal(calls[0].searchParams.has("query"), false);
  assert.equal(complete.failed.length, 0);
  assert.equal(complete.items[0].doi, "10.1000/crossref-1");

  const incomplete = await fetchCrossrefRescue(intent, { enabled: true, query_budget: 1, request_budget: 1 }, {
    fetchImpl: async () => jsonResponse({ message: { "total-results": 2, "next-cursor": "more", items: [{ DOI: "10.1000/crossref-1", title: ["Crossref candidate"] }] } }),
  });
  assert.equal(incomplete.items.length, 1);
  assert.equal(incomplete.audit[0].complete, false);
  assert.match(incomplete.failed[0].error, /REQUEST_BUDGET_EXHAUSTED/);
});

test("Europe PMC uses cursor paging and preserves PubMed identity for canonical dedupe", async () => {
  const cursors = [];
  const result = await fetchEuropePmcRescue(intent, { enabled: true, request_budget: 2, include_preprints: false }, {
    fetchImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      cursors.push(url.searchParams.get("cursorMark"));
      assert.match(url.searchParams.get("query"), /NOT SRC:PPR/);
      return cursors.length === 1
        ? jsonResponse({ hitCount: 2, nextCursorMark: "next", resultList: { result: [{ source: "MED", id: "123", pmid: "123", doi: "10.1000/shared", title: "Shared paper" }] } })
        : jsonResponse({ hitCount: 2, resultList: { result: [{ source: "AGR", id: "AGR-1", title: "Unique life-science record" }] } });
    },
  });
  assert.deepEqual(cursors, ["*", "next"]);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].pmid, "123");
  assert.equal(result.audit[0].complete, true);
});

test("canonical merge is transitive, retains provenance, and never changes an existing grade", () => {
  const openalex = { title: "Shared paper", doi: "10.1000/shared", source: "openalex", retrieval_sources: ["openalex"], grade: "B" };
  const europePmc = { title: "Shared paper", doi: "10.1000/shared", pmid: "123", source: "europe_pmc", retrieval_sources: ["europe_pmc"] };
  const pubmed = { title: "Shared paper", pmid: "123", source_platform: "pubmed", source_channel: "database" };
  const crossref = { title: "Crossref only", doi: "10.1000/crossref", source: "crossref", retrieval_sources: ["crossref"] };
  const result = dedupWithDiagnostics([openalex, europePmc, pubmed, crossref]);
  assert.equal(result.items.length, 2);
  assert.deepEqual(new Set(result.items[0].retrieval_sources), new Set(["openalex", "europe_pmc", "pubmed"]));
  assert.equal(result.items[0].grade, "B");
  assert.equal(result.diagnostics.duplicate_removed_count, 2);
});

test("retrieval sufficiency reports exclusive contributions and preserves healthy-source rescue", () => {
  const merged = [
    { title: "Shared", doi: "10.1000/shared", retrieval_sources: ["openalex", "semantic_scholar"] },
    { title: "S2 only", doi: "10.1000/s2", retrieval_sources: ["semantic_scholar"] },
  ];
  const summary = buildRetrievalSufficiencySummary({
    openalex: { metrics: { normalized: 0, degraded: false, zeroReason: "healthy_zero" } },
    semantic_scholar: { metrics: { normalized: 2, degraded: false, zeroReason: "" } },
    crossref: { metrics: { normalized: 0, degraded: true, zeroReason: "source_failure" } },
  }, merged, { primarySources: ["openalex"] });
  assert.equal(summary.unionCandidateCount, 2);
  assert.equal(summary.primaryZeroRescued, true);
  assert.equal(summary.zeroReason, "single_source_zero_rescued");
  assert.equal(summary.uniqueContributionBySource.semantic_scholar, 1);
  assert.equal(summary.uniqueContributionBySource.openalex, 0);
  assert.equal(summary.perSource.find((entry) => entry.source === "openalex").uniqueAfterMerge, 1);
});
