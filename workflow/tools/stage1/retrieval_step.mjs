import { XMLParser, XMLValidator } from "fast-xml-parser";
import { createServiceConcurrencyController, parseServerDelayMs } from "../lib/adaptive_concurrency.mjs";
import { buildNcbiESearchUrl, loadOpenAlexConfig, loadPubMedPmcSearchConfig, loadRssSources } from "../lib/literature_config.mjs";
import { cleanJournalName, inferJournalFromUrlSync } from "../lib/journal_name_cleaner.mjs";
import { getLiteratureIdentityKeys } from "../lib/literature_identity.mjs";
import { buildOpenAlexQueryPlan, buildQueryHealthProbes, buildSearchIntent, buildSemanticRescueText, openAlexSearchParameterForQuery } from "./search_intent.mjs";
import {
  buildSourceState,
  canonicalQueryHash,
  loadSourceState,
  sanitizeSourceUrl,
  sourceStatePath,
} from "./source_state.mjs";

const RSS_ADAPTER_VERSION = "rss-fast-xml-parser-v1";
const NCBI_ADAPTER_VERSION = "ncbi-esearch-efetch-v1";
const OPENALEX_ADAPTER_VERSION = "openalex-intent-cursor-v2";
const SOURCE_HTTP_MAX_CONCURRENCY = 4;
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
  parseTagValue: false,
  trimValues: true,
  processEntities: true,
});

