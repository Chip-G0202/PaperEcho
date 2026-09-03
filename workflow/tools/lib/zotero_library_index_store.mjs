import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerEphemeral } from "./ephemeral_registry.mjs";

import { getLiteratureDedupeFingerprints, getLiteratureIdentityKeys, LITERATURE_IDENTITY_PRIORITY } from "./literature_identity.mjs";

export const ZOTERO_LIBRARY_INDEX_SCHEMA_VERSION = 2;
export const ZOTERO_LIBRARY_INDEX_RELATIVE_PATH = path.join("review_results", "shared", "current_literature_index.json");
export const LEGACY_ZOTERO_LIBRARY_INDEX_RELATIVE_PATH = path.join("review_results", "zotero_index", "current_library_index.json");

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeUrl(value) {
  const raw = cleanString(value);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/#.*$/, "").replace(/\/$/, "").toLowerCase();
  }
}

function firstString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

export function getDefaultZoteroLibraryIndexPath(projectRoot = process.cwd()) {
  const resolved = path.resolve(projectRoot);
  const root = path.basename(resolved).toLowerCase() === "review_results" ? path.dirname(resolved) : resolved;
  return path.join(root, ZOTERO_LIBRARY_INDEX_RELATIVE_PATH);
}

function legacyPathForSharedIndex(filePath) {
  const suffix = path.normalize(ZOTERO_LIBRARY_INDEX_RELATIVE_PATH);
  const normalized = path.normalize(filePath);
  return normalized.endsWith(suffix)
    ? path.join(normalized.slice(0, -suffix.length), LEGACY_ZOTERO_LIBRARY_INDEX_RELATIVE_PATH)
    : "";
}

export function emptyZoteroLibraryIndex({ generatedAt = nowIso(), workflowDay = "", mcpUrl = "" } = {}) {
  return {
    schema_version: ZOTERO_LIBRARY_INDEX_SCHEMA_VERSION,
    generated_at: generatedAt,
    workflow_day: cleanString(workflowDay),
    mcp_url: cleanString(mcpUrl),
    coverage: { zotero: { complete: false, scope: "", backend_identity: "", refreshed_at: "", status: "unknown" } },
    records: {},
    live_items: {},
    tombstones: {},
    fingerprints: {
      doi: {},
      pmid: {},
      pmcid: {},
      arxiv: {},
      openalex: {},
      url: {},
      title: {},
    },
    collections: {},
    integrity_monitoring: { schema_version: 1, bootstrap: {} },
    stats: {},
  };
}

export function getZoteroIndexFingerprints(item = {}) {
  return getLiteratureDedupeFingerprints({ ...item, title: item.title || item.name || "" });
}

export function normalizeLiveIndexItem(item = {}) {
  const itemKey = firstString(item.itemKey, item.item_key, item.key);
  const title = firstString(item.title, item.name);
  const fingerprints = getZoteroIndexFingerprints({ ...item, title });
  const tags = Array.isArray(item.tags) ? item.tags.map((tag) => { if (typeof tag === "string") return { tag }; if (tag?.name) return { tag: tag.name }; return tag; }).filter((tag) => cleanString(tag?.tag))
    : [];
  return {
    itemKey,
    title,
    shortTitle: cleanString(item.shortTitle || item.short_title),
    doi: fingerprints.doi,
    pmid: fingerprints.pmid,
    pmcid: fingerprints.pmcid,
    arxiv: fingerprints.arxiv,
    openalex: fingerprints.openalex,
    url: fingerprints.url,
    normalizedTitle: fingerprints.title,
    collections: Array.isArray(item.collections) ? item.collections : [],
    collection_roles: Array.isArray(item.collection_roles) ? item.collection_roles : [],
    tags,
    starred: item.starred === true || item.starred === 1,
    favorite: item.favorite === true || item.favorite === 1,
    dateAdded: cleanString(item.dateAdded || item.date_added),
    dateModified: cleanString(item.dateModified || item.date_modified),
    version: Number(item.version || item.data?.version || 0) || 0,
    indexed_at: cleanString(item.indexed_at) || nowIso(),
  };
}

function tombstoneIdFromItem(item = {}) {
  const fp = getZoteroIndexFingerprints(item);
  const source = cleanString(item.tombstone_source || item.source || "deleted_trash");
  for (const type of LITERATURE_IDENTITY_PRIORITY) {
    if (fp[type]) return `${source}:${type}:${fp[type]}`;
  }
  const itemKey = firstString(item.itemKey, item.item_key, item.key);
  return itemKey ? `${source}:itemKey:${itemKey}` : "";
}

