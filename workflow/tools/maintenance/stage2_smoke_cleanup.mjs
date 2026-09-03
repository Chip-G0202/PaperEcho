import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createZoteroBackendClient } from "../lib/zotero_backend_client.mjs";
import { buildFingerprintMaps, writeZoteroLibraryIndex } from "../lib/zotero_library_index_store.mjs";

export const STAGE2_SMOKE_CLEANUP_MANIFEST_VERSION = 1;

function uniqueKeys(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

async function deleteItemsInChunks(backend, itemKeys, chunkSize = 50) {
  const result = { deleted: [], failed: [] };
  for (let offset = 0; offset < itemKeys.length; offset += chunkSize) {
    const batch = itemKeys.slice(offset, offset + chunkSize);
    try {
      const batchResult = normalizeDeleteResult(await backend.deleteItems(batch, { stage: "stage2_smoke_cleanup" }), "itemKey");
      result.deleted.push(...batchResult.deleted);
      result.failed.push(...batchResult.failed);
    } catch (error) {
      result.failed.push(...batch.map((itemKey) => ({ itemKey, error: String(error?.message || error) })));
    }
  }
  return result;
}

function normalizeCollection(record = {}) {
  return {
    key: String(record.key || "").trim(),
    createdByRun: record.createdByRun === true,
    parentKey: String(record.parentKey || record.parentCollection || "").trim(),
    role: String(record.role || "").trim(),
    name: String(record.name || "").trim(),
  };
}

export function buildStage2SmokeCleanupManifest({
  runId,
  backend,
  createdItemKeys = [],
  createdCollections = [],
  reusedCollectionKeys = [],
  localIndexPath = "",
  reportPath = "",
  generatedAt = new Date().toISOString(),
  realRun = true,
} = {}) {
  const collections = [];
  const seen = new Set();
  for (const entry of Array.isArray(createdCollections) ? createdCollections : []) {
    const collection = normalizeCollection(entry);
    if (!collection.key || seen.has(collection.key)) continue;
    seen.add(collection.key);
    collections.push(collection);
  }
  const manifest = {
    version: STAGE2_SMOKE_CLEANUP_MANIFEST_VERSION,
    runId: String(runId || "").trim(),
    backend: String(backend || "").trim(),
    generatedAt,
    createdItemKeys: realRun ? uniqueKeys(createdItemKeys) : [],
    createdCollections: collections,
    reusedCollectionKeys: uniqueKeys(reusedCollectionKeys),
    localIndexPath: String(localIndexPath || "").trim(),
    reportPath: String(reportPath || "").trim(),
    cleanupEligible: Boolean(realRun && (
      uniqueKeys(createdItemKeys).length > 0
      || collections.some((collection) => collection.createdByRun && collection.role !== "root_pool" && collection.name !== "文献池")
    )),
  };
  return manifest;
}

export function validateStage2SmokeCleanupManifest(manifest, { expectedRunId = "" } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") errors.push("manifest_missing");
  if (manifest?.version !== STAGE2_SMOKE_CLEANUP_MANIFEST_VERSION) errors.push("unsupported_manifest_version");
  if (!String(manifest?.runId || "").trim()) errors.push("manifest_run_id_missing");
  if (expectedRunId && String(manifest?.runId || "") !== String(expectedRunId)) errors.push("manifest_run_id_mismatch");
  if (!String(manifest?.backend || "").trim()) errors.push("manifest_backend_missing");
  if (!Array.isArray(manifest?.createdItemKeys)) errors.push("manifest_created_item_keys_invalid");
  if (!Array.isArray(manifest?.createdCollections)) errors.push("manifest_created_collections_invalid");
  if (manifest?.cleanupEligible !== true) errors.push("manifest_not_cleanup_eligible");
  return { ok: errors.length === 0, errors };
}

function collectionDepth(collection, byKey, seen = new Set()) {
  if (!collection.parentKey || seen.has(collection.key)) return 0;
  const parent = byKey.get(collection.parentKey);
  if (!parent) return 0;
  seen.add(collection.key);
  return 1 + collectionDepth(parent, byKey, seen);
}

export function buildStage2SmokeCleanupPlan(manifest, { expectedRunId = "" } = {}) {
  const validation = validateStage2SmokeCleanupManifest(manifest, { expectedRunId });
  if (!validation.ok) return { ok: false, errors: validation.errors, itemKeys: [], collectionKeys: [], skipped: [] };

  const reused = new Set(uniqueKeys(manifest.reusedCollectionKeys));
  const skipped = [];
  const candidates = [];
  for (const raw of manifest.createdCollections) {
    const collection = normalizeCollection(raw);
    if (!collection.key) {
      skipped.push({ reason: "collection_key_missing" });
    } else if (reused.has(collection.key)) {
      skipped.push({ key: collection.key, reason: "collection_marked_reused" });
    } else if (!collection.createdByRun) {
      skipped.push({ key: collection.key, reason: "collection_ownership_unknown" });
    } else if (collection.role === "root_pool" || collection.name === "文献池") {
      skipped.push({ key: collection.key, reason: "root_pool_protected" });
    } else {
      candidates.push(collection);
    }
  }
  const byKey = new Map(candidates.map((collection) => [collection.key, collection]));
  const collectionKeys = candidates
    .sort((left, right) => collectionDepth(right, byKey) - collectionDepth(left, byKey))
    .map((collection) => collection.key);
  return {
    ok: true,
    errors: [],
    runId: manifest.runId,
    itemKeys: uniqueKeys(manifest.createdItemKeys),
    collectionKeys,
    skipped,
  };
}

function normalizeDeleteResult(result, keyName) {
  return {
    deleted: uniqueKeys(result?.deleted || []),
    failed: Array.isArray(result?.failed) ? result.failed : [],
    keyName,
  };
}

async function removeLocalIndexEntries(localIndexPath, itemKeys, { apply }) {
  if (!localIndexPath) return { removed: 0, residual: 0, error: "" };
  try {
    const index = JSON.parse(await fs.readFile(localIndexPath, "utf8"));
    const liveItems = index?.live_items || {};
    const residual = itemKeys.filter((key) => liveItems[key]);
    if (apply && residual.length) {
      for (const key of residual) delete liveItems[key];
      index.fingerprints = buildFingerprintMaps(index);
      await writeZoteroLibraryIndex(localIndexPath, index, { mergeCurrent: false });
    }
    return { removed: apply ? residual.length : 0, residual: apply ? 0 : residual.length, error: "" };
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: 0, residual: 0, error: "" };
    return { removed: 0, residual: itemKeys.length, error: error?.message || String(error) };
  }
}

