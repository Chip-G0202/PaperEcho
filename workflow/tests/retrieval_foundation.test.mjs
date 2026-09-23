import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchNcbiDatabase,
  fetchOpenAlex,
  fetchRssAll,
  parseNcbiDetails,
  parseRssItems,
} from "../tools/stage1/retrieval_step.mjs";
import { loadOpenAlexConfig, loadPubMedPmcSearchConfig } from "../tools/lib/literature_config.mjs";
import { writeAtomicJson } from "../tools/stage1/source_state.mjs";
import { runSourceSelectionAndFetch } from "../tools/stage1/source_selection_step.mjs";

const fixtureRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "retrieval");
const fixedNow = new Date("2026-08-04T00:00:00.000Z");

async function fixture(name) {
  return fs.readFile(path.join(fixtureRoot, name), "utf8");
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-retrieval-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function jsonResponse(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}

function textResponse(value, status = 200, headers = {}) {
  return new Response(status === 304 ? null : value, { status, headers });
}

test("retrieval config exposes explicit overlap and bounded paging defaults", async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "pubmed_pmc_search.json"), JSON.stringify({ query: "brain", detail_batch_size: 999 }), "utf8");
  await fs.writeFile(path.join(root, "config", "openalex_search.json"), JSON.stringify({ enabled: true, query: "brain" }), "utf8");
  const ncbi = loadPubMedPmcSearchConfig({ root, now: fixedNow });
  const openalex = loadOpenAlexConfig({ root });
  assert.equal(ncbi.overlap_days, 3);
  assert.equal(ncbi.page_size, 500);
  assert.equal(ncbi.detail_batch_size, 200);
  assert.equal(openalex.overlap_days, 3);
  assert.equal(openalex.max_pages, 10000);
});

test("Stage1 retrieval writes normalized candidates atomically before source state", async (t) => {
  const root = await temporaryDirectory(t);
  const pipeDir = path.join(root, "review_results", "pipeline", "26.8.4");
  const stateRoot = path.join(root, "review_results", "source_state");
  const statePath = path.join(stateRoot, "v1", "weekly", "rss-test", `${"a".repeat(64)}.json`);
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "source_selection.json"), JSON.stringify({
    research_domain: "biomedical",
    domain_options: { biomedical: { primary_sources: [], supplemental_sources: ["rss"] } },
    override_enabled_sources: ["rss"],
  }), "utf8");
  const result = await runSourceSelectionAndFetch({
    root,
    pipeDir,
    sourceStateRoot: stateRoot,
    now: fixedNow,
    pubmedPmcConfig: { databases: ["pubmed"] },
    fetchers: {
      fetchRssAll: async () => ({
        items: [{ title: "Durable candidate", source_channel: "rss" }],
        failed: [],
        config: { warnings: [] },
        audit: [{ source: "rss-test", queryHash: "a".repeat(64), complete: true, itemCount: 1 }],
        stateUpdates: [{ path: statePath, state: { schemaVersion: 1, committed: { lastSuccessfulCheck: fixedNow.toISOString() } } }],
      }),
    },
  });
  const artifact = JSON.parse(await fs.readFile(result.retrievalAuditPath, "utf8"));
  const persistedState = JSON.parse(await fs.readFile(statePath, "utf8"));
  assert.equal(artifact.schemaVersion, 1);
  assert.equal(artifact.candidates.rss[0].title, "Durable candidate");
  assert.equal(persistedState.committed.lastSuccessfulCheck, fixedNow.toISOString());
});

