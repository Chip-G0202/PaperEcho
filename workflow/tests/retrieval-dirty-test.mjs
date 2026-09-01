#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getLiteratureIdentityKeys } from "../tools/lib/literature_identity.mjs";
import { fetchResponseWithRetry, normalizeOpenAlexItem } from "../tools/stage1/retrieval_step.mjs";
import { dedupWithDiagnostics } from "../tools/stage1/dedupe_step.mjs";
import { normalizeCrossrefDiscoveryItem, normalizeEuropePmcItem, normalizeSemanticScholarItem } from "../tools/stage1/retrieval_sources.mjs";
import { buildOpenAlexQueryPlan, buildSearchIntent, buildSemanticScholarQueryPlan, compileCrossrefRescueQueries, compileSearchIntent } from "../tools/stage1/search_intent.mjs";
import { buildMutationCases, KNOWN_HIT_SENTINEL_SETS, RETRIEVAL_DIRTY_CASES, TIER_1_CASE_IDS } from "./retrieval_dirty_cases.mjs";

const SOURCE_DELAY_MS = 1050;
const lastSourceRequestAt = new Map();

function cliOptions(argv = process.argv.slice(2)) {
  const value = (prefix, fallback = "") => argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || fallback;
  return {
    production: argv.includes("--production"),
    json: argv.includes("--json"),
    tier: Number(value("--tier=", "1")),
    tier2Stable: argv.includes("--tier2-stable"),
    mutations: Math.max(100, Math.min(200, Number(value("--mutations=", "120")) || 120)),
  };
}

function intentFor(entry) {
  return buildSearchIntent({ query: entry.query || "", keywordGroups: entry.keywordGroups || null, domainHints: [entry.domain] });
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)];
}

function sourceResult(source, extra = {}) {
  return { source, candidates: [], success: false, zero: false, status: 0, error: "", requestCount: 0, count: 0, latencyMs: 0, ...extra };
}

async function pace(source) {
  const last = lastSourceRequestAt.get(source) || 0;
  const waitMs = Math.max(0, SOURCE_DELAY_MS - (Date.now() - last));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastSourceRequestAt.set(source, Date.now());
}

async function requestJson(source, url) {
  await pace(source);
  const started = Date.now();
  try {
    const response = await fetchResponseWithRetry(url, { timeoutMs: 20000, fetchImpl: globalThis.fetch }, 1);
    const json = JSON.parse(await response.text());
    return { ok: true, status: response.status, json, latencyMs: Date.now() - started };
  } catch (error) {
    return { ok: false, status: Number(error?.status || 0), error: String(error?.message || error), latencyMs: Date.now() - started };
  }
}

async function probeOpenAlex(intent, requestBudget = 2) {
  const plan = buildOpenAlexQueryPlan(intent, { maxEncodedUrlLength: 3800, baseUrlLength: 500, requestBudget });
  if (!plan.variants.length || plan.errors.length) return sourceResult("openalex", { error: plan.errors.join(",") || "query_compiler_error" });
  const candidates = [];
  let requestCount = 0;
  let latencyMs = 0;
  let status = 0;
  for (const variant of plan.variants.slice(0, requestBudget)) {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set(plan.searchParameter, variant.query);
    url.searchParams.set("per_page", "10");
    url.searchParams.set("select", "id,doi,title,publication_year,publication_date,authorships,primary_location,abstract_inverted_index,open_access,type");
    if (url.toString().length > 4094) return sourceResult("openalex", { candidates, requestCount, count: candidates.length, error: "OPENALEX_URL_LIMIT_GUARD", latencyMs });
    const response = await requestJson("openalex", url);
    requestCount += 1;
    latencyMs += response.latencyMs;
    status = response.status;
    if (!response.ok) return sourceResult("openalex", { candidates, requestCount, count: candidates.length, status, error: response.error, latencyMs });
    if (!Array.isArray(response.json?.results)) return sourceResult("openalex", { candidates, requestCount, count: candidates.length, status, error: "OPENALEX_RESULTS_INVALID", latencyMs });
    candidates.push(...response.json.results.map(normalizeOpenAlexItem).filter((item) => item.title));
  }
  const unique = dedupWithDiagnostics(candidates).items;
  return sourceResult("openalex", { candidates: unique, success: true, zero: unique.length === 0, status, requestCount, count: unique.length, latencyMs, compilerDegraded: plan.queryDegraded });
}

