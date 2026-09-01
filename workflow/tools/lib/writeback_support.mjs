import { LABELS } from "./grade_primitives.mjs";
import { normalizeDoi as normalizeDoiValue } from "./doi_normalization.mjs";
import { parseDateNameToDate, parseMonthDayCollectionDate } from "./zotero_date_collections.mjs";

export const MIGRATION_SOURCE_NAMES = ["RSS订阅", "数据库检索", LABELS.A, LABELS.B, LABELS.C];
export const BAD_TAG_RE = /^(doi|pmid|pmcid|url|title):/i;

export function normalizeDoi(value) {
  return normalizeDoiValue(value);
}

export function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeTitleExact(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[\u2010-\u2015\u2212\uff0d]/g, "-")
    .replace(/[\u2018\u2019\u201A\u201B\u02BC\u2032\uff07]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033\uff02]/g, '"')
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, " ")
    .replace(/[\uFE30\uFE31\uFE32\uFE33\uFE34\uFE58\uFE63\uff0d]/g, "-")
    .replace(/\.{3}/g, " ")
    .replace(/…/g, " ")
    .replace(/~/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\uff10-\uff19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF10 + 48))
    .replace(/[\uff21-\uff3a]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF21 + 97))
    .replace(/[\uff41-\uff5a]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFF41 + 97))
    .replace(/[\u00bc-\u00be]/g, (ch) => ({ "\u00bc": "1/4", "\u00bd": "1/2", "\u00be": "3/4" }[ch] || ch))
    .replace(/[\u2150-\u215f]/g, (ch) => ({
      "\u2150": "1/7", "\u2151": "1/9", "\u2152": "1/10", "\u2153": "1/3", "\u2154": "2/3", "\u2155": "1/5", "\u2156": "2/5", "\u2157": "3/5", "\u2158": "4/5", "\u2159": "1/6", "\u215a": "5/6", "\u215b": "1/8", "\u215c": "3/8", "\u215d": "5/8", "\u215e": "7/8", "\u215f": "1"
    }[ch] || ch))
    .replace(/[\u2460-\u2473\u2474-\u2487\u2488-\u249b\u3251-\u325f\u3260-\u327e\u3280-\u32bf\u32d0-\u32fe]/g, (ch) => {
      const code = ch.charCodeAt(0);
      if (code >= 0x2460 && code <= 0x2473) return String(code - 0x2460 + 1);
      if (code >= 0x2474 && code <= 0x2487) return String(code - 0x2474 + 1);
      if (code >= 0x2488 && code <= 0x249b) return String(code - 0x2488 + 1);
      if (code >= 0x3251 && code <= 0x325f) return String(code - 0x3251 + 21);
      if (code >= 0x3260 && code <= 0x327e) return String(code - 0x3260 + 1);
      if (code >= 0x3280 && code <= 0x32bf) return String(code - 0x3280 + 1);
      if (code >= 0x32d0 && code <= 0x32fe) return String(code - 0x32d0 + 1);
      return " ";
    })
    .replace(/[\u2460-\u2473\u2474-\u2487\u2488-\u249b\u3251-\u325f\u3260-\u327e\u3280-\u32bf\u32d0-\u32fe]/g, " ")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .trim();
}


export function buildPoolDuplicateIndex(items = []) {
  const idx = { doi: new Map(), pmid: new Map(), pmcid: new Map(), arxiv: new Map(), title: new Map() };
  for (const item of items) {
    const key = item.itemKey || item.key || "";
    const doi = normalizeDoi(item.doi || item.DOI || "");
    const pmid = normalizeIdentifier(item.pmid || "");
    const pmcid = normalizeIdentifier(item.pmcid || "");
    const arxiv = normalizeIdentifier(item.arxiv || item.arxiv_id || "");
    const title = normalizeTitleExact(item.title || "");
    if (doi && !idx.doi.has(doi)) idx.doi.set(doi, key);
    if (pmid && !idx.pmid.has(pmid)) idx.pmid.set(pmid, key);
    if (pmcid && !idx.pmcid.has(pmcid)) idx.pmcid.set(pmcid, key);
    if (arxiv && !idx.arxiv.has(arxiv)) idx.arxiv.set(arxiv, key);
    if (title && !idx.title.has(title)) idx.title.set(title, key);
  }
  return idx;
}