test("RSS parser handles RSS 2.0, Atom, namespaces, CDATA, entities, and singleton entries", async () => {
  const rss = parseRssItems(await fixture("rss2-single.xml"), "https://feed.example/rss");
  const atom = parseRssItems(await fixture("atom-single.xml"), "https://feed.example/atom");
  const namespaced = parseRssItems(await fixture("rdf-namespaced.xml"), "https://feed.example/rdf");
  assert.equal(rss.length, 1);
  assert.equal(rss[0].title, "Microplastics & neuroinflammation");
  assert.equal(rss[0].journal, "Research & Health Journal");
  assert.equal(rss[0].doi, "10.1234/abc.1");
  assert.equal(atom.length, 1);
  assert.equal(atom[0].url, "https://example.org/atom/1");
  assert.match(atom[0].abstract, /<safe>/);
  assert.equal(namespaced.length, 2);
  assert.equal(namespaced[0].title, "Namespaced Item");
  assert.equal(namespaced[0].journal, "Namespaced Journal");
  assert.equal(namespaced[0].publicationTitle, "Namespaced Journal");
  assert.equal(namespaced[1].title, "Part A Part B");
  assert.equal(namespaced[1].publicationTitle, "Namespaced Journal");
});

async function rssRoot(t) {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, "config"), { recursive: true });
  await fs.writeFile(path.join(root, "config", "rss_sources.json"), JSON.stringify({ sources: [{ url: "https://feed.example/rss" }] }), "utf8");
  return root;
}

test("RSS persists ETag/Last-Modified semantics and treats 304 as success without yield", async (t) => {
  const root = await rssRoot(t);
  const stateRoot = path.join(root, "state");
  const first = await fetchRssAll({
    root,
    stateRoot,
    now: fixedNow,
    fetchImpl: async () => textResponse(await fixture("rss2-single.xml"), 200, { etag: '"v1"', "last-modified": "Tue, 04 Aug 2026 00:00:00 GMT" }),
  });
  assert.equal(first.items.length, 1);
  await writeAtomicJson(first.stateUpdates[0].path, first.stateUpdates[0].state);
  let sentHeaders;
  const second = await fetchRssAll({
    root,
    stateRoot,
    now: new Date("2026-08-05T00:00:00.000Z"),
    fetchImpl: async (_url, options) => {
      sentHeaders = options.headers;
      return textResponse("", 304);
    },
  });
  assert.equal(sentHeaders["If-None-Match"], '"v1"');
  assert.equal(sentHeaders["If-Modified-Since"], "Tue, 04 Aug 2026 00:00:00 GMT");
  assert.deepEqual(second.items, []);
  assert.equal(second.audit[0].notModified, true);
  assert.deepEqual(second.stateUpdates[0].state.validators, first.stateUpdates[0].state.validators);
  assert.deepEqual(second.stateUpdates[0].state.health.yield.successfulSamples, [1]);
});

test("RSS parse failure preserves prior validator and committed boundary", async (t) => {
  const root = await rssRoot(t);
  const stateRoot = path.join(root, "state");
  const first = await fetchRssAll({ root, stateRoot, now: fixedNow, fetchImpl: async () => textResponse(await fixture("rss2-single.xml"), 200, { etag: '"v1"' }) });
  await writeAtomicJson(first.stateUpdates[0].path, first.stateUpdates[0].state);
  const failed = await fetchRssAll({ root, stateRoot, now: new Date("2026-08-05T00:00:00Z"), fetchImpl: async () => textResponse("<rss><broken>") });
  assert.equal(failed.failed[0].stage, "parse");
  assert.deepEqual(failed.stateUpdates[0].state.validators, first.stateUpdates[0].state.validators);
  assert.deepEqual(failed.stateUpdates[0].state.committed, first.stateUpdates[0].state.committed);
});

function ncbiConfig(overrides = {}) {
  return {
    databases: ["pubmed"],
    query: "brain AND toxin",
    effective_query: "brain AND toxin",
    sort: "date",
    days_back: 10,
    overlap_days: 3,
    page_size: 2,
    detail_batch_size: 2,
    max_results: 100,
    ...overrides,
  };
}

