import fs from "node:fs/promises";
import path from "node:path";

import { getLiteratureIdentityKeys, normalizeTitleForExistingDedupe } from "../lib/literature_identity.mjs";
import { finishRunGroup, runGroupPath } from "../lib/runtime_housekeeping.mjs";
import { canonicalQueryHash, writeAtomicJson } from "../stage1/source_state.mjs";
import {
  acquireRunLease,
  hashFile,
  OperationLedgerStore,
  releaseRunLease,
  validateRecoveryRunId,
} from "./operation_ledger.mjs";
import { reconcileOperationLedger } from "./reconciliation.mjs";

export function literatureIdentity(item = {}) {
  return getLiteratureIdentityKeys(item)[0] || `title:${normalizeTitleForExistingDedupe(item.title || "")}`;
}

export async function createRunRecoveryCoordinator({ runRoot, runId, mode, profile, launcherId, configHash, inputHash, artifactPath }, dependencies = {}) {
  const store = await OperationLedgerStore.create({
    runRoot,
    runId,
    mode,
    profile,
    launcherId,
    configHash,
    inputHash,
    artifactPath,
    stages: profile === "radar"
      ? ["stage1", "stage2_writeback", "stage3_translation", "stage4_exports", "stage5_notification"]
      : mode === "local"
        ? ["stage1", "state_persist", "stage4_exports", "stage5_notification"]
        : ["stage1", "stage2_writeback", "stage3_translation", "stage4_exports", "stage5_notification"],
  }, dependencies);
  return new RunRecoveryCoordinator(store, dependencies);
}

async function transitionToVerified(store, operation, options = {}) {
  let current = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
  if (current.status === "pending" || current.status === "failed") await store.transition(current.idempotencyKey, "started");
  current = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
  if (current.status === "started") await store.transition(current.idempotencyKey, "remote_observed", options);
  current = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
  if (current.status === "remote_observed") await store.transition(current.idempotencyKey, "verified", options);
}

export class RunRecoveryCoordinator {
  constructor(store, dependencies = {}) {
    this.store = store;
    this.fsApi = dependencies.fsApi || fs;
    this.stage2 = null;
  }

  async bindArtifact(artifactPath, items = []) {
    return this.store.bindArtifact({ artifactPath, identities: items.map(literatureIdentity) });
  }

  async prepareCollectionSetup(names = []) {
    const logicalNames = [...new Set(names.map(String).filter(Boolean))];
    const operation = await this.store.planOperation({
      type: "zotero_collection_ensure",
      identity: "run",
      target: { id: `managed-collections:${canonicalQueryHash(logicalNames)}` },
      input: { names: logicalNames },
      scope: "global",
      retryable: false,
      intent: { names: logicalNames },
    });
    if (operation.status === "pending" || operation.status === "failed") await this.store.transition(operation.idempotencyKey, "started");
    return operation;
  }

  async completeCollectionSetup(operation, records = []) {
    const collectionIds = [...new Set(records.map((record) => String(record?.key || "")).filter(Boolean))];
    await transitionToVerified(this.store, operation, { target: { collectionIds }, verification: { collectionIds, recordCount: records.length } });
  }

  async persistArtifact(artifact, items = Array.isArray(artifact) ? artifact : []) {
    await writeAtomicJson(this.store.ledger.artifact.path, artifact, { fsApi: this.fsApi });
    return this.bindArtifact(this.store.ledger.artifact.path, items);
  }

  async prepareStage2({ items, sourceKeys, gradeKeys, resolveSourceName, resolveGradeName, indexPath }) {
    const records = [];
    for (const item of items) {
      const identity = literatureIdentity(item);
      const create = await this.store.planOperation({
        type: "zotero_item_create",
        identity,
        target: { id: `zotero-library:${this.store.ledger.mode}` },
        input: item,
        inputVersion: "literature-identity-v1",
      });
      const sourceKey = sourceKeys[resolveSourceName(item)];
      const gradeKey = gradeKeys[resolveGradeName(item)];
      const memberships = [];
      for (const [role, collectionId] of [["source", sourceKey], ["grade", gradeKey]]) {
        if (!collectionId) continue;
        memberships.push(await this.store.planOperation({
          type: "zotero_collection_add",
          identity,
          target: { id: collectionId, collectionId },
          input: { role, collectionId },
          dependsOn: [create.idempotencyKey],
          intent: { role },
        }));
      }
      records.push({ item, identity, create, memberships });
    }
    const indexInputVersion = await hashFile(indexPath, { fsApi: this.fsApi }).catch(() => "missing");
    const index = await this.store.planOperation({
      type: "shared_index",
      identity: "run",
      target: { id: path.resolve(indexPath), path: path.resolve(indexPath) },
      input: { identities: records.map((record) => record.identity) },
      inputVersion: indexInputVersion,
      scope: "global",
    });
    for (const operation of [...records.flatMap((record) => [record.create, ...record.memberships]), index]) {
      if (operation.status === "pending" || operation.status === "failed") await this.store.transition(operation.idempotencyKey, "started");
    }
    await this.store.setStage("stage2_writeback", "started");
    this.stage2 = { records, index };
    return this.stage2;
  }