export function normalizeTombstone(item = {}, { source = "", reason = "", generatedAt = nowIso() } = {}) {
  const title = firstString(item.title, item.name);
  const fingerprints = getZoteroIndexFingerprints({ ...item, title });
  const tombstoneSource = cleanString(source || item.tombstone_source || item.source || "deleted_trash");
  const tombstoneReason = cleanString(reason || item.tombstone_reason || item.reason || "deleted_trash_tombstone");
  const tombstoneId = cleanString(item.tombstoneId || item.tombstone_id) || tombstoneIdFromItem({ ...item, title, tombstone_source: tombstoneSource });
  return {
    tombstoneId,
    itemKey: firstString(item.itemKey, item.item_key, item.key),
    title,
    doi: fingerprints.doi,
    pmid: fingerprints.pmid,
    pmcid: fingerprints.pmcid,
    arxiv: fingerprints.arxiv,
    openalex: fingerprints.openalex,
    url: fingerprints.url,
    normalizedTitle: fingerprints.title,
    tombstone_source: tombstoneSource,
    tombstone_reason: tombstoneReason,
    first_seen_at: cleanString(item.first_seen_at) || generatedAt,
    last_seen_at: cleanString(item.last_seen_at) || generatedAt,
  };
}

function sourceItemsFromIndex(index = {}) {
  const liveItems = Object.values(index.live_items || {}).map((item) => ({ status: "live", item }));
  const tombstones = Object.values(index.tombstones || {}).map((item) => ({ status: "tombstone", item }));
  return [...liveItems, ...tombstones];
}

function setFingerprint(map, type, value, match) {
  if (!value || map[type][value]) return;
  map[type][value] = match;
}

export function buildFingerprintMaps(input = {}) {
  const maps = { doi: {}, pmid: {}, pmcid: {}, arxiv: {}, openalex: {}, url: {}, title: {} };
  const entries = Array.isArray(input) ? input.map((item) => ({ status: item.tombstoneId ? "tombstone" : "live", item })) : sourceItemsFromIndex(input);
  for (const entry of entries) {
    const item = entry.status === "tombstone" ? normalizeTombstone(entry.item) : normalizeLiveIndexItem(entry.item);
    const match = {
      status: entry.status,
      itemKey: item.itemKey || "",
      tombstoneId: item.tombstoneId || "",
      reason: entry.status === "tombstone" ? item.tombstone_reason || "deleted_trash_tombstone" : "existing_live_item",
      source: entry.status === "tombstone" ? item.tombstone_source || "deleted_trash" : "live_items",
    };
    setFingerprint(maps, "doi", item.doi, { ...match, type: "doi", value: item.doi });
    setFingerprint(maps, "pmid", item.pmid, { ...match, type: "pmid", value: item.pmid });
    setFingerprint(maps, "pmcid", item.pmcid, { ...match, type: "pmcid", value: item.pmcid });
    setFingerprint(maps, "arxiv", item.arxiv, { ...match, type: "arxiv", value: item.arxiv });
    setFingerprint(maps, "openalex", item.openalex, { ...match, type: "openalex", value: item.openalex });
    setFingerprint(maps, "url", item.url, { ...match, type: "url", value: item.url });
    setFingerprint(maps, "title", item.normalizedTitle, { ...match, type: "title", value: item.normalizedTitle });
  }
  return maps;
}

function canonicalRecordId(item = {}) {
  return getLiteratureIdentityKeys(item)[0] || "";
}

function recordFromZoteroItem(item = {}, previous = {}) {
  const normalized = normalizeLiveIndexItem(item);
  const canonicalId = canonicalRecordId(normalized);
  if (!canonicalId) return null;
  return {
    canonical_id: canonicalId,
    identity: getZoteroIndexFingerprints(normalized),
    title: normalized.title,
    first_seen_at: previous.first_seen_at || normalized.indexed_at || nowIso(),
    last_seen_at: normalized.indexed_at || nowIso(),
    presence: {
      ...(previous.presence || {}),
      zotero: {
        itemKey: normalized.itemKey,
        shortTitle: normalized.shortTitle,
        collections: normalized.collections,
        collection_roles: normalized.collection_roles,
        tags: normalized.tags,
        starred: normalized.starred,
        favorite: normalized.favorite,
        dateAdded: normalized.dateAdded,
        dateModified: normalized.dateModified,
        version: normalized.version,
      },
    },
    ...(previous.radar_notification ? { radar_notification: previous.radar_notification } : {}),
    ...(previous.radar_metadata ? { radar_metadata: previous.radar_metadata } : {}),
    ...(previous.integrity ? { integrity: previous.integrity } : {}),
  };
}

