import { hashText } from "../lib/llm_json_support.mjs";
import { getLiteratureDedupeFingerprints, normalizeTitleForExistingDedupe } from "../lib/literature_identity.mjs";
import { parseToolText } from "../lib/writeback_support.mjs";
import {
  getDefaultZoteroLibraryIndexPath,
  normalizeLiveIndexItem,
  normalizeTombstone,
  readZoteroLibraryIndex,
} from "../lib/zotero_library_index_store.mjs";
import { sanitizeZoteroSearchQuery } from "../maintenance/zotero_feedback_collection_corrections.mjs";

const TITLE_SKIP_MIN_LENGTH = 20;

export function getExistingDedupeFingerprints(item = {}) {
  return {
    itemKey: String(item.itemKey || item.item_key || item.key || "").trim(),
    ...getLiteratureDedupeFingerprints(item),
  };
}

export { normalizeTitleForExistingDedupe };

function emptyIndex() {
  return {
    byItemKey: new Map(),
    byDoi: new Map(),
    byPmid: new Map(),
    byPmcid: new Map(),
    byArxiv: new Map(),
    byOpenalex: new Map(),
    byUrl: new Map(),
    byTitle: new Map(),
    meta: new Map(),
  };
}

function addIndex(map, key, match) {
  if (!key || map.has(key)) return;
  map.set(key, match);
}

function addExistingItemToIndex(index, item, collection) {
  const fp = getExistingDedupeFingerprints(item);
  const itemKey = fp.itemKey;
  if (!itemKey) return;
  const base = {
    itemKey,
    collection,
    matched_existing_item_key_hash: hashText(itemKey).slice(0, 16),
  };
  addIndex(index.byItemKey, itemKey, { ...base, reason: "itemKey", type: "itemKey", confidence: "strong" });
  addIndex(index.byDoi, fp.doi, { ...base, reason: "doi", type: "doi", confidence: "strong" });
  addIndex(index.byPmid, fp.pmid, { ...base, reason: "pmid", type: "pmid", confidence: "strong" });
  addIndex(index.byPmcid, fp.pmcid, { ...base, reason: "pmcid", type: "pmcid", confidence: "strong" });
  addIndex(index.byArxiv, fp.arxiv, { ...base, reason: "arxiv", type: "arxiv", confidence: "strong" });
  addIndex(index.byOpenalex, fp.openalex, { ...base, reason: "openalex", type: "openalex", confidence: "strong" });
  addIndex(index.byUrl, fp.url, { ...base, reason: "url", type: "url", confidence: "strong" });
  addIndex(index.byTitle, fp.title, { ...base, reason: "title", type: "title", confidence: "weak" });
  index.meta.set(itemKey, { title_hash: hashText(item.title || "").slice(0, 16), collection });
}

function localItemHasRelevantRole(item = {}) {
  const roles = new Set(item.collection_roles || []);
  if (roles.has("pool") || roles.has("source") || roles.has("grade") || roles.has("trash") || roles.has("worthy")) return true;
  return (item.collections || []).some((collection) => {
    const name = String(collection?.name || collection?.path || collection || "");
    return name === "文献池" || name === "待删除" || name === "值得精读" || name.endsWith("/待删除");
  });
}

function localItemCollectionLabel(item = {}) {
  const roles = new Set(item.collection_roles || []);
  if (roles.has("trash")) return "trash";
  if (roles.has("worthy")) return "worthy";
  if (roles.has("pool")) return "pool";
  const names = (item.collections || []).map((collection) => String(collection?.name || collection?.path || collection || ""));
  if (names.some((name) => name === "待删除" || name.endsWith("/待删除"))) return "trash";
  if (names.includes("值得精读")) return "worthy";
  return "pool";
}

function buildExistingIndexFromLocalLibrary(localLibraryIndex) {
  const index = emptyIndex();
  let live_items_loaded = 0;
  let tombstones_loaded = 0;
  for (const item of Object.values(localLibraryIndex?.live_items || {})) {
    const normalized = normalizeLiveIndexItem(item);
    if (!normalized.itemKey || !localItemHasRelevantRole(normalized)) continue;
    addExistingItemToIndex(index, normalized, localItemCollectionLabel(normalized));
    live_items_loaded += 1;
  }
  for (const item of Object.values(localLibraryIndex?.tombstones || {})) {
    const normalized = normalizeTombstone(item);
    if (!normalized.tombstoneId) continue;
    addExistingItemToIndex(index, { ...normalized, itemKey: normalized.tombstoneId }, "trash");
    tombstones_loaded += 1;
  }
  return { index, counts: { local_index_live_items_loaded: live_items_loaded, local_index_tombstones_loaded: tombstones_loaded } };
}