export function matchPoolDuplicate(candidate, idx) {
  const doi = normalizeDoi(candidate.doi || candidate.DOI || "");
  if (doi && idx.doi.has(doi)) return { matched: true, type: "doi", value: doi, itemKey: idx.doi.get(doi) };
  const pmid = normalizeIdentifier(candidate.pmid || "");
  if (pmid && idx.pmid.has(pmid)) return { matched: true, type: "pmid", value: pmid, itemKey: idx.pmid.get(pmid) };
  const pmcid = normalizeIdentifier(candidate.pmcid || "");
  if (pmcid && idx.pmcid.has(pmcid)) return { matched: true, type: "pmcid", value: pmcid, itemKey: idx.pmcid.get(pmcid) };
  const arxiv = normalizeIdentifier(candidate.arxiv || candidate.arxiv_id || "");
  if (arxiv && idx.arxiv.has(arxiv)) return { matched: true, type: "arxiv", value: arxiv, itemKey: idx.arxiv.get(arxiv) };
  const title = normalizeTitleExact(candidate.title || "");
  if (title && idx.title.has(title)) return { matched: true, type: "title", value: title, itemKey: idx.title.get(title) };
  return { matched: false };
}

export function resolveWritebackConcurrency(rawValue, defaultConcurrency = 10) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return { value: defaultConcurrency, clamped: false, warning: "" };
  }
  const n = Number(rawValue);
  if (!Number.isFinite(n) || n < 1) {
    return { value: defaultConcurrency, clamped: true, warning: "invalid_writeback_concurrency_fallback_to_default" };
  }
  const value = Math.max(1, Math.floor(n));
  const warning = value > 10 ? "writeback_concurrency_gt_10_high_risk_experiment" : "";
  return { value, clamped: value !== n, warning };
}

export function resolveConcurrencySource(rawValue) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") {
    return "default";
  }
  return "env";
}

export function nextWritebackDowngrade(current) {
  const c = Number(current || 1);
  if (c > 10) return 10;
  if (c > 6) return 6;
  if (c > 3) return 3;
  if (c > 1) return 1;
  return 1;
}

export function shouldStopWritebackByRisk({
  failureRate = 0,
  uncertainCreateStateCount = 0,
  fallbackToSerial = false,
  duplicateDetectedCount = 0,
  wrongCollectionDetectedCount = 0,
  mcpErrors = [],
}) {
  if (duplicateDetectedCount > 0 || wrongCollectionDetectedCount > 0) {
    return { stop: true, downgrade: false, reason: "high_risk_data_integrity" };
  }
  if (uncertainCreateStateCount > 0) {
    return { stop: false, downgrade: true, reason: "uncertain_create_state" };
  }
  if (failureRate > 0.05) {
    return { stop: false, downgrade: true, reason: "failure_rate_gt_5pct" };
  }
  if (fallbackToSerial) {
    return { stop: false, downgrade: true, reason: "collection_attach_fallback" };
  }
  const joined = (mcpErrors || []).join(" | ").toLowerCase();
  if (/(database busy|transaction failed|timeout|lock conflict|writeback_failed|429|rate limit)/i.test(joined)) {
    return { stop: false, downgrade: true, reason: "mcp_runtime_error" };
  }
  return { stop: false, downgrade: false, reason: "" };
}

export function parseToolText(result) {
  const txt = result?.content?.[0]?.text || "{}";
  return JSON.parse(txt);
}

function normalizeCollectionItemsResult(raw) {
  if (raw?.content?.[0]?.text) return { items: parseToolText(raw), failed: [] };
  if (Array.isArray(raw)) return { items: raw, failed: [] };
  return {
    items: Array.isArray(raw?.items) ? raw.items : [],
    failed: Array.isArray(raw?.failed) ? raw.failed : [],
  };
}

function normalizeSubcollectionsResult(raw) {
  if (raw?.content?.[0]?.text) return { items: parseToolText(raw), failed: [] };
  if (Array.isArray(raw)) return { items: raw, failed: [] };
  return {
    items: Array.isArray(raw?.subcollections)
      ? raw.subcollections
      : (Array.isArray(raw?.items) ? raw.items : []),
    failed: [
      ...(Array.isArray(raw?.missing) ? raw.missing : []),
      ...(Array.isArray(raw?.failed) ? raw.failed : []),
    ],
  };
}