async function probeSemanticScholar(intent) {
  const plan = buildSemanticScholarQueryPlan(intent, { requestBudget: 2 });
  if (!plan.variants.length || plan.errors.length) return sourceResult("semantic_scholar", { error: plan.errors.join(",") || "query_compiler_error" });
  const candidates = [];
  let requestCount = 0;
  let latencyMs = 0;
  let status = 0;
  for (const variant of plan.variants) {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search/bulk");
    url.searchParams.set("query", variant.query);
    url.searchParams.set("fields", "paperId,externalIds,title,year");
    const response = await requestJson("semantic_scholar", url);
    requestCount += 1;
    latencyMs += response.latencyMs;
    status = response.status;
    if (!response.ok) return sourceResult("semantic_scholar", { candidates, requestCount, count: candidates.length, status, error: response.error, latencyMs });
    if (!Array.isArray(response.json?.data)) return sourceResult("semantic_scholar", { candidates, requestCount, count: candidates.length, status, error: "SEMANTIC_SCHOLAR_RESULTS_INVALID", latencyMs });
    candidates.push(...response.json.data.map(normalizeSemanticScholarItem).filter((item) => item.title));
  }
  const unique = dedupWithDiagnostics(candidates).items;
  return sourceResult("semantic_scholar", { candidates: unique, success: true, zero: unique.length === 0, status, requestCount, count: unique.length, latencyMs, compilerDegraded: plan.queryDegraded });
}

async function probeCrossref(intent) {
  const query = compileCrossrefRescueQueries(intent, { requestBudget: 1 })[0];
  if (!query) return sourceResult("crossref", { error: "crossref_anchor_unavailable" });
  const url = new URL("https://api.crossref.org/works");
  url.searchParams.set("query.bibliographic", query);
  url.searchParams.set("rows", "10");
  url.searchParams.set("select", "DOI,title,URL,author,published,container-title,type,abstract");
  const response = await requestJson("crossref", url);
  if (!response.ok) return sourceResult("crossref", { requestCount: 1, status: response.status, error: response.error, latencyMs: response.latencyMs });
  const items = response.json?.message?.items;
  if (!Array.isArray(items)) return sourceResult("crossref", { requestCount: 1, status: response.status, error: "CROSSREF_RESULTS_INVALID", latencyMs: response.latencyMs });
  const candidates = dedupWithDiagnostics(items.map(normalizeCrossrefDiscoveryItem).filter((item) => item.title)).items;
  return sourceResult("crossref", { candidates, success: true, zero: candidates.length === 0, status: response.status, requestCount: 1, count: candidates.length, latencyMs: response.latencyMs });
}

async function probePubMed(intent) {
  const compiled = compileSearchIntent(intent, "pubmed");
  if (!compiled.query || compiled.errors.length) return sourceResult("pubmed", { error: compiled.errors.join(",") || "query_compiler_error" });
  const url = new URL("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi");
  url.searchParams.set("db", "pubmed");
  url.searchParams.set("retmode", "json");
  url.searchParams.set("retmax", "20");
  url.searchParams.set("sort", "relevance");
  url.searchParams.set("term", compiled.query);
  const response = await requestJson("pubmed", url);
  if (!response.ok) return sourceResult("pubmed", { requestCount: 1, status: response.status, error: response.error, latencyMs: response.latencyMs });
  const ids = response.json?.esearchresult?.idlist;
  if (!Array.isArray(ids)) return sourceResult("pubmed", { requestCount: 1, status: response.status, error: "PUBMED_RESULTS_INVALID", latencyMs: response.latencyMs });
  const candidates = ids.map((pmid) => ({ source: "pubmed", source_platform: "pubmed", retrieval_sources: ["pubmed"], title: `PMID ${pmid}`, pmid: String(pmid) }));
  return sourceResult("pubmed", { candidates, success: true, zero: candidates.length === 0, status: response.status, requestCount: 1, count: candidates.length, latencyMs: response.latencyMs });
}