function pubmedSingleXml(id) {
  return `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>${id}</PMID><Article><ArticleTitle>Article ${id}</ArticleTitle><Abstract><AbstractText>Abstract ${id}</AbstractText></Abstract><AuthorList><Author><ForeName>Test</ForeName><LastName>Author</LastName></Author></AuthorList><Journal><Title>Journal ${id}</Title></Journal></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${id}</ArticleId><ArticleId IdType="doi">10.1000/${id}</ArticleId></ArticleIdList></PubmedData></PubmedArticle></PubmedArticleSet>`;
}

test("PubMed exhausts search pages and fetches complete details in chunks", async () => {
  const requested = [];
  const fetchImpl = async (rawUrl) => {
    const url = new URL(rawUrl);
    requested.push(url);
    if (url.pathname.endsWith("esearch.fcgi")) {
      const start = Number(url.searchParams.get("retstart"));
      return jsonResponse({ esearchresult: { count: "3", idlist: start === 0 ? ["1", "2"] : ["3"] } });
    }
    const ids = url.searchParams.get("id");
    return textResponse(ids === "1,2" ? await fixture("pubmed-details.xml") : pubmedSingleXml(3));
  };
  const result = await fetchNcbiDatabase("pubmed", ncbiConfig(), { now: fixedNow, fetchImpl });
  assert.equal(result.failed.length, 0);
  assert.equal(result.items.length, 3);
  assert.equal(result.audit.pagesCompleted, 2);
  assert.equal(result.audit.detailBatchesCompleted, 2);
  assert.equal(result.items[0].doi, "10.1000/one");
  assert.equal(result.items[0].authors, "Ada Lovelace");
  assert.match(result.items[0].abstract, /First abstract/);
  assert.equal(requested.filter((url) => url.pathname.endsWith("efetch.fcgi")).length, 2);
});

test("PubMed retries missing detail IDs and retains complete records without advancing an incomplete source", async () => {
  const fetchImpl = async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("esearch.fcgi")) {
      const start = Number(url.searchParams.get("retstart"));
      return jsonResponse({ esearchresult: { count: "3", idlist: start === 0 ? ["1", "2"] : ["3"] } });
    }
    const ids = url.searchParams.get("id");
    if (ids === "1,2") return textResponse(pubmedSingleXml(1));
    if (ids === "2") return textResponse("<PubmedArticleSet/>");
    return textResponse(pubmedSingleXml(3));
  };
  const partial = await fetchNcbiDatabase("pubmed", ncbiConfig(), { stateRoot: "state", now: fixedNow, fetchImpl });
  assert.deepEqual(partial.items.map((item) => item.pmid), ["1", "3"]);
  assert.equal(partial.audit.complete, false);
  assert.equal(partial.audit.detailBatchesCompleted, 1);
  assert.match(partial.failed[0].error, /NCBI_DETAILS_INCOMPLETE_1/);
  assert.equal(partial.stateUpdates[0].state.committed, null);

  const recovered = await fetchNcbiDatabase("pubmed", ncbiConfig(), { now: fixedNow, fetchImpl: async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("esearch.fcgi")) {
      const start = Number(url.searchParams.get("retstart"));
      return jsonResponse({ esearchresult: { count: "3", idlist: start === 0 ? ["1", "2"] : ["3"] } });
    }
    const ids = url.searchParams.get("id");
    if (ids === "1,2") return textResponse(pubmedSingleXml(1));
    return textResponse(pubmedSingleXml(Number(ids)));
  } });
  assert.deepEqual(recovered.items.map((item) => item.pmid), ["1", "2", "3"]);
  assert.equal(recovered.audit.complete, true);
  assert.equal(recovered.audit.detailBatchesCompleted, 2);
});

test("PMC detail normalization preserves PMID/PMCID/DOI identity fields", async () => {
  const items = parseNcbiDetails(await fixture("pmc-details.xml"), "pmc");
  assert.equal(items.length, 1);
  assert.equal(items[0].pmcid, "PMC3");
  assert.equal(items[0].pmid, "30");
  assert.equal(items[0].doi, "10.1000/pmc");
  assert.equal(items[0].authors, "Alan Turing");
});