function findByIndex(item, index) {
  const fp = getExistingDedupeFingerprints(item);
  if (fp.itemKey && index.byItemKey.has(fp.itemKey)) return index.byItemKey.get(fp.itemKey);
  if (fp.doi && index.byDoi.has(fp.doi)) return index.byDoi.get(fp.doi);
  if (fp.pmid && index.byPmid.has(fp.pmid)) return index.byPmid.get(fp.pmid);
  if (fp.pmcid && index.byPmcid.has(fp.pmcid)) return index.byPmcid.get(fp.pmcid);
  if (fp.arxiv && index.byArxiv.has(fp.arxiv)) return index.byArxiv.get(fp.arxiv);
  if (fp.openalex && index.byOpenalex.has(fp.openalex)) return index.byOpenalex.get(fp.openalex);
  if (fp.url && index.byUrl.has(fp.url)) return index.byUrl.get(fp.url);
  if (fp.title && index.byTitle.has(fp.title)) {
    const match = index.byTitle.get(fp.title);
    if (fp.title.length >= TITLE_SKIP_MIN_LENGTH) return match;
    return { ...match, possibleOnly: true, reason: "title_short_possible_duplicate" };
  }
  return null;
}

function topCollectionByName(collections, name) {
  const matches = (Array.isArray(collections) ? collections : []).filter((entry) => entry?.name === name && !(entry.parent || entry.parentCollection));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`top_collection_ambiguous:${name}`);
  return null;
}

async function getCollectionItemKeys(collectionKey, mcpToolCall, idBase) {
  const keys = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const payload = await mcpToolCall("get_collection_items", { collectionKey, limit, offset }, idBase + offset);
    const items = parseToolText(payload);
    if (!Array.isArray(items) || !items.length) break;
    for (const item of items) {
      if (item?.key) keys.push(String(item.key));
    }
    if (items.length < limit) break;
    offset += limit;
  }
  return keys;
}

async function addCollectionToIndex(index, { collectionKey, collectionName, mcpToolCall, idBase }) {
  if (!collectionKey) return 0;
  const keys = await getCollectionItemKeys(collectionKey, mcpToolCall, idBase);
  for (let i = 0; i < keys.length; i += 1) {
    try {
      const details = parseToolText(await mcpToolCall("get_item_details", { itemKey: keys[i], mode: "preview" }, idBase + 10000 + i));
      const data = details?.data || details || {};
      addExistingItemToIndex(index, { ...data, key: keys[i], itemKey: keys[i], title: data.title || details?.title || "" }, collectionName);
    } catch {
      // Broken Zotero item details should not block the whole pre-LLM check.
    }
  }
  return keys.length;
}

async function buildExistingIndex({ mcpToolCall }) {
  const collections = parseToolText(await mcpToolCall("get_collections", { mode: "complete", limit: 1000 }, 810000));
  const pool = topCollectionByName(collections, "文献池");
  if (!pool?.key) throw new Error("pool_collection_missing");
  const worthy = topCollectionByName(collections, "值得精读");
  const children = parseToolText(await mcpToolCall("get_subcollections", { collectionKey: pool.key, recursive: false }, 810001));
  const trash = (Array.isArray(children) ? children : []).find((entry) => entry?.name === "待删除");
  const index = emptyIndex();
  const counts = {
    pool_items_scanned: await addCollectionToIndex(index, { collectionKey: pool.key, collectionName: "pool", mcpToolCall, idBase: 811000 }),
    trash_items_scanned: trash?.key ? await addCollectionToIndex(index, { collectionKey: trash.key, collectionName: "trash", mcpToolCall, idBase: 812000 }) : 0,
    worthy_items_scanned: worthy?.key ? await addCollectionToIndex(index, { collectionKey: worthy.key, collectionName: "worthy", mcpToolCall, idBase: 813000 }) : 0,
  };
  return { index, counts };
}

function isMcpParseError(error) {
  const raw = String(error?.message || error || "");
  return /"code"\s*:\s*-32700/.test(raw) || /parse error/i.test(raw);
}

