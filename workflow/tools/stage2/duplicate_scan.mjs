import { getCollectionItemKeys, parseToolText } from "../lib/writeback_support.mjs";
import { normalizeLiveIndexItem } from "../lib/zotero_library_index_store.mjs";
import {
  addDuplicateIndexItem,
  getFingerprints,
} from "./duplicate_fingerprints.mjs";

export { getCollectionItemKeys };

function createEmptyDuplicateIndex() {
  return { byDoi: new Map(), byPmid: new Map(), byPmcid: new Map(), byArxiv: new Map(), byOpenalex: new Map(), byUrl: new Map(), byTitle: new Map(), meta: new Map() };
}

function itemFromLocalIndex(localIndex, itemKey) {
  return localIndex?.live_items?.[itemKey] || null;
}

export function previewItemFromDetails(details = {}, itemKey = "") {
  const data = details?.data || details || {};
  return {
    key: itemKey || data.key || data.itemKey || details?.key || details?.itemKey || "",
    itemKey: itemKey || data.itemKey || data.key || details?.itemKey || details?.key || "",
    title: data.title || details?.title || "",
    doi: data.DOI || data.doi || "",
    pmid: data.extra && String(data.extra).match(/PMID:\s*([^\s]+)/i)?.[1],
    pmcid: data.extra && String(data.extra).match(/PMCID:\s*([^\s]+)/i)?.[1],
    arxiv: data.extra && String(data.extra).match(/arXiv:\s*([^\s]+)/i)?.[1],
    url: data.url || data.URL || "",
    missing: Boolean(details?.missing || data?.missing),
  };
}

function normalizeItemReadResult(raw, itemKey = "") {
  if (raw?.content?.[0]?.text) return { item: parseToolText(raw), failed: [] };
  if (Array.isArray(raw)) {
    const item = raw.find((entry) => {
      const key = entry?.itemKey || entry?.key || entry?.data?.itemKey || entry?.data?.key || "";
      return key === itemKey;
    }) || raw[0] || null;
    return { item, failed: [] };
  }
  return {
    item: Array.isArray(raw?.items) ? raw.items[0] || null : raw,
    failed: Array.isArray(raw?.failed) ? raw.failed : [],
  };
}

async function readPreviewItemViaBackend(itemKey, { mcpToolCall, zoteroBackend = null, id = 0 } = {}) {
  const contractBackend = zoteroBackend || mcpToolCall?.adapter || null;
  const raw = typeof contractBackend?.getItems === "function"
    ? await contractBackend.getItems([itemKey], { mode: "preview", stage: "stage2_duplicate_index" })
    : await mcpToolCall("get_item_details", { itemKey, mode: "preview" }, id);
  const { item, failed } = normalizeItemReadResult(raw, itemKey);
  if (failed.length) {
    const first = failed[0];
    throw new Error(`get_item_details_failed:${first?.error || first?.reason || "unknown"}`);
  }
  if (!item) throw new Error(`get_item_details_failed:missing_result:${itemKey}`);
  return item;
}

async function readPreviewItemWithCache(itemKey, { mcpToolCall, zoteroBackend = null, localIndex = null, cacheStats = null, id = 0 } = {}) {
  const cached = itemFromLocalIndex(localIndex, itemKey);
  if (cached) {
    if (cacheStats) cacheStats.fingerprint_cache_hit_count += 1;
    return {
      item: {
        key: itemKey,
        itemKey,
        title: cached.title || "",
        doi: cached.doi || "",
        pmid: cached.pmid || "",
        pmcid: cached.pmcid || "",
        arxiv: cached.arxiv || "",
        url: cached.url || "",
      },
      fromCache: true,
    };
  }
  if (cacheStats) {
    cacheStats.fingerprint_cache_miss_count += 1;
    cacheStats.live_get_item_details_count += 1;
  }
  const details = await readPreviewItemViaBackend(itemKey, { mcpToolCall, zoteroBackend, id });
  return {
    item: previewItemFromDetails(details, itemKey),
    fromCache: false,
  };
}