async function probeEuropePmc(intent, { includePreprints = true } = {}) {
  const compiled = compileSearchIntent(intent, "europe_pmc");
  if (!compiled.query || compiled.errors.length) return sourceResult("europe_pmc", { error: compiled.errors.join(",") || "query_compiler_error" });
  const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
  url.searchParams.set("query", `${compiled.query}${includePreprints ? "" : " NOT SRC:PPR"}`);
  url.searchParams.set("format", "json");
  url.searchParams.set("resultType", "lite");
  url.searchParams.set("pageSize", "20");
  url.searchParams.set("cursorMark", "*");
  const response = await requestJson("europe_pmc", url);
  if (!response.ok) return sourceResult("europe_pmc", { requestCount: 1, status: response.status, error: response.error, latencyMs: response.latencyMs });
  const items = response.json?.resultList?.result;
  if (!Array.isArray(items)) return sourceResult("europe_pmc", { requestCount: 1, status: response.status, error: "EUROPE_PMC_RESULTS_INVALID", latencyMs: response.latencyMs });
  const candidates = dedupWithDiagnostics(items.map(normalizeEuropePmcItem).filter((item) => item.title)).items;
  return sourceResult("europe_pmc", { candidates, success: true, zero: candidates.length === 0, status: response.status, requestCount: 1, count: candidates.length, latencyMs: response.latencyMs });
}

function unionResults(results) {
  const raw = results.flatMap((result) => result.candidates || []);
  const mergedResult = dedupWithDiagnostics(raw);
  const merged = mergedResult.items;
  const uniqueContributions = {};
  for (const result of results) uniqueContributions[result.source] = 0;
  for (const item of merged) {
    const provenance = [...new Set(item.retrieval_sources || [])];
    if (provenance.length === 1 && Object.hasOwn(uniqueContributions, provenance[0])) uniqueContributions[provenance[0]] += 1;
  }
  return { raw, merged, uniqueContributions, duplicateCount: mergedResult.diagnostics.duplicate_removed_count };
}

async function productionQuery(entry, { forceSupplements = false } = {}) {
  const intent = intentFor(entry);
  const compilerGate = compileSearchIntent(intent, entry.domain === "biomedical" ? "pubmed" : "openalex");
  if (compilerGate.errors.length) {
    const result = sourceResult("compiler", { error: compilerGate.errors.join(",") });
    return { id: entry.id, label: entry.label, results: [result], union: unionResults([result]), singleSourceZeroRescued: false, confirmedMultiSourceZero: false, requestCount: 0 };
  }
  const results = entry.domain === "biomedical"
    ? [await probePubMed(intent)]
    : await Promise.all([probeOpenAlex(intent), probeSemanticScholar(intent)]);
  if (entry.domain === "biomedical" && (forceSupplements || results[0].zero)) results.push(await probeEuropePmc(intent));
  const healthyGeneral = results.filter((result) => result.success);
  if (entry.domain !== "biomedical" && (forceSupplements || (healthyGeneral.length > 0 && healthyGeneral.every((result) => result.zero)))) results.push(await probeCrossref(intent));
  const union = unionResults(results);
  const healthy = results.filter((result) => result.success);
  const healthyZeros = healthy.filter((result) => result.zero);
  return {
    id: entry.id,
    label: entry.label,
    results,
    union,
    singleSourceZeroRescued: healthyZeros.length > 0 && healthy.some((result) => result.count > 0),
    confirmedMultiSourceZero: healthy.length > 1 && healthy.every((result) => result.zero),
    requestCount: results.reduce((sum, result) => sum + result.requestCount, 0),
  };
}

function sentinelHits(run, sentinelSet) {
  const perSource = {};
  for (const result of run.results) {
    const keys = new Set((result.candidates || []).flatMap(getLiteratureIdentityKeys));
    perSource[result.source] = sentinelSet.identifiers.filter((identifier) => keys.has(identifier.toLowerCase()));
  }
  const unionKeys = new Set(run.union.merged.flatMap(getLiteratureIdentityKeys));
  return { set: sentinelSet.id, expected: sentinelSet.identifiers.length, perSource, union: sentinelSet.identifiers.filter((identifier) => unionKeys.has(identifier.toLowerCase())) };
}