function shortError(error) {
  return String(error?.message || error || "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function tokenFallback(value) {
  return sanitizeZoteroSearchQuery(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3)
    .slice(0, 12)
    .join(" ")
    .slice(0, 180)
    .trim();
}

async function searchLibraryWithFallback(query, { mcpToolCall, idBase, diagnostics }) {
  const attempts = [String(query || "").trim()];
  const sanitized = sanitizeZoteroSearchQuery(query);
  if (sanitized && !attempts.includes(sanitized)) attempts.push(sanitized);
  const fallback = tokenFallback(sanitized);
  if (fallback && !attempts.includes(fallback)) attempts.push(fallback);
  let lastParseError = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const q = attempts[i];
    if (!q) continue;
    try {
      const payload = await mcpToolCall("search_library", { q, limit: 8, mode: "preview", relevanceScoring: true }, idBase + i);
      const parsed = parseToolText(payload);
      if (i > 0) diagnostics.search_query_fallback_success_count += 1;
      return Array.isArray(parsed?.results) ? parsed.results : Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      if (!isMcpParseError(error)) throw error;
      lastParseError = error;
      diagnostics.search_library_parse_error_count += 1;
      diagnostics.search_library_error_samples.push({
        error_code: "-32700",
        fallback_used: i > 0 ? "sanitized_or_token" : "",
        fallback_success: false,
        query_hash: hashText(q).slice(0, 16),
        query_length: q.length,
        error_summary: shortError(error),
      });
    }
  }
  if (lastParseError) throw lastParseError;
  return [];
}

async function findBySearchLibrary(item, { mcpToolCall, idBase, diagnostics }) {
  const fp = getExistingDedupeFingerprints(item);
  const queries = [
    { type: "doi", value: fp.doi },
    { type: "pmid", value: fp.pmid },
    { type: "pmcid", value: fp.pmcid },
    { type: "arxiv", value: fp.arxiv },
    { type: "openalex", value: fp.openalex },
    { type: "url", value: fp.url },
    { type: "title", value: fp.title && fp.title.length >= TITLE_SKIP_MIN_LENGTH ? item.title : "" },
  ].filter((entry) => entry.value);
  for (let i = 0; i < queries.length; i += 1) {
    const query = queries[i];
    const hits = await searchLibraryWithFallback(query.value, { mcpToolCall, idBase: idBase + i * 10, diagnostics });
    for (const hit of hits) {
      const h = getExistingDedupeFingerprints({
        key: hit.key || hit.itemKey,
        itemKey: hit.key || hit.itemKey,
        doi: hit.DOI || hit.doi,
        pmid: hit.pmid,
        pmcid: hit.pmcid,
        arxiv: hit.arxiv,
        openalex_id: hit.openalex_id,
        url: hit.url || hit.URL,
        title: hit.title,
        extra: hit.extra,
      });
      if (query.type === "doi" && fp.doi && h.doi === fp.doi) return { itemKey: h.itemKey, reason: "doi", type: "doi", confidence: "strong", collection: "search_library" };
      if (query.type === "pmid" && fp.pmid && h.pmid === fp.pmid) return { itemKey: h.itemKey, reason: "pmid", type: "pmid", confidence: "strong", collection: "search_library" };
      if (query.type === "pmcid" && fp.pmcid && h.pmcid === fp.pmcid) return { itemKey: h.itemKey, reason: "pmcid", type: "pmcid", confidence: "strong", collection: "search_library" };
      if (query.type === "arxiv" && fp.arxiv && h.arxiv === fp.arxiv) return { itemKey: h.itemKey, reason: "arxiv", type: "arxiv", confidence: "strong", collection: "search_library" };
      if (query.type === "openalex" && fp.openalex && h.openalex === fp.openalex) return { itemKey: h.itemKey, reason: "openalex", type: "openalex", confidence: "strong", collection: "search_library" };
      if (query.type === "url" && fp.url && h.url === fp.url) return { itemKey: h.itemKey, reason: "url", type: "url", confidence: "strong", collection: "search_library" };
      if (query.type === "title" && fp.title && h.title === fp.title) return { itemKey: h.itemKey, reason: "title", type: "title", confidence: "weak", collection: "search_library" };
    }
  }
  return null;
}