export async function buildPoolIndex(rootKey, { mcpToolCall, zoteroBackend = null, localIndex = null, cacheStats = null, currentLiveItems = null } = {}) {
  const allKeys = new Set();
  const keys = await getCollectionItemKeys(rootKey, 510000, mcpToolCall, { zoteroBackend });
  for (const key of keys) allKeys.add(key);

  const index = createEmptyDuplicateIndex();
  const keyArray = [...allKeys];
  for (let i = 0; i < keyArray.length; i++) {
    const itemKey = keyArray[i];
    try {
      const { item, fromCache } = await readPreviewItemWithCache(itemKey, { mcpToolCall, zoteroBackend, localIndex, cacheStats, id: 530000 + i });
      addDuplicateIndexItem(index, item, itemKey, { source: "pool", fromCache });
      if (currentLiveItems) {
        currentLiveItems[itemKey] = normalizeLiveIndexItem({
          ...item,
          collections: [{ key: rootKey, name: "文献池" }],
          collection_roles: ["pool"],
        });
      }
    } catch {
      // Broken Zotero item reads should not abort writeback setup.
    }
  }
  return index;
}

export async function buildCollectionDuplicateIndex({ collectionKey, collectionName, collectionRole, idBase, mcpToolCall, zoteroBackend = null, localIndex = null, cacheStats = null, currentLiveItems = null }) {
  const index = createEmptyDuplicateIndex();
  let itemCount = 0;
  if (!collectionKey) return { index, itemCount };
  const keys = await getCollectionItemKeys(collectionKey, idBase, mcpToolCall, { zoteroBackend });
  for (let i = 0; i < keys.length; i++) {
    const itemKey = keys[i];
    try {
      const { item, fromCache } = await readPreviewItemWithCache(itemKey, { mcpToolCall, zoteroBackend, localIndex, cacheStats, id: idBase + 2000 + i });
      addDuplicateIndexItem(index, item, itemKey, { source: collectionRole, fromCache });
      itemCount++;
      if (currentLiveItems) {
        const previous = currentLiveItems[itemKey] || {};
        const prevCollections = Array.isArray(previous.collections) ? previous.collections : [];
        const prevRoles = Array.isArray(previous.collection_roles) ? previous.collection_roles : [];
        currentLiveItems[itemKey] = normalizeLiveIndexItem({
          ...previous,
          ...item,
          collections: [...prevCollections, { key: collectionKey, name: collectionName }],
          collection_roles: Array.from(new Set([...prevRoles, collectionRole])),
        });
      }
    } catch {
      // Broken Zotero item reads should not abort duplicate index setup.
    }
  }
  return { index, itemCount };
}

function fingerprintsMatch(candidate, liveItem, match) {
  if (!liveItem || liveItem.missing) return false;
  const candidateFp = getFingerprints(candidate);
  const liveFp = getFingerprints(liveItem);
  if (match.type === "doi") return Boolean(candidateFp.doi && liveFp.doi && candidateFp.doi === liveFp.doi);
  if (match.type === "pmid") return Boolean(candidateFp.pmid && liveFp.pmid && candidateFp.pmid === liveFp.pmid);
  if (match.type === "pmcid") return Boolean(candidateFp.pmcid && liveFp.pmcid && candidateFp.pmcid === liveFp.pmcid);
  if (match.type === "arxiv") return Boolean(candidateFp.arxiv && liveFp.arxiv && candidateFp.arxiv === liveFp.arxiv);
  if (match.type === "openalex") return Boolean(candidateFp.openalex && liveFp.openalex && candidateFp.openalex === liveFp.openalex);
  if (match.type === "url") return Boolean(candidateFp.url && liveFp.url && candidateFp.url === liveFp.url);
  if (match.type === "title") return Boolean(candidateFp.title && liveFp.title && candidateFp.title === liveFp.title);
  return false;
}

