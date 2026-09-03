import { runGuardedWriteMetadataUpdates } from "../lib/writeback_support.mjs";

export function normalizeStage3MutationStage(stage = "stage3_translation") {
  if (stage === "stage3_translation" || stage === "stage3_translation_backfill") return "stage3_translation";
  throw new Error(`stage3_metadata_stage_invalid:${String(stage || "missing")}`);
}

function normalizeStage3MetadataBatchResult(result = {}, updates = []) {
  const failed = Array.isArray(result?.failed)
    ? result.failed
    : Array.isArray(result?.write_failures)
      ? result.write_failures
      : [];
  let updated = Array.isArray(result?.updated) ? result.updated : [];
  if (!updated.length && Number(result?.write_success_count || 0) > 0) {
    const failedKeys = new Set(failed.map((failure) => String(failure?.itemKey || "").trim()).filter(Boolean));
    updated = (Array.isArray(updates) ? updates : [])
      .map((update) => String(update?.itemKey || "").trim())
      .filter((itemKey) => itemKey && !failedKeys.has(itemKey));
  }
  const normalized = { updated, failed };
  if (Array.isArray(result?.unchanged)) normalized.unchanged = result.unchanged;
  if (result?.versions && typeof result.versions === "object") normalized.versions = result.versions;
  if (result?.libraryVersion !== undefined) normalized.libraryVersion = result.libraryVersion;
  return normalized;
}

export function createStage3WriteMetadataBatchTool({
  zoteroBackendCall,
  zoteroBackend = null,
  idBase = 970000,
  stage = "stage3_translation",
} = {}) {
  const normalizedStage = normalizeStage3MutationStage(stage);
  return async function writeMetadataBatchTool(updates = []) {
    const contractBackend = typeof zoteroBackend?.writeMetadataBatch === "function"
      ? zoteroBackend
      : zoteroBackendCall?.adapter || null;
    if (typeof contractBackend?.writeMetadataBatch === "function") {
      const result = await contractBackend.writeMetadataBatch(updates, { stage: normalizedStage });
      return normalizeStage3MetadataBatchResult(result, updates);
    }
    if (typeof zoteroBackendCall !== "function") throw new Error("write_metadata_batch_writer_required");
    const result = await zoteroBackendCall("write_metadata_batch", { updates }, idBase + Math.floor(Math.random() * 10000));
    const parsed = JSON.parse(result?.content?.[0]?.text || "{}");
    return normalizeStage3MetadataBatchResult(parsed, updates);
  };
}

export function createStage3WriteMetadata({
  admittedMetadataItemKeys = new Set(),
  metadataScopeBlocks = [],
  writeMetadataTool,
  apply = false,
  dryRun = !apply,
} = {}) {
  const admittedKeys = admittedMetadataItemKeys instanceof Set
    ? admittedMetadataItemKeys
    : new Set(Array.isArray(admittedMetadataItemKeys) ? admittedMetadataItemKeys : []);

  return async function writeMetadata(itemKey, fields) {
    const result = await runGuardedWriteMetadataUpdates({
      updates: [{ itemKey, fields }],
      apply,
      dryRun,
      allowedItemKeys: admittedKeys,
      blockedItemReason: "collection_scope_blocked:write_metadata_item_not_admitted",
      writer: async ({ itemKey: key, fields: metadataFields }) => {
        await writeMetadataTool(key, metadataFields);
      },
      onFailure: ({ itemKey: failedKey, error }) => {
        const reason = String(error?.message || error);
        if (reason.includes("collection_scope_blocked:write_metadata_item_not_admitted")) {
          metadataScopeBlocks.push({
            action: "write_metadata",
            role: "shortTitle_backfill",
            itemKey: failedKey,
            reason: "write_metadata_item_not_admitted_by_stage2_or_allowed_pool_scan",
          });
        }
      },
    });
    if (!result.ok) {
      throw new Error(result.write_failures[0]?.error || "write_metadata_failed");
    }
    return result;
  };
}

export function createStage3WriteMetadataBatch({
  admittedMetadataItemKeys = new Set(),
  metadataScopeBlocks = [],
  writeMetadataBatchTool,
  apply = false,
  dryRun = !apply,
} = {}) {
  const admittedKeys = admittedMetadataItemKeys instanceof Set
    ? admittedMetadataItemKeys
    : new Set(Array.isArray(admittedMetadataItemKeys) ? admittedMetadataItemKeys : []);

  return async function writeMetadataBatch(updates = []) {
    const list = Array.isArray(updates) ? updates : [];
    const result = {
      ok: true,
      dry_run: Boolean(dryRun || !apply),
      apply: Boolean(apply && !dryRun),
      planned_update_count: list.length,
      write_success_count: 0,
      write_unchanged_count: 0,
      write_failure_count: 0,
      write_failures: [],
      updated: [],
      unchanged: [],
      failed: [],
      versions: {},
      libraryVersion: null,
      guard_blocked_count: 0,
      writer_called: false,
    };

    if (result.dry_run) return result;
    if (typeof writeMetadataBatchTool !== "function") {
      throw new Error("write_metadata_batch_writer_required");
    }

    const allowed = [];
    for (const update of list) {
      const itemKey = String(update?.itemKey || "").trim();
      if (!admittedKeys.has(itemKey)) {
        result.guard_blocked_count++;
        result.write_failure_count++;
        result.write_failures.push({
          itemKey,
          error: "collection_scope_blocked:write_metadata_item_not_admitted",
          blocked: true,
        });
        metadataScopeBlocks.push({
          action: "write_metadata",
          role: "shortTitle_backfill",
          itemKey,
          reason: "write_metadata_item_not_admitted_by_stage2_or_allowed_pool_scan",
        });
        continue;
      }
      allowed.push({ itemKey, fields: update.fields || {} });
    }

    if (allowed.length) {
      result.writer_called = true;
      const batch = await writeMetadataBatchTool(allowed);
      const updated = new Set(batch?.updated || []);
      const unchanged = new Set(batch?.unchanged || []);
      const failed = Array.isArray(batch?.failed) ? batch.failed : [];
      result.updated = [...updated];
      result.unchanged = [...unchanged];
      result.write_success_count += updated.size;
      result.write_unchanged_count += unchanged.size;
      result.versions = batch?.versions || {};
      result.libraryVersion = batch?.libraryVersion || null;
      for (const failure of failed) {
        result.write_failure_count++;
        result.write_failures.push({
          itemKey: failure.itemKey || "",
          error: failure.error || "write_metadata_failed",
        });
      }
      for (const update of allowed) {
        if (!updated.has(update.itemKey) && !unchanged.has(update.itemKey) && !failed.some((failure) => failure.itemKey === update.itemKey)) {
          result.write_failure_count++;
          result.write_failures.push({
            itemKey: update.itemKey,
            error: "write_metadata_batch_missing_result",
          });
        }
      }
    }

    result.failed = result.write_failures.map((failure) => ({ ...failure }));
    result.ok = result.write_failure_count === 0;
    if (!result.ok) {
      throw Object.assign(new Error(result.write_failures[0]?.error || "write_metadata_failed"), { result });
    }
    return result;
  };
}