function resolveSourceHttpController(existing = null, service = "source_http") {
  return existing || createServiceConcurrencyController(service, {
    minConcurrency: 1,
    initialConcurrency: SOURCE_HTTP_MAX_CONCURRENCY,
    maxConcurrency: SOURCE_HTTP_MAX_CONCURRENCY,
  });
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function cleanText(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/<\/?(?:a|b|br|div|em|i|p|span|strong)\b[^>]*>/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function xmlText(value) {
  if (value == null) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return cleanText(value);
  if (Array.isArray(value)) {
    const fragments = [];
    const seen = new Set();
    for (const entry of value) {
      const text = cleanText(xmlText(entry));
      if (!text || seen.has(text)) continue;
      seen.add(text);
      fragments.push(text);
    }
    return cleanText(fragments.join(" "));
  }
  if (typeof value === "object") {
    if (value["#text"] != null) return cleanText(value["#text"]);
    return cleanText(Object.entries(value)
      .filter(([key]) => !key.startsWith("@_"))
      .map(([, entry]) => xmlText(entry))
      .filter(Boolean)
      .join(" "));
  }
  return "";
}

function parseXml(xml, label) {
  const validity = XMLValidator.validate(String(xml || ""));
  if (validity !== true) throw new Error(`${label}_XML_INVALID`);
  return xmlParser.parse(xml);
}

function responseHeader(response, name) {
  return response?.headers?.get?.(name) || "";
}

export async function fetchResponse(url, { timeoutMs = 15000, headers = {}, method = "GET", body, fetchImpl = globalThis.fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: "follow", headers, method, ...(body === undefined ? {} : { body }) });
    if (!response.ok && response.status !== 304) {
      const error = new Error(`HTTP_${response.status}`);
      error.status = response.status;
      error.retryAfterMs = parseServerDelayMs(responseHeader(response, "Retry-After"));
      error.backoffMs = parseServerDelayMs(responseHeader(response, "Backoff"));
      throw error;
    }
    const responseBody = response.status === 304 ? "" : await response.text();
    return { ok: response.ok, status: response.status, headers: response.headers, text: async () => responseBody };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchResponseWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  const retryDelayMs = options.retryDelayMs ?? (options.fetchImpl === globalThis.fetch ? 600 : 0);
  const concurrencyController = options.concurrencyController || null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const startedAt = Date.now();
    try {
      const execute = () => fetchResponse(url, options);
      const response = concurrencyController && options.controllerSlotOwned !== true
        ? await concurrencyController.run(execute, { observe: false })
        : await execute();
      const backoffMs = parseServerDelayMs(responseHeader(response, "Backoff"));
      if (backoffMs > 0) concurrencyController?.recordServerDirective({ backoffMs });
      concurrencyController?.recordSuccess(Date.now() - startedAt);
      return response;
    } catch (error) {
      lastError = error;
      options.onAttemptFailure?.({ attempt, error });
      const retryAfterMs = Math.max(0, Number(error?.retryAfterMs || 0));
      concurrencyController?.recordFailure(error);
      const delayMs = Math.max(retryAfterMs, retryDelayMs * attempt);
      if (attempt < attempts && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("UNKNOWN_FETCH_ERROR");
}

export async function fetchText(url, timeoutMs = 15000, fetchImpl = globalThis.fetch) {
  const response = await fetchResponse(url, { timeoutMs, fetchImpl });
  return response.text();
}

export async function fetchTextWithRetry(url, attempts = 3, timeoutMs = 15000, fetchImpl = globalThis.fetch, concurrencyController = null) {
  const response = await fetchResponseWithRetry(url, { timeoutMs, fetchImpl, concurrencyController }, attempts);
  return response.text();
}

function rssLink(entry) {
  for (const link of asArray(entry?.link)) {
    if (typeof link === "string") return cleanText(link);
    if (link?.["@_href"] && (!link["@_rel"] || link["@_rel"] === "alternate")) return cleanText(link["@_href"]);
  }
  return xmlText(entry?.link);
}

export function parseRssItems(xml, sourceUrl) {
  const document = parseXml(xml, "RSS");
  const rssChannel = document?.rss?.channel;
  const atomFeed = document?.feed;
  const rdf = document?.RDF;
  if (!rssChannel && !atomFeed && !rdf) throw new Error("RSS_FORMAT_UNSUPPORTED");
  const entries = rssChannel ? asArray(rssChannel.item) : atomFeed ? asArray(atomFeed.entry) : asArray(rdf?.item);
  const channelTitle = xmlText(rssChannel?.title || atomFeed?.title || rdf?.channel?.title);
  return entries.flatMap((entry) => {
    const title = xmlText(entry?.title);
    if (!title) return [];
    const link = rssLink(entry);
    const abstract = xmlText(entry?.description || entry?.summary || entry?.content || entry?.encoded);
    const identityText = [abstract, xmlText(entry?.identifier), xmlText(entry?.id), link].join(" ");
    const doi = (identityText.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i) || [])[0]?.replace(/[.,;)]+$/, "") || "";
    const publicationTitle = cleanJournalName(channelTitle) || inferJournalFromUrlSync(link) || "";
    return [{
      source_channel: "rss",
      source_platform: "rss",
      feed_url: sourceUrl,
      journal: channelTitle,
      publicationTitle,
      item_type_hint: "journalArticle",
      title,
      url: link,
      abstract,
      doi: doi.toLowerCase(),
      authors: xmlText(entry?.author || entry?.creator),
      pubdate: xmlText(entry?.pubDate || entry?.published || entry?.updated || entry?.date),
    }];
  });
}

function rssNamespace(url) {
  const sanitizedUrl = sanitizeSourceUrl(url);
  const queryHash = canonicalQueryHash({ adapterVersion: RSS_ADAPTER_VERSION, url: sanitizedUrl });
  return { source: `rss-${canonicalQueryHash(sanitizedUrl).slice(0, 16)}`, queryHash, sanitizedUrl };
}

export async function fetchRssAll({ root, profile = "weekly", stateRoot = "", fetchImpl = globalThis.fetch, now = new Date(), sourceConcurrencyController = null } = {}) {
  const rssConfig = loadRssSources({ root });
  const controller = resolveSourceHttpController(sourceConcurrencyController, "retrieval_rss");
  const feedResults = await controller.map(rssConfig.sources, async ({ url }) => {
    const checkedAt = new Date(now).toISOString();
    const namespace = rssNamespace(url);
    const filePath = sourceStatePath({ stateRoot, profile, source: namespace.source, queryHash: namespace.queryHash });
    const previous = await loadSourceState(filePath);
    const headers = {};
    if (previous?.validators?.etag) headers["If-None-Match"] = previous.validators.etag;
    if (previous?.validators?.lastModified) headers["If-Modified-Since"] = previous.validators.lastModified;
    let proposal;
    let parsed = [];
    let failure = null;
    try {
      const response = await fetchResponseWithRetry(url, {
        timeoutMs: 15000,
        headers,
        fetchImpl,
        concurrencyController: controller,
        controllerSlotOwned: true,
      }, 3);
      if (response.status === 304) {
        proposal = {
          complete: true,
          notModified: true,
          itemCount: 0,
          validators: previous?.validators || {},
          committed: { ...(previous?.committed || {}), lastSuccessfulCheck: checkedAt },
        };
      } else {
        parsed = parseRssItems(await response.text(), namespace.sanitizedUrl);
        proposal = {
          complete: true,
          itemCount: parsed.length,
          validators: {
            etag: responseHeader(response, "etag"),
            lastModified: responseHeader(response, "last-modified"),
          },
          committed: { lastSuccessfulCheck: checkedAt },
        };
      }
    } catch (error) {
      proposal = { complete: false, failureStage: /XML/.test(error.message) ? "parse" : "request", error: error.message };
      failure = { feed: namespace.sanitizedUrl, stage: proposal.failureStage, error: String(error.message || error) };
    }
    const state = buildSourceState({ previous, profile, source: namespace.source, queryHash: namespace.queryHash, adapterVersion: RSS_ADAPTER_VERSION, proposal, checkedAt });
    return {
      items: parsed,
      failure,
      stateUpdate: filePath ? { path: filePath, state } : null,
      audit: { source: namespace.source, queryHash: namespace.queryHash, complete: proposal.complete, notModified: proposal.notModified === true, itemCount: proposal.itemCount || 0, pagesCompleted: proposal.complete ? 1 : 0, failureStage: proposal.failureStage || null },
    };
  }, { observe: false });
  const items = feedResults.flatMap((result) => result.items);
  const failed = feedResults.map((result) => result.failure).filter(Boolean);
  const audit = feedResults.map((result) => result.audit);
  const stateUpdates = feedResults.map((result) => result.stateUpdate).filter(Boolean);
  return { items, failed, config: rssConfig, audit, stateUpdates };
}

export function hasExplicitNcbiDateConstraint(query) {
  return /\[(?:pdat|dp|edat|crdt|mhda|dcom)\]/i.test(String(query || ""));
}

function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function ncbiDay(value) {
  return isoDay(value).replace(/-/g, "/");
}

function subtractDays(value, days) {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() - days);
  return date;
}