  async completeStage2({ summary, indexPath }) {
    if (!this.stage2) throw new Error("RECOVERY_STAGE2_NOT_PREPARED");
    const byTitle = new Map(this.stage2.records.map((record) => [normalizeTitleForExistingDedupe(record.item.title || ""), record]));
    const completed = new Set();
    for (const item of summary?.writeback_items || []) {
      const record = byTitle.get(normalizeTitleForExistingDedupe(item.title || ""));
      if (!record || !item.itemKey) continue;
      completed.add(record.identity);
      await transitionToVerified(this.store, record.create, { target: { itemKey: item.itemKey, actualId: item.itemKey }, verification: { itemKey: item.itemKey, evidence: "stage2_writeback_verified" } });
      const attachFailed = Number(summary?.current_date_add_failed || 0) > 0;
      if (!attachFailed) {
        for (const operation of record.memberships) await transitionToVerified(this.store, operation, { target: { itemKey: item.itemKey }, verification: { itemKey: item.itemKey, collectionId: operation.target.collectionId, evidence: "stage2_collection_postcheck" } });
      }
    }
    for (const duplicate of summary?.duplicate_records || []) {
      const record = byTitle.get(normalizeTitleForExistingDedupe(duplicate.title || ""));
      const existingKey = String(duplicate.matched_pool_item_key || "");
      if (!record || !existingKey || completed.has(record.identity)) continue;
      completed.add(record.identity);
      await transitionToVerified(this.store, record.create, { target: { itemKey: existingKey, actualId: existingKey }, verification: { itemKey: existingKey, notApplicable: true, reason: "preexisting_duplicate" } });
      for (const operation of record.memberships) await transitionToVerified(this.store, operation, { target: { itemKey: existingKey }, verification: { itemKey: existingKey, notApplicable: true, reason: "duplicate_routing_skipped" } });
    }
    for (const record of this.stage2.records.filter((item) => !completed.has(item.identity))) {
      const current = this.store.ledger.operations.find((item) => item.idempotencyKey === record.create.idempotencyKey);
      if (current.status === "started") await this.store.transition(current.idempotencyKey, "failed", { error: "STAGE2_ITEM_NOT_VERIFIED" });
    }
    const outputHash = await hashFile(indexPath, { fsApi: this.fsApi });
    await transitionToVerified(this.store, this.stage2.index, { target: { outputHash }, verification: { outputHash } });
    await this.store.setStage("stage2_writeback", "verified", { created: completed.size });
  }

  async prepareMetadata(updates = []) {
    const operations = [];
    for (const update of updates) {
      const itemKey = String(update?.itemKey || "");
      if (!itemKey) continue;
      const identity = this.store.ledger.operations.find((operation) => operation.target?.itemKey === itemKey)?.identity || `item:${itemKey}`;
      const operation = await this.store.planOperation({
        type: "zotero_metadata",
        identity,
        target: { id: itemKey, itemKey },
        input: update.fields || {},
        inputVersion: Number(update.version || update.fields?.version || 0) || "backend_version_unrecorded",
        retryable: Number(update.version || update.fields?.version || 0) > 0,
        intent: { fields: update.fields || {} },
      });
      if (operation.status === "pending" || operation.status === "failed") await this.store.transition(operation.idempotencyKey, "started");
      operations.push(operation);
    }
    await this.store.setStage("stage3_translation", "started");
    return operations;
  }

  async completeMetadata(operations, result = {}) {
    const successes = new Set([...(result.updated || []), ...(result.unchanged || [])].map(String));
    for (const operation of operations) {
      const itemKey = operation.target.itemKey;
      if (successes.has(itemKey)) await transitionToVerified(this.store, operation, { verification: { itemKey, version: result.versions?.[itemKey] || null } });
      else {
        const current = this.store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
        if (current.status === "started") await this.store.transition(current.idempotencyKey, "failed", { error: result.failed?.find((failure) => failure.itemKey === itemKey)?.error || "METADATA_NOT_VERIFIED" });
      }
    }
  }

  async prepareMembership({ type, itemKey, collectionId, identity = `item:${itemKey}`, role = "" }) {
    const operation = await this.store.planOperation({
      type,
      identity,
      target: { id: collectionId, collectionId, itemKey },
      input: { itemKey, collectionId, role },
      intent: { role },
    });
    if (operation.status === "pending" || operation.status === "failed") await this.store.transition(operation.idempotencyKey, "started");
    return operation;
  }

  async completeMembership(operation, ok, error = "") {
    if (ok) await transitionToVerified(this.store, operation, { verification: { itemKey: operation.target.itemKey, collectionId: operation.target.collectionId } });
    else {
      const current = this.store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      if (current.status === "started") await this.store.transition(current.idempotencyKey, "failed", { error: error || "COLLECTION_MUTATION_NOT_VERIFIED" });
    }
  }