test("PMC retrieval uses CRDT and fetches normalized details", async () => {
  let searchUrl;
  const result = await fetchNcbiDatabase("pmc", ncbiConfig(), { now: fixedNow, fetchImpl: async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("esearch.fcgi")) {
      searchUrl = url;
      return jsonResponse({ esearchresult: { count: "1", idlist: ["3"] } });
    }
    return textResponse(await fixture("pmc-details.xml"));
  } });
  assert.equal(searchUrl.searchParams.get("datetype"), "crdt");
  assert.equal(result.failed.length, 0);
  assert.equal(result.items[0].pmcid, "PMC3");
});

test("PubMed overlap starts from committed EDAT boundary minus configured days", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const cfg = ncbiConfig();
  const emptyFetch = async () => jsonResponse({ esearchresult: { count: "0", idlist: [] } });
  const first = await fetchNcbiDatabase("pubmed", cfg, { stateRoot, now: new Date("2026-08-01T00:00:00Z"), fetchImpl: emptyFetch });
  await writeAtomicJson(first.stateUpdates[0].path, first.stateUpdates[0].state);
  let searchUrl;
  await fetchNcbiDatabase("pubmed", cfg, {
    stateRoot,
    now: fixedNow,
    fetchImpl: async (rawUrl) => {
      searchUrl = new URL(rawUrl);
      return jsonResponse({ esearchresult: { count: "0", idlist: [] } });
    },
  });
  assert.equal(searchUrl.searchParams.get("datetype"), "edat");
  assert.equal(searchUrl.searchParams.get("mindate"), "2026/07/29");
});

test("explicit NCBI date query is preserved without generated date parameters", async () => {
  let searchUrl;
  const cfg = ncbiConfig({ query: "brain AND 2025:2026[pdat]", effective_query: "adaptive query without date" });
  await fetchNcbiDatabase("pubmed", cfg, { now: fixedNow, fetchImpl: async (rawUrl) => {
    searchUrl = new URL(rawUrl);
    return jsonResponse({ esearchresult: { count: "0", idlist: [] } });
  } });
  assert.equal(searchUrl.searchParams.get("term"), "brain AND 2025:2026[pdat]");
  assert.equal(searchUrl.searchParams.has("mindate"), false);
  assert.equal(searchUrl.searchParams.has("datetype"), false);
});

test("PubMed reports the ESearch API result ceiling instead of silently truncating", async () => {
  const result = await fetchNcbiDatabase("pubmed", ncbiConfig({ max_results: 20000 }), {
    now: fixedNow,
    fetchImpl: async () => jsonResponse({ esearchresult: { count: "10000", idlist: ["1", "2"] } }),
  });
  assert.equal(result.audit.complete, false);
  assert.match(result.failed[0].error, /NCBI_PUBMED_API_RESULT_LIMIT_EXCEEDED_10000/);
});

test("PubMed middle-page and detail-batch failures remain incomplete without boundary advance", async () => {
  let searchCalls = 0;
  const pageFailure = await fetchNcbiDatabase("pubmed", ncbiConfig(), { stateRoot: "state", now: fixedNow, fetchImpl: async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("esearch.fcgi") && searchCalls++ === 0) return jsonResponse({ esearchresult: { count: "3", idlist: ["1", "2"] } });
    return textResponse("unavailable", 503);
  } });
  assert.equal(pageFailure.audit.complete, false);
  assert.equal(pageFailure.audit.failureStage, "search");
  assert.equal(pageFailure.stateUpdates[0].state.committed, null);

  const detailFailure = await fetchNcbiDatabase("pubmed", ncbiConfig(), { stateRoot: "state", now: fixedNow, fetchImpl: async (rawUrl) => {
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("esearch.fcgi")) return jsonResponse({ esearchresult: { count: "3", idlist: Number(url.searchParams.get("retstart")) === 0 ? ["1", "2"] : ["3"] } });
    if (url.searchParams.get("id") === "1,2") return textResponse(await fixture("pubmed-details.xml"));
    return textResponse("unavailable", 503);
  } });
  assert.equal(detailFailure.audit.complete, false);
  assert.equal(detailFailure.audit.failureStage, "details");
  assert.equal(detailFailure.items.length, 2);
  assert.equal(detailFailure.stateUpdates[0].state.committed, null);
});

