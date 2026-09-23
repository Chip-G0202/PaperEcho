import {
  buildWritebackItemRecord,
  nextWritebackDowngrade,
  parseToolText,
  readCollectionItems,
  resolveConcurrencySource,
  resolveWritebackConcurrency,
  shouldStopWritebackByRisk,
} from "../lib/writeback_support.mjs";
import { normalizeLiveIndexItem } from "../lib/zotero_library_index_store.mjs";
import {
  isDefinitelyFailedWithoutSideEffect,
  legacyCreateFallbackEnabled,
  uncertainCreateError,
} from "../lib/zotero_create_safety.mjs";
import { createItemWithDedupeRetry } from "./item_create_retry.mjs";
import {
  findByIndex,
  getFingerprints,
  normalizeTitleForMatch,
  pushIndex,
} from "./duplicate_fingerprints.mjs";
import {
  findExistingByExactFields,
  previewItemFromDetails,
  verifyCachedDuplicateMatch,
} from "./duplicate_scan.mjs";
import { buildCreateItemRequest, resolveGradeName } from "./item_payload.mjs";

function collectCachedDuplicateMatchKeys(items = [], indexes = []) {
  const keys = new Set();
  for (const item of items) {
    for (const index of indexes) {
      const match = findByIndex(item, index);
      if (match?.itemKey && match.fromCache && !match.isTombstone) keys.add(match.itemKey);
    }
  }
  return [...keys];
}

function normalizeReadbackItemsResult(raw) {
  if (raw?.content?.[0]?.text) return { items: parseToolText(raw) || [], failed: [] };
  if (Array.isArray(raw)) return { items: raw, failed: [] };
  return {
    items: Array.isArray(raw?.items) ? raw.items : [],
    failed: Array.isArray(raw?.failed) ? raw.failed : [],
  };
}

function failedReadbackKey(entry) {
  return entry?.itemKey || entry?.key || entry?.data?.itemKey || entry?.data?.key || "";
}

async function readDuplicateVerificationItems(itemKeys, { callZotero, zoteroBackend = null, batchSize = 250 } = {}) {
  const liveItemsByKey = new Map();
  const keys = [...new Set((itemKeys || []).filter(Boolean))];
  const stats = {
    duplicate_verification_batch_enabled: keys.length > 0,
    duplicate_verification_batch_request_count: 0,
    duplicate_verification_batch_item_count: keys.length,
    duplicate_verification_batch_fallback_count: 0,
  };
  const contractBackend = zoteroBackend || callZotero?.adapter || null;
  const canReadViaContract = typeof contractBackend?.getItems === "function";
  if (!keys.length || (!canReadViaContract && typeof callZotero !== "function")) return { liveItemsByKey, stats };
  try {
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      stats.duplicate_verification_batch_request_count += 1;
      const raw = canReadViaContract
        ? await contractBackend.getItems(batch, { mode: "preview", stage: "stage2_duplicate_verification" })
        : await callZotero("get_items_details", { itemKeys: batch, mode: "preview" }, 770000 + i);
      const { items: details, failed } = normalizeReadbackItemsResult(raw);
      for (const entry of details) {
        const key = entry?.itemKey || entry?.key || entry?.data?.itemKey || entry?.data?.key || "";
        if (key) liveItemsByKey.set(key, previewItemFromDetails(entry, key));
      }
      for (const entry of failed) {
        const key = failedReadbackKey(entry);
        if (key && entry?.missing === true && !liveItemsByKey.has(key)) liveItemsByKey.set(key, { itemKey: key, key, missing: true });
      }
    }
  } catch {
    liveItemsByKey.clear();
    stats.duplicate_verification_batch_fallback_count += keys.length;
  }
  return { liveItemsByKey, stats };
}

function parseCreateItemsResult(raw) {
  if (raw?.content?.[0]?.text) return parseToolText(raw) || {};
  if (Array.isArray(raw)) return { created: raw, failed: [] };
  return raw || {};
}