  async prepareFileOperation({ type, targetId, targetPath = "", input, inputVersion = null, scope = "global", retryable = true, intent = null }) {
    const resolvedInputVersion = inputVersion ?? (targetPath ? await hashFile(targetPath, { fsApi: this.fsApi }).catch(() => "missing") : null);
    const operation = await this.store.planOperation({ type, identity: "run", target: { id: targetId, ...(targetPath ? { path: path.resolve(targetPath) } : {}) }, input, inputVersion: resolvedInputVersion, scope, retryable, intent });
    if (operation.status === "pending" || operation.status === "failed") await this.store.transition(operation.idempotencyKey, "started");
    return operation;
  }

  async completeFileOperation(operation, filePath, verification = {}) {
    const outputHash = await hashFile(filePath, { fsApi: this.fsApi });
    await transitionToVerified(this.store, operation, { target: { path: path.resolve(filePath), outputHash }, verification: { ...verification, outputHash } });
  }

  async completeNotification(operation, receipt = {}) {
    if (receipt.receiptStatus !== "accepted" && !(receipt.status === "skipped" && receipt.reason === "already_sent")) throw new Error("NOTIFICATION_RECEIPT_NOT_ACCEPTED");
    await transitionToVerified(this.store, operation, { target: { receiptPath: receipt.receiptPath || operation.target.path || "" }, verification: { status: "accepted", messageId: receipt.messageId || "" } });
  }
}

export async function resumeRunFromLedger({ runRoot, runId, mode, profile, configHash, inputHash = "", buildReconcilers, context = {} }, dependencies = {}) {
  const safeRunId = validateRecoveryRunId(runId);
  const lease = await acquireRunLease({ runRoot, runId: safeRunId, ttlMs: dependencies.ttlMs || 60_000 }, dependencies);
  if (!lease.acquired) return { runId: safeRunId, run_id: safeRunId, resume: true, status: "blocked", reason: lease.reason || "active_lease" };
  try {
    const fsApi = dependencies.fsApi || fs;
    const originalLockPath = path.join(path.dirname(runGroupPath(runRoot, safeRunId)), "run.lock");
    try {
      const originalLock = JSON.parse(await fsApi.readFile(originalLockPath, "utf8"));
      const processAlive = dependencies.processAlive || ((pid) => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === "EPERM"; } });
      if (Number(originalLock.pid) !== process.pid && processAlive(originalLock.pid)) throw new Error("RECOVERY_ORIGINAL_RUN_ACTIVE");
    } catch (error) {
      if (error?.code === "ENOENT") {
        // Normal failed runs release the original run lock.
      } else if (error?.message === "RECOVERY_ORIGINAL_RUN_ACTIVE") throw error;
      else if (error instanceof SyntaxError) throw new Error("RECOVERY_ORIGINAL_RUN_LOCK_INVALID");
      else throw new Error("RECOVERY_ORIGINAL_RUN_LOCK_UNREADABLE");
    }
    const store = await OperationLedgerStore.load({ runRoot, runId: safeRunId }, dependencies);
    if (lease.takeover) await store.recordLeaseTakeover(lease.takeover.previous);
    if (store.ledger.mode !== mode || store.ledger.profile !== profile) throw new Error("RECOVERY_MODE_PROFILE_MISMATCH");
    if (store.ledger.configHash !== configHash) throw new Error("RECOVERY_CONFIG_HASH_MISMATCH");
    if (inputHash && store.ledger.inputHash !== inputHash) throw new Error("RECOVERY_INPUT_HASH_MISMATCH");
    const actualArtifactHash = await hashFile(store.ledger.artifact.path, { fsApi });
    if (actualArtifactHash !== store.ledger.artifact.hash) throw new Error("RECOVERY_ARTIFACT_HASH_MISMATCH");
    if (store.ledger.inputHash !== actualArtifactHash) throw new Error("RECOVERY_INPUT_ARTIFACT_HASH_MISMATCH");
    const artifact = JSON.parse(await fsApi.readFile(store.ledger.artifact.path, "utf8"));
    const reconcilers = await buildReconcilers({ store, artifact, context });
    const recovery = await reconcileOperationLedger({ store, reconcilers, context: { ...context, artifact } });
    if (recovery.status === "completed") {
      await finishRunGroup({ manifestPath: runGroupPath(runRoot, safeRunId), status: "completed", finishedAt: new Date().toISOString() });
    }
    return { runId: safeRunId, run_id: safeRunId, resume: true, status: recovery.status, outcomes: recovery.outcomes };
  } finally {
    await releaseRunLease(lease, { fsApi: dependencies.fsApi || fs });
  }
}

export function runtimeRecoveryMetadata({ mode, profile, artifactPath, env = process.env }) {
  const configHash = String(env.PAPERECHO_CONFIG_HASH || "");
  const inputHash = String(env.PAPERECHO_INPUT_HASH || "");
  if (!/^[a-f0-9]{64}$/.test(configHash) || !/^[a-f0-9]{64}$/.test(inputHash)) throw new Error("RECOVERY_RUNTIME_HASH_MISSING");
  return {
    mode,
    profile,
    launcherId: String(env.PAPERECHO_LAUNCHER_ID || "fixed-launcher/runner"),
    configHash,
    inputHash,
    artifactPath,
  };
}