function baseDiagnostics(total) {
  return {
    ok: true,
    pre_llm_zotero_existing_dedupe_enabled: true,
    pre_llm_zotero_duplicate_checked_count: total,
    pre_llm_existing_duplicate_count: 0,
    pre_llm_existing_duplicate_by_reason: { doi: 0, pmid: 0, pmcid: 0, url: 0, title: 0, itemKey: 0, other: 0 },
    pre_llm_duplicate_check_failed_count: 0,
    llm_review_candidate_count_before_zotero_dedupe: total,
    llm_review_candidate_count_after_zotero_dedupe: total,
    skipped_llm_review_existing_count: 0,
    duplicate_check_failed_reviewed_count: 0,
    skipped_writeback_pre_llm_existing_count: 0,
    search_library_parse_error_count: 0,
    search_query_fallback_success_count: 0,
    possible_duplicate_count: 0,
    duplicate_records: [],
    possible_duplicate_records: [],
    failed_records: [],
    search_library_error_samples: [],
    local_index_match_verification_enabled: false,
    local_index_match_verified_count: 0,
    local_index_stale_match_count: 0,
    local_index_stale_match_records: [],
    local_index_match_batch_verification_enabled: false,
    local_index_match_batch_request_count: 0,
    local_index_match_batch_item_count: 0,
    local_index_match_batch_fallback_count: 0,
  };
}

function candidateSafeId(item, index) {
  return String(item.id || item.itemKey || item.doi || item.pmid || `candidate-${index + 1}`);
}

function recordDuplicate(item, index, match, diagnostics) {
  item.pre_llm_zotero_existing_duplicate = true;
  item.pre_llm_skip_writeback = true;
  item.pre_llm_duplicate_reason = match.reason || "other";
  item.pre_llm_duplicate_collection = match.collection || "";
  item.pre_llm_existing_item_key_hash = hashText(match.itemKey || "").slice(0, 16);
  diagnostics.pre_llm_existing_duplicate_count += 1;
  diagnostics.skipped_llm_review_existing_count += 1;
  diagnostics.skipped_writeback_pre_llm_existing_count += 1;
  const reason = diagnostics.pre_llm_existing_duplicate_by_reason[match.reason] === undefined ? "other" : match.reason;
  diagnostics.pre_llm_existing_duplicate_by_reason[reason] += 1;
  if (diagnostics.duplicate_records.length < 100) {
    diagnostics.duplicate_records.push({
      candidate_id: candidateSafeId(item, index),
      title_hash: hashText(item.title || "").slice(0, 16),
      duplicate_reason: match.reason || "other",
      matched_existing_item_key_hash: hashText(match.itemKey || "").slice(0, 16),
      collection: match.collection || "",
    });
  }
}

async function verifyLocalIndexMatch(item, match, { mcpToolCall, idBase }) {
  if (!match?.itemKey || typeof mcpToolCall !== "function") return null;
  if (match.collection === "trash") return true;
  try {
    const payload = await mcpToolCall("get_item_details", { itemKey: match.itemKey, mode: "preview" }, idBase);
    const details = payload?.content?.[0]?.text ? parseToolText(payload) : payload;
    if (details?.missing === true || details?.data?.missing === true) return false;
    if (!details || !(details?.key || details?.itemKey || details?.data?.key || details?.data?.itemKey)) return null;
    const data = details?.data || details || {};
    const live = getExistingDedupeFingerprints({
      key: match.itemKey,
      itemKey: match.itemKey,
      doi: data.DOI || data.doi,
      pmid: data.pmid,
      pmcid: data.pmcid,
      url: data.url || data.URL,
      title: data.title || details?.title || "",
      extra: data.extra || details?.extra || "",
    });
    const candidate = getExistingDedupeFingerprints(item);
    if (match.type === "doi") return Boolean(candidate.doi && live.doi && candidate.doi === live.doi);
    if (match.type === "pmid") return Boolean(candidate.pmid && live.pmid && candidate.pmid === live.pmid);
    if (match.type === "pmcid") return Boolean(candidate.pmcid && live.pmcid && candidate.pmcid === live.pmcid);
    if (match.type === "url") return Boolean(candidate.url && live.url && candidate.url === live.url);
    if (match.type === "title") return Boolean(candidate.title && live.title && candidate.title === live.title);
    if (match.type === "itemKey") return Boolean(live.itemKey);
    return Boolean(live.itemKey);
  } catch {
    return null;
  }
}