function rebuildRecords(index = {}) {
  const records = { ...(index.records || {}) };
  for (const item of Object.values(index.live_items || {})) {
    const canonicalId = canonicalRecordId(item);
    const record = recordFromZoteroItem(item, records[canonicalId] || {});
    if (record) records[canonicalId] = record;
  }
  return records;
}

export function normalizeZoteroLibraryIndex(index = {}) {
  const normalized = emptyZoteroLibraryIndex({
    generatedAt: cleanString(index.generated_at) || nowIso(),
    workflowDay: index.workflow_day,
    mcpUrl: index.mcp_url,
  });
  normalized.collections = index.collections && typeof index.collections === "object" && !Array.isArray(index.collections)
    ? index.collections
    : {};
  normalized.stats = index.stats && typeof index.stats === "object" && !Array.isArray(index.stats)
    ? index.stats
    : {};
  normalized.integrity_monitoring = index.integrity_monitoring && typeof index.integrity_monitoring === "object" && !Array.isArray(index.integrity_monitoring)
    ? index.integrity_monitoring
    : normalized.integrity_monitoring;
  normalized.coverage = index.coverage && typeof index.coverage === "object"
    ? index.coverage
    : normalized.coverage;

  for (const item of Object.values(index.live_items || {})) {
    const normalizedItem = normalizeLiveIndexItem(item);
    if (normalizedItem.itemKey) normalized.live_items[normalizedItem.itemKey] = normalizedItem;
  }
  for (const item of Object.values(index.tombstones || {})) {
    const normalizedTombstone = normalizeTombstone(item);
    if (normalizedTombstone.tombstoneId) normalized.tombstones[normalizedTombstone.tombstoneId] = normalizedTombstone;
  }
  normalized.fingerprints = buildFingerprintMaps(normalized);
  normalized.records = rebuildRecords({ ...normalized, records: index.records });
  return normalized;
}

export function validateZoteroLibraryIndex(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { usable: false, reason: "index_not_object" };
  }
  if (![1, ZOTERO_LIBRARY_INDEX_SCHEMA_VERSION].includes(value.schema_version)) {
    return { usable: false, reason: "schema_version_mismatch" };
  }
  if (!value.live_items || typeof value.live_items !== "object" || Array.isArray(value.live_items)) {
    return { usable: false, reason: "live_items_invalid" };
  }
  if (!value.tombstones || typeof value.tombstones !== "object" || Array.isArray(value.tombstones)) {
    return { usable: false, reason: "tombstones_invalid" };
  }
  return { usable: true, reason: "" };
}

export async function readZoteroLibraryIndex(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    const validation = validateZoteroLibraryIndex(parsed);
    if (!validation.usable) {
      return { usable: false, index: null, reason: validation.reason, error: "" };
    }
    return { usable: true, index: normalizeZoteroLibraryIndex(parsed), reason: "", error: "" };
  } catch (error) {
    if (error?.code === "ENOENT") {
      const legacyPath = legacyPathForSharedIndex(filePath);
      if (legacyPath) {
        try {
          const parsed = JSON.parse(await fs.readFile(legacyPath, "utf8"));
          const validation = validateZoteroLibraryIndex(parsed);
          if (validation.usable) {
            const index = normalizeZoteroLibraryIndex(parsed);
            index.stats = { ...(index.stats || {}), migrated_from: legacyPath, migration_pending_write: true };
            return { usable: true, index, reason: "", error: "", migrated_from: legacyPath };
          }
        } catch {}
      }
      return { usable: false, index: null, reason: "index_missing", error: "" };
    }
    return {
      usable: false,
      index: null,
      reason: error instanceof SyntaxError ? "index_json_invalid" : "index_read_failed",
      error: String(error?.message || error),
    };
  }
}

async function atomicWriteIndex(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryRegistration = registerEphemeral({ path: tmpPath, ownerStage: "literature_index", cleanupWhen: "always_after_close" });
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await fs.rename(tmpPath, filePath);
    temporaryRegistration.forget();
  } catch (error) {
    temporaryRegistration.markClosed();
    try { await fs.unlink(tmpPath); temporaryRegistration.forget(); } catch {}
    throw error;
  }
}

