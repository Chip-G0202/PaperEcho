import test from "node:test";
import assert from "node:assert/strict";

import { buildOpenAlexQueryPlan, buildSearchIntent, compileSearchIntent } from "../tools/stage1/search_intent.mjs";
import { buildMutationCases, KNOWN_HIT_SENTINEL_SETS, RETRIEVAL_DIRTY_CASES, TIER_1_CASE_IDS } from "./retrieval_dirty_cases.mjs";

function intentFor(entry) {
  return buildSearchIntent({
    query: entry.query || "",
    keywordGroups: entry.keywordGroups || null,
    domainHints: [entry.domain],
  });
}

test("dirty corpus covers exactly the 45 required query families with a bounded Tier 1", () => {
  assert.equal(RETRIEVAL_DIRTY_CASES.length, 45);
  assert.deepEqual(RETRIEVAL_DIRTY_CASES.map((entry) => entry.id), Array.from({ length: 45 }, (_, index) => index + 1));
  assert.equal(TIER_1_CASE_IDS.length, 15);
  assert.ok(TIER_1_CASE_IDS.every((id) => RETRIEVAL_DIRTY_CASES.some((entry) => entry.id === id)));
});

test("all dirty queries compile source-specifically or fail closed only where declared", () => {
  for (const entry of RETRIEVAL_DIRTY_CASES) {
    const intent = intentFor(entry);
    const openalex = compileSearchIntent(intent, "openalex");
    const semanticScholar = compileSearchIntent(intent, "semantic_scholar");
    const biomedical = compileSearchIntent(intent, "pubmed");
    if (entry.expectCompilerError) {
      assert.ok(openalex.errors.length > 0, `${entry.id}:${entry.label} must fail closed`);
      continue;
    }
    assert.equal(openalex.errors.length, 0, `${entry.id}:${entry.label}: OpenAlex`);
    assert.equal(semanticScholar.errors.length, 0, `${entry.id}:${entry.label}: Semantic Scholar`);
    assert.equal(biomedical.errors.length, 0, `${entry.id}:${entry.label}: PubMed`);
    assert.ok(openalex.query, `${entry.id}:${entry.label}: non-empty OpenAlex query`);
    if (entry.expectDegraded) assert.ok(openalex.degradedReasons.includes(entry.expectDegraded), `${entry.id}:${entry.label}: declared degradation`);
  }
});

test("near and over-limit OpenAlex queries are measured, chunked deterministically, and bounded", () => {
  for (const entry of RETRIEVAL_DIRTY_CASES.filter((candidate) => [25, 26].includes(candidate.id))) {
    const intent = intentFor(entry);
    const first = buildOpenAlexQueryPlan(intent, { maxEncodedUrlLength: 3800, baseUrlLength: 500, requestBudget: 4 });
    const second = buildOpenAlexQueryPlan(intent, { maxEncodedUrlLength: 3800, baseUrlLength: 500, requestBudget: 4 });
    assert.deepEqual(first, second);
    assert.ok(first.variants.length >= 1 && first.variants.length <= 4);
    assert.ok(first.variants.every((variant) => 500 + encodeURIComponent(variant.query).length <= 3800));
    if (entry.expectChunking) assert.ok(first.degradedReasons.includes("openalex_query_chunked"));
  }
});

test("known-hit bank contains five general, five biomedical, and three interdisciplinary public sets", () => {
  const counts = KNOWN_HIT_SENTINEL_SETS.reduce((acc, entry) => ({ ...acc, [entry.domain]: (acc[entry.domain] || 0) + 1 }), {});
  assert.equal(counts.general, 5);
  assert.equal(counts.biomedical, 5);
  assert.equal(counts.interdisciplinary, 3);
  for (const entry of KNOWN_HIT_SENTINEL_SETS) {
    assert.ok(entry.identifiers.length >= 3 && entry.identifiers.length <= 10, entry.id);
    assert.ok(entry.identifiers.every((value) => /^(doi|pmid):\S+$/i.test(value)), entry.id);
  }
});

test("Tier 3 mutation corpus is deterministic and strictly bounded", () => {
  const first = buildMutationCases(120);
  const second = buildMutationCases(120);
  assert.equal(first.length, 120);
  assert.deepEqual(first, second);
  assert.ok(first.every((entry) => entry.keywordGroups.required.length === 2));
});
