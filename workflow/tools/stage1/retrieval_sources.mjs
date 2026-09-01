import { createServiceConcurrencyController } from "../lib/adaptive_concurrency.mjs";
import { normalizeDoi } from "../lib/doi_normalization.mjs";
import { getLiteratureIdentityKeys } from "../lib/literature_identity.mjs";
import { fetchResponseWithRetry } from "./retrieval_step.mjs";
import {
  buildSourceState,
  canonicalQueryHash,
  loadSourceState,
  sourceStatePath,
} from "./source_state.mjs";
import {
  buildSemanticRescueText,
  buildSemanticScholarQueryPlan,
  compileCrossrefRescueQueries,
  compileSearchIntent,
} from "./search_intent.mjs";

export const SEMANTIC_SCHOLAR_ADAPTER_VERSION = "semantic-scholar-bulk-v1";
export const CROSSREF_DISCOVERY_ADAPTER_VERSION = "crossref-bibliographic-v1";
export const EUROPE_PMC_ADAPTER_VERSION = "europe-pmc-cursor-v1";

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function text(value) {
  return String(value || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function authors(values = []) {
  return asArray(values).slice(0, 10).map((entry) => text(entry?.name || [entry?.given, entry?.family].filter(Boolean).join(" "))).filter(Boolean).join(", ");
}

function median(values = []) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function latencySummary(values = []) {
  return { count: values.length, minMs: values.length ? Math.min(...values) : null, medianMs: median(values), maxMs: values.length ? Math.max(...values) : null };
}

function emptyMetrics(source, queryVariantCount = 0) {
  return {
    source,
    queryVariantCount,
    requestCount: 0,
    totalReported: 0,
    fetched: 0,
    normalized: 0,
    uniqueAfterMerge: 0,
    duplicateCount: 0,
    errorCount: 0,
    "429Count": 0,
    zeroReason: "",
    degraded: false,
    latency: latencySummary(),
  };
}

function disabledResult(source, config, reason = "disabled") {
  return { items: [], failed: [], config, audit: [], stateUpdates: [], metrics: { ...emptyMetrics(source), zeroReason: reason }, skipped_reason: reason };
}

function stateEnvelope({ stateRoot, profile, source, adapterVersion, semanticConfig, itemCount, complete, checkedAt, error = "" }) {
  const queryHash = canonicalQueryHash({ adapterVersion, ...semanticConfig });
  const path = sourceStatePath({ stateRoot, profile, source, queryHash });
  return { queryHash, path, itemCount, complete, checkedAt, error };
}

async function finishState(envelope) {
  if (!envelope.path) return [];
  const previous = await loadSourceState(envelope.path);
  const proposal = envelope.complete
    ? { complete: true, itemCount: envelope.itemCount, committed: { completedAt: envelope.checkedAt } }
    : { complete: false, itemCount: envelope.itemCount, failureStage: "paging", error: envelope.error };
  return [{
    path: envelope.path,
    state: buildSourceState({
      previous,
      profile: envelope.profile,
      source: envelope.source,
      queryHash: envelope.queryHash,
      adapterVersion: envelope.adapterVersion,
      proposal,
      checkedAt: envelope.checkedAt,
    }),
  }];
}

function uniqueItems(items = []) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = getLiteratureIdentityKeys(item)[0];
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dateRangeParameter(intent = {}) {
  const from = String(intent.dateRange?.from || "");
  const to = String(intent.dateRange?.to || "");
  if (from && to) return `${from}:${to}`;
  if (from) return `${from}:`;
  if (to) return `:${to}`;
  return "";
}

function adapterController(source, maximum = 2) {
  return createServiceConcurrencyController(`retrieval_${source}`, { minConcurrency: 1, initialConcurrency: maximum, maxConcurrency: maximum });
}

function failureObserver(metrics) {
  return ({ error }) => {
    metrics.errorCount += 1;
    if (Number(error?.status || 0) === 429) metrics["429Count"] += 1;
  };
}

async function fetchJson(url, { fetchImpl, headers = {}, controller, metrics, attempts = 3, timeoutMs = 20000 } = {}) {
  const started = Date.now();
  metrics.requestCount += 1;
  try {
    const response = await fetchResponseWithRetry(url, { fetchImpl, headers, timeoutMs, concurrencyController: controller, onAttemptFailure: failureObserver(metrics) }, attempts);
    return JSON.parse(await response.text());
  } finally {
    metrics._latencies.push(Date.now() - started);
  }
}

export function normalizeSemanticScholarItem(paper = {}) {
  const external = paper.externalIds || {};
  const doi = normalizeDoi(external.DOI || external.doi || "");
  const title = text(paper.title);
  return {
    source: "semantic_scholar",
    source_channel: "semantic_scholar",
    source_platform: "semantic_scholar",
    item_type_hint: "journalArticle",
    title,
    abstract: text(paper.abstract),
    url: text(paper.url) || (doi ? `https://doi.org/${doi}` : ""),
    doi,
    pmid: text(external.PubMed || external.PMID),
    pmcid: text(external.PubMedCentral || external.PMC),
    arxiv: text(external.ArXiv),
    semantic_scholar_id: text(paper.paperId),
    authors: authors(paper.authors),
    publication_year: paper.year || null,
    publication_date: text(paper.publicationDate),
    journal: text(paper.venue),
    publicationTitle: text(paper.venue),
    retrieval_sources: ["semantic_scholar"],
  };
}

export function normalizeCrossrefDiscoveryItem(work = {}) {
  const doi = normalizeDoi(work.DOI || "");
  const title = text(asArray(work.title)[0]);
  const dateParts = asArray(work?.published?.["date-parts"])[0] || [];
  const publicationDate = dateParts.length ? [dateParts[0], String(dateParts[1] || 1).padStart(2, "0"), String(dateParts[2] || 1).padStart(2, "0")].join("-") : "";
  return {
    source: "crossref",
    source_channel: "crossref",
    source_platform: "crossref",
    item_type_hint: "journalArticle",
    title,
    abstract: text(work.abstract),
    url: text(work.URL) || (doi ? `https://doi.org/${doi}` : ""),
    doi,
    pmid: "",
    pmcid: "",
    authors: authors(work.author),
    publication_year: dateParts[0] || null,
    publication_date: publicationDate,
    journal: text(asArray(work["container-title"])[0]),
    publicationTitle: text(asArray(work["container-title"])[0]),
    retrieval_sources: ["crossref"],
  };
}

export function normalizeEuropePmcItem(record = {}) {
  const doi = normalizeDoi(record.doi || "");
  const source = text(record.source).toUpperCase();
  const id = text(record.id);
  return {
    source: "europe_pmc",
    source_channel: "europe_pmc",
    source_platform: "europe_pmc",
    item_type_hint: "journalArticle",
    title: text(record.title),
    abstract: text(record.abstractText),
    url: doi ? `https://doi.org/${doi}` : text(record.pmcid) ? `https://europepmc.org/article/PMC/${record.pmcid}` : "",
    doi,
    pmid: text(record.pmid || (source === "MED" ? id : "")),
    pmcid: text(record.pmcid || (source === "PMC" ? id : "")),
    authors: text(record.authorString),
    publication_year: Number(record.pubYear) || null,
    publication_date: text(record.firstPublicationDate),
    journal: text(record.journalTitle),
    publicationTitle: text(record.journalTitle),
    europe_pmc_source: source,
    europe_pmc_id: id,
    is_preprint: /PPR|PREPRINT/i.test(source) || asArray(record.pubTypeList?.pubType).some((value) => /preprint/i.test(String(value))),
    retrieval_sources: ["europe_pmc"],
  };
}

export async function fetchSemanticScholar(intent, config = {}, { profile = "weekly", stateRoot = "", fetchImpl = globalThis.fetch, now = new Date(), controller = null, apiKey = "" } = {}) {
  const source = "semantic_scholar";
  if (config.enabled !== true) return disabledResult(source, config);
  const requestBudget = Math.max(1, Number(config.request_budget || 4));
  const queryPlan = buildSemanticScholarQueryPlan(intent, {
    maxEncodedUrlLength: Number(config.max_encoded_url_length || 3800),
    maxQueryCharacters: Number(config.max_query_characters || 3500),
    requestBudget,
  });
  const metrics = { ...emptyMetrics(source, queryPlan.variants.length), _latencies: [] };
  if (!queryPlan.variants.length || queryPlan.errors.length) {
    metrics.degraded = true;
    metrics.errorCount = queryPlan.errors.length || 1;
    metrics.zeroReason = "query_compiler_error";
    delete metrics._latencies;
    return { items: [], failed: [{ source, stage: "compiler", error: queryPlan.errors.join(",") || "empty_query" }], config, audit: [{ source, complete: false, queryCompilerDegraded: true }], stateUpdates: [], metrics };
  }
  const maximum = Math.max(1, Math.min(2, Number(config.concurrency || (apiKey ? 2 : 1))));
  const limiter = controller || adapterController(source, maximum);
  const items = [];
  const failed = [];
  let pagesCompleted = 0;
  let totalReported = 0;
  let budgetIncomplete = false;
  try {
    for (const [variantIndex, variant] of queryPlan.variants.entries()) {
      let token = "";
      let variantFetched = 0;
      let variantTotal = 0;
      do {
        if (metrics.requestCount >= requestBudget) {
          budgetIncomplete = true;
          break;
        }
        const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search/bulk");
        url.searchParams.set("query", variant.query);
        url.searchParams.set("fields", "paperId,externalIds,url,title,abstract,venue,year,publicationDate,authors,publicationTypes");
        const range = dateRangeParameter(intent);
        if (range) url.searchParams.set("publicationDateOrYear", range);
        if (token) url.searchParams.set("token", token);
        const headers = apiKey ? { "x-api-key": apiKey } : {};
        const json = await fetchJson(url, { fetchImpl, headers, controller: limiter, metrics });
        if (!Array.isArray(json?.data)) throw new Error("SEMANTIC_SCHOLAR_RESULTS_INVALID");
        variantTotal = Math.max(variantTotal, Number(json.total || 0));
        items.push(...json.data.map(normalizeSemanticScholarItem).filter((item) => item.title));
        variantFetched += json.data.length;
        pagesCompleted += 1;
        token = String(json.token || "");
        if (!token && variantFetched < variantTotal) throw new Error("SEMANTIC_SCHOLAR_PAGINATION_TOKEN_MISSING");
      } while (token);
      totalReported += variantTotal;
      if (token || (metrics.requestCount >= requestBudget && variantIndex < queryPlan.variants.length - 1)) {
        budgetIncomplete = true;
        break;
      }
    }
    if (budgetIncomplete || queryPlan.degradedReasons.includes("semantic_scholar_request_budget_truncated")) throw new Error("SEMANTIC_SCHOLAR_REQUEST_BUDGET_EXCEEDED");
  } catch (error) {
    failed.push({ source, stage: "paging", error: String(error.message || error) });
  }
  const normalized = uniqueItems(items);
  metrics.totalReported = totalReported;
  metrics.fetched = items.length;
  metrics.normalized = normalized.length;
  metrics.duplicateCount = Math.max(0, items.length - normalized.length);
  metrics.errorCount = Math.max(metrics.errorCount, failed.length);
  metrics.degraded = failed.length > 0 || queryPlan.queryDegraded;
  metrics.zeroReason = normalized.length ? "" : failed.length ? "source_failure" : "healthy_zero";
  metrics.latency = latencySummary(metrics._latencies);
  delete metrics._latencies;
  const checkedAt = new Date(now).toISOString();
  const envelope = stateEnvelope({ stateRoot, profile, source, adapterVersion: SEMANTIC_SCHOLAR_ADAPTER_VERSION, semanticConfig: { queries: queryPlan.variants.map((variant) => variant.query), dateRange: intent.dateRange, requestBudget }, itemCount: normalized.length, complete: failed.length === 0, checkedAt, error: failed[0]?.error });
  Object.assign(envelope, { profile, source, adapterVersion: SEMANTIC_SCHOLAR_ADAPTER_VERSION });
  metrics.queryCompilerDegraded = queryPlan.queryDegraded;
  return { items: normalized, failed, config, audit: [{ source, queryHash: envelope.queryHash, complete: failed.length === 0, pagesCompleted, itemCount: normalized.length, totalReported, queryVariantCount: queryPlan.variants.length, queryCompilerDegraded: queryPlan.queryDegraded, degradedReasons: queryPlan.degradedReasons }], stateUpdates: await finishState(envelope), metrics };
}

export async function fetchCrossrefRescue(intent, config = {}, { profile = "weekly", stateRoot = "", fetchImpl = globalThis.fetch, now = new Date(), controller = null } = {}) {
  const source = "crossref";
  if (config.enabled !== true) return disabledResult(source, config);
  const queries = compileCrossrefRescueQueries(intent, { requestBudget: Math.max(1, Number(config.query_budget || 3)) });
  const metrics = { ...emptyMetrics(source, queries.length), _latencies: [] };
  const limiter = controller || adapterController(source, Math.max(1, Math.min(2, Number(config.concurrency || 1))));
  const requestBudget = Math.max(1, Number(config.request_budget || 4));
  const items = [];
  const failed = [];
  let totalReported = 0;
  let pagesCompleted = 0;
  let budgetExhausted = false;
  try {
    for (const [queryIndex, query] of queries.entries()) {
      let cursor = "*";
      while (cursor && metrics.requestCount < requestBudget) {
        const url = new URL("https://api.crossref.org/works");
        url.searchParams.set("query.bibliographic", query);
        url.searchParams.set("rows", String(Math.max(1, Math.min(100, Number(config.per_page || 50)))));
        url.searchParams.set("cursor", cursor);
        url.searchParams.set("select", "DOI,title,URL,author,published,container-title,type,abstract");
        const filters = [];
        if (intent.dateRange?.from) filters.push(`from-pub-date:${intent.dateRange.from}`);
        if (intent.dateRange?.to) filters.push(`until-pub-date:${intent.dateRange.to}`);
        if (filters.length) url.searchParams.set("filter", filters.join(","));
        if (config.mailto) url.searchParams.set("mailto", config.mailto);
        const json = await fetchJson(url, { fetchImpl, controller: limiter, metrics });
        const message = json?.message;
        if (!Array.isArray(message?.items)) throw new Error("CROSSREF_RESULTS_INVALID");
        totalReported = Math.max(totalReported, Number(message["total-results"] || 0));
        items.push(...message.items.map(normalizeCrossrefDiscoveryItem).filter((item) => item.title));
        pagesCompleted += 1;
        const next = String(message["next-cursor"] || "");
        if (!message.items.length || !next || next === cursor) cursor = "";
        else cursor = next;
      }
      if (cursor || (metrics.requestCount >= requestBudget && queryIndex < queries.length - 1)) {
        budgetExhausted = true;
        break;
      }
    }
  } catch (error) {
    failed.push({ source, stage: "paging", error: String(error.message || error) });
  }
  if (budgetExhausted) failed.push({ source, stage: "budget", error: "CROSSREF_REQUEST_BUDGET_EXHAUSTED" });
  const normalized = uniqueItems(items);
  Object.assign(metrics, { totalReported, fetched: items.length, normalized: normalized.length, duplicateCount: Math.max(0, items.length - normalized.length), errorCount: Math.max(metrics.errorCount, failed.length), degraded: failed.length > 0, zeroReason: normalized.length ? "" : failed.length ? "source_failure" : "healthy_zero", latency: latencySummary(metrics._latencies) });
  delete metrics._latencies;
  const checkedAt = new Date(now).toISOString();
  const envelope = stateEnvelope({ stateRoot, profile, source, adapterVersion: CROSSREF_DISCOVERY_ADAPTER_VERSION, semanticConfig: { queries, dateRange: intent.dateRange, requestBudget }, itemCount: normalized.length, complete: failed.length === 0, checkedAt, error: failed[0]?.error });
  Object.assign(envelope, { profile, source, adapterVersion: CROSSREF_DISCOVERY_ADAPTER_VERSION });
  return { items: normalized, failed, config, audit: [{ source, queryHash: envelope.queryHash, complete: failed.length === 0, pagesCompleted, itemCount: normalized.length, totalReported }], stateUpdates: await finishState(envelope), metrics };
}

export async function fetchEuropePmcRescue(intent, config = {}, { profile = "weekly", stateRoot = "", fetchImpl = globalThis.fetch, now = new Date(), controller = null } = {}) {
  const source = "europe_pmc";
  if (config.enabled !== true) return disabledResult(source, config);
  const compiled = compileSearchIntent(intent, source);
  const metrics = { ...emptyMetrics(source, compiled.query ? 1 : 0), _latencies: [] };
  if (!compiled.query || compiled.errors.length) {
    metrics.degraded = true;
    metrics.errorCount = compiled.errors.length || 1;
    metrics.zeroReason = "query_compiler_error";
    delete metrics._latencies;
    return { items: [], failed: [{ source, stage: "compiler", error: compiled.errors.join(",") || "empty_query" }], config, audit: [{ source, complete: false, queryCompilerDegraded: true }], stateUpdates: [], metrics };
  }
  const limiter = controller || adapterController(source, Math.max(1, Math.min(2, Number(config.concurrency || 1))));
  const requestBudget = Math.max(1, Number(config.request_budget || 4));
  const items = [];
  const failed = [];
  let cursor = "*";
  let pagesCompleted = 0;
  let totalReported = 0;
  try {
    do {
      const url = new URL("https://www.ebi.ac.uk/europepmc/webservices/rest/search");
      let query = compiled.query;
      if (intent.dateRange?.from || intent.dateRange?.to) query += ` AND FIRST_PDATE:[${intent.dateRange.from || "0001-01-01"} TO ${intent.dateRange.to || "9999-12-31"}]`;
      if (config.include_preprints !== true) query += " NOT SRC:PPR";
      url.searchParams.set("query", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("resultType", "lite");
      url.searchParams.set("pageSize", String(Math.max(1, Math.min(1000, Number(config.per_page || 100)))));
      url.searchParams.set("cursorMark", cursor);
      url.searchParams.set("synonym", config.synonym === true ? "true" : "false");
      const json = await fetchJson(url, { fetchImpl, controller: limiter, metrics });
      const results = json?.resultList?.result;
      if (!Array.isArray(results)) throw new Error("EUROPE_PMC_RESULTS_INVALID");
      totalReported = Math.max(totalReported, Number(json.hitCount || 0));
      items.push(...results.map(normalizeEuropePmcItem).filter((item) => item.title));
      pagesCompleted += 1;
      const next = String(json.nextCursorMark || "");
      if (!results.length || !next || next === cursor) cursor = "";
      else cursor = next;
    } while (cursor && pagesCompleted < requestBudget);
    if (cursor) throw new Error("EUROPE_PMC_REQUEST_BUDGET_EXCEEDED");
  } catch (error) {
    failed.push({ source, stage: "paging", error: String(error.message || error) });
  }
  const normalized = uniqueItems(items);
  Object.assign(metrics, { totalReported, fetched: items.length, normalized: normalized.length, duplicateCount: Math.max(0, items.length - normalized.length), errorCount: Math.max(metrics.errorCount, failed.length), degraded: failed.length > 0, zeroReason: normalized.length ? "" : failed.length ? "source_failure" : "healthy_zero", latency: latencySummary(metrics._latencies) });
  delete metrics._latencies;
  const checkedAt = new Date(now).toISOString();
  const envelope = stateEnvelope({ stateRoot, profile, source, adapterVersion: EUROPE_PMC_ADAPTER_VERSION, semanticConfig: { query: compiled.query, dateRange: intent.dateRange, includePreprints: config.include_preprints === true, requestBudget }, itemCount: normalized.length, complete: failed.length === 0, checkedAt, error: failed[0]?.error });
  Object.assign(envelope, { profile, source, adapterVersion: EUROPE_PMC_ADAPTER_VERSION });
  return { items: normalized, failed, config, audit: [{ source, queryHash: envelope.queryHash, complete: failed.length === 0, pagesCompleted, itemCount: normalized.length, totalReported }], stateUpdates: await finishState(envelope), metrics };
}

export function buildRetrievalSufficiencySummary(results = {}, mergedItems = [], { primarySources = [], compilerDegraded = false, queryOverConstrained = false } = {}) {
  const sources = Object.entries(results).map(([source, result]) => ({ source, result }));
  const contribution = Object.fromEntries(sources.map(({ source }) => [source, 0]));
  const retained = Object.fromEntries(sources.map(({ source }) => [source, 0]));
  const mergedKeys = new Set(mergedItems.map((item) => getLiteratureIdentityKeys(item)[0]).filter(Boolean));
  for (const item of mergedItems) {
    const provenance = [...new Set(asArray(item.retrieval_sources?.length ? item.retrieval_sources : item.source || item.source_platform || item.source_channel).map(String))];
    for (const source of provenance) {
      if (Object.hasOwn(retained, source)) retained[source] += 1;
    }
    if (provenance.length === 1 && Object.hasOwn(contribution, provenance[0])) contribution[provenance[0]] += 1;
  }
  const perSource = sources.map(({ source, result }) => ({ ...emptyMetrics(source), ...(result.metrics || {}), uniqueAfterMerge: retained[source] || 0 }));
  const primary = perSource.filter((entry) => primarySources.includes(entry.source));
  const healthy = perSource.filter((entry) => !entry.degraded && !/disabled|not_enabled|not_triggered|not_applicable|validation_required/.test(entry.zeroReason));
  const primaryZero = primary.some((entry) => entry.normalized === 0 && !entry.degraded);
  const rescued = primaryZero && healthy.some((entry) => entry.normalized > 0);
  const multiSourceZero = healthy.length > 1 && healthy.every((entry) => entry.normalized === 0);
  return {
    perSource,
    unionCandidateCount: mergedKeys.size,
    uniqueContributionBySource: contribution,
    primaryZeroRescued: rescued,
    multiSourceZero,
    zeroReason: multiSourceZero ? "confirmed_multi_source_zero" : rescued ? "single_source_zero_rescued" : primaryZero ? "primary_zero_unresolved" : "",
    queryOverConstrained,
    queryCompilerDegraded: compilerDegraded,
  };
}

export function openAlexSemanticRescueConfig(intent, config = {}) {
  return {
    enabled: config.semantic_rescue_enabled === true,
    query: buildSemanticRescueText(intent, { maxChars: 2000 }),
    maxResults: Math.min(50, Math.max(1, Number(config.semantic_rescue_max_results || 25))),
  };
}
