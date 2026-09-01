import fs from "node:fs/promises";

import { getLiteratureIdentityKeys } from "../lib/literature_identity.mjs";
import { normalizeLiveIndexItem, readZoteroLibraryIndex, writeZoteroLibraryIndex } from "../lib/zotero_library_index_store.mjs";
import { createZoteroBackendClient } from "../lib/zotero_backend_client.mjs";
import { buildCreateItemRequest } from "../stage2/item_payload.mjs";
import { hashFile } from "./operation_ledger.mjs";
import { createWorkbookReconciler } from "./reconciliation.mjs";
import { writeNotificationReceipt } from "../stage5/email_receipt.mjs";
import { findRadarQueueStateItem, loadRadarUrgentQueue, transitionRadarQueueItem } from "../radar/state.mjs";

function itemKey(item = {}) {
  return String(item.itemKey || item.key || item.data?.itemKey || item.data?.key || "");
}

function itemVersion(item = {}) {
  return Number(item.version || item.data?.version || 0);
}

function itemCollections(item = {}) {
  const values = item.collections || item.data?.collections || [];
  return new Set((Array.isArray(values) ? values : []).map((value) => String(typeof value === "string" ? value : value?.key || "")).filter(Boolean));
}

function hasRunMarker(item, runId) {
  const tags = item.tags || item.data?.tags || [];
  const values = (Array.isArray(tags) ? tags : []).map((tag) => String(typeof tag === "string" ? tag : tag?.tag || ""));
  return values.includes(`run:${runId}`) || new RegExp(`(?:^|\\n)run_id:\\s*${runId}(?:$|\\n)`, "m").test(String(item.extra || item.data?.extra || ""));
}

function normalizeCreateResult(result) {
  if (Array.isArray(result)) return { created: result, failed: [] };
  return { created: Array.isArray(result?.created) ? result.created : [], failed: Array.isArray(result?.failed) ? result.failed : [] };
}

function artifactItems(artifact) {
  if (Array.isArray(artifact)) return artifact;
  for (const key of ["items", "candidates", "writeback_items", "writebackReadyItems"]) if (Array.isArray(artifact?.[key])) return artifact[key];
  return [];
}

async function readItem(backend, key) {
  if (!key) return null;
  const values = typeof backend.getItems === "function"
    ? await backend.getItems([key], { mode: "preview", stage: "recovery" })
    : await backend.getItemsDetails([key], "preview", { stage: "recovery" });
  const list = Array.isArray(values) ? values : values?.items || [];
  return list.find((item) => itemKey(item) === key) || list[0] || null;
}

function exactIdentityMatches(candidate, value) {
  const expected = new Set(getLiteratureIdentityKeys(candidate));
  return getLiteratureIdentityKeys(value).some((identity) => expected.has(identity));
}

async function targetedMatches(backend, candidate, runId) {
  const queries = [candidate.doi, candidate.pmid, candidate.pmcid, candidate.arxiv, candidate.title].map(String).filter(Boolean);
  const matches = new Map();
  for (const q of queries) {
    const raw = await backend.searchLibrary({ q, limit: 8, mode: "preview", stage: "recovery_targeted_identity" });
    const items = Array.isArray(raw) ? raw : raw?.items || [];
    for (const item of items) if (itemKey(item) && exactIdentityMatches(candidate, item) && hasRunMarker(item, runId)) matches.set(itemKey(item), item);
  }
  return [...matches.values()];
}

function findArtifactItem(items, identity) {
  return items.find((item) => getLiteratureIdentityKeys(item).includes(identity)) || null;
}

function resolveOperationItemKey(operation, store) {
  if (operation.target?.itemKey || operation.target?.actualId) return operation.target.itemKey || operation.target.actualId;
  for (const dependency of operation.dependsOn || []) {
    const prior = store.ledger.operations.find((item) => item.idempotencyKey === dependency);
    if (prior?.target?.itemKey || prior?.target?.actualId) return prior.target.itemKey || prior.target.actualId;
  }
  return "";
}