function ncbiWindow({ database, cfg, previous, now }) {
  const query = hasExplicitNcbiDateConstraint(cfg.query) ? cfg.query : (cfg.effective_query || cfg.query);
  if (hasExplicitNcbiDateConstraint(query)) return { explicit: true, datetype: null, minDate: null, maxDate: null };
  const committedThrough = previous?.committed?.committedThrough;
  const min = committedThrough
    ? subtractDays(`${committedThrough}T00:00:00Z`, cfg.overlap_days || 3)
    : subtractDays(now, cfg.days_back || 10);
  return {
    explicit: false,
    datetype: database === "pmc" ? "crdt" : "edat",
    minDate: ncbiDay(min),
    maxDate: ncbiDay(now),
  };
}

function articleId(entries, type) {
  const match = asArray(entries).find((entry) => String(entry?.["@_IdType"] || entry?.["@_EIdType"] || entry?.["@_pub-id-type"] || "").toLowerCase() === type);
  return xmlText(match);
}

function pubmedAuthors(article) {
  return asArray(article?.MedlineCitation?.Article?.AuthorList?.Author).map((author) => {
    return xmlText(author?.CollectiveName) || [xmlText(author?.ForeName || author?.Initials), xmlText(author?.LastName)].filter(Boolean).join(" ");
  }).filter(Boolean).join(", ");
}

function pubmedRecord(article) {
  const citation = article?.MedlineCitation || {};
  const body = citation.Article || {};
  const identifiers = article?.PubmedData?.ArticleIdList?.ArticleId;
  const pmid = xmlText(citation.PMID) || articleId(identifiers, "pubmed");
  const pmcid = articleId(identifiers, "pmc");
  const doi = articleId(identifiers, "doi") || articleId(body.ELocationID, "doi");
  return {
    source_channel: "database",
    source_platform: "pubmed",
    item_type_hint: "journalArticle",
    title: xmlText(body.ArticleTitle),
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
    abstract: xmlText(body.Abstract?.AbstractText),
    doi: String(doi || "").toLowerCase(),
    pmid,
    pmcid,
    authors: pubmedAuthors(article),
    journal: xmlText(body.Journal?.Title),
    publicationTitle: xmlText(body.Journal?.Title),
    pubdate: xmlText(body.Journal?.JournalIssue?.PubDate),
  };
}

function pmcAuthors(articleMeta) {
  const groups = asArray(articleMeta?.["contrib-group"]);
  return groups.flatMap((group) => asArray(group?.contrib))
    .filter((contrib) => !contrib?.["@_contrib-type"] || contrib["@_contrib-type"] === "author")
    .map((contrib) => xmlText(contrib?.collab) || [xmlText(contrib?.name?.["given-names"]), xmlText(contrib?.name?.surname)].filter(Boolean).join(" "))
    .filter(Boolean)
    .join(", ");
}

function pmcRecord(article) {
  const front = article?.front || {};
  const articleMeta = front?.["article-meta"] || {};
  const identifiers = articleMeta?.["article-id"];
  const pmcid = articleId(identifiers, "pmc") || articleId(identifiers, "pmcid");
  const pmid = articleId(identifiers, "pmid");
  const doi = articleId(identifiers, "doi");
  const journal = xmlText(front?.["journal-meta"]?.["journal-title-group"]?.["journal-title"] || front?.["journal-meta"]?.["journal-title"]);
  return {
    source_channel: "database",
    source_platform: "pmc",
    item_type_hint: "journalArticle",
    title: xmlText(articleMeta?.["title-group"]?.["article-title"]),
    url: `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcid}/`,
    abstract: xmlText(articleMeta?.abstract),
    doi: String(doi || "").toLowerCase(),
    pmid,
    pmcid,
    authors: pmcAuthors(articleMeta),
    journal,
    publicationTitle: journal,
    pubdate: xmlText(articleMeta?.["pub-date"]),
  };
}

export function parseNcbiDetails(xml, database) {
  const document = parseXml(xml, "NCBI");
  if (database === "pmc") {
    return asArray(document?.["pmc-articleset"]?.article || document?.article).map(pmcRecord);
  }
  const root = document?.PubmedArticleSet || document;
  return [...asArray(root?.PubmedArticle), ...asArray(root?.PubmedBookArticle)].map(pubmedRecord);
}