function normalizeItemDetailsResult(raw, itemKey = "") {
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

export async function readItemDetails(itemKey, { zoteroBackend = null, zoteroBackendCall, mcpToolCall, mode = "preview", id = 0, stage = "stage2_item_read" } = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const contractBackend = typeof zoteroBackend?.getItems === "function" ? zoteroBackend : callZotero?.adapter || null;
  const raw = typeof contractBackend?.getItems === "function"
    ? await contractBackend.getItems([itemKey], { mode, stage })
    : await callZotero("get_item_details", { itemKey, mode }, id);
  const { item, failed } = normalizeItemDetailsResult(raw, itemKey);
  if (failed.length) {
    const first = failed[0];
    throw new Error(`get_item_details_failed:${first?.error || first?.reason || "unknown"}`);
  }
  if (!item) throw new Error(`get_item_details_failed:missing_result:${itemKey}`);
  return item;
}

export async function readCollectionItems(collectionKey, { zoteroBackend = null, zoteroBackendCall, mcpToolCall, limit = 500, offset = 0, id = 0, stage = "stage2_collection_items" } = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const contractBackend = typeof zoteroBackend?.getCollectionItems === "function" ? zoteroBackend : callZotero?.adapter || null;
  const options = { collectionKey, limit, offset, stage };
  const raw = typeof contractBackend?.getCollectionItems === "function"
    ? await contractBackend.getCollectionItems(collectionKey, options)
    : await callZotero("get_collection_items", { collectionKey, limit, offset }, id);
  const { items, failed } = normalizeCollectionItemsResult(raw);
  if (failed.length) {
    const first = failed[0];
    throw new Error(`get_collection_items_failed:${first?.error || first?.reason || "unknown"}`);
  }
  return items;
}

export async function readSubcollections(collectionKey, { zoteroBackend = null, zoteroBackendCall, mcpToolCall, recursive = false, id = 0, stage = "stage2_subcollection_read" } = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const contractBackend = typeof zoteroBackend?.getSubcollections === "function" ? zoteroBackend : callZotero?.adapter || null;
  let raw;
  try {
    raw = typeof contractBackend?.getSubcollections === "function"
      ? await contractBackend.getSubcollections(collectionKey, recursive, { stage })
      : await callZotero("get_subcollections", { collectionKey, recursive }, id);
  } catch (error) {
    throw new Error(`get_subcollections_failed:${error?.message || String(error)}`);
  }
  const { items, failed } = normalizeSubcollectionsResult(raw);
  if (failed.length) {
    const first = failed[0];
    throw new Error(`get_subcollections_failed:${first?.error || first?.reason || "unknown"}`);
  }
  return items;
}

export async function getCollectionItemKeys(collectionKey, idBase, mcpToolCall, options = {}) {
  const keys = [];
  let offset = 0;
  const limit = 500;
  while (true) {
    const items = await readCollectionItems(collectionKey, {
      ...options,
      mcpToolCall,
      limit,
      offset,
      id: idBase + offset,
    });
    if (!Array.isArray(items) || !items.length) break;
    for (const it of items) {
      if (it?.key) keys.push(it.key);
    }
    if (items.length < limit) break;
    offset += limit;
  }
  return keys;
}

export async function runGuardedWriteMetadataUpdates({
  updates = [],
  apply = false,
  dryRun = !apply,
  writer = null,
  itemKeyForUpdate = (update) => update?.itemKey || "",
  fieldsForUpdate = (update) => update?.fields || {},
  allowedItemKeys = null,
  blockedItemReason = "write_metadata_item_not_seen_in_allowed_scan",
  guardReady = true,
  guardBlockedReason = "",
  onProgress = null,
  onFailure = null,
} = {}) {
  const list = Array.isArray(updates) ? updates : [];
  const result = {
    ok: true,
    dry_run: Boolean(dryRun || !apply),
    apply: Boolean(apply && !dryRun),
    planned_update_count: list.length,
    write_success_count: 0,
    write_failure_count: 0,
    write_failures: [],
    guard_blocked_count: 0,
    writer_called: false,
  };

  if (result.dry_run) {
    return result;
  }

  if (!guardReady) {
    const reason = guardBlockedReason || "write_metadata_guard_not_ready";
    result.ok = false;
    result.guard_blocked_count = list.length;
    result.write_failure_count = list.length;
    result.write_failures = list.map((update) => ({
      itemKey: itemKeyForUpdate(update),
      error: reason,
      blocked: true,
    }));
    return result;
  }

  if (typeof writer !== "function") {
    throw new Error("write_metadata_writer_required");
  }

  for (const update of list) {
    const itemKey = itemKeyForUpdate(update);
    try {
      if (allowedItemKeys && !allowedItemKeys.has(itemKey)) {
        throw new Error(blockedItemReason);
      }
      const fields = fieldsForUpdate(update);
      result.writer_called = true;
      await writer({ update, itemKey, fields });
      result.write_success_count++;
      if (typeof onProgress === "function") {
        onProgress({ update, itemKey, success: result.write_success_count, total: list.length });
      }
    } catch (error) {
      result.write_failure_count++;
      const failure = {
        itemKey,
        error: error?.message || String(error),
      };
      result.write_failures.push(failure);
      if (typeof onFailure === "function") {
        onFailure({ update, itemKey, error, failure });
      }
    }
  }

  result.ok = result.write_failure_count === 0;
  return result;
}

export function buildWritebackItemRecord(itemKey, item, sourceCollection, gradeCollection) {
  return {
    itemKey,
    title: item.title || "",
    abstract: item.abstract || item.abstractNote || item.summary || "",
    中文标题: item["中文标题"] || item.title || "",
    grade: item.grade || "",
    grade_label: item.grade_label || item["推荐等级"] || "",
    final_grade: item.final_grade || "",
    doi: item.doi || item.DOI || "",
    pmid: item.pmid || "",
    pmcid: item.pmcid || "",
    arxiv: item.arxiv || item.arxiv_id || "",
    openalex: item.openalex || item.openalex_id || "",
    url: item.url || item.URL || "",
    effective_grade: gradeCollection || "",
    source_channel: item.source_channel || "",
    source_collection: sourceCollection,
    grade_collection: gradeCollection,
    backfill_short_title: true,
  };
}

export function groupItemKeysByCollection(records = []) {
  const grouped = new Map();
  for (const rec of records) {
    if (!rec?.itemKey) continue;
    for (const key of [rec.pool_collection_key, rec.source_collection_key, rec.grade_collection_key]) {
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, new Set());
      grouped.get(key).add(rec.itemKey);
    }
  }
  return grouped;
}