function aggregate(queryRuns, sentinelRuns, tier) {
  const sources = {};
  for (const run of [...queryRuns, ...sentinelRuns.map((entry) => entry.run)]) {
    for (const result of run.results) {
      const stats = sources[result.source] ||= { queries: 0, success: 0, zero: 0, errors: 0, "429": 0, candidateCounts: [], uniqueContributions: 0, sentinelHits: 0, requests: 0 };
      stats.queries += 1;
      stats.success += result.success ? 1 : 0;
      stats.zero += result.success && result.zero ? 1 : 0;
      stats.errors += result.success ? 0 : 1;
      stats["429"] += result.status === 429 ? 1 : 0;
      if (result.success) stats.candidateCounts.push(result.count);
      stats.uniqueContributions += run.union.uniqueContributions[result.source] || 0;
      stats.requests += result.requestCount;
    }
  }
  for (const entry of sentinelRuns) {
    for (const [source, hits] of Object.entries(entry.hits.perSource)) if (sources[source]) sources[source].sentinelHits += hits.length;
  }
  const perSource = Object.fromEntries(Object.entries(sources).map(([source, stats]) => [source, {
    queries: stats.queries,
    success: stats.success,
    zero: stats.zero,
    zeroRate: stats.success ? Number((stats.zero / stats.success).toFixed(4)) : null,
    errors: stats.errors,
    "429": stats["429"],
    medianCandidateCount: percentile(stats.candidateCounts, 0.5),
    p10CandidateCount: percentile(stats.candidateCounts, 0.1),
    uniqueContributions: stats.uniqueContributions,
    sentinelHits: stats.sentinelHits,
    requests: stats.requests,
  }]));
  const expectedSentinels = sentinelRuns.reduce((sum, entry) => sum + entry.hits.expected, 0);
  const unionSentinelHits = sentinelRuns.reduce((sum, entry) => sum + entry.hits.union.length, 0);
  const perSourceSentinelTotals = Object.fromEntries(Object.entries(perSource).map(([source, stats]) => [source, stats.sentinelHits]));
  const bestSingleSourceHits = Math.max(0, ...Object.values(perSourceSentinelTotals));
  const totalRaw = queryRuns.reduce((sum, run) => sum + run.union.raw.length, 0);
  const totalUnique = queryRuns.reduce((sum, run) => sum + run.union.merged.length, 0);
  const totalRequests = [...queryRuns, ...sentinelRuns.map((entry) => entry.run)].reduce((sum, run) => sum + run.requestCount, 0);
  const queryHealthy = queryRuns.filter((run) => run.results.some((result) => result.success)).length;
  return {
    mode: "production_read_only",
    tier,
    dirtyQueries: queryRuns.length,
    sentinelSets: sentinelRuns.length,
    perSource,
    overall: {
      singleSourceZeroCases: queryRuns.filter((run) => run.results.some((result) => result.success && result.zero)).length,
      rescuedZeroCases: queryRuns.filter((run) => run.singleSourceZeroRescued).length,
      confirmedMultiSourceZeroCases: queryRuns.filter((run) => run.confirmedMultiSourceZero).length,
      knownHitRecall: expectedSentinels ? Number((unionSentinelHits / expectedSentinels).toFixed(4)) : null,
      unionSentinelHits,
      expectedSentinels,
      bestSingleSourceSentinelHits: bestSingleSourceHits,
      unionNotBelowBestSingleSource: unionSentinelHits >= bestSingleSourceHits,
      unionUniqueCandidates: totalUnique,
      dedupeRatio: totalRaw ? Number(((totalRaw - totalUnique) / totalRaw).toFixed(4)) : 0,
      maxRequestsPerQuery: Math.max(0, ...queryRuns.map((run) => run.requestCount)),
      totalRequests,
      healthyQueryRate: queryRuns.length ? Number((queryHealthy / queryRuns.length).toFixed(4)) : 0,
    },
    rescuedCases: queryRuns.filter((run) => run.singleSourceZeroRescued).map((run) => run.id),
    confirmedMultiSourceZeroCases: queryRuns.filter((run) => run.confirmedMultiSourceZero).map((run) => run.id),
    failures: queryRuns.flatMap((run) => run.results.filter((result) => !result.success).map((result) => ({ id: run.id, source: result.source, status: result.status, error: result.error }))).slice(0, 50),
    sentinels: sentinelRuns.map((entry) => entry.hits),
    stable: queryHealthy / Math.max(1, queryRuns.length) >= 0.8 && unionSentinelHits >= bestSingleSourceHits && Math.max(0, ...queryRuns.map((run) => run.requestCount)) <= 5,
  };
}