function missingError(error) {
  return /HTTP 404|does not exist|not found/i.test(String(error?.message || error));
}

function safeError(error) {
  return String(error?.message || error).replace(/Zotero-API-Key\s*[:=]\s*\S+/gi, "Zotero-API-Key=[redacted]").slice(0, 300);
}

async function verifyKeys(keys, check, concurrency = 4) {
  const result = { requested: keys.length, present: 0, missing: 0, unknown: 0, request_errors: [] };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      try {
        const exists = await check(key);
        if (exists) result.present++;
        else result.missing++;
      } catch (error) {
        if (missingError(error)) result.missing++;
        else {
          result.unknown++;
          result.request_errors.push({ key, error: safeError(error) });
        }
      }
    }
  }));
  return result;
}

async function classifyItemKeys(backend, keys, concurrency = 4) {
  const result = { present: [], missing: [], unknown: [] };
  if (backend?.backendType === "cli" && typeof backend.getItems === "function") {
    try {
      const items = await backend.getItems(keys, { mode: "preview", stage: "stage2_smoke_cleanup_preflight" });
      const byKey = new Map((Array.isArray(items) ? items : []).map((item) => [String(item?.itemKey || item?.key || ""), item]));
      for (const key of keys) {
        const item = byKey.get(key);
        if (item && item.missing !== true) result.present.push(key);
        else result.missing.push(key);
      }
    } catch (error) {
      const target = missingError(error) ? result.missing : null;
      if (target) target.push(...keys);
      else result.unknown.push(...keys.map((key) => ({ key, error: safeError(error) })));
    }
    return result;
  }
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    while (cursor < keys.length) {
      const key = keys[cursor++];
      try {
        const item = typeof backend.getItemDetails === "function"
          ? await backend.getItemDetails(key, "preview")
          : (await backend.getItems([key], { mode: "preview", stage: "stage2_smoke_cleanup_preflight" }))?.[0];
        if (item && item.missing !== true) result.present.push(key);
        else result.missing.push(key);
      } catch (error) {
        if (missingError(error)) result.missing.push(key);
        else result.unknown.push({ key, error: safeError(error) });
      }
    }
  }));
  return result;
}

export async function verifyExactResourceResiduals(backend, itemKeys = [], collectionKeys = [], { concurrency = 4 } = {}) {
  const cliItems = backend?.backendType === "cli" ? await classifyItemKeys(backend, itemKeys, concurrency) : null;
  const items = cliItems ? {
    requested: itemKeys.length,
    present: cliItems.present.length,
    missing: cliItems.missing.length,
    unknown: cliItems.unknown.length,
    request_errors: cliItems.unknown,
  } : await verifyKeys(itemKeys, async (key) => {
    if (typeof backend.getItemDetails === "function") return Boolean(await backend.getItemDetails(key, "preview"));
    const values = await backend.getItems([key], { mode: "preview", stage: "stage2_smoke_cleanup_verify" });
    return (Array.isArray(values) ? values : []).some((item) => item && item.missing !== true);
  }, concurrency);
  const collections = await verifyKeys(collectionKeys, async (key) => {
    await backend.getCollectionItems(key, { limit: 1, stage: "stage2_smoke_cleanup_verify" });
    return true;
  }, concurrency);
  return { items, collections };
}

