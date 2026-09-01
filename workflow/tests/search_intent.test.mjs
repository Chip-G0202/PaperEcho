import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenAlexQueryPlan,
  buildQueryHealthProbes,
  buildSearchIntent,
  buildSemanticScholarQueryPlan,
  buildSemanticRescueText,
  compileCrossrefRescueQueries,
  compileSearchIntent,
  parseSearchExpression,
  tokenizeSearchQuery,
} from "../tools/stage1/search_intent.mjs";

function groupedIntent() {
  return buildSearchIntent({
    query: "legacy raw value must not win",
    keywordGroups: {
      required: [
        ["single-cell RNA sequencing", "scRNA-seq", "scRNAseq"],
        ["cancer", "tumor", "neoplasm"],
      ],
      optional: ["spatial transcriptomics"],
      negative: ["protocol"],
    },
    dateRange: { from: "2026-01-01", to: "2026-08-31" },
    publicationTypes: ["article"],
    domainHints: ["biomedical"],
  });
}

test("structured keyword groups preserve synonym OR and required-group AND", () => {
  const intent = groupedIntent();
  const compiled = compileSearchIntent(intent, "openalex");
  assert.match(compiled.query, /single-cell RNA sequencing OR scRNA-seq OR scRNAseq/);
  assert.match(compiled.query, /\) AND \(/);
  assert.match(compiled.query, /NOT protocol/);
  assert.doesNotMatch(compiled.query, /spatial transcriptomics/);
  assert.equal(intent.optionalTerms[0].value, "spatial transcriptomics");
});

test("raw Boolean query normalizes operator case and retains nested precedence", () => {
  const intent = buildSearchIntent({ query: '(graph neural network or GNN) and (climate OR energy) not survey' });
  assert.deepEqual(intent.parseErrors, []);
  const openalex = compileSearchIntent(intent, "openalex");
  assert.match(openalex.query, /\(graph AND neural AND network\) OR GNN/);
  assert.match(openalex.query, /climate OR energy/);
  assert.match(openalex.query, /NOT survey/);
});

test("quoted phrases and punctuation remain terms while unmatched syntax fails closed", () => {
  const tokens = tokenizeSearchQuery('"T-cell therapy" AND TP53(R175H) AND IL-6/STAT3');
  assert.deepEqual(tokens.filter((token) => token.type === "TERM").map((token) => token.value), ["T-cell therapy", "TP53(R175H)", "IL-6/STAT3"]);
  assert.deepEqual(parseSearchExpression('(cancer OR tumor').errors, ["unclosed_parenthesis"]);
  assert.deepEqual(parseSearchExpression('"unclosed phrase').errors, ["unclosed_quote"]);
});

test("Semantic Scholar uses bulk Boolean syntax and expands hyphenated terms", () => {
  const compiled = compileSearchIntent(groupedIntent(), "semantic_scholar");
  assert.match(compiled.query, /\|/);
  assert.match(compiled.query, /\+/);
  assert.match(compiled.query, /-protocol/);
  assert.match(compiled.query, /"scRNA seq"/);
  assert.ok(compiled.hyphenExpansions > 0);
});

test("OpenAlex current search wildcard is preserved and malformed wildcard is not silent", () => {
  const intent = buildSearchIntent({ query: "neuro* AND cancer" });
  const valid = compileSearchIntent(intent, "openalex");
  assert.equal(valid.queryDegraded, false);
  assert.match(valid.query, /neuro\* AND cancer/);
  assert.equal(buildOpenAlexQueryPlan(intent).searchParameter, "search.exact");
  const malformed = compileSearchIntent(buildSearchIntent({ query: "can*cer" }), "openalex");
  assert.ok(malformed.errors.includes("malformed_wildcard"));
});

test("Semantic Scholar has an independent 4094-byte request-line guard", () => {
  const terms = Array.from({ length: 110 }, (_, index) => `material-term-${String(index).padStart(3, "0")}`);
  const intent = buildSearchIntent({ keywordGroups: { required: [terms] } });
  const plan = buildSemanticScholarQueryPlan(intent, { maxEncodedUrlLength: 3800, baseUrlLength: 350, requestBudget: 4 });
  assert.ok(plan.variants.length > 1 && plan.variants.length <= 4);
  assert.ok(plan.variants.every((variant) => 350 + encodeURIComponent(variant.query).length <= 3800));
  assert.ok(plan.degradedReasons.includes("semantic_scholar_query_chunked"));
  assert.equal(plan.queryDegraded, false, "fully represented chunks are not semantic degradation");
});

test("OpenAlex over-length groups chunk deterministically within a hard request budget", () => {
  const terms = Array.from({ length: 120 }, (_, index) => `long-synonym-${String(index).padStart(3, "0")}`);
  const intent = buildSearchIntent({ keywordGroups: { required: [terms, ["cancer", "tumor"]] } });
  const plan = buildOpenAlexQueryPlan(intent, { maxEncodedUrlLength: 550, baseUrlLength: 150, requestBudget: 4 });
  assert.equal(plan.queryDegraded, true);
  assert.ok(plan.variants.length > 0 && plan.variants.length <= 4);
  assert.ok(plan.variants.every((variant) => 150 + encodeURIComponent(variant.query).length <= 550));
  assert.ok(plan.degradedReasons.includes("openalex_query_chunked"));
  assert.ok(plan.degradedReasons.includes("openalex_request_budget_truncated"));
});

test("query-health probes are bounded and never become candidate assertions", () => {
  const probes = buildQueryHealthProbes(groupedIntent(), { requestBudget: 3 });
  assert.equal(probes.length, 3);
  assert.deepEqual(probes.map((probe) => probe.kind), ["required_group", "required_group", "required_pair"]);
  assert.ok(probes.every((probe) => !Object.hasOwn(probe, "items")));
});

test("Crossref rescue uses a few high-information anchors rather than raw Boolean", () => {
  const queries = compileCrossrefRescueQueries(groupedIntent(), { requestBudget: 2 });
  assert.deepEqual(queries, ["single-cell RNA sequencing neoplasm"]);
  assert.ok(queries.every((query) => !/[()]/.test(query) && !/\b(?:AND|OR|NOT)\b/.test(query)));
});

test("semantic rescue text is stable, bounded, and does not assign a grade", () => {
  const text = buildSemanticRescueText(groupedIntent(), { maxChars: 120 });
  assert.ok(text.length <= 120);
  assert.match(text, /^Research about/);
  assert.doesNotMatch(text, /\bgrade\b|A课题相关/);
});