export async function attachItemsByCollectionBatched({
  groupedItemKeys,
  batchSize = 50,
  zoteroBackendCall,
  mcpToolCall,
  idBase = 800000,
  collectionGuard = null,
  collectionScopeBlocks = null,
}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const attachStats = {
    collection_attach_mode: "batch",
    collection_attach_batch_size: batchSize,
    collection_attach_calls: 0,
    collection_attach_failures: [],
    fallback_to_per_item_count: 0,
  };

  let callOffset = 0;
  for (const [collectionKey, keySet] of (groupedItemKeys || new Map()).entries()) {
    if (collectionGuard) {
      const check = collectionGuard.checkCollectionKey(collectionKey, { action: "add_items_to_collection", role: "target" });
      if (!check.ok) {
        const keys = [...keySet];
        const block = {
          status: "collection_scope_blocked",
          action: "add_items_to_collection",
          role: "target",
          collection_key: collectionKey,
          collection_name: check.collectionName || "",
          itemKeys: keys,
          reason: check.reason,
        };
        if (Array.isArray(collectionScopeBlocks)) collectionScopeBlocks.push(block);
        attachStats.collection_attach_failures.push({
          collectionKey,
          itemKeys: keys,
          error: `collection_scope_blocked:${check.reason}`,
        });
        continue;
      }
    }
    const keys = [...keySet];
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      try {
        attachStats.collection_attach_calls += 1;
        await callZotero("add_items_to_collection", { collectionKey, itemKeys: batch }, idBase + callOffset++);
      } catch (error) {
        attachStats.collection_attach_failures.push({
          collectionKey,
          itemKeys: batch,
          error: String(error?.message || error),
        });
        for (const itemKey of batch) {
          try {
            attachStats.fallback_to_per_item_count += 1;
            attachStats.collection_attach_calls += 1;
            await callZotero("add_items_to_collection", { collectionKey, itemKeys: [itemKey] }, idBase + callOffset++);
          } catch (perItemError) {
            attachStats.collection_attach_failures.push({
              collectionKey,
              itemKeys: [itemKey],
              error: String(perItemError?.message || perItemError),
              fallback: true,
            });
          }
        }
      }
    }
  }
  return attachStats;
}