export async function verifyCachedDuplicateMatch(candidate, match, { mcpToolCall, zoteroBackend = null, idBase, liveItemsByKey = null }) {
  if (!match?.itemKey || !match.fromCache || match.isTombstone) return Boolean(match?.itemKey);
  if (liveItemsByKey instanceof Map && liveItemsByKey.has(match.itemKey)) {
    return fingerprintsMatch(candidate, liveItemsByKey.get(match.itemKey), match);
  }
  const { item } = await readPreviewItemWithCache(match.itemKey, { mcpToolCall, zoteroBackend, localIndex: null, cacheStats: null, id: idBase });
  return fingerprintsMatch(candidate, item, match);
}

function normalizeSearchLibraryResult(raw) {
  if (raw?.content?.[0]?.text) return { items: parseToolText(raw) || [], failed: [] };
  if (Array.isArray(raw)) return { items: raw, failed: [] };
  return {
    items: Array.isArray(raw?.items) ? raw.items : [],
    failed: Array.isArray(raw?.failed) ? raw.failed : [],
  };
}

async function searchLibraryForExactDedupe(query, { mcpToolCall, zoteroBackend = null, id = 0 } = {}) {
  const options = { q: query, limit: 8, mode: "preview", relevanceScoring: true };
  const contractBackend = zoteroBackend || mcpToolCall?.adapter || null;
  const raw = typeof contractBackend?.searchLibrary === "function"
    ? await contractBackend.searchLibrary({ ...options, stage: "stage2_exact_dedupe" })
    : await mcpToolCall("search_library", options, id);
  const { items, failed } = normalizeSearchLibraryResult(raw);
  if (failed.length) {
    const first = failed[0];
    throw new Error(`search_library_failed:${first?.error || first?.reason || "unknown"}`);
  }
  return items;
}

export async function findExistingByExactFields(item, { mcpToolCall, zoteroBackend = null, idBase }) {
  const queries = [item.doi, item.pmid, item.pmcid, item.arxiv, item.openalex_id, item.url, item.title].filter(Boolean);
  for (let qi = 0; qi < queries.length; qi++) {
    const q = String(queries[qi]).trim();
    if (!q) continue;
    const result = await searchLibraryForExactDedupe(q, { mcpToolCall, zoteroBackend, id: idBase + qi });
    if (!Array.isArray(result) || !result.length) continue;
    const target = getFingerprints(item);
    for (const hit of result) {
      const hitFp = getFingerprints({
        doi: hit?.DOI || hit?.doi || "",
        pmid: hit?.pmid || String(hit?.extra || "").match(/PMID:\s*([^\s]+)/i)?.[1] || "",
        pmcid: hit?.pmcid || String(hit?.extra || "").match(/PMCID:\s*([^\s]+)/i)?.[1] || "",
        arxiv: hit?.arxiv || String(hit?.extra || "").match(/arXiv:\s*([^\s]+)/i)?.[1] || "",
        openalex_id: hit?.openalex_id || "",
        url: hit?.url || hit?.URL || "",
        title: hit?.title || "",
      });
      if (target.doi && hitFp.doi && target.doi === hitFp.doi) return hit?.key || null;
      if (target.pmid && hitFp.pmid && target.pmid === hitFp.pmid) return hit?.key || null;
      if (target.pmcid && hitFp.pmcid && target.pmcid === hitFp.pmcid) return hit?.key || null;
      if (target.arxiv && hitFp.arxiv && target.arxiv === hitFp.arxiv) return hit?.key || null;
      if (target.openalex && hitFp.openalex && target.openalex === hitFp.openalex) return hit?.key || null;
      if (target.url && hitFp.url && target.url === hitFp.url) return hit?.key || null;
      if (target.title && hitFp.title && target.title === hitFp.title) return hit?.key || null;
    }
  }
  return null;
}