function verifyDetailsAgainstCandidate(item, match, details) {
  if (!match?.itemKey) return true;
  if (match.collection === "trash") return true;
  if (!details) return null;
  if (details.missing || details?.data?.missing) return false;
  if (!(details?.key || details?.itemKey || details?.data?.key || details?.data?.itemKey)) return null;
  const data = details?.data || details || {};
  const live = getExistingDedupeFingerprints({
    key: match.itemKey,
    itemKey: match.itemKey,
    doi: data.DOI || data.doi,
    pmid: data.pmid,
    pmcid: data.pmcid,
    url: data.url || data.URL,
    title: data.title || details?.title || "",
    extra: data.extra || details?.extra || "",
  });
  const candidate = getExistingDedupeFingerprints(item);
  if (match.type === "doi") return Boolean(candidate.doi && live.doi && candidate.doi === live.doi);
  if (match.type === "pmid") return Boolean(candidate.pmid && live.pmid && candidate.pmid === live.pmid);
  if (match.type === "pmcid") return Boolean(candidate.pmcid && live.pmcid && candidate.pmcid === live.pmcid);
  if (match.type === "url") return Boolean(candidate.url && live.url && candidate.url === live.url);
  if (match.type === "title") return Boolean(candidate.title && live.title && candidate.title === live.title);
  if (match.type === "itemKey") return Boolean(live.itemKey);
  return Boolean(live.itemKey);
}

async function batchVerifyLocalIndexMatches(pending = [], { mcpToolCall, diagnostics }) {
  const results = new Map();
  const livePending = pending.filter((entry) => entry.match?.itemKey && entry.match.collection !== "trash");
  for (const entry of pending) {
    if (entry.match?.collection === "trash") results.set(entry.index, true);
  }
  if (!livePending.length) return results;

  const keys = [...new Set(livePending.map((entry) => String(entry.match.itemKey || "")).filter(Boolean))];
  try {
    diagnostics.local_index_match_batch_verification_enabled = true;
    diagnostics.local_index_match_batch_request_count += 1;
    diagnostics.local_index_match_batch_item_count += keys.length;
    const payload = await mcpToolCall("get_items_details", { itemKeys: keys, mode: "preview" }, 825000);
    const parsed = payload?.content?.[0]?.text ? parseToolText(payload) : payload;
    const details = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    const byKey = new Map(details.map((entry) => [String(entry.itemKey || entry.key || entry?.data?.itemKey || entry?.data?.key || ""), entry]));
    for (let i = 0; i < livePending.length; i += 1) {
      const entry = livePending[i];
      const detail = byKey.get(String(entry.match.itemKey || ""));
      results.set(entry.index, detail
        ? verifyDetailsAgainstCandidate(entry.item, entry.match, detail)
        : await verifyLocalIndexMatch(entry.item, entry.match, { mcpToolCall, idBase: 825000 + i }));
    }
    return results;
  } catch {
    diagnostics.local_index_match_batch_fallback_count += livePending.length;
    for (let i = 0; i < livePending.length; i += 1) {
      const entry = livePending[i];
      results.set(entry.index, await verifyLocalIndexMatch(entry.item, entry.match, { mcpToolCall, idBase: 825000 + i }));
    }
    return results;
  }
}

