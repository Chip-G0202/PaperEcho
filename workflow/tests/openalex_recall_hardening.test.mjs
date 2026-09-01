import test from "node:test";
import assert from "node:assert/strict";

import { fetchOpenAlex } from "../tools/stage1/retrieval_step.mjs";

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "" },
    text: async () => JSON.stringify(value),
  };
}

function config(overrides = {}) {
  return {
    enabled: true,
    query: "",
    keyword_groups: { required: [["graphene"], ["medieval liturgy"]] },
    days_back: 10,
    overlap_days: 3,
    per_page: 10,
    request_budget: 6,
    diagnostic_probe_budget: 3,
    diagnostics_enabled: true,
    semantic_rescue_enabled: false,
    filters: { type: "article", concepts: [] },
    sort: "relevance_score:desc",
    select: "id,doi,title,publication_year,publication_date,authorships,primary_location,abstract_inverted_index,open_access,type",
    ...overrides,
  };
}

function work(id, doi = `10.1000/${id}`) {
  return { id: `https://openalex.org/${id}`, doi: `https://doi.org/${doi}`, title: `Work ${id}`, authorships: [], primary_location: null, open_access: { is_oa: false } };
}

test("OpenAlex zero diagnostics distinguish over-constraint without admitting probe hits", async () => {
  const result = await fetchOpenAlex(config(), {
    now: new Date("2026-01-01T00:00:00Z"),
    fetchImpl: async (rawUrl) => {
      const query = new URL(rawUrl).searchParams.get("search");
      const count = query === "graphene" || query === "medieval liturgy" ? 10 : 0;
      return jsonResponse({ meta: { count, next_cursor: null }, results: [] });
    },
  });
  assert.equal(result.items.length, 0);
  assert.equal(result.audit[0].queryOverConstrained, true);
  assert.equal(result.metrics.zeroReason, "query_over_constrained");
  assert.equal(result.audit[0].probeResults.length, 3);
});

test("OpenAlex semantic rescue runs only after keyword zero and remains an ordinary candidate", async () => {
  const parameters = [];
  const result = await fetchOpenAlex(config({ diagnostics_enabled: false, semantic_rescue_enabled: true, semantic_rescue_max_results: 5 }), {
    now: new Date("2026-01-01T00:00:00Z"),
    fetchImpl: async (rawUrl) => {
      const url = new URL(rawUrl);
      parameters.push(url.searchParams.has("search.semantic") ? "search.semantic" : "search");
      return url.searchParams.has("search.semantic")
        ? jsonResponse({ meta: { count: 1 }, results: [work("W-semantic")] })
        : jsonResponse({ meta: { count: 0, next_cursor: null }, results: [] });
    },
  });
  assert.deepEqual(parameters, ["search", "search.semantic"]);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].grade, undefined);
  assert.equal(result.audit[0].semanticRescueUsed, true);
  assert.equal(result.metrics.zeroReason, "primary_zero_rescued_semantic");
});

test("OpenAlex truncated query plan retains partial items but cannot advance source state", async () => {
  const terms = Array.from({ length: 120 }, (_, index) => `long-synonym-${String(index).padStart(3, "0")}`);
  const result = await fetchOpenAlex(config({ keyword_groups: { required: [terms, ["cancer"]] }, request_budget: 1, diagnostics_enabled: false }), {
    stateRoot: "state",
    now: new Date("2026-01-01T00:00:00Z"),
    fetchImpl: async () => jsonResponse({ meta: { count: 1, next_cursor: null }, results: [work("W-partial")] }),
  });
  assert.equal(result.items.length, 1);
  assert.equal(result.audit[0].complete, false);
  assert.equal(result.audit[0].queryCompilerDegraded, true);
  assert.match(result.failed[0].error, /QUERY_REQUEST_BUDGET_TRUNCATED/);
  assert.equal(result.stateUpdates[0].state.committed, null);
});

test("OpenAlex wildcard queries use search.exact in the real request shape", async () => {
  let requestUrl;
  const result = await fetchOpenAlex(config({ query: "electrocatal* AND hydrogen", keyword_groups: null, diagnostics_enabled: false }), {
    now: new Date("2026-01-01T00:00:00Z"),
    fetchImpl: async (rawUrl) => {
      requestUrl = new URL(rawUrl);
      return jsonResponse({ meta: { count: 1, next_cursor: null }, results: [work("W-wildcard")] });
    },
  });
  assert.equal(requestUrl.searchParams.has("search.exact"), true);
  assert.equal(requestUrl.searchParams.has("search"), false);
  assert.equal(result.items.length, 1);
});