function openAlexConfig(overrides = {}) {
  return {
    enabled: true,
    query: "microplastics",
    days_back: 10,
    overlap_days: 3,
    per_page: 2,
    max_pages: 20,
    mailto: "",
    filters: { type: "article", from_publication_date: null, to_publication_date: null, concepts: [] },
    sort: "publication_date:desc",
    select: "id,doi,title,publication_year,publication_date,authorships,primary_location,abstract_inverted_index,open_access,type",
    ...overrides,
  };
}

function openAlexWork(id) {
  return { id: `https://openalex.org/W${id}`, title: `Work ${id}`, publication_date: "2026-08-01", authorships: [], primary_location: null, open_access: { is_oa: false } };
}

test("OpenAlex exhausts cursor pages and records normal termination", async () => {
  const cursors = [];
  const result = await fetchOpenAlex(openAlexConfig(), { now: fixedNow, fetchImpl: async (rawUrl) => {
    const cursor = new URL(rawUrl).searchParams.get("cursor");
    cursors.push(cursor);
    return cursor === "*"
      ? jsonResponse({ results: [openAlexWork(1)], meta: { next_cursor: "next-page" } })
      : jsonResponse({ results: [openAlexWork(2)], meta: { next_cursor: null } });
  } });
  assert.deepEqual(cursors, ["*", "next-page"]);
  assert.equal(result.items.length, 2);
  assert.equal(result.audit[0].pagesCompleted, 2);
  assert.equal(result.audit[0].complete, true);
});

test("OpenAlex free overlap is stateful and never assumes an advanced updated-date path", async (t) => {
  const stateRoot = await temporaryDirectory(t);
  const cfg = openAlexConfig({ api_key: "must-not-be-used" });
  const first = await fetchOpenAlex(cfg, { stateRoot, now: new Date("2026-08-01T00:00:00Z"), fetchImpl: async () => jsonResponse({ results: [], meta: { next_cursor: null } }) });
  await writeAtomicJson(first.stateUpdates[0].path, first.stateUpdates[0].state);
  let requestUrl;
  const second = await fetchOpenAlex(cfg, { stateRoot, now: fixedNow, fetchImpl: async (rawUrl) => {
    requestUrl = new URL(rawUrl);
    return jsonResponse({ results: [], meta: { next_cursor: null } });
  } });
  const filter = requestUrl.searchParams.get("filter");
  assert.match(filter, /from_publication_date:2026-07-29/);
  assert.doesNotMatch(filter, /updated/);
  assert.equal(requestUrl.searchParams.has("api_key"), false);
  assert.equal(second.audit[0].advancedUpdatedDateUsed, false);
});

test("OpenAlex middle cursor failure preserves partial audit and does not advance boundary", async () => {
  let calls = 0;
  const result = await fetchOpenAlex(openAlexConfig(), { stateRoot: "state", now: fixedNow, fetchImpl: async () => {
    if (calls++ === 0) return jsonResponse({ results: [openAlexWork(1)], meta: { next_cursor: "next" } });
    return textResponse("unavailable", 503);
  } });
  assert.equal(result.items.length, 1);
  assert.equal(result.audit[0].complete, false);
  assert.equal(result.stateUpdates[0].state.committed, null);
  assert.equal(result.stateUpdates[0].state.health.availability.status, "unavailable");
});