export function createStage2ItemWriter({ zoteroBackendCall, mcpToolCall, onCreatedKeys } = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const contractBackend = arguments[0]?.zoteroBackend || callZotero?.adapter || null;
  const batchCreateDisabled = process.env.ZOTERO_WRITEBACK_BATCH_CREATE_DISABLED === "1";
  const batchCreateStats = {
    batch_create_supported: !batchCreateDisabled,
    batch_create_used: false,
    batch_create_request_count: 0,
    batch_create_item_count: 0,
    batch_create_success_count: 0,
    batch_create_failed_count: 0,
    batch_create_fallback_count: 0,
    batch_create_fallback_errors: [],
  };
  const pending = [];
  let flushScheduled = false;
  let recoveryError = null;

  async function recordCreatedKeys(keys) {
    if (typeof onCreatedKeys !== "function" || !keys.length) return;
    try {
      await onCreatedKeys(keys);
    } catch (error) {
      recoveryError = new Error(`stage2_recovery_persistence_failed:${String(error?.message || error)}`);
      recoveryError.cause = error;
      throw recoveryError;
    }
  }

  async function persistCreatedKey(key) {
    const exactKey = String(key || "").trim();
    if (!exactKey) {
      recoveryError = new Error("stage2_create_item_key_missing");
      throw recoveryError;
    }
    await recordCreatedKeys([exactKey]);
    return exactKey;
  }

  function rejectRemaining(entries, start, error) {
    for (const entry of entries.slice(start)) entry.reject(error);
  }

  async function createItemsViaContract(entries) {
    if (typeof contractBackend?.createItems !== "function") return null;
    const itemsData = entries.map((entry) => ({
      inputIndex: entry.index,
      itemType: entry.request.itemType,
      ...(entry.request.fields || {}),
      tags: entry.request.tags || [],
      collections: entry.request.collections || [],
    }));
    return contractBackend.createItems(itemsData, { stage: "stage2_writeback" });
  }

  async function writeOne(request, i) {
    try {
      const raw = await callZotero("write_item", request, 10000 + i * 3);
      // Unwrap MCP format {content: [{text: "..."}]} if needed
      const created = raw?.content?.[0]?.text ? JSON.parse(raw.content[0].text) : raw;
      return created?.itemKey || created?.key || created?.data?.itemKey || "";
    } catch (e) {
      const safe = { title: request.fields?.title?.slice(0, 80), doi: request.fields?.DOI, idx: i };
      console.error(`[createItem] MCP write_item failed for item #${i}:`, JSON.stringify(safe), String(e?.message || e).slice(0, 200));
      throw e;
    }
  }

  async function flushBatch() {
    flushScheduled = false;
    const batch = pending.splice(0);
    if (!batch.length) return;
    if (batchCreateDisabled || batch.length === 1) {
      for (let index = 0; index < batch.length; index += 1) {
        const entry = batch[index];
        try {
          const key = await writeOne(entry.request, entry.index);
          entry.resolve(await persistCreatedKey(key));
        } catch (error) {
          entry.reject(error);
          if (error === recoveryError) {
            rejectRemaining(batch, index + 1, error);
            return;
          }
        }
      }
      return;
    }

    // Process in chunks of MAX_BATCH_SIZE (50 is Zotero API limit)
    const MAX_BATCH_SIZE = 50;
    for (let offset = 0; offset < batch.length; offset += MAX_BATCH_SIZE) {
      const chunk = batch.slice(offset, offset + MAX_BATCH_SIZE);
      batchCreateStats.batch_create_used = true;
      batchCreateStats.batch_create_request_count += 1;
      batchCreateStats.batch_create_item_count += chunk.length;

      try {
        const raw = await createItemsViaContract(chunk) ?? await callZotero(
            "write_items",
            { items: chunk.map((entry) => ({ ...entry.request, inputIndex: entry.index })) },
            900000 + chunk[0].index,
          );
        const data = parseCreateItemsResult(raw);
        const createdByIndex = new Map();
        for (const created of Array.isArray(data.created) ? data.created : []) {
          const inputIndex = Number(created?.inputIndex);
          const key = created?.itemKey || created?.key || "";
          if (Number.isFinite(inputIndex) && key) createdByIndex.set(inputIndex, key);
        }
        const failedByIndex = new Map();
        for (const failed of Array.isArray(data.failed) ? data.failed : []) {
          const inputIndex = Number(failed?.inputIndex);
          if (Number.isFinite(inputIndex)) failedByIndex.set(inputIndex, failed?.error || "batch_create_failed");
        }
        await recordCreatedKeys([...createdByIndex.values()]);
        const missingResultEntries = chunk.filter((entry) => !createdByIndex.has(entry.index) && !failedByIndex.has(entry.index));
        if (missingResultEntries.length) {
          const error = new Error("stage2_create_item_key_missing");
          recoveryError = error;
          for (const entry of chunk) {
            const key = createdByIndex.get(entry.index);
            if (key) {
              batchCreateStats.batch_create_success_count += 1;
              entry.resolve(key);
            } else {
              batchCreateStats.batch_create_failed_count += 1;
              entry.reject(error);
            }
          }
          rejectRemaining(batch, offset + chunk.length, error);
          return;
        }
        for (const entry of chunk) {
          const key = createdByIndex.get(entry.index);
          if (key) {
            batchCreateStats.batch_create_success_count += 1;
            entry.resolve(key);
            continue;
          }
          const error = failedByIndex.get(entry.index) || "batch_create_missing_result";
          batchCreateStats.batch_create_failed_count += 1;
          entry.reject(new Error(error));
        }
      } catch (error) {
        if (error === recoveryError) {
          rejectRemaining(batch, offset, error);
          return;
        }
        if (!isDefinitelyFailedWithoutSideEffect(error) && !legacyCreateFallbackEnabled()) {
          const uncertain = uncertainCreateError(error, {
            batchSize: chunk.length,
            firstIndex: chunk[0]?.index ?? null,
            source: "stage2_batch_create",
          });
          for (const entry of chunk) entry.reject(uncertain);
          rejectRemaining(batch, offset + chunk.length, uncertain);
          return;
        }
        batchCreateStats.batch_create_fallback_count += chunk.length;
        if (batchCreateStats.batch_create_fallback_errors.length < 5) {
          batchCreateStats.batch_create_fallback_errors.push({
            batch_size: chunk.length,
            first_index: chunk[0]?.index ?? null,
            error: String(error?.message || error).slice(0, 500),
          });
        }
        // Fallback to serial creation for this chunk
        for (const entry of chunk) {
          try {
            const key = await writeOne(entry.request, entry.index);
            entry.resolve(await persistCreatedKey(key));
          } catch (oneError) {
            entry.reject(oneError);
            if (oneError === recoveryError) {
              rejectRemaining(chunk, chunk.indexOf(entry) + 1, oneError);
              rejectRemaining(batch, offset + chunk.length, oneError);
              return;
            }
          }
        }
      }
    }
  }

  async function createItem(it, i) {
    if (recoveryError) throw recoveryError;
    const request = await buildCreateItemRequest(it);
    if (batchCreateDisabled) return persistCreatedKey(await writeOne(request, i));
    return new Promise((resolve, reject) => {
      pending.push({ request, index: i, resolve, reject });
      if (!flushScheduled) {
        flushScheduled = true;
        setTimeout(() => { flushBatch().catch(() => {}); }, 1000);
      }
    });
  }
  createItem.createBatch = async (itemsWithIndexes = []) => {
    if (recoveryError) throw recoveryError;
    const entries = await Promise.all(itemsWithIndexes.map(async ({ item, index }) => ({
      request: await buildCreateItemRequest(item),
      index,
    })));
    if (!entries.length) return [];
    batchCreateStats.batch_create_used = true;
    batchCreateStats.batch_create_request_count += 1;
    batchCreateStats.batch_create_item_count += entries.length;
    const raw = await createItemsViaContract(entries);
    if (!raw) throw new Error("stage2_batch_create_contract_missing");
    const data = parseCreateItemsResult(raw);
    const createdByIndex = new Map((data.created || []).map((entry) => [Number(entry.inputIndex), entry.itemKey || entry.key || ""]));
    const failedByIndex = new Map((data.failed || []).map((entry) => [Number(entry.inputIndex), entry.error || "batch_create_failed"]));
    const createdKeys = [...createdByIndex.values()].filter(Boolean);
    await recordCreatedKeys(createdKeys);
    return entries.map((entry) => {
      const itemKey = createdByIndex.get(entry.index) || "";
      if (itemKey) {
        batchCreateStats.batch_create_success_count += 1;
        return { index: entry.index, itemKey, error: "" };
      }
      batchCreateStats.batch_create_failed_count += 1;
      return { index: entry.index, itemKey: "", error: failedByIndex.get(entry.index) || "stage2_create_item_key_missing" };
    });
  };
  createItem.batchCreateStats = batchCreateStats;
  Object.defineProperty(createItem, "recoveryError", { get: () => recoveryError });
  return createItem;
}