export async function attachItemsToCollectionsBatched({
  groupedItemKeys,
  batchSize = 50,
  zoteroBackend = null,
  zoteroBackendCall,
  mcpToolCall,
  idBase = 800000,
  collectionGuard = null,
  collectionScopeBlocks = null,
}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const attachStats = {
    collection_attach_mode: "multi_collection_batch",
    collection_attach_batch_size: batchSize,
    collection_attach_calls: 0,
    collection_attach_failures: [],
    fallback_to_per_item_count: 0,
    collection_attach_fallback_to_collection_batch: false,
  };

  const operations = [];
  for (const [collectionKey, keySet] of (groupedItemKeys || new Map()).entries()) {
    const keys = [...keySet];
    if (!collectionKey || keys.length === 0) continue;
    if (collectionGuard) {
      const check = collectionGuard.checkCollectionKey(collectionKey, { action: "add_items_to_collection", role: "target" });
      if (!check.ok) {
        const block = {
          status: "collection_scope_blocked",
          action: "add_items_to_collection",
          role: "target",
          collection_key: collectionKey,
          collection_name: check.collectionName || "",
          itemKeys: keys,
          reason: check.reason,
        };
        if (Array.isArray(collectionScopeBlocks)) collectionScopeBlocks.push(block);
        attachStats.collection_attach_failures.push({
          collectionKey,
          itemKeys: keys,
          error: `collection_scope_blocked:${check.reason}`,
        });
        continue;
      }
    }
    for (let i = 0; i < keys.length; i += batchSize) {
      operations.push({ collectionKey, itemKeys: keys.slice(i, i + batchSize) });
    }
  }

  if (!operations.length) return attachStats;

  try {
    attachStats.collection_attach_calls += 1;
    const result = typeof zoteroBackend?.addItemsToCollections === "function"
      ? await zoteroBackend.addItemsToCollections(operations, { verify: false, stage: "stage2_collection_attach" })
      : await callZotero("add_items_to_collections", { operations }, idBase);
    const parsed = result?.content?.[0]?.text ? parseToolText(result) : result;
    for (const failure of parsed?.failed || []) {
      attachStats.collection_attach_failures.push({
        collectionKey: failure.collectionKey || "",
        itemKeys: failure.itemKey ? [failure.itemKey] : [],
        error: String(failure.error || "add_items_to_collections_failed"),
      });
    }
    return attachStats;
  } catch (error) {
    attachStats.collection_attach_fallback_to_collection_batch = true;
    attachStats.collection_attach_failures.push({
      collectionKey: "",
      itemKeys: [],
      error: String(error?.message || error),
      fallback: "collection_batch",
    });
    const fallbackStats = await attachItemsByCollectionBatched({
      groupedItemKeys,
      batchSize,
      zoteroBackendCall: callZotero,
      idBase: idBase + 1000,
      collectionGuard,
      collectionScopeBlocks,
    });
    return {
      ...attachStats,
      collection_attach_calls: attachStats.collection_attach_calls + fallbackStats.collection_attach_calls,
      collection_attach_failures: [
        ...attachStats.collection_attach_failures,
        ...fallbackStats.collection_attach_failures,
      ],
      fallback_to_per_item_count: fallbackStats.fallback_to_per_item_count,
    };
  }
}

export function inLast7Days(d, now) {
  if (!d) return false;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d >= start && d <= end;
}

function normalizeTags(rawTags) {
  return (rawTags || [])
    .map((t) => (typeof t === "string" ? { tag: t } : t))
    .filter((x) => x && x.tag);
}

function collectionPathParts(collection = {}) {
  return String(collection?.path || collection?.name || collection || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
}

function collectionPathHasRecentDate(collection = {}, now) {
  const parts = collectionPathParts(collection);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const dt = parseDateNameToDate(parts[i]) || parseMonthDayCollectionDate(parts[i], parts.slice(0, i));
    if (inLast7Days(dt, now)) return true;
  }
  return false;
}

function localItemInCleanupScope(item = {}, worthyKey, now) {
  return (item.collections || []).some((collection) => {
    const key = String(collection?.key || collection || "");
    const name = String(collection?.name || collection?.path || collection || "");
    if (worthyKey && key === worthyKey) return true;
    const parts = collectionPathParts(collection);
    const last = parts.at(-1) || name;
    return MIGRATION_SOURCE_NAMES.includes(last) && collectionPathHasRecentDate(collection, now);
  });
}