export function parsePubMedIntegrityRecords(xml) {
  const document = parseXml(xml, "PUBMED_INTEGRITY");
  const root = document?.PubmedArticleSet || document;
  return [...asArray(root?.PubmedArticle), ...asArray(root?.PubmedBookArticle)].map((article) => {
    const citation = article?.MedlineCitation || article?.BookDocument || {};
    const identifiers = article?.PubmedData?.ArticleIdList?.ArticleId;
    const pmid = xmlText(citation.PMID) || articleId(identifiers, "pubmed");
    const relations = asArray(citation?.CommentsCorrectionsList?.CommentsCorrections).map((relation) => ({
      refType: cleanText(relation?.["@_RefType"]),
      targetPmid: xmlText(relation?.PMID),
      note: xmlText(relation?.Note),
    })).filter((relation) => relation.refType || relation.targetPmid);
    return { pmid, relations };
  }).filter((record) => record.pmid);
}

function ncbiIdentity(database, item) {
  return database === "pmc" ? String(item.pmcid || "").replace(/^PMC/i, "") : String(item.pmid || "");
}

export async function fetchNcbiDatabase(database, cfg, { profile = "weekly", stateRoot = "", fetchImpl = globalThis.fetch, now = new Date(), sourceConcurrencyController = null } = {}) {
  const controller = resolveSourceHttpController(sourceConcurrencyController, `retrieval_${database}`);
  const effectiveQuery = hasExplicitNcbiDateConstraint(cfg.query) ? cfg.query : (cfg.effective_query || cfg.query);
  const semanticConfig = {
    adapterVersion: NCBI_ADAPTER_VERSION,
    database,
    query: effectiveQuery,
    sort: cfg.sort || "date",
    dateStrategy: hasExplicitNcbiDateConstraint(effectiveQuery) ? "explicit_query" : (database === "pmc" ? "crdt" : "edat"),
    overlapDays: cfg.overlap_days || 3,
    initialDaysBack: cfg.days_back || 10,
    pageSize: cfg.page_size || cfg.retmax || 300,
    detailBatchSize: Math.min(cfg.detail_batch_size || 200, 200),
    maxResults: cfg.max_results || 100000,
  };
  const queryHash = canonicalQueryHash(semanticConfig);
  const filePath = sourceStatePath({ stateRoot, profile, source: database, queryHash });
  const previous = await loadSourceState(filePath);
  const checkedAt = new Date(now).toISOString();
  const window = ncbiWindow({ database, cfg, previous, now: new Date(now) });
  const pageSize = cfg.page_size || cfg.retmax || 300;
  const maxResults = cfg.max_results || 100000;
  const ids = [];
  const items = [];
  let expectedCount = null;
  let pagesCompleted = 0;
  let detailBatchesCompleted = 0;
  let stage = "search";
  try {
    while (expectedCount == null || ids.length < expectedCount) {
      const url = buildNcbiESearchUrl({ ...cfg, effective_query: effectiveQuery }, database, {
        retstart: ids.length,
        retmax: pageSize,
        includeDate: !window.explicit,
        datetype: window.datetype,
        minDate: window.minDate,
        maxDate: window.maxDate,
      });
      const json = JSON.parse(await fetchTextWithRetry(url, 3, 20000, fetchImpl, controller));
      const result = json?.esearchresult || {};
      const pageIds = Array.isArray(result.idlist) ? result.idlist.map(String) : [];
      expectedCount ??= Number(result.count || 0);
      if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw new Error("NCBI_COUNT_INVALID");
      if (database === "pubmed" && expectedCount > 9999) throw new Error(`NCBI_PUBMED_API_RESULT_LIMIT_EXCEEDED_${expectedCount}`);
      if (expectedCount > maxResults) throw new Error(`NCBI_RESULT_LIMIT_EXCEEDED_${expectedCount}`);
      if (!pageIds.length && ids.length < expectedCount) throw new Error("NCBI_PAGING_INCOMPLETE");
      ids.push(...pageIds);
      pagesCompleted += 1;
      if (expectedCount === 0 || pageIds.length === 0) break;
    }
    if (ids.length !== expectedCount) throw new Error(`NCBI_PAGING_COUNT_MISMATCH_${ids.length}_${expectedCount}`);
    stage = "details";
    const batchSize = Math.min(cfg.detail_batch_size || 200, 200);
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const batch = ids.slice(offset, offset + batchSize);
      const params = new URLSearchParams({ db: database, retmode: "xml", id: batch.join(",") });
      const xml = await fetchTextWithRetry(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?${params}`, 3, 20000, fetchImpl, controller);
      const parsed = parseNcbiDetails(xml, database);
      const returned = new Set(parsed.map((item) => ncbiIdentity(database, item)).filter(Boolean));
      const missing = batch.filter((id) => !returned.has(String(id).replace(/^PMC/i, "")));
      if (missing.length) throw new Error(`NCBI_DETAILS_INCOMPLETE_${missing.length}`);
      items.push(...parsed);
      detailBatchesCompleted += 1;
    }
    const proposal = {
      complete: true,
      itemCount: items.length,
      committed: {
        dateType: window.datetype,
        overlapDays: cfg.overlap_days || 3,
        committedThrough: isoDay(now),
        explicitDateConstraint: window.explicit,
      },
    };
    const state = buildSourceState({ previous, profile, source: database, queryHash, adapterVersion: NCBI_ADAPTER_VERSION, proposal, checkedAt });
    return {
      items,
      failed: [],
      audit: { source: database, queryHash, complete: true, expectedCount, pagesCompleted, detailBatchesCompleted, window },
      stateUpdates: filePath ? [{ path: filePath, state }] : [],
    };
  } catch (error) {
    const proposal = { complete: false, failureStage: stage, error: error.message };
    const state = buildSourceState({ previous, profile, source: database, queryHash, adapterVersion: NCBI_ADAPTER_VERSION, proposal, checkedAt });
    return {
      items,
      failed: [{ source: database, stage, error: String(error.message || error) }],
      audit: { source: database, queryHash, complete: false, expectedCount, idsCollected: ids.length, itemsCollected: items.length, pagesCompleted, detailBatchesCompleted, failureStage: stage },
      stateUpdates: filePath ? [{ path: filePath, state }] : [],
    };
  }
}

export async function fetchPubMed(externalCfg, { root, profile = "weekly", stateRoot = "", fetchImpl = globalThis.fetch, now = new Date(), sourceConcurrencyController = null } = {}) {
  const cfg = externalCfg || loadPubMedPmcSearchConfig({ root, now });
  const items = [];
  const failed = [];
  const audit = [];
  const stateUpdates = [];
  for (const database of cfg.databases) {
    const controller = sourceConcurrencyController || resolveSourceHttpController(null, `retrieval_${database}`);
    const result = await fetchNcbiDatabase(database, cfg, { profile, stateRoot, fetchImpl, now, sourceConcurrencyController: controller });
    items.push(...result.items);
    failed.push(...result.failed);
    audit.push(result.audit);
    stateUpdates.push(...result.stateUpdates);
  }
  return { items, failed, config: cfg, audit, stateUpdates };
}

function normalizeDoi(doi) {
  return String(doi || "").replace(/^https?:\/\/doi\.org\//i, "").toLowerCase().trim();
}

function decodeAbstractFromInvertedIndex(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") return "";
  const wordPositions = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const position of asArray(positions)) if (typeof position === "number") wordPositions.push({ word, position });
  }
  return wordPositions.sort((a, b) => a.position - b.position).map(({ word }) => word).join(" ").replace(/\s+/g, " ").trim();
}

function formatAuthors(authorships) {
  return asArray(authorships).slice(0, 10).map((entry) => entry?.author?.display_name || "").filter(Boolean).join(", ");
}

function extractVenue(primaryLocation) {
  return primaryLocation?.source?.display_name || primaryLocation?.venue || "";
}

export function normalizeOpenAlexItem(work) {
  const doi = normalizeDoi(work?.doi);
  const title = String(work?.title || "").replace(/\s+/g, " ").trim();
  const venue = extractVenue(work?.primary_location);
  const oaUrl = work?.open_access?.oa_url || "";
  return {
    source: "openalex",
    source_channel: "openalex",
    source_platform: "openalex",
    item_type_hint: "journalArticle",
    title,
    url: work?.primary_location?.landing_page_url || (doi ? `https://doi.org/${doi}` : oaUrl),
    abstract: decodeAbstractFromInvertedIndex(work?.abstract_inverted_index),
    doi,
    authors: formatAuthors(work?.authorships),
    publication_year: work?.publication_year || null,
    publication_date: work?.publication_date || "",
    journal: venue,
    publicationTitle: venue,
    openalex_id: String(work?.id || "").replace("https://openalex.org/", ""),
    is_open_access: work?.open_access?.is_oa === true,
    oa_url: oaUrl,
    pmid: "",
    pmcid: "",
    retrieval_sources: ["openalex"],
  };
}

function openAlexWindow(cfg, previous, now) {
  if (cfg.filters?.from_publication_date) {
    return { from: cfg.filters.from_publication_date, to: cfg.filters?.to_publication_date || null, strategy: "configured_publication_date" };
  }
  const committedThrough = previous?.committed?.committedThrough;
  const min = committedThrough
    ? subtractDays(`${committedThrough}T00:00:00Z`, cfg.overlap_days || 3)
    : subtractDays(now, cfg.days_back || 10);
  return { from: isoDay(min), to: cfg.filters?.to_publication_date || isoDay(now), strategy: "free_publication_date_overlap" };
}

export function buildOpenAlexSearchParams(cfg, { cursor = "*", window = null, now = new Date() } = {}) {
  const params = new URLSearchParams();
  if (cfg.query) params.set(cfg.search_parameter || "search", cfg.query);
  params.set("per_page", String(cfg.per_page || 50));
  if (cfg.search_parameter !== "search.semantic") params.set("cursor", cursor);
  params.set("select", cfg.select || "id,doi,title,publication_year,publication_date,authorships,primary_location,abstract_inverted_index,open_access,type");
  if (cfg.mailto) params.set("mailto", cfg.mailto);
  const filters = [];
  if (cfg.filters?.type) filters.push(`type:${cfg.filters.type}`);
  const effectiveWindow = window || openAlexWindow(cfg, null, now);
  if (effectiveWindow.from) filters.push(`from_publication_date:${effectiveWindow.from}`);
  if (effectiveWindow.to) filters.push(`to_publication_date:${effectiveWindow.to}`);
  if (cfg.filters?.is_oa === true) filters.push("is_oa:true");
  if (asArray(cfg.filters?.concepts).length) filters.push(`concepts:${cfg.filters.concepts.join("|")}`);
  if (filters.length) params.set("filter", filters.join(","));
  if (cfg.sort) params.set("sort", cfg.sort);
  return `https://api.openalex.org/works?${params}`;
}

function uniqueByCanonicalIdentity(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = getLiteratureIdentityKeys(item)[0];
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latencyMetrics(values = []) {
  if (!values.length) return { count: 0, minMs: null, medianMs: null, maxMs: null };
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  const medianMs = ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
  return { count: values.length, minMs: ordered[0], medianMs, maxMs: ordered.at(-1) };
}

export async function fetchOpenAlex(externalCfg, { root, profile = "weekly", stateRoot = "", fetchImpl = globalThis.fetch, now = new Date(), sourceConcurrencyController = null } = {}) {
  const controller = resolveSourceHttpController(sourceConcurrencyController, "retrieval_openalex");
  const cfg = externalCfg || loadOpenAlexConfig({ root });
  const emptyMetrics = { source: "openalex", queryVariantCount: 0, requestCount: 0, totalReported: 0, fetched: 0, normalized: 0, uniqueAfterMerge: 0, duplicateCount: 0, errorCount: 0, "429Count": 0, zeroReason: "", degraded: false, latency: latencyMetrics() };
  if (!cfg.enabled) return { items: [], failed: [], config: cfg, audit: [], stateUpdates: [], metrics: { ...emptyMetrics, zeroReason: "disabled" }, skipped_reason: "openalex_disabled" };
  const intent = cfg.search_intent || buildSearchIntent({ query: cfg.query, keywordGroups: cfg.keyword_groups, publicationTypes: [cfg.filters?.type].filter(Boolean) });
  if (!intent.expression) return { items: [], failed: [], config: cfg, audit: [], stateUpdates: [], metrics: { ...emptyMetrics, zeroReason: "empty_query" }, skipped_reason: "empty_query" };
  const baseUrlLength = buildOpenAlexSearchParams({ ...cfg, query: "" }, { cursor: "*", now }).length;
  const requestBudget = Math.max(1, Number(cfg.request_budget || cfg.max_pages || 8));
  const queryPlan = buildOpenAlexQueryPlan(intent, { maxEncodedUrlLength: 4000, maxQueryCharacters: Number(cfg.max_query_characters || 1400), baseUrlLength, requestBudget });
  if (!queryPlan.variants.length || queryPlan.errors.length) {
    const error = queryPlan.errors.join(",") || "OPENALEX_QUERY_COMPILATION_FAILED";
    return {
      items: [],
      failed: [{ source: "openalex", stage: "compiler", error }],
      config: cfg,
      audit: [{ source: "openalex", complete: false, pagesCompleted: 0, itemCount: 0, failureStage: "compiler", queryCompilerDegraded: true }],
      stateUpdates: [],
      metrics: { ...emptyMetrics, queryVariantCount: queryPlan.variants.length, errorCount: 1, zeroReason: "query_compiler_error", degraded: true },
    };
  }
  const semanticConfig = {
    adapterVersion: OPENALEX_ADAPTER_VERSION,
    queries: queryPlan.variants.map((variant) => variant.query),
    filters: cfg.filters,
    sort: cfg.sort || "",
    select: cfg.select || "",
    overlapDays: cfg.overlap_days || 3,
    initialDaysBack: cfg.days_back || 10,
    perPage: cfg.per_page || 50,
    requestBudget,
    searchParameter: queryPlan.searchParameter,
    updateStrategy: "free_publication_date_overlap",
  };
  const queryHash = canonicalQueryHash(semanticConfig);
  const filePath = sourceStatePath({ stateRoot, profile, source: "openalex", queryHash });
  const previous = await loadSourceState(filePath);
  const checkedAt = new Date(now).toISOString();
  const window = openAlexWindow(cfg, previous, new Date(now));
  const items = [];
  const variantTotals = [];
  const probeResults = [];
  const latencies = [];
  let pagesCompleted = 0;
  let requestCount = 0;
  let count429 = 0;
  let cursor = "";
  let semanticRescueUsed = false;
  const requestJson = async (url) => {
    if (url.length > 4094) throw new Error("OPENALEX_URL_LIMIT_GUARD");
    if (requestCount >= requestBudget) throw new Error("OPENALEX_REQUEST_BUDGET_EXCEEDED");
    requestCount += 1;
    const started = Date.now();
    try {
      const response = await fetchResponseWithRetry(url, {
        timeoutMs: 20000,
        fetchImpl,
        concurrencyController: controller,
        onAttemptFailure: ({ error }) => { if (Number(error?.status || 0) === 429) count429 += 1; },
      }, 3);
      return JSON.parse(await response.text());
    } finally {
      latencies.push(Date.now() - started);
    }
  };
  let failure = null;
  try {
    for (const variant of queryPlan.variants) {
      cursor = "*";
      let variantTotal = 0;
      while (cursor) {
        const json = await requestJson(buildOpenAlexSearchParams({ ...cfg, query: variant.query, search_parameter: queryPlan.searchParameter }, { cursor, window, now }));
        if (!Array.isArray(json?.results)) throw new Error("OPENALEX_RESULTS_INVALID");
        variantTotal = Math.max(variantTotal, Number(json?.meta?.count || 0));
        const results = json.results;
        items.push(...results.map(normalizeOpenAlexItem));
        pagesCompleted += 1;
        const nextCursor = String(json?.meta?.next_cursor || "");
        if (!results.length || !nextCursor) cursor = "";
        else if (nextCursor === cursor) throw new Error("OPENALEX_CURSOR_STALLED");
        else cursor = nextCursor;
      }
      variantTotals.push({ kind: variant.kind, total: variantTotal });
    }
    const primaryTotal = variantTotals.reduce((sum, entry) => sum + entry.total, 0);
    if (primaryTotal === 0 && items.length === 0 && cfg.diagnostics_enabled !== false) {
      const probes = buildQueryHealthProbes(intent, { requestBudget: Math.min(Number(cfg.diagnostic_probe_budget || 6), Math.max(0, requestBudget - requestCount)) });
      for (const probe of probes) {
        const json = await requestJson(buildOpenAlexSearchParams({ ...cfg, query: probe.query, per_page: 1, search_parameter: openAlexSearchParameterForQuery(probe.query) }, { cursor: "*", window, now }));
        probeResults.push({ kind: probe.kind, groupIds: probe.groupIds, total: Number(json?.meta?.count || 0) });
      }
    }
    if (!items.length && cfg.semantic_rescue_enabled === true && requestCount < requestBudget) {
      const semanticText = buildSemanticRescueText(intent, { maxChars: 2000 });
      if (semanticText) {
        const json = await requestJson(buildOpenAlexSearchParams({ ...cfg, query: semanticText, per_page: Math.min(50, Number(cfg.semantic_rescue_max_results || 25)), search_parameter: "search.semantic", sort: "" }, { cursor: "*", window, now }));
        if (!Array.isArray(json?.results)) throw new Error("OPENALEX_SEMANTIC_RESULTS_INVALID");
        items.push(...json.results.map(normalizeOpenAlexItem));
        semanticRescueUsed = json.results.length > 0;
      }
    }
    if (queryPlan.degradedReasons.includes("openalex_request_budget_truncated")) throw new Error("OPENALEX_QUERY_REQUEST_BUDGET_TRUNCATED");
  } catch (error) {
    failure = error;
  }
  const normalized = uniqueByCanonicalIdentity(items);
  const requiredProbeResults = probeResults.filter((probe) => probe.kind === "required_group");
  const queryOverConstrained = variantTotals.length > 0 && variantTotals.every((entry) => entry.total === 0) && requiredProbeResults.length > 0 && requiredProbeResults.every((probe) => probe.total > 0);
  const coreGroupZero = requiredProbeResults.some((probe) => probe.total === 0);
  const complete = !failure;
  const proposal = complete
    ? { complete: true, itemCount: normalized.length, committed: { committedThrough: isoDay(now), overlapDays: cfg.overlap_days || 3, strategy: window.strategy, terminalCursor: cursor || null } }
    : { complete: false, failureStage: "paging", error: failure.message };
  const state = buildSourceState({ previous, profile, source: "openalex", queryHash, adapterVersion: OPENALEX_ADAPTER_VERSION, proposal, checkedAt });
  const totalReported = variantTotals.reduce((sum, entry) => sum + entry.total, 0);
  const zeroReason = normalized.length
    ? (semanticRescueUsed ? "primary_zero_rescued_semantic" : "")
    : failure ? "source_failure"
      : queryOverConstrained ? "query_over_constrained"
        : coreGroupZero ? "term_database_coverage"
          : "healthy_zero";
  const failed = failure ? [{ source: "openalex", stage: "paging", error: String(failure.message || failure) }] : [];
  return {
    items: normalized,
    failed,
    config: cfg,
    audit: [{ source: "openalex", queryHash, complete, pagesCompleted, itemCount: normalized.length, totalReported, queryVariantCount: queryPlan.variants.length, queryCompilerDegraded: queryPlan.queryDegraded, degradedReasons: queryPlan.degradedReasons, queryOverConstrained, semanticRescueUsed, probeResults, failureStage: complete ? undefined : "paging", window, advancedUpdatedDateUsed: false }],
    stateUpdates: filePath ? [{ path: filePath, state }] : [],
    metrics: { source: "openalex", queryVariantCount: queryPlan.variants.length, requestCount, totalReported, fetched: items.length, normalized: normalized.length, uniqueAfterMerge: 0, duplicateCount: Math.max(0, items.length - normalized.length), errorCount: failed.length, "429Count": count429, zeroReason, degraded: failed.length > 0 || queryPlan.queryDegraded, latency: latencyMetrics(latencies), queryOverConstrained, queryCompilerDegraded: queryPlan.queryDegraded, semanticRescueUsed },
  };
}

function retrievalFailureResult(source, error) {
  const message = String(error?.message || error);
  const audit = [{ source, complete: false, itemCount: 0, failureStage: "adapter" }];
  if (source === "rss") return { items: [], failed: [{ source: "rss", error: message }], config: { enabled_count: 0, warnings: [] }, audit, stateUpdates: [] };
  if (source === "pubmed") return { items: [], failed: [{ source: "pubmed", error: message }], config: { databases: [], warnings: [] }, audit, stateUpdates: [] };
  return {
    items: [],
    failed: [{ source, error: message }],
    config: { enabled: true, warnings: [] },
    audit,
    stateUpdates: [],
    metrics: { source, queryVariantCount: 0, requestCount: 0, totalReported: 0, fetched: 0, normalized: 0, uniqueAfterMerge: 0, duplicateCount: 0, errorCount: 1, "429Count": 0, zeroReason: "source_failure", degraded: true },
  };
}

export async function runSelectedRetrievalSources({
  root,
  pubmedPmcConfig,
  openAlexConfig = null,
  searchIntent = null,
  semanticScholarConfig = {},
  semanticScholarApiKey = "",
  plan = {},
  fetchers = {},
  profile = "weekly",
  stateRoot = "",
  now = new Date(),
} = {}) {
  const { rssEnabled = false, pubmedEnabled = false, openalexEnabled = false, semanticScholarEnabled = false } = plan;
  const fetchRss = fetchers.fetchRssAll || fetchRssAll;
  const fetchPubmed = fetchers.fetchPubMed || fetchPubMed;
  const fetchOpenalex = fetchers.fetchOpenAlex || fetchOpenAlex;
  const fetchSemanticScholar = fetchers.fetchSemanticScholar || (async () => { throw new Error("SEMANTIC_SCHOLAR_ADAPTER_UNAVAILABLE"); });
  const shared = (source) => ({ root, profile, stateRoot, now, sourceConcurrencyController: resolveSourceHttpController(null, `retrieval_${source}`) });
  const tasks = [
    { key: "rss", enabled: rssEnabled, disabled: { items: [], failed: [], config: { enabled_count: 0, warnings: [] }, audit: [], stateUpdates: [] }, run: () => fetchRss(shared("rss")) },
    { key: "db", failureSource: "pubmed", enabled: pubmedEnabled, disabled: { items: [], failed: [], config: { databases: [], warnings: [] }, audit: [], stateUpdates: [] }, run: () => fetchPubmed(pubmedPmcConfig, shared("pubmed_pmc")) },
    { key: "openalex", enabled: openalexEnabled, disabled: { items: [], failed: [], config: { enabled: false, warnings: [] }, audit: [], stateUpdates: [], metrics: { source: "openalex", normalized: 0, degraded: false, zeroReason: "disabled" } }, run: () => fetchOpenalex({ ...(openAlexConfig || loadOpenAlexConfig({ root })), ...(searchIntent ? { search_intent: searchIntent } : {}) }, shared("openalex")) },
    { key: "semanticScholar", failureSource: "semantic_scholar", enabled: semanticScholarEnabled, disabled: { items: [], failed: [], config: { enabled: false, warnings: [] }, audit: [], stateUpdates: [], metrics: { source: "semantic_scholar", normalized: 0, degraded: false, zeroReason: "disabled" } }, run: () => fetchSemanticScholar(searchIntent, { ...semanticScholarConfig, enabled: true }, { profile, stateRoot, now, controller: resolveSourceHttpController(null, "retrieval_semantic_scholar"), apiKey: semanticScholarApiKey }) },
  ];
  const settled = await Promise.allSettled(tasks.map(async (task) => task.enabled ? [task.key, await task.run()] : [task.key, task.disabled]));
  const result = {};
  for (let index = 0; index < tasks.length; index++) {
    const task = tasks[index];
    const entry = settled[index];
    if (entry.status === "fulfilled") {
      const [key, value] = entry.value;
      result[key] = value;
    } else {
      result[task.key] = retrievalFailureResult(task.failureSource || task.key, entry.reason);
    }
  }
  return result;
}