export async function buildZoteroRecoveryReconcilers({ store, artifact, exportExecutor = null, fsApi = fs, backend = null } = {}) {
  const adapter = backend || (await createZoteroBackendClient()).callTool.adapter;
  const items = artifactItems(artifact);
  const create = {
    async observe(operation) {
      const knownKey = resolveOperationItemKey(operation, store);
      if (knownKey) {
        const item = await readItem(adapter, knownKey);
        if (!item) return { state: "conflict", evidence: { itemKey: knownKey, reason: "recorded_item_missing" } };
        const candidate = findArtifactItem(items, operation.identity);
        return candidate && exactIdentityMatches(candidate, item)
          ? { state: "match", target: { itemKey: knownKey, actualId: knownKey }, evidence: { itemKey: knownKey, targeted: true } }
          : { state: "conflict", evidence: { itemKey: knownKey, reason: "recorded_item_identity_changed" } };
      }
      const candidate = findArtifactItem(items, operation.identity);
      if (!candidate) return { state: "conflict", evidence: { reason: "artifact_identity_missing" } };
      const matches = await targetedMatches(adapter, candidate, store.ledger.runId);
      if (matches.length > 1) return { state: "ambiguous", evidence: { candidateCount: matches.length, targeted: true } };
      if (!matches.length) return { state: "absent", evidence: { candidateCount: 0, targeted: true } };
      const key = itemKey(matches[0]);
      return { state: "match", target: { itemKey: key, actualId: key }, evidence: { itemKey: key, candidateCount: 1, targeted: true } };
    },
    async execute(operation) {
      const candidate = findArtifactItem(items, operation.identity);
      if (!candidate) throw new Error("RECOVERY_ARTIFACT_IDENTITY_MISSING");
      const previousRunId = process.env.review_results_RUN_ID;
      process.env.review_results_RUN_ID = store.ledger.runId;
      let request;
      try { request = await buildCreateItemRequest(candidate); }
      finally {
        if (previousRunId === undefined) delete process.env.review_results_RUN_ID;
        else process.env.review_results_RUN_ID = previousRunId;
      }
      const input = { itemType: request.itemType, ...request.fields, tags: request.tags, collections: request.collections };
      const result = normalizeCreateResult(await adapter.createItems([input], { stage: "recovery" }));
      if (result.failed.length || result.created.length !== 1) throw new Error(result.failed[0]?.error || "RECOVERY_CREATE_RESULT_INVALID");
      const key = itemKey(result.created[0]);
      if (!key) throw new Error("RECOVERY_CREATE_ITEM_KEY_MISSING");
      return { target: { itemKey: key, actualId: key }, evidence: { itemKey: key, remoteAccepted: true } };
    },
    async verify(operation) { return this.observe(operation); },
  };
  const membership = (present) => ({
    async observe(operation) {
      if (operation.verification?.notApplicable) return { state: "match", evidence: operation.verification };
      const key = resolveOperationItemKey(operation, store);
      if (!key) return { state: "absent", evidence: { reason: "item_key_pending" } };
      const item = await readItem(adapter, key);
      if (!item) return { state: "conflict", evidence: { itemKey: key, reason: "item_missing" } };
      const has = itemCollections(item).has(String(operation.target.collectionId || operation.target.id));
      return has === present ? { state: "match", target: { itemKey: key }, evidence: { itemKey: key, collectionId: operation.target.collectionId || operation.target.id } } : { state: "absent", evidence: { itemKey: key } };
    },
    async execute(operation) {
      const key = resolveOperationItemKey(operation, store);
      const collectionId = operation.target.collectionId || operation.target.id;
      if (!key || !collectionId) throw new Error("RECOVERY_COLLECTION_TARGET_MISSING");
      if (present) await adapter.addItemsToCollection([key], collectionId, { verify: true, stage: "recovery" });
      else await adapter.removeItemsFromCollection([key], collectionId, { verify: true, stage: "recovery" });
      return { target: { itemKey: key }, evidence: { itemKey: key, collectionId } };
    },
    async verify(operation) { return this.observe(operation); },
  });
  const metadata = {
    async observe(operation) {
      const key = resolveOperationItemKey(operation, store);
      const item = await readItem(adapter, key);
      if (!item) return { state: "conflict", evidence: { itemKey: key, reason: "item_missing" } };
      const fields = operation.intent?.fields || {};
      const data = item.data || item;
      const matches = Object.entries(fields).filter(([name]) => name !== "version").every(([name, value]) => String(data[name] ?? item[name] ?? "") === String(value ?? ""));
      if (matches) return { state: "match", evidence: { itemKey: key, version: itemVersion(item) } };
      const expectedVersion = Number(operation.inputVersion);
      if (Number.isFinite(expectedVersion) && expectedVersion > 0 && itemVersion(item) !== expectedVersion) return { state: "conflict", evidence: { itemKey: key, expectedVersion, actualVersion: itemVersion(item) } };
      return { state: "absent", evidence: { itemKey: key, version: itemVersion(item) } };
    },
    async execute(operation) {
      const key = resolveOperationItemKey(operation, store);
      const expectedVersion = Number(operation.inputVersion);
      const fields = { ...(operation.intent?.fields || {}), ...(Number.isFinite(expectedVersion) && expectedVersion > 0 ? { version: expectedVersion } : {}) };
      await adapter.writeMetadata(key, fields, { stage: "recovery" });
      return { evidence: { itemKey: key } };
    },
    async verify(operation) { return this.observe(operation); },
  };
  const sharedIndex = {
    async observe(operation) {
      try {
        const actualHash = await hashFile(operation.target.path, { fsApi });
        if (operation.target.outputHash) return actualHash === operation.target.outputHash ? { state: "match", evidence: { outputHash: actualHash } } : { state: "conflict", evidence: { expectedHash: operation.target.outputHash, actualHash } };
        const index = JSON.parse(await fsApi.readFile(operation.target.path, "utf8"));
        const expectedKeys = store.ledger.operations.filter((item) => item.type === "zotero_item_create" && item.status === "verified").map((item) => item.target.itemKey || item.target.actualId).filter(Boolean);
        const live = index.live_items || {};
        const expectedUpdates = operation.intent?.updates || {};
        const updatesMatch = Object.entries(expectedUpdates).every(([key, patch]) => live[key] && Object.entries(patch || {}).every(([field, value]) => String(live[key]?.[field] ?? "") === String(value ?? "")));
        if (expectedKeys.every((key) => live[key]) && updatesMatch) return { state: "match", target: { outputHash: actualHash }, evidence: { outputHash: actualHash, itemCount: expectedKeys.length, updateCount: Object.keys(expectedUpdates).length } };
        if (/^[a-f0-9]{64}$/.test(String(operation.inputVersion || "")) && actualHash !== operation.inputVersion) return { state: "conflict", evidence: { reason: "shared_index_version_changed", expectedHash: operation.inputVersion, actualHash } };
        return { state: "absent", evidence: { outputHash: actualHash } };
      } catch (error) { return error?.code === "ENOENT" ? { state: "absent", evidence: { exists: false } } : { state: "conflict", evidence: { reason: String(error?.message || error) } }; }
    },
    async execute(operation) {
      const updates = {};
      for (const createOperation of store.ledger.operations.filter((item) => item.type === "zotero_item_create" && item.status === "verified")) {
        const key = createOperation.target.itemKey || createOperation.target.actualId;
        const item = await readItem(adapter, key);
        if (!item) throw new Error(`RECOVERY_INDEX_ITEM_MISSING:${key}`);
        updates[key] = normalizeLiveIndexItem({ ...item, itemKey: key });
      }
      const current = await readZoteroLibraryIndex(operation.target.path);
      if (!current.usable) throw new Error(`RECOVERY_SHARED_INDEX_UNUSABLE:${current.reason}`);
      await writeZoteroLibraryIndex(operation.target.path, { ...current.index, live_items: { ...(current.index.live_items || {}), ...updates } });
      const outputHash = await hashFile(operation.target.path, { fsApi });
      return { target: { outputHash }, evidence: { outputHash, itemCount: Object.keys(updates).length } };
    },
    async verify(operation) { return this.observe(operation); },
  };
  const exportReconciler = createWorkbookReconciler({ fsApi, execute: async (operation) => {
      if (typeof exportExecutor !== "function") throw new Error("RECOVERY_EXPORT_EXECUTOR_UNAVAILABLE");
      const result = await exportExecutor(operation);
      const outputPath = result?.outputPath || result?.exportAudit?.actual_output_path || result?.output?.exportAudit?.actual_output_path || "";
      if (!outputPath) throw new Error("RECOVERY_EXPORT_PATH_MISSING");
      const outputHash = await hashFile(outputPath, { fsApi });
      return { target: { path: outputPath, outputHash }, evidence: { outputHash } };
    } });
  const collectionEnsure = {
    async observe(operation) {
      if (!operation.target.collectionIds?.length) return { state: "ambiguous", evidence: { reason: "stable_collection_ids_not_recorded" } };
      const raw = await adapter.getCollections({ mode: "complete", stage: "recovery_collection_ensure" });
      const collections = Array.isArray(raw) ? raw : raw?.collections || raw?.items || [];
      const keys = new Set(collections.map((collection) => String(collection.key || collection.id || "")));
      return operation.target.collectionIds.every((key) => keys.has(key))
        ? { state: "match", evidence: { collectionIds: operation.target.collectionIds } }
        : { state: "conflict", evidence: { reason: "managed_collection_id_changed" } };
    },
    async execute() { throw new Error("RECOVERY_COLLECTION_ENSURE_RETRY_REQUIRES_STAGE2_RECEIPT"); },
    async verify(operation) { return this.observe(operation); },
  };
  const radarQueueConsume = {
    async observe(operation) {
      try {
        const state = await loadRadarUrgentQueue(operation.target.path, { fsApi });
        const found = findRadarQueueStateItem(state, operation.target.queueIdentity || operation.identity);
        if (!found) return { state: "conflict", evidence: { reason: "queue_item_missing" } };
        if (found.item.state === "consumed") {
          const evidence = found.item.verifiedWriteEvidence || {};
          return evidence.verified === true && evidence.ledgerOperationId === operation.idempotencyKey
            ? { state: "match", evidence }
            : { state: "conflict", evidence: { reason: "queue_consumed_by_different_evidence" } };
        }
        if (found.item.state === "claimed" && found.item.claimedByWeeklyRunId === store.ledger.runId) return { state: "absent", evidence: { claimed: true, weeklyRunId: store.ledger.runId } };
        return { state: "conflict", evidence: { reason: `queue_state_${found.item.state}`, claimedByWeeklyRunId: found.item.claimedByWeeklyRunId || "" } };
      } catch (error) {
        return { state: "conflict", evidence: { reason: String(error?.message || error).slice(0, 200) } };
      }
    },
    async execute(operation) {
      const createDependency = (operation.dependsOn || []).map((key) => store.ledger.operations.find((item) => item.idempotencyKey === key)).find((item) => item?.type === "zotero_item_create");
      const evidence = {
        verified: true,
        kind: createDependency?.verification?.notApplicable ? "preexisting_zotero_state" : "zotero_write",
        weeklyRunId: store.ledger.runId,
        ledgerOperationId: operation.idempotencyKey,
        dependencyOperationIds: operation.dependsOn || [],
        finalGrade: operation.intent?.finalGrade || "",
        outcome: operation.intent?.outcome || "weekly_verified_write",
      };
      await transitionRadarQueueItem(operation.target.path, operation.target.queueIdentity || operation.identity, "consumed", {
        weeklyRunId: store.ledger.runId,
        verifiedWriteEvidence: evidence,
        fsApi,
      });
      return { evidence };
    },
    async verify(operation) { return this.observe(operation); },
  };
  return {
    zotero_collection_ensure: collectionEnsure,
    zotero_item_create: create,
    zotero_collection_add: membership(true),
    zotero_collection_remove: membership(false),
    zotero_metadata: metadata,
    shared_index: sharedIndex,
    radar_queue_consume: radarQueueConsume,
    export: exportReconciler,
    notification: {
      async observe(operation) {
        try {
          const receipt = JSON.parse(await fsApi.readFile(operation.target.receiptPath || operation.target.path, "utf8"));
          if (receipt.schemaVersion === 2 && receipt.status === "pending" && receipt.attempts > 0) {
            const uncertain = { ...receipt, status: "unknown", updatedAt: new Date().toISOString(), lastSmtp: { outcome: "unknown", category: "interrupted_after_attempt_started", responseCode: null, acceptedCount: 0, rejectedCount: 0 } };
            await writeNotificationReceipt(operation.target.receiptPath || operation.target.path, uncertain, { fsApi });
            return { state: "ambiguous", evidence: { reason: "notification_possibly_accepted" } };
          }
          if (receipt.schemaVersion === 2 && receipt.status === "unknown") return { state: "ambiguous", evidence: { reason: "notification_possibly_accepted" } };
          const matches = ((receipt.schemaVersion === 1 && receipt.status === "sent") || (receipt.schemaVersion === 2 && receipt.status === "accepted")) && receipt.runId === store.ledger.runId
            && (!operation.verification?.messageId || receipt.messageId === operation.verification.messageId);
          return matches ? { state: "match", evidence: { receiptPath: operation.target.receiptPath, status: receipt.status } } : { state: "conflict", evidence: { reason: "notification_receipt_changed" } };
        } catch (error) { return error?.code === "ENOENT" ? { state: "absent", evidence: { reason: "notification_receipt_missing" } } : { state: "conflict", evidence: { reason: "notification_receipt_unreadable" } }; }
      },
      async execute() { throw new Error("NOTIFICATION_RECEIPT_SEMANTICS_REQUIRED"); },
    },
  };
}