export async function cleanupSignatureTags(rootKey, worthyKey, { now = new Date(), localLibraryIndex = null, candidateItems = [], fullScan = true, zoteroBackendCall, mcpToolCall, writeTagSet = null, apply = true, dryRun = !apply } = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const itemDetailsFromLocalIndex = new Map();
  const itemKeys = new Set();
  const candidateKeys = new Set();
  for (const item of candidateItems || []) {
    const itemKey = String(item?.itemKey || item?.key || "").trim();
    if (!itemKey) continue;
    candidateKeys.add(itemKey);
    itemKeys.add(itemKey);
    if (Array.isArray(item.tags)) itemDetailsFromLocalIndex.set(itemKey, item);
  }
  let scopedLocalItemCount = 0;
  let includedScopedLocalItemCount = 0;
  if (localLibraryIndex?.live_items) {
    for (const item of Object.values(localLibraryIndex.live_items || {})) {
      if (!item?.itemKey || !localItemInCleanupScope(item, worthyKey, now)) continue;
      scopedLocalItemCount += 1;
      const hasSignatureTag = normalizeTags(item.tags).some((tag) => BAD_TAG_RE.test(String(tag.tag)));
      if (!fullScan && !candidateKeys.has(item.itemKey) && !hasSignatureTag) continue;
      includedScopedLocalItemCount += 1;
      itemKeys.add(item.itemKey);
      if (Array.isArray(item.tags) && (!fullScan || item.tags.length)) itemDetailsFromLocalIndex.set(item.itemKey, item);
    }
  }
  if (fullScan && !localLibraryIndex?.live_items) {
    const tree = await readSubcollections(rootKey, { mcpToolCall: callZotero, recursive: true, id: 600000, stage: "stage2_tag_cleanup_tree" });
    const collections = new Set([worthyKey]);
    for (const node of tree) {
      const dt = parseDateNameToDate(node.name);
      if (!inLast7Days(dt, now)) continue;
      for (const c of (node.subcollections || [])) {
        if (MIGRATION_SOURCE_NAMES.includes(c.name)) collections.add(c.key);
      }
    }
    let base = 610000;
    for (const ck of collections) {
      const keys = await getCollectionItemKeys(ck, base, callZotero);
      base += 2000;
      for (const k of keys) itemKeys.add(k);
    }
  }
  const stats = { scanned: 0, cleaned_items: 0, removed_tag_count: 0, failures: [], cleaned_item_records: [], local_zotero_index_used: Boolean(localLibraryIndex?.live_items), local_tag_detail_hit_count: 0, live_get_item_details_count: 0, candidate_item_count: candidateKeys.size, skipped_non_candidate_count: Math.max(0, scopedLocalItemCount - includedScopedLocalItemCount), historical_fallback_used: Boolean(fullScan) };
  const keys = [...itemKeys];
  for (let i = 0; i < keys.length; i++) {
    const itemKey = keys[i];
    stats.scanned++;
    try {
      const local = itemDetailsFromLocalIndex.get(itemKey);
      let tags = local?.tags || null;
      if (tags) {
        stats.local_tag_detail_hit_count += 1;
      } else {
        stats.live_get_item_details_count += 1;
        const det = await readItemDetails(itemKey, { mcpToolCall: callZotero, mode: "preview", id: 630000 + i, stage: "stage2_tag_cleanup" });
        const data = det?.data || {};
        tags = Array.isArray(data.tags) ? data.tags : (Array.isArray(det?.tags) ? det.tags : []);
      }
      const normalized = normalizeTags(tags);
      const keep = normalized.filter((t) => !BAD_TAG_RE.test(String(t.tag)));
      const removed = normalized.length - keep.length;
      if (removed <= 0) continue;
      const nextTags = keep.map((t) => String(t.tag));
      const writeResult = typeof writeTagSet === "function"
        ? await writeTagSet({ itemKey, tags: nextTags, id: 650000 + i, apply, dryRun })
        : await callZotero("write_tag", { action: "set", itemKey, tags: nextTags }, 650000 + i);
      if (writeResult?.ok === false) {
        const failures = Array.isArray(writeResult.write_failures) && writeResult.write_failures.length
          ? writeResult.write_failures
          : [{ itemKey, error: "tag_cleanup_write_failed" }];
        for (const failure of failures) {
          if (stats.failures.length < 80) stats.failures.push({ itemKey, error: String(failure?.error || failure) });
        }
        continue;
      }
      stats.cleaned_items++;
      stats.removed_tag_count += removed;
      if (stats.cleaned_item_records.length < 500) stats.cleaned_item_records.push({ itemKey, tags: nextTags });
    } catch (e) {
      if (stats.failures.length < 80) stats.failures.push({ itemKey, error: String(e.message || e) });
    }
  }
  return stats;
}