export async function runStage2SmokeCleanup({ manifest, backend, apply = false, expectedRunId = "" } = {}) {
  const plan = buildStage2SmokeCleanupPlan(manifest, { expectedRunId });
  const base = {
    ...plan,
    mode: apply ? "apply" : "dry-run",
    external_write_performed: false,
    deleted_items: 0,
    deleted_collections: 0,
    failed_item_deletes: [],
    failed_collection_deletes: [],
    already_absent_items: 0,
    already_absent_collections: 0,
    residual: { items: null, collections: null, local: null, cloud: null },
  };
  if (!plan.ok || !apply) return base;
  if (!backend?.deleteItems || !backend?.deleteCollections || !backend?.getItems || !backend?.getCollections || (plan.collectionKeys.length && !backend?.getCollectionItems)) {
    return { ...base, ok: false, errors: [...plan.errors, "cleanup_backend_contract_missing"] };
  }

  const itemPreflight = await classifyItemKeys(backend, plan.itemKeys);
  const itemResult = await deleteItemsInChunks(backend, itemPreflight.present);
  const alreadyAbsentItemFailures = itemResult.failed.filter((entry) => missingError(entry?.error));
  itemResult.failed = itemResult.failed.filter((entry) => !missingError(entry?.error));
  const safeCollectionKeys = [];
  const blockedCollectionDeletes = [];
  const alreadyAbsentCollectionKeys = [];
  for (const collectionKey of plan.collectionKeys) {
    try {
      const items = await backend.getCollectionItems(collectionKey, { limit: 1, stage: "stage2_smoke_cleanup_preflight" });
      if ((Array.isArray(items) ? items : []).length) blockedCollectionDeletes.push({ collectionKey, error: "collection_not_empty_after_item_cleanup" });
      else safeCollectionKeys.push(collectionKey);
    } catch (error) {
      if (missingError(error)) alreadyAbsentCollectionKeys.push(collectionKey);
      else blockedCollectionDeletes.push({ collectionKey, error: `collection_preflight_failed:${error?.message || error}` });
    }
  }
  const collectionResult = normalizeDeleteResult(await backend.deleteCollections(safeCollectionKeys, { deleteItems: false, stage: "stage2_smoke_cleanup" }), "collectionKey");
  collectionResult.failed.push(...blockedCollectionDeletes);
  const local = await removeLocalIndexEntries(manifest.localIndexPath, plan.itemKeys, { apply: true });
  const verification = await verifyExactResourceResiduals(backend, plan.itemKeys, plan.collectionKeys);
  const residual = {
    items: verification.items.present,
    collections: verification.collections.present,
    local: local.residual,
    cloud: verification.items.present + verification.collections.present,
  };
  const requestErrors = [...itemPreflight.unknown, ...verification.items.request_errors, ...verification.collections.request_errors];
  const errors = [...plan.errors, ...requestErrors.map((entry) => `verify_failed:${entry.error}`)];
  if (local.error) errors.push(`local_index_cleanup_failed:${local.error}`);
  return {
    ...base,
    ok: itemResult.failed.length === 0 && collectionResult.failed.length === 0 && errors.length === 0 && residual.cloud === 0 && residual.local === 0,
    errors,
    external_write_performed: plan.itemKeys.length > 0 || safeCollectionKeys.length > 0,
    deleted_items: itemResult.deleted.length,
    deleted_collections: collectionResult.deleted.length,
    failed_item_deletes: itemResult.failed,
    failed_collection_deletes: collectionResult.failed,
    already_absent_items: itemPreflight.missing.length + alreadyAbsentItemFailures.length,
    already_absent_collections: alreadyAbsentCollectionKeys.length,
    local_index_removed_items: local.removed,
    verification,
    residual,
  };
}

function argValue(argv, name, fallback = "") {
  const prefix = `--${name}=`;
  const inline = argv.find((entry) => String(entry || "").startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = argv.findIndex((entry) => String(entry || "") === `--${name}`);
  return index >= 0 ? String(argv[index + 1] || "") : fallback;
}

async function readManifest(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export async function main(argv = process.argv) {
  const manifestPath = argValue(argv, "manifest");
  if (!manifestPath) throw new Error("cleanup_manifest_required");
  const manifest = await readManifest(path.resolve(manifestPath));
  const apply = argv.includes("--apply");
  const expectedRunId = argValue(argv, "run-id");
  if (!apply) return runStage2SmokeCleanup({ manifest, apply: false, expectedRunId });
  const { callTool } = await createZoteroBackendClient();
  return runStage2SmokeCleanup({ manifest, backend: callTool.adapter, apply: true, expectedRunId });
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