export async function classifyPreLlmZoteroExistingDuplicates(candidates = [], { mcpToolCall = null, localIndexPath = "", verifyLocalIndexMatches = false } = {}) {
  const source = Array.isArray(candidates) ? candidates : [];
  const diagnostics = baseDiagnostics(source.length);
  const resolvedLocalIndexPath = localIndexPath || getDefaultZoteroLibraryIndexPath(process.env.ZOTERO_PROJECT_ROOT || process.cwd());
  const localIndexRead = await readZoteroLibraryIndex(resolvedLocalIndexPath);
  const localIndexResult = localIndexRead.usable ? buildExistingIndexFromLocalLibrary(localIndexRead.index) : null;
  const localIndex = localIndexResult?.index || null;
  const completeSnapshot = localIndexRead.index?.coverage?.zotero?.complete === true;
  diagnostics.lookup_strategy = localIndex ? (completeSnapshot ? "complete_local_index" : "local_index_with_miss_fallback") : "search_library_only";
  diagnostics.local_zotero_index_complete = completeSnapshot;
  diagnostics.local_zotero_index_path = resolvedLocalIndexPath;
  diagnostics.local_zotero_index_used = Boolean(localIndex);
  diagnostics.local_zotero_index_fallback_reason = localIndexRead.usable ? "" : localIndexRead.reason;
  diagnostics.local_index_live_items_loaded = localIndexResult?.counts.local_index_live_items_loaded || 0;
  diagnostics.local_index_tombstones_loaded = localIndexResult?.counts.local_index_tombstones_loaded || 0;
  diagnostics.local_index_match_verification_enabled = Boolean(localIndex && verifyLocalIndexMatches && typeof mcpToolCall === "function");
  if (!source.length) {
    return { newCandidatesForLlmReview: [], skippedExistingBeforeLlmReview: [], duplicateCheckFailedCandidates: [], diagnostics };
  }
  if (!localIndex && typeof mcpToolCall !== "function") {
    return { newCandidatesForLlmReview: source, skippedExistingBeforeLlmReview: [], duplicateCheckFailedCandidates: [], diagnostics: { ...diagnostics, ok: false, skipped_reason: "mcp_tool_call_unavailable" } };
  }

  const newCandidates = [];
  const skipped = [];
  const failed = [];
  const preliminary = [];
  const pendingLocalVerification = [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    try {
      let match = localIndex ? findByIndex(item, localIndex) : null;
      if (!match && (!localIndex || !completeSnapshot) && typeof mcpToolCall === "function") {
        match = await findBySearchLibrary(item, { mcpToolCall, idBase: 820000 + i * 100, diagnostics });
      }
      preliminary.push({ index: i, item, match });
      if (match?.itemKey && diagnostics.local_index_match_verification_enabled) {
        pendingLocalVerification.push({ index: i, item, match });
      }
    } catch (error) {
      preliminary.push({ index: i, item, error });
    }
  }

  const localVerificationResults = diagnostics.local_index_match_verification_enabled
    ? await batchVerifyLocalIndexMatches(pendingLocalVerification, { mcpToolCall, diagnostics })
    : new Map();

  for (const entry of preliminary) {
    const { item, match, index: i, error } = entry;
    if (error) {
      item.pre_llm_duplicate_check_failed = true;
      item.pre_llm_skip_writeback = true;
      failed.push(item);
      diagnostics.pre_llm_duplicate_check_failed_count += 1;
      diagnostics.failed_records.push({
        candidate_id: candidateSafeId(item, i),
        title_hash: hashText(item.title || "").slice(0, 16),
        reason: "item_duplicate_check_failed",
        error_summary: shortError(error),
      });
      continue;
    }

    if (match?.itemKey) {
      if (diagnostics.local_index_match_verification_enabled) {
        const verified = localVerificationResults.get(i);
        if (verified == null) {
          item.pre_llm_duplicate_check_failed = true;
          item.pre_llm_skip_writeback = true;
          failed.push(item);
          diagnostics.pre_llm_duplicate_check_failed_count += 1;
          if (diagnostics.failed_records.length < 100) diagnostics.failed_records.push({
            candidate_id: candidateSafeId(item, i),
            title_hash: hashText(item.title || "").slice(0, 16),
            reason: "local_index_verification_unavailable",
          });
          continue;
        }
        if (verified === false) {
          diagnostics.local_index_stale_match_count += 1;
          if (diagnostics.local_index_stale_match_records.length < 100) {
            diagnostics.local_index_stale_match_records.push({
              candidate_id: candidateSafeId(item, i),
              title_hash: hashText(item.title || "").slice(0, 16),
              stale_item_key_hash: hashText(match.itemKey || "").slice(0, 16),
              duplicate_reason: match.reason || "other",
              collection: match.collection || "",
            });
          }
          newCandidates.push(item);
          continue;
        }
        diagnostics.local_index_match_verified_count += 1;
      }
      if (match.possibleOnly) {
        diagnostics.possible_duplicate_count += 1;
        if (diagnostics.possible_duplicate_records.length < 100) {
          diagnostics.possible_duplicate_records.push({
            candidate_id: candidateSafeId(item, i),
            title_hash: hashText(item.title || "").slice(0, 16),
            duplicate_reason: match.reason || "possible_duplicate",
            matched_existing_item_key_hash: hashText(match.itemKey || "").slice(0, 16),
            collection: match.collection || "",
          });
        }
        newCandidates.push(item);
      } else {
        recordDuplicate(item, i, match, diagnostics);
        skipped.push(item);
      }
    } else {
      newCandidates.push(item);
    }
  }
  diagnostics.llm_review_candidate_count_after_zotero_dedupe = newCandidates.length;
  return {
    newCandidatesForLlmReview: newCandidates,
    skippedExistingBeforeLlmReview: skipped,
    duplicateCheckFailedCandidates: failed,
    diagnostics,
  };
}