async function withIndexLock(filePath, operation, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + timeoutMs;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx");
      const lockRegistration = registerEphemeral({ path: lockPath, ownerStage: "literature_index", cleanupWhen: "always_after_close" });
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, created_at: nowIso() }));
        return await operation();
      } finally {
        await handle.close();
        lockRegistration.markClosed();
        try { await fs.unlink(lockPath); lockRegistration.forget(); } catch {}
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) { await fs.unlink(lockPath); continue; }
      } catch (statError) { if (statError?.code === "ENOENT") continue; }
      if (Date.now() >= deadline) throw new Error(`LITERATURE_INDEX_LOCK_TIMEOUT:${lockPath}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function writeIndexUnlocked(filePath, index) {
  const normalized = normalizeZoteroLibraryIndex({
    ...index,
    schema_version: ZOTERO_LIBRARY_INDEX_SCHEMA_VERSION,
    generated_at: cleanString(index?.generated_at) || nowIso(),
  });
  await atomicWriteIndex(filePath, normalized);
  return normalized;
}

export async function writeZoteroLibraryIndex(filePath, index, { mergeCurrent = true } = {}) {
  return withIndexLock(filePath, async () => {
    const current = await readZoteroLibraryIndex(filePath);
    const normalized = normalizeZoteroLibraryIndex(index);
    if (mergeCurrent && current.usable) {
      normalized.integrity_monitoring = {
        ...(current.index.integrity_monitoring || {}),
        ...(normalized.integrity_monitoring || {}),
        bootstrap: {
          ...(current.index.integrity_monitoring?.bootstrap || {}),
          ...(normalized.integrity_monitoring?.bootstrap || {}),
        },
      };
      if (normalized.coverage?.zotero?.complete !== true) {
        normalized.live_items = { ...(current.index.live_items || {}), ...(normalized.live_items || {}) };
        normalized.tombstones = { ...(current.index.tombstones || {}), ...(normalized.tombstones || {}) };
        normalized.fingerprints = buildFingerprintMaps(normalized);
        normalized.records = rebuildRecords({ ...normalized, records: current.index.records });
      }
      for (const [canonicalId, record] of Object.entries(current.index.records || {})) {
        if (record.integrity && !normalized.records[canonicalId]?.integrity) {
          normalized.records[canonicalId] = { ...(normalized.records[canonicalId] || record), integrity: record.integrity };
        }
        if (!record.presence?.local) continue;
        const target = normalized.records[canonicalId] || record;
        normalized.records[canonicalId] = { ...target, presence: { ...(target.presence || {}), local: record.presence.local } };
      }
    }
    return writeIndexUnlocked(filePath, normalized);
  });
}

export async function updateIntegrityMonitoringState(filePath, { recordUpdates = [], monitoring = {} } = {}, { generatedAt = nowIso() } = {}) {
  return withIndexLock(filePath, async () => {
    const read = await readZoteroLibraryIndex(filePath);
    if (!read.usable) return { ok: false, reason: read.reason, updated_count: 0 };
    const index = normalizeZoteroLibraryIndex(read.index);
    let updatedCount = 0;
    for (const update of recordUpdates) {
      const canonicalId = cleanString(update?.canonicalId || update?.canonical_id);
      if (!canonicalId || !index.records[canonicalId]) continue;
      index.records[canonicalId] = {
        ...index.records[canonicalId],
        integrity: update.integrity,
        last_seen_at: index.records[canonicalId].last_seen_at || generatedAt,
      };
      updatedCount += 1;
    }
    index.integrity_monitoring = {
      ...(index.integrity_monitoring || {}),
      ...monitoring,
      schema_version: 1,
      bootstrap: {
        ...(index.integrity_monitoring?.bootstrap || {}),
        ...(monitoring.bootstrap || {}),
      },
    };
    index.generated_at = generatedAt;
    await writeIndexUnlocked(filePath, index);
    return { ok: true, reason: "", updated_count: updatedCount, index };
  });
}

export async function updateZoteroLibraryIndexItems(filePath, updates = {}, { generatedAt = nowIso() } = {}) {
  return withIndexLock(filePath, async () => {
    const read = await readZoteroLibraryIndex(filePath);
    if (!read.usable) return { ok: false, reason: read.reason, updated_count: 0 };
    const index = normalizeZoteroLibraryIndex(read.index);
    let updatedCount = 0;
    for (const [itemKey, patch] of Object.entries(updates || {})) {
      if (!itemKey || !index.live_items[itemKey]) continue;
      index.live_items[itemKey] = normalizeLiveIndexItem({ ...index.live_items[itemKey], ...patch, itemKey, indexed_at: generatedAt });
      updatedCount += 1;
    }
    if (updatedCount > 0) {
      index.generated_at = generatedAt;
      index.stats = { ...(index.stats || {}), last_incremental_update_at: generatedAt, last_incremental_update_count: updatedCount };
      await writeIndexUnlocked(filePath, index);
    }
    return { ok: true, reason: "", updated_count: updatedCount };
  });
}

export async function updateLocalLiteratureIndexItems(filePath, items = [], { outputRoot = "", generatedAt = nowIso() } = {}) {
  return withIndexLock(filePath, async () => {
    const read = await readZoteroLibraryIndex(filePath);
    const index = read.usable ? normalizeZoteroLibraryIndex(read.index) : emptyZoteroLibraryIndex({ generatedAt });
    let updatedCount = 0;
    for (const item of items) {
      const canonicalId = canonicalRecordId(item);
      if (!canonicalId || !item.local_id) continue;
      const previous = index.records[canonicalId] || {};
      index.records[canonicalId] = {
        ...previous,
        canonical_id: canonicalId,
        identity: getZoteroIndexFingerprints(item),
        title: item.title || previous.title || "",
        first_seen_at: previous.first_seen_at || item.first_seen_at || generatedAt,
        last_seen_at: generatedAt,
        presence: { ...(previous.presence || {}), local: { local_paper_id: item.local_id, output_root: outputRoot, processing_state: item.grade || item.final_grade || "" } },
      };
      updatedCount += 1;
    }
    index.generated_at = generatedAt;
    await writeIndexUnlocked(filePath, index);
    return { ok: true, updated_count: updatedCount };
  });
}

export async function updateSharedLiteratureRecordState(filePath, updates = [], { generatedAt = nowIso() } = {}) {
  return withIndexLock(filePath, async () => {
    const read = await readZoteroLibraryIndex(filePath);
    const index = read.usable ? normalizeZoteroLibraryIndex(read.index) : emptyZoteroLibraryIndex({ generatedAt });
    let updatedCount = 0;
    for (const update of updates) {
      const item = update?.item || update;
      const canonicalId = canonicalRecordId(item);
      if (!canonicalId) continue;
      const previous = index.records[canonicalId] || {};
      const patch = update?.patch && typeof update.patch === "object" ? update.patch : {};
      index.records[canonicalId] = {
        ...previous,
        ...patch,
        canonical_id: canonicalId,
        identity: { ...(previous.identity || {}), ...getZoteroIndexFingerprints(item) },
        title: firstString(item.title, previous.title),
        first_seen_at: previous.first_seen_at || generatedAt,
        last_seen_at: generatedAt,
        presence: { ...(previous.presence || {}), ...(patch.presence || {}) },
      };
      updatedCount += 1;
    }
    index.generated_at = generatedAt;
    await writeIndexUnlocked(filePath, index);
    return { ok: true, updated_count: updatedCount, index };
  });
}

export function findLiteratureRecord(index = {}, item = {}, presence = "") {
  const candidate = getZoteroIndexFingerprints(item);
  for (const record of Object.values(index.records || {})) {
    if (presence && !record.presence?.[presence]) continue;
    if (LITERATURE_IDENTITY_PRIORITY.some((type) => candidate[type] && candidate[type] === record.identity?.[type])) return record;
  }
  return null;
}

function hasTrashRole(item = {}) {
  if ((item.collection_roles || []).includes("trash")) return true;
  return (item.collections || []).some((entry) => {
    const name = cleanString(entry?.name || entry?.path || entry);
    return name === "待删除" || name.endsWith("/待删除") || name.includes("文献池/待删除");
  });
}

export function mergeDeletedTrashTombstones(previousIndex = {}, currentLiveItems = {}, { generatedAt = nowIso() } = {}) {
  const previous = validateZoteroLibraryIndex(previousIndex).usable ? normalizeZoteroLibraryIndex(previousIndex) : emptyZoteroLibraryIndex();
  const currentKeys = new Set(Object.keys(currentLiveItems || {}));
  const tombstones = { ...(previous.tombstones || {}) };
  for (const [itemKey, item] of Object.entries(previous.live_items || {})) {
    if (!itemKey || currentKeys.has(itemKey) || !hasTrashRole(item)) continue;
    const tombstone = normalizeTombstone(item, { source: "deleted_trash", reason: "deleted_trash_tombstone", generatedAt });
    if (tombstone.tombstoneId && !tombstones[tombstone.tombstoneId]) tombstones[tombstone.tombstoneId] = tombstone;
  }
  return tombstones;
}