export function runFixtureDirtyTest() {
  const cases = RETRIEVAL_DIRTY_CASES.map((entry) => {
    const intent = intentFor(entry);
    const compiled = compileSearchIntent(intent, entry.domain === "biomedical" ? "pubmed" : "openalex");
    const plan = entry.domain === "biomedical" ? null : buildOpenAlexQueryPlan(intent, { maxEncodedUrlLength: 3800, baseUrlLength: 500, requestBudget: 4 });
    return { id: entry.id, expectedCompilerError: entry.expectCompilerError === true, compilerError: compiled.errors.length > 0, variants: plan?.variants.length || 1, degraded: compiled.queryDegraded || plan?.queryDegraded || false };
  });
  return {
    mode: "fixture_compiler",
    dirtyQueries: cases.length,
    expectedCompilerErrors: cases.filter((entry) => entry.expectedCompilerError).length,
    unexpectedCompilerErrors: cases.filter((entry) => entry.compilerError !== entry.expectedCompilerError).map((entry) => entry.id),
    maxQueryVariants: Math.max(...cases.map((entry) => entry.variants)),
    sentinelSets: KNOWN_HIT_SENTINEL_SETS.length,
    mutationVariants: buildMutationCases(120).length,
    stable: cases.every((entry) => entry.compilerError === entry.expectedCompilerError) && Math.max(...cases.map((entry) => entry.variants)) <= 4,
  };
}

export async function runProductionDirtyTest({ tier = 1, tier2Stable = false, mutations = 120 } = {}) {
  if (![1, 2, 3].includes(tier)) throw new Error("TIER_MUST_BE_1_2_OR_3");
  if (tier === 3 && !tier2Stable) throw new Error("TIER_3_REQUIRES_CONFIRMED_TIER_2_STABILITY");
  const entries = tier === 1
    ? RETRIEVAL_DIRTY_CASES.filter((entry) => TIER_1_CASE_IDS.includes(entry.id))
    : tier === 2 ? RETRIEVAL_DIRTY_CASES : buildMutationCases(mutations);
  const queryRuns = [];
  for (const entry of entries) queryRuns.push(await productionQuery(entry));
  const sentinelRuns = [];
  if (tier <= 2) {
    const sentinelSets = tier === 1
      ? KNOWN_HIT_SENTINEL_SETS.filter((entry) => ["graphene", "checkpoint_immunotherapy", "alphafold", "ai_medical_imaging"].includes(entry.id))
      : KNOWN_HIT_SENTINEL_SETS;
    for (const sentinelSet of sentinelSets) {
      const entry = { id: `sentinel:${sentinelSet.id}`, label: sentinelSet.id, domain: sentinelSet.domain === "biomedical" ? "biomedical" : "general", query: sentinelSet.query };
      const run = await productionQuery(entry, { forceSupplements: true });
      sentinelRuns.push({ run, hits: sentinelHits(run, sentinelSet) });
    }
  }
  return aggregate(queryRuns, sentinelRuns, tier);
}

async function main() {
  const options = cliOptions();
  const summary = options.production
    ? await runProductionDirtyTest({ tier: options.tier, tier2Stable: options.tier2Stable, mutations: options.mutations })
    : runFixtureDirtyTest();
  process.stdout.write(`${JSON.stringify(summary, null, options.json ? 2 : 0)}\n`);
  if (!summary.stable) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) await main();