export function createStage2RecoveryRecordItemsCallback(recovery) {
  if (typeof recovery?.recordItems !== "function") return undefined;
  return (itemKeys) => recovery.recordItems(itemKeys);
}

export async function runWritebackExecution({
  items,
  root,
  sourceKeys,
  gradeKeys,
  sourceCollections,
  poolIndex,
  trashIndex,
  worthyIndex,
  currentLiveItems,
  counters,
  failures,
  localIndexStats,
  skippedDuplicatesInPool,
  skippedDuplicatesInTrash,
  duplicateRecords,
  writebackItems,
  zoteroBackendCall,
  mcpToolCall,
  createItem,
  zoteroBackend,
  skipBackendExactDedupe = false,
} = {}) {
  const callZotero = zoteroBackendCall || mcpToolCall;
  const writebackConcurrencyRaw = process.env.ZOTERO_WRITEBACK_CONCURRENCY;
  const writebackBatchSize = Math.max(1, Number(process.env.ZOTERO_WRITEBACK_CONCURRENCY_BATCH_SIZE || 20));
  const defaultWritebackConcurrency = Math.min(writebackBatchSize, 10);
  const configuredConcurrency = Number(writebackConcurrencyRaw || defaultWritebackConcurrency);
  const concurrencySource = resolveConcurrencySource(writebackConcurrencyRaw);
  const resolvedWritebackConcurrency = resolveWritebackConcurrency(writebackConcurrencyRaw, defaultWritebackConcurrency);
  let writebackConcurrency = resolvedWritebackConcurrency.value;
  const concurrencyWarning = resolvedWritebackConcurrency.warning;
  const concurrencyClamped = resolvedWritebackConcurrency.clamped;
  const writebackRetryLimit = Math.max(0, Number(process.env.ZOTERO_WRITEBACK_RETRY_LIMIT || 4));
  const observationMode = process.env.ZOTERO_WRITEBACK_OBSERVATION_MODE === "1";
  let retryCount = 0;
  let duplicatePreventedCount = 0;
  let duplicateDetectedCount = 0;
  let wrongCollectionDetectedCount = 0;
  let uncertainCreateStateCount = 0;
  let inFlightDedupeWaitCount = 0;
  const inFlightByDedupeKey = new Map();
  const writebackRecords = [];
  const batchObservations = [];
  let autoDowngrade = {
    auto_downgrade_triggered: false,
    original_concurrency: writebackConcurrency,
    downgraded_concurrency: writebackConcurrency,
    downgrade_reason: "",
    downgrade_at_batch: null,
    downgrade_error: "",
    items_completed_before_downgrade: 0,
    items_remaining_after_downgrade: 0,
  };
  let stopForHighRisk = false;
  let stopReason = "";

  const itemWritebackStarted = Date.now();
  const batchCreateStats = createItem?.batchCreateStats || {};
  const duplicateVerification = await readDuplicateVerificationItems(
    collectCachedDuplicateMatchKeys(items, [poolIndex, trashIndex, worthyIndex]),
    { callZotero, zoteroBackend },
  );
  const liveItemsByKey = duplicateVerification.liveItemsByKey;
  async function processItem(it, i) {
    const dedupeKey = String(it?.dedupe_key || normalizeTitleForMatch(it?.title || "") || `idx:${i}`);
    const fingerprints = getFingerprints(it);
    const identityKeys = [...new Set([
      `dedupe:${dedupeKey}`,
      ...["doi", "pmid", "pmcid", "arxiv", "openalex", "url", "title"]
        .filter((field) => fingerprints[field])
        .map((field) => `${field}:${fingerprints[field]}`),
    ])];
    const waiting = [...new Set(identityKeys.map((key) => inFlightByDedupeKey.get(key)).filter(Boolean))];
    if (waiting.length) {
      inFlightDedupeWaitCount += 1;
      await Promise.all(waiting);
    }
    const running = (async () => {
      try {
        let duplicateMatch = findByIndex(it, poolIndex);
        let itemKey = duplicateMatch?.itemKey || "";
        let duplicateInPool = Boolean(itemKey);
        if (duplicateInPool && !(await verifyCachedDuplicateMatch(it, duplicateMatch, { mcpToolCall: callZotero, idBase: 755000 + i * 10, liveItemsByKey }))) {
          duplicateMatch = null;
          itemKey = "";
          duplicateInPool = false;
        }
        let duplicateInTrash = false;
        let duplicateInWorthy = false;
        if (!duplicateInPool) {
          duplicateMatch = findByIndex(it, trashIndex);
          itemKey = duplicateMatch?.itemKey || "";
          duplicateInTrash = Boolean(itemKey);
          if (duplicateInTrash && !(await verifyCachedDuplicateMatch(it, duplicateMatch, { mcpToolCall: callZotero, idBase: 756000 + i * 10, liveItemsByKey }))) {
            duplicateMatch = null;
            itemKey = "";
            duplicateInTrash = false;
          }
          if (duplicateInTrash) {
            duplicateMatch = { ...duplicateMatch, reason: (duplicateMatch.reason || "").replace("duplicate_", "duplicate_trash_") };
          }
        }
        if (!duplicateInPool && !duplicateInTrash) {
          duplicateMatch = findByIndex(it, worthyIndex);
          itemKey = duplicateMatch?.itemKey || "";
          duplicateInWorthy = Boolean(itemKey);
          if (duplicateInWorthy && !(await verifyCachedDuplicateMatch(it, duplicateMatch, { mcpToolCall: callZotero, idBase: 757000 + i * 10, liveItemsByKey }))) {
            duplicateMatch = null;
            itemKey = "";
            duplicateInWorthy = false;
          }
          if (duplicateInWorthy) {
            duplicateMatch = { ...duplicateMatch, reason: (duplicateMatch.reason || "").replace("duplicate_", "duplicate_worthy_") };
          }
        }
        let backendExactDuplicateKey = "";
        if (!duplicateInPool && !duplicateInTrash && !duplicateInWorthy && !skipBackendExactDedupe) {
          backendExactDuplicateKey = await findExistingByExactFields(it, { mcpToolCall: callZotero, zoteroBackend, idBase: 700000 + i * 5 }) || "";
        }
        if (backendExactDuplicateKey) {
          duplicatePreventedCount += 1;
          counters.skipped_historical_duplicate += 1;
          if (duplicateRecords.length < 500) duplicateRecords.push({
            candidate_id: i,
            title: (it.title || "").slice(0, 300),
            matched_pool_item_key: backendExactDuplicateKey,
            action: "skipped_duplicate_in_library",
          });
          writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey: backendExactDuplicateKey, status: "skipped_duplicate_in_library" });
          return;
        }
        if (duplicateInPool) duplicatePreventedCount += 1;
        const sourceName = sourceCollections[it.source_channel] || sourceCollections.rss;
        const gradeName = resolveGradeName(it);
        // New entries are routed only to their source and grade collections.
        // The local/live library index is the dedupe source of truth; root pool
        // membership is no longer required for newly admitted items.
        it._target_collections = [
          { key: sourceKeys[sourceName], name: sourceName },
          { key: gradeKeys[gradeName], name: gradeName },
        ];

        if (duplicateInPool) {
          counters.reused_existing++;
          counters.skipped_historical_duplicate++;
          counters.skipped_duplicate_in_pool++;
          if (skippedDuplicatesInPool.length < 200) {
            skippedDuplicatesInPool.push({
              idx: i,
              title: (it.title || "").slice(0, 180),
              source_channel: it.source_channel || "",
              grade: resolveGradeName(it),
              existing_itemKey: itemKey || "",
            });
          }
          if (duplicateRecords.length < 500) {
            duplicateRecords.push({
              candidate_id: i,
              title: (it.title || "").slice(0, 300),
              duplicate_reason: duplicateMatch?.reason || "duplicate_in_pool",
              matched_pool_item_key: itemKey || "",
              matched_identifier_type: duplicateMatch?.type || "unknown",
              matched_identifier_value: duplicateMatch?.value || "",
              pool_item_title: poolIndex.meta?.get(itemKey)?.title || "",
              action: "skipped_duplicate_in_pool",
            });
          }
          writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey, status: "skipped_duplicate_in_pool" });
          return;
        }

        if (duplicateInTrash) {
          counters.skipped_duplicate_in_trash++;
          if (duplicateMatch?.isTombstone) {
            counters.skipped_duplicate_in_deleted_trash_index++;
            localIndexStats.skipped_duplicate_in_deleted_trash_index++;
          }
          if (skippedDuplicatesInTrash.length < 200) {
            skippedDuplicatesInTrash.push({
              idx: i,
              title: (it.title || "").slice(0, 180),
              source_channel: it.source_channel || "",
              grade: resolveGradeName(it),
              existing_itemKey: itemKey || "",
              tombstone_match: Boolean(duplicateMatch?.isTombstone),
            });
          }
          if (duplicateRecords.length < 500) {
            duplicateRecords.push({
              candidate_id: i,
              title: (it.title || "").slice(0, 300),
              duplicate_reason: duplicateMatch?.reason || "duplicate_in_trash",
              matched_pool_item_key: itemKey || "",
              matched_identifier_type: duplicateMatch?.type || "unknown",
              matched_identifier_value: duplicateMatch?.value || "",
              pool_item_title: trashIndex.meta?.get(itemKey)?.title || "",
              action: "skipped_duplicate_in_trash",
            });
          }
          writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey, status: "skipped_duplicate_in_trash" });
          return;
        }

        if (duplicateInWorthy) {
          counters.skipped_duplicate_in_worthy++;
          if (duplicateRecords.length < 500) {
            duplicateRecords.push({
              candidate_id: i,
              title: (it.title || "").slice(0, 300),
              duplicate_reason: duplicateMatch?.reason || "duplicate_in_worthy",
              matched_pool_item_key: itemKey || "",
              matched_identifier_type: duplicateMatch?.type || "unknown",
              matched_identifier_value: duplicateMatch?.value || "",
              pool_item_title: worthyIndex.meta?.get(itemKey)?.title || "",
              action: "skipped_duplicate_in_worthy",
            });
          }
          writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey, status: "skipped_duplicate_in_worthy" });
          return;
        }

        if (!itemKey) {
          const createResult = await createItemWithDedupeRetry({
            retryLimit: writebackRetryLimit,
            createItem: async () => createItem(it, i),
            findExisting: async ({ attempt }) =>
              findByIndex(it, poolIndex)
              || findByIndex(it, trashIndex)
              || findByIndex(it, worthyIndex)
              || (!skipBackendExactDedupe
                ? await findExistingByExactFields(it, { mcpToolCall: callZotero, zoteroBackend, idBase: 760000 + i * 5 + attempt })
                : null),
          });
          itemKey = createResult.itemKey;
          if (itemKey && itemKey.startsWith("cli-")) {
            await new Promise(r => setTimeout(r, 500));
            try {
              const tmpTitle = (it.title || "").slice(0, 40);
              const collItems = await readCollectionItems(gradeKeys[gradeName], {
                mcpToolCall: callZotero,
                id: 800000 + i,
                stage: "stage2_create_key_recovery",
              });
              const found = collItems.find(ci => (ci.title || "").includes(tmpTitle));
              if (found?.key) itemKey = found.key;
            } catch {}
          }
          retryCount += createResult.retryCount;
          if (createResult.duplicatePrevented) {
            duplicatePreventedCount += 1;
            counters.skipped_duplicate_in_pool++;
            if (skippedDuplicatesInPool.length < 200) {
              skippedDuplicatesInPool.push({
                idx: i,
                title: (it.title || "").slice(0, 180),
                source_channel: it.source_channel || "",
                grade: resolveGradeName(it),
                existing_itemKey: itemKey || "",
              });
            }
          }
        }
        if (!itemKey) throw new Error("create_item_no_key");
        const fp = getFingerprints(it);
        pushIndex(poolIndex.byDoi, fp.doi, itemKey);
        pushIndex(poolIndex.byPmid, fp.pmid, itemKey);
        pushIndex(poolIndex.byPmcid, fp.pmcid, itemKey);
        pushIndex(poolIndex.byArxiv, fp.arxiv, itemKey);
        if (poolIndex.byOpenalex) pushIndex(poolIndex.byOpenalex, fp.openalex, itemKey);
        if (poolIndex.byUrl) pushIndex(poolIndex.byUrl, fp.url, itemKey);
        pushIndex(poolIndex.byTitle, fp.title, itemKey);
        if (poolIndex.meta) poolIndex.meta.set(itemKey, { title: it.title || "" });
        currentLiveItems[itemKey] = normalizeLiveIndexItem({
          key: itemKey,
          itemKey,
          title: it.title || "",
          doi: it.doi || it.DOI || "",
          pmid: it.pmid || "",
          pmcid: it.pmcid || "",
          arxiv: it.arxiv || it.arxiv_id || "",
          url: it.url || it.URL || "",
          collections: [
            { key: sourceKeys[sourceName], name: sourceName },
            { key: gradeKeys[gradeName], name: gradeName },
          ],
          collection_roles: ["source", "grade"],
          tags: ["research-os", "自动入库", gradeName, it.source_channel || ""]
            .filter((tag) => String(tag || "").trim())
            .map((tag) => ({ tag })),
        });

        writebackItems.push({
          ...buildWritebackItemRecord(itemKey, it, sourceName, gradeName),
          pool_collection_key: "",
          root_pool_attach_skipped: true,
          source_collection_key: sourceKeys[sourceName],
          grade_collection_key: gradeKeys[gradeName],
        });

        counters.created++;
        counters.by_source[it.source_channel] = (counters.by_source[it.source_channel] || 0) + 1;
        counters.by_grade[gradeName] = (counters.by_grade[gradeName] || 0) + 1;
        writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey, status: "created" });
      } catch (e) {
        if (/timeout|database busy|transaction failed|lock conflict|writeback_failed|rate limit|429/i.test(String(e?.message || e))) {
          uncertainCreateStateCount += 1;
        }
        counters.failed++;
        if (failures.length < 100) {
          failures.push({
            idx: i,
            title: (it.title || "").slice(0, 180),
            source_channel: it.source_channel,
            grade: resolveGradeName(it),
            error: String(e.message || e),
          });
        }
        writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey: "", status: "failed", error: String(e.message || e) });
      }
    })();
    for (const key of identityKeys) inFlightByDedupeKey.set(key, running);
    try {
      await running;
    } finally {
      for (const key of identityKeys) {
        if (inFlightByDedupeKey.get(key) === running) inFlightByDedupeKey.delete(key);
      }
    }
  }

  let processedCount = 0;
  const desktopBatchSizeRaw = Number(process.env.ZOTERO_CLI_WRITEBACK_BATCH_SIZE || 50);
  const desktopBatchSize = Number.isFinite(desktopBatchSizeRaw) && desktopBatchSizeRaw > 0
    ? Math.min(50, Math.max(1, Math.floor(desktopBatchSizeRaw)))
    : 50;
  const fastPathDedupeKeys = items.map((item, index) => String(item?.dedupe_key || normalizeTitleForMatch(item?.title || "") || `idx:${index}`));
  const inputFingerprints = items.map(getFingerprints);
  const fastPathIdentitiesDistinct = ["doi", "pmid", "pmcid", "arxiv", "openalex", "url", "title"].every((field) => {
    const values = inputFingerprints.map((fingerprint) => fingerprint[field]).filter(Boolean);
    return new Set(values).size === values.length;
  });
  const desktopFastPath = zoteroBackend?.backendType === "cli"
    && skipBackendExactDedupe
    && typeof createItem?.createBatch === "function"
    && new Set(fastPathDedupeKeys).size === items.length
    && fastPathIdentitiesDistinct
    && items.every((item) => !findByIndex(item, poolIndex) && !findByIndex(item, trashIndex) && !findByIndex(item, worthyIndex));
  if (desktopFastPath) {
    for (let offset = 0; offset < items.length && !stopForHighRisk; offset += desktopBatchSize) {
      const chunk = items.slice(offset, offset + desktopBatchSize);
      const batchStarted = Date.now();
      for (const item of chunk) {
        const sourceName = sourceCollections[item.source_channel] || sourceCollections.rss;
        const gradeName = resolveGradeName(item);
        item._target_collections = [
          { key: sourceKeys[sourceName], name: sourceName },
          { key: gradeKeys[gradeName], name: gradeName },
        ];
      }
      let results;
      try {
        results = await createItem.createBatch(chunk.map((item, index) => ({ item, index: offset + index })));
      } catch (error) {
        stopForHighRisk = true;
        stopReason = `desktop_batch_create_failed:${String(error?.message || error)}`;
        counters.failed += chunk.length;
        break;
      }
      for (let localIndex = 0; localIndex < chunk.length; localIndex += 1) {
        const it = chunk[localIndex];
        const i = offset + localIndex;
        const result = results[localIndex] || {};
        const itemKey = result.itemKey || "";
        const sourceName = sourceCollections[it.source_channel] || sourceCollections.rss;
        const gradeName = resolveGradeName(it);
        const dedupeKey = fastPathDedupeKeys[i];
        if (!itemKey) {
          counters.failed += 1;
          failures.push({ idx: i, title: (it.title || "").slice(0, 180), source_channel: it.source_channel, grade: gradeName, error: result.error || "batch_create_failed" });
          writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey: "", status: "failed", error: result.error || "batch_create_failed" });
          continue;
        }
        const fp = getFingerprints(it);
        pushIndex(poolIndex.byDoi, fp.doi, itemKey);
        pushIndex(poolIndex.byPmid, fp.pmid, itemKey);
        pushIndex(poolIndex.byPmcid, fp.pmcid, itemKey);
        pushIndex(poolIndex.byArxiv, fp.arxiv, itemKey);
        if (poolIndex.byOpenalex) pushIndex(poolIndex.byOpenalex, fp.openalex, itemKey);
        if (poolIndex.byUrl) pushIndex(poolIndex.byUrl, fp.url, itemKey);
        pushIndex(poolIndex.byTitle, fp.title, itemKey);
        if (poolIndex.meta) poolIndex.meta.set(itemKey, { title: it.title || "" });
        currentLiveItems[itemKey] = normalizeLiveIndexItem({ key: itemKey, itemKey, title: it.title || "", doi: it.doi || it.DOI || "", pmid: it.pmid || "", pmcid: it.pmcid || "", arxiv: it.arxiv || it.arxiv_id || "", url: it.url || it.URL || "", collections: [{ key: sourceKeys[sourceName], name: sourceName }, { key: gradeKeys[gradeName], name: gradeName }], collection_roles: ["source", "grade"], tags: ["research-os", "自动入库", gradeName, it.source_channel || ""].filter(Boolean).map((tag) => ({ tag })) });
        writebackItems.push({ ...buildWritebackItemRecord(itemKey, it, sourceName, gradeName), pool_collection_key: "", root_pool_attach_skipped: true, source_collection_key: sourceKeys[sourceName], grade_collection_key: gradeKeys[gradeName] });
        counters.created += 1;
        counters.by_source[it.source_channel] = (counters.by_source[it.source_channel] || 0) + 1;
        counters.by_grade[gradeName] = (counters.by_grade[gradeName] || 0) + 1;
        writebackRecords.push({ idx: i, dedupe_key: dedupeKey, itemKey, status: "created" });
      }
      processedCount += chunk.length;
      if (observationMode) batchObservations.push({ batch_index: batchObservations.length + 1, batch_size: chunk.length, per_batch_duration: Date.now() - batchStarted, per_batch_success_count: results.filter((entry) => entry.itemKey).length, per_batch_failure_count: results.filter((entry) => !entry.itemKey).length, per_batch_retry_count: 0, per_batch_avg_ms_per_item: (Date.now() - batchStarted) / chunk.length, per_batch_mcp_errors: [], per_batch_downgrade_status: "none" });
    }
  }
  let batchIndex = 0;
  while (processedCount < items.length && !stopForHighRisk) {
    batchIndex += 1;
    const batchStarted = Date.now();
    const currentBatch = items.slice(processedCount, Math.min(items.length, processedCount + writebackBatchSize));
    const before = {
      created: counters.created,
      failed: counters.failed,
      retryCount,
      duplicateDetectedCount,
      uncertainCreateStateCount,
    };
    const workers = Array.from({ length: writebackConcurrency }).map(async (_, workerIndex) => {
      for (let i = workerIndex; i < currentBatch.length; i += writebackConcurrency) {
        await processItem(currentBatch[i], processedCount + i);
      }
    });
    await Promise.all(workers);
    processedCount += currentBatch.length;
    const batchFailures = counters.failed - before.failed;
    const batchFailureRate = currentBatch.length ? batchFailures / currentBatch.length : 0;
    const batchMcpErrors = failures.slice(-Math.max(1, batchFailures)).map((x) => String(x.error || ""));
    const risk = shouldStopWritebackByRisk({
      failureRate: batchFailureRate,
      uncertainCreateStateCount: uncertainCreateStateCount - before.uncertainCreateStateCount,
      fallbackToSerial: false,
      duplicateDetectedCount: duplicateDetectedCount - before.duplicateDetectedCount,
      wrongCollectionDetectedCount: 0,
      mcpErrors: batchMcpErrors,
    });
    if (observationMode) {
      batchObservations.push({
        batch_index: batchIndex,
        batch_size: currentBatch.length,
        per_batch_duration: Date.now() - batchStarted,
        per_batch_success_count: (counters.created - before.created),
        per_batch_failure_count: batchFailures,
        per_batch_retry_count: retryCount - before.retryCount,
        per_batch_avg_ms_per_item: currentBatch.length ? (Date.now() - batchStarted) / currentBatch.length : 0,
        per_batch_mcp_errors: batchMcpErrors.slice(0, 10),
        per_batch_downgrade_status: risk.downgrade ? "pending" : "none",
      });
    }
    if (risk.stop) {
      stopForHighRisk = true;
      stopReason = risk.reason;
      break;
    }
    if (risk.downgrade && writebackConcurrency > 1) {
      const downgraded = nextWritebackDowngrade(writebackConcurrency);
      if (downgraded < writebackConcurrency) {
        autoDowngrade = {
          auto_downgrade_triggered: true,
          original_concurrency: autoDowngrade.original_concurrency,
          downgraded_concurrency: downgraded,
          downgrade_reason: risk.reason,
          downgrade_at_batch: batchIndex,
          downgrade_error: batchMcpErrors[0] || "",
          items_completed_before_downgrade: processedCount,
          items_remaining_after_downgrade: Math.max(0, items.length - processedCount),
        };
        writebackConcurrency = downgraded;
      }
    }
  }

  const distinctCreated = new Set(writebackRecords.filter((x) => x.status === "created").map((x) => x.itemKey));
  duplicateDetectedCount = Math.max(0, writebackRecords.filter((x) => x.status === "created").length - distinctCreated.size);
  if (duplicateDetectedCount > 0) {
    stopForHighRisk = true;
    stopReason = "duplicate_detected";
  }
  const itemWritebackMs = Date.now() - itemWritebackStarted;

  return {
    configuredConcurrency,
    writebackConcurrency,
    concurrencyWarning,
    concurrencyClamped,
    concurrencySource,
    autoDowngrade,
    stopForHighRisk,
    stopReason,
    retryCount,
    writebackRetryLimit,
    observationMode,
    duplicatePreventedCount,
    duplicateDetectedCount,
    wrongCollectionDetectedCount,
    uncertainCreateStateCount,
    inFlightDedupeWaitCount,
    batchObservations,
    itemWritebackMs,
    duplicateVerificationStats: duplicateVerification.stats,
    batchCreateStats,
  };
}
