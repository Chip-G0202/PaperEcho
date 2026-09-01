import { createServiceConcurrencyController } from "../lib/adaptive_concurrency.mjs";
import { fetchResponseWithRetry, parsePubMedIntegrityRecords } from "../stage1/retrieval_step.mjs";
import { normalizeCrossrefIntegrity, normalizeIntegrityDoi, normalizePubMedIntegrity } from "./evidence.mjs";

const CROSSREF_BASE = "https://api.crossref.org/works/";
const PUBMED_EFETCH = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi";

function classifyError(error) {
  if (error?.name === "AbortError") return "timeout";
  if (/XML|JSON|parse/i.test(String(error?.message || ""))) return "parse_error";
  if (/HTTP_/.test(String(error?.message || ""))) return "outage";
  return "provider_error";
}

export async function fetchCrossrefIntegrity(doi, { fetchImpl = globalThis.fetch, controller = null, timeoutMs = 15000, attempts = 3 } = {}) {
  const normalized = normalizeIntegrityDoi(doi);
  const concurrency = controller || createServiceConcurrencyController("integrity_crossref", { minConcurrency: 1, initialConcurrency: 2, maxConcurrency: 4 });
  try {
    const response = await fetchResponseWithRetry(`${CROSSREF_BASE}${encodeURIComponent(normalized)}`, {
      timeoutMs, fetchImpl, concurrencyController: concurrency,
      headers: { Accept: "application/json", "User-Agent": "PaperEcho/2.3 (literature-integrity-monitor)" },
    }, attempts);
    const payload = JSON.parse(await response.text());
    const normalizedResult = normalizeCrossrefIntegrity(payload?.message || payload, { targetDoi: normalized });
    return { provider: "crossref", status: "success", checked: true, empty: normalizedResult.evidence.length === 0, ...normalizedResult };
  } catch (error) {
    return { provider: "crossref", status: classifyError(error), checked: false, empty: false, evidence: [], conflicts: [], directionalExclusions: [], error: String(error?.message || error).slice(0, 200) };
  }
}

export async function fetchPubMedIntegrityBatch(pmids, { fetchImpl = globalThis.fetch, timeoutMs = 20000, attempts = 3, batchSize = 180 } = {}) {
  const unique = [...new Set((pmids || []).map((value) => String(value || "").replace(/\D/g, "")).filter(Boolean))];
  const results = new Map(unique.map((pmid) => [pmid, { provider: "pubmed", status: "partial", checked: false, empty: false, evidence: [], conflicts: [], directionalExclusions: [], error: "record_missing_from_response" }]));
  for (let offset = 0; offset < unique.length; offset += Math.min(200, Math.max(1, batchSize))) {
    const batch = unique.slice(offset, offset + Math.min(200, Math.max(1, batchSize)));
    const body = new URLSearchParams({ db: "pubmed", id: batch.join(","), rettype: "xml", retmode: "xml" }).toString();
    try {
      const response = await fetchResponseWithRetry(PUBMED_EFETCH, { method: "POST", body, timeoutMs, fetchImpl, headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/xml" } }, attempts);
      const records = parsePubMedIntegrityRecords(await response.text());
      for (const record of records) results.set(record.pmid, { provider: "pubmed", status: "success", checked: true, empty: record.relations.length === 0, ...normalizePubMedIntegrity(record) });
    } catch (error) {
      const status = classifyError(error);
      for (const pmid of batch) results.set(pmid, { provider: "pubmed", status, checked: false, empty: false, evidence: [], conflicts: [], directionalExclusions: [], error: String(error?.message || error).slice(0, 200) });
    }
  }
  return results;
}
