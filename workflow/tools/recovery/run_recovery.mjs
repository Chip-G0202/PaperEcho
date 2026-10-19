import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from 'node:crypto';
import { readBoundedJson, readBoundedBytes, boundedDirectory } from '../lib/atomic_json.mjs';
import { validateNotificationReceipt } from '../stage5/email_receipt.mjs';
import { scheduleDayDecisionPath, plannedSlotCalendarDateKey, validateScheduleDayClaim } from '../lib/schedule_support.mjs';

import { getLiteratureIdentityKeys, normalizeTitleForExistingDedupe } from "../lib/literature_identity.mjs";
import { finishRunGroup, runGroupPath } from "../lib/runtime_housekeeping.mjs";
import { canonicalQueryHash, writeAtomicJson } from "../stage1/source_state.mjs";
import {
  acquireRunLease,
  acquireWorkflowLease,
  inspectWorkflowLease,
  validateOperationLedger,
  hashFile,
  OperationLedgerStore,
  releaseRunLease,
  validateRecoveryRunId,
} from "./operation_ledger.mjs";
import { reconcileOperationLedger } from "./reconciliation.mjs";
import { transitionRadarQueueItem } from "../radar/state.mjs";
import { resumeCompletedBusinessNotification } from "./notification_recovery.mjs";

export function literatureIdentity(item = {}) {
  return getLiteratureIdentityKeys(item)[0] || `title:${normalizeTitleForExistingDedupe(item.title || "")}`;
}

export function inspectRecoveryLedger(ledger) {
  const required = ledger.profile === 'radar' ? ['stage1'] : ledger.mode === 'local'
    ? ['stage1', 'state_persist', 'stage4_exports'] : ['stage1', 'stage2_writeback', 'stage3_translation', 'stage4_exports'];
  return {
    businessComplete: required.every(name => ledger.stages?.[name]?.status === 'verified'),
    recoveryPending: ['failed', 'incomplete', 'interrupted', 'timed_out'].includes(ledger.status),
    unresolvedOperations: ledger.operations.filter(op => op.status !== 'verified').length,
    conflicts: ledger.operations.filter(op => op.status === 'conflict').length,
  };
}

// A bounded read-only projection of existing owners, never a recovery journal.
// Inspect every registered group in the bound: an older unfinished run is not
// hidden by a newer completed one, and inspection limits stay UNKNOWN.
export async function inspectStartupRecovery({ runRoot, resumeRunId = '', automatic = false, ownLeaseOwnerId = '', dataRoots = [], researchRoot } = {}, dependencies = {}) {
  const result = (state, code, extra = {}) => ({ state, code, blocking: state !== 'SAFE_TO_CONTINUE', canResume: false, ...extra });
  let bytes = 0;
  const read = async (root, file, maxBytes = 1048576) => {
    const value = await readBoundedJson(root, file, { maxBytes });
    bytes += value ? Buffer.byteLength(JSON.stringify(value)) : 0;
    if (bytes > 8 * 1048576) throw new Error('INSPECTION_LIMIT');
    return value;
  };
  const within = (root, file) => { const r = path.relative(path.resolve(root), path.resolve(file)); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
  try {
    if (!path.isAbsolute(runRoot || '')) throw new Error('STARTUP_ROOT_INVALID');
    if (resumeRunId) validateRecoveryRunId(resumeRunId);
    const legacy = await read(runRoot, path.join(runRoot, '.runner.operation.lock'), 8192);
    if (legacy) return result('UNKNOWN', 'STARTUP_LEGACY_ADMISSION_UNCONFIRMED');
    const lease = await read(runRoot, path.join(runRoot, '.workflow.lease.json'), 8192);
    const claim = inspectWorkflowLease(lease, { ...dependencies, now: (dependencies.clock || (() => new Date()))() });
    if (claim === 'unknown') return result('UNKNOWN', 'STARTUP_LEASE_UNCONFIRMED');
    if (claim === 'running' && !(lease.ownerId === ownLeaseOwnerId && lease.pid === process.pid)) return result('BLOCKED', 'STARTUP_WORKFLOW_ACTIVE');
    let dayClaim;
    if (researchRoot) {
      const now = (dependencies.clock || (() => new Date()))();
      dayClaim = await read(researchRoot, scheduleDayDecisionPath(path.join(researchRoot, 'schedule_decisions'), plannedSlotCalendarDateKey(now)), 8192);
      if (dayClaim) validateScheduleDayClaim(dayClaim, now);
    }
    const pending = [], seen = new Set();
    for (const entry of await boundedDirectory(runRoot)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const runId = validateRecoveryRunId(entry.name), directory = path.join(runRoot, runId); seen.add(runId);
      const manifest = await read(runRoot, path.join(directory, 'run_group.json'));
      const ledger = await read(runRoot, path.join(directory, 'operation_ledger.json'));
      if (!manifest || !ledger || manifest.schemaVersion !== 1 || manifest.runId !== runId || !Number.isFinite(Date.parse(manifest.startedAt))) throw new Error('STARTUP_RUN_UNCONFIRMED');
      validateOperationLedger(ledger, { expectedRunId: runId });
      const statuses = ['running', 'completed', 'skipped', 'failed', 'incomplete', 'interrupted', 'timed_out'];
      if (!statuses.includes(ledger.status) || !statuses.includes(manifest.status) || manifest.pipelineMode !== ledger.mode) throw new Error('STARTUP_RUN_UNCONFIRMED');
      const lock = await read(directory, path.join(directory, 'run.lock'), 8192);
      if (lock) {
        if (!Number.isInteger(lock.pid) || lock.pid < 1) throw new Error('STARTUP_RUN_LOCK_UNCONFIRMED');
        let alive;
        if (dependencies.processAlive) alive = dependencies.processAlive(lock.pid);
        else { try { process.kill(lock.pid, 0); alive = true; } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; } }
        if (alive) return result('BLOCKED', 'STARTUP_ORIGINAL_RUN_ACTIVE');
      }
      let autoResume = true, receiptsComplete = true;
      for (const operation of ledger.operations) {
        for (const key of ['path', 'receiptPath']) {
          const file = operation.target?.[key];
          if (file && path.isAbsolute(file) && ![runRoot, ...dataRoots].some(root => within(root, file))) throw new Error('STARTUP_OPERATION_SCOPE_UNCONFIRMED');
        }
        if (operation.type !== 'notification') {
          if (operation.status !== 'verified') autoResume = false;
          continue;
        }
        const file = operation.target?.receiptPath || operation.target?.path;
        if (!file || !path.isAbsolute(file) || !within(directory, file)) throw new Error('STARTUP_RECEIPT_UNCONFIRMED');
        const receipt = await read(directory, file);
        if (receipt) {
          validateNotificationReceipt(receipt);
          if (receipt.runId !== runId || receipt.ledgerOperationId !== operation.idempotencyKey || (receipt.channel || 'email') !== (operation.intent?.channel || 'email')) throw new Error('STARTUP_RECEIPT_UNCONFIRMED');
        }
        if (operation.status === 'verified' && receipt?.status !== 'accepted') throw new Error('STARTUP_RECEIPT_UNCONFIRMED');
        if (receipt?.status !== 'accepted') { receiptsComplete = false; if (receipt || operation.status !== 'pending') autoResume = false; }
      }
      const facts = inspectRecoveryLedger(ledger);
      const artifact = ledger.artifact?.path;
      const bound = /^[a-f0-9]{64}$/.test(ledger.artifact?.hash || '') && path.isAbsolute(artifact || '') && within(directory, artifact);
      // Formal interval/duplicate skips have no planned business effects.
      if (manifest.status === 'skipped' && ledger.status === 'skipped' && ledger.workflowStatus === 'skipped'
        && !ledger.operations.length && Object.values(ledger.stages).every(stage => ['pending', 'skipped'].includes(stage.status))) continue;
      const completedLedger = ledger.status === 'completed' || ledger.status === 'incomplete' && !ledger.operations.length && ledger.workflowStatus === 'completed';
      if (completedLedger && manifest.status === 'completed' && bound && facts.businessComplete && !facts.unresolvedOperations
        && ['verified', 'skipped'].includes(ledger.stages?.stage5_notification?.status) && receiptsComplete) continue;
      if (facts.conflicts || manifest.status === 'completed' && ledger.status !== 'completed') throw new Error('STARTUP_RUN_UNCONFIRMED');
      pending.push({ runId, canResume: bound, autoResume: autoResume && facts.businessComplete });
    }
    if (claim === 'stale' && !seen.has(lease.runId)) return result('UNKNOWN', 'STARTUP_ORPHAN_LEASE_UNCONFIRMED');
    if (dayClaim?.businessRunId && !seen.has(dayClaim.businessRunId)) return result('UNKNOWN', 'STARTUP_SCHEDULE_RUN_UNCONFIRMED');
    if (!pending.length) return result('SAFE_TO_CONTINUE', 'STARTUP_SAFE');
    const one = pending.length === 1 ? pending[0] : null;
    const canResume = Boolean(one?.canResume && one.runId === resumeRunId && (!automatic || one.autoResume));
    if (pending.some(run => !run.canResume)) return result('UNKNOWN', 'STARTUP_RUN_UNBOUND', { pendingRuns: pending.length });
    return result('RECOVERY_REQUIRED', 'STARTUP_RUN_RECOVERY_REQUIRED', { canResume, runId: one?.runId || null, pendingRuns: pending.length, automaticSafe: Boolean(one?.canResume && one.autoResume) });
  } catch { return result('UNKNOWN', 'STARTUP_STATE_UNCONFIRMED'); }
}

export async function acquireStartupWorkflowLease(options, dependencies = {}) {
  if (options.parentOwnerId) return acquireWorkflowLease(options, dependencies);
  const allowed = state => !state.blocking || state.canResume;
  const before = await inspectStartupRecovery(options, dependencies);
  if (!allowed(before)) return { acquired: false, reason: before.code, recovery: before };
  const lease = await acquireWorkflowLease(options, dependencies);
  if (!lease.acquired) return lease;
  try {
    const after = await inspectStartupRecovery({ ...options, ownLeaseOwnerId: lease.lease.ownerId }, dependencies);
    if (allowed(after)) return lease;
    await releaseRunLease(lease); return { acquired: false, reason: after.code, recovery: after };
  } catch (error) { await releaseRunLease(lease); throw error; }
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
    const queueConsumes = [];
    for (const record of records) {
      const claim = record.item?.weekly_radar_queue_claim;
      if (!claim?.claimed || !claim.queuePath || !claim.identity) continue;
      queueConsumes.push(await this.store.planOperation({
        type: "radar_queue_consume",
        identity: record.identity,
        target: { id: `radar-queue:${claim.identity}`, path: path.resolve(claim.queuePath), queueIdentity: claim.identity },
        input: {
          weeklyRunId: this.store.ledger.runId,
          classificationFingerprint: claim.classificationFingerprint || "",
          priorClassificationFingerprint: claim.priorClassificationFingerprint || "",
          finalGrade: claim.finalGrade || record.item.final_grade || record.item.grade || "",
        },
        dependsOn: [record.create.idempotencyKey, ...record.memberships.map((operation) => operation.idempotencyKey), index.idempotencyKey],
        intent: { outcome: claim.outcome || "weekly_verified_write", finalGrade: claim.finalGrade || record.item.final_grade || record.item.grade || "" },
      }));
    }
    for (const operation of [...records.flatMap((record) => [record.create, ...record.memberships]), index]) {
      if (operation.status === "pending" || operation.status === "failed") await this.store.transition(operation.idempotencyKey, "started");
    }
    await this.store.setStage("stage2_writeback", "started");
    this.stage2 = { records, index, queueConsumes };
    return this.stage2;
  }

  async persistIntegrityPlan(plan = {}) {
    const filePath = path.join(path.dirname(this.store.filePath), "integrity_plan.json");
    await writeAtomicJson(filePath, plan, { fsApi: this.fsApi });
    return filePath;
  }

  async completeStage2({ summary, indexPath, failedCollectionItemKeys = [], onVerifiedWrites = null }) {
    if (!this.stage2) throw new Error("RECOVERY_STAGE2_NOT_PREPARED");
    const byIdentity = new Map(this.stage2.records.map((record) => [record.identity, record]));
    const byTitle = new Map(this.stage2.records.map((record) => [normalizeTitleForExistingDedupe(record.item.title || ""), record]));
    const resolveRecord = (item) => byIdentity.get(literatureIdentity(item)) || byTitle.get(normalizeTitleForExistingDedupe(item.title || ""));
    const failedCollectionKeys = new Set([...failedCollectionItemKeys].map(String));
    const completed = new Set();
    for (const item of summary?.writeback_items || []) {
      const record = resolveRecord(item);
      if (!record || !item.itemKey) continue;
      completed.add(record.identity);
      await transitionToVerified(this.store, record.create, { target: { itemKey: item.itemKey, actualId: item.itemKey }, verification: { itemKey: item.itemKey, evidence: "stage2_writeback_verified" } });
      const attachFailed = failedCollectionKeys.size ? failedCollectionKeys.has(String(item.itemKey)) : Number(summary?.current_date_add_failed || 0) > 0;
      if (!attachFailed) {
        for (const operation of record.memberships) await transitionToVerified(this.store, operation, { target: { itemKey: item.itemKey }, verification: { itemKey: item.itemKey, collectionId: operation.target.collectionId, evidence: "stage2_collection_postcheck" } });
      } else {
        for (const operation of record.memberships) {
          const current = this.store.ledger.operations.find((entry) => entry.idempotencyKey === operation.idempotencyKey);
          if (current.status === "started") await this.store.transition(current.idempotencyKey, "failed", { error: "STAGE2_COLLECTION_NOT_VERIFIED" });
        }
      }
    }
    for (const duplicate of summary?.duplicate_records || []) {
      const record = resolveRecord(duplicate);
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
    const verifiedWriteItems = [];
    for (const item of summary?.writeback_items || []) {
      const record = resolveRecord(item);
      if (!record) continue;
      const create = this.store.ledger.operations.find((entry) => entry.idempotencyKey === record.create.idempotencyKey);
      const memberships = record.memberships.map((planned) => this.store.ledger.operations.find((entry) => entry.idempotencyKey === planned.idempotencyKey));
      if (create?.status === "verified" && create.verification?.notApplicable !== true && memberships.every((entry) => entry?.status === "verified")) {
        verifiedWriteItems.push({ ...item, verified_identity: record.identity });
      }
    }
    const verifiedBusinessWriteIdentities = [...new Set(verifiedWriteItems.map((item) => item.verified_identity).filter(Boolean))].sort();
    if (typeof onVerifiedWrites === "function") {
      await onVerifiedWrites({ verifiedWriteItems, verifiedBusinessWriteIdentities });
    }
    const queueResults = [];
    for (const planned of this.stage2.queueConsumes || []) {
      const operation = this.store.ledger.operations.find((item) => item.idempotencyKey === planned.idempotencyKey);
      const dependencies = operation.dependsOn.map((key) => this.store.ledger.operations.find((item) => item.idempotencyKey === key)).filter(Boolean);
      if (dependencies.every((item) => item.status === "verified")) {
        if (operation.status === "pending" || operation.status === "failed") await this.store.transition(operation.idempotencyKey, "started");
        const evidence = {
          verified: true,
          kind: dependencies.find((item) => item.type === "zotero_item_create")?.verification?.notApplicable ? "preexisting_zotero_state" : "zotero_write",
          weeklyRunId: this.store.ledger.runId,
          ledgerOperationId: operation.idempotencyKey,
          dependencyOperationIds: operation.dependsOn,
          finalGrade: operation.intent?.finalGrade || "",
          outcome: operation.intent?.outcome || "weekly_verified_write",
        };
        await transitionRadarQueueItem(operation.target.path, operation.target.queueIdentity, "consumed", { weeklyRunId: this.store.ledger.runId, verifiedWriteEvidence: evidence, fsApi: this.fsApi });
        await this.store.transition(operation.idempotencyKey, "remote_observed", { verification: evidence });
        await this.store.transition(operation.idempotencyKey, "verified", { verification: evidence });
        queueResults.push({ identity: operation.identity, status: "consumed" });
      } else {
        const reason = dependencies.some((item) => item.status === "conflict") ? "dependent_operation_conflict" : "dependent_operation_not_verified";
        await transitionRadarQueueItem(operation.target.path, operation.target.queueIdentity, "conflict", { weeklyRunId: this.store.ledger.runId, verifiedWriteEvidence: { reason }, fsApi: this.fsApi });
        await this.store.transition(operation.idempotencyKey, "conflict", { error: reason, verification: { reason } });
        queueResults.push({ identity: operation.identity, status: "conflict", reason });
      }
    }
    await this.store.setStage("stage2_writeback", "verified", { created: completed.size, verifiedBusinessWrites: verifiedBusinessWriteIdentities.length, queueResults });
    return { verifiedWriteItems, verifiedBusinessWriteIdentities, queueResults };
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
    const notApplicable = new Set([...(result.notApplicable || []), ...(result.not_applicable || [])]
      .map((entry) => String(entry?.itemKey || entry || ""))
      .filter(Boolean));
    for (const operation of operations) {
      const itemKey = operation.target.itemKey;
      if (notApplicable.has(itemKey)) {
        await transitionToVerified(this.store, operation, { verification: { itemKey, notApplicable: true, outcome: "verified_no_op", reason: "metadata_not_applicable" } });
      } else if (successes.has(itemKey)) await transitionToVerified(this.store, operation, { verification: { itemKey, version: result.versions?.[itemKey] || null } });
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

  async prepareIntegrityOperations({ plan = [], indexPath }) {
    const records = [];
    for (const entry of plan) {
      const target = entry?.target || {};
      if (!entry?.canonicalId || !target.required || target.blocked) {
        records.push({ entry, operations: [], commit: null });
        continue;
      }
      const operations = [];
      let trashAdd = null;
      let pendingCommit = null;
      if (target.status === "retraction") {
        trashAdd = await this.store.planOperation({
          type: "zotero_collection_add", identity: entry.canonicalId,
          target: { id: target.addCollectionId, collectionId: target.addCollectionId, itemKey: target.itemKey },
          input: { role: "trash", itemKey: target.itemKey, collectionId: target.addCollectionId },
          inputVersion: target.itemVersion || "backend_version_guard", intent: { role: "trash", integrity: true },
        });
        operations.push(trashAdd);
        pendingCommit = await this.store.planOperation({
          type: "integrity_state_commit", identity: entry.canonicalId,
          target: { id: `${path.resolve(indexPath)}#${entry.canonicalId}:pending_delete`, path: path.resolve(indexPath), canonicalId: entry.canonicalId },
          input: { targetFingerprint: target.targetFingerprint, status: target.status, applicationState: "pending_delete" },
          inputVersion: entry.evidenceFingerprint || "integrity-evidence-v1", scope: "identity",
          dependsOn: [trashAdd.idempotencyKey], intent: { targetFingerprint: target.targetFingerprint, status: target.status, applicationState: "pending_delete" },
        });
        for (const collectionId of target.removeCollectionIds || []) operations.push(await this.store.planOperation({
          type: "zotero_collection_remove", identity: entry.canonicalId,
          target: { id: collectionId, collectionId, itemKey: target.itemKey },
          input: { role: "integrity_managed_removal", itemKey: target.itemKey, collectionId },
          inputVersion: target.itemVersion || "backend_version_guard", dependsOn: [trashAdd.idempotencyKey], intent: { role: "integrity_managed_removal", integrity: true },
        }));
      }
      for (const tag of target.addTags || []) operations.push(await this.store.planOperation({
        type: "zotero_tag_add", identity: entry.canonicalId,
        target: { id: `${target.itemKey}:tag:${tag}`, itemKey: target.itemKey, tag },
        input: { itemKey: target.itemKey, tag }, inputVersion: target.itemVersion || "backend_version_guard",
        dependsOn: trashAdd ? [trashAdd.idempotencyKey] : [], intent: { action: "add", tags: [tag], integrity: true },
      }));
      const commit = await this.store.planOperation({
        type: "integrity_state_commit", identity: entry.canonicalId,
        target: { id: `${path.resolve(indexPath)}#${entry.canonicalId}:applied`, path: path.resolve(indexPath), canonicalId: entry.canonicalId },
        input: { targetFingerprint: target.targetFingerprint, status: target.status, applicationState: "applied" },
        inputVersion: entry.evidenceFingerprint || "integrity-evidence-v1", scope: "identity",
        dependsOn: operations.map((operation) => operation.idempotencyKey),
        intent: { targetFingerprint: target.targetFingerprint, status: target.status, applicationState: "applied" },
      });
      records.push({ entry, operations, pendingCommit, commit });
    }
    return records;
  }

  async startOperation(operation) {
    const current = this.store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
    if (current.status === "pending" || current.status === "failed") await this.store.transition(current.idempotencyKey, "started");
    return this.store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
  }

  async completeOperation(operation, ok, verification = {}, error = "") {
    if (ok) await transitionToVerified(this.store, operation, { verification });
    else {
      const current = this.store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      if (current.status === "pending") await this.store.transition(current.idempotencyKey, "started");
      const started = this.store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
      if (started.status === "started") await this.store.transition(started.idempotencyKey, "failed", { error: error || "INTEGRITY_MUTATION_NOT_VERIFIED", verification });
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

export async function resumeRunFromLedger({ runRoot, runId, mode, profile, configHash, inputHash = "", buildReconcilers, beforeReconcile = null, onBusinessVerified = null, context = {}, notification = {} }, dependencies = {}) {
  const safeRunId = validateRecoveryRunId(runId);
  // Reject missing/unsafe metadata before creating a resume directory or lease.
  await OperationLedgerStore.load({ runRoot, runId: safeRunId }, dependencies);
  const lease = await acquireRunLease({ runRoot, runId: safeRunId, ttlMs: dependencies.ttlMs || 60_000 }, dependencies);
  if (!lease.acquired) return { runId: safeRunId, run_id: safeRunId, resume: true, status: "blocked", reason: lease.reason || "active_lease" };
  try {
    const fsApi = dependencies.fsApi || fs;
    const originalLockPath = path.join(path.dirname(runGroupPath(runRoot, safeRunId)), "run.lock");
    try {
      const originalLock = await readBoundedJson(path.dirname(runGroupPath(runRoot, safeRunId)), originalLockPath, { maxBytes: 8192 });
      if (originalLock && (!Number.isInteger(originalLock.pid) || originalLock.pid < 1)) throw new Error('RECOVERY_ORIGINAL_RUN_LOCK_INVALID');
      const processAlive = dependencies.processAlive || ((pid) => { try { process.kill(Number(pid), 0); return true; } catch (error) { return error?.code === "EPERM"; } });
      if (originalLock && Number(originalLock.pid) !== process.pid && processAlive(originalLock.pid)) throw new Error("RECOVERY_ORIGINAL_RUN_ACTIVE");
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
    const artifactBytes = await readBoundedBytes(path.dirname(runGroupPath(runRoot, safeRunId)), store.ledger.artifact.path, { maxBytes: 16 * 1048576 });
    if (!artifactBytes) throw new Error('RECOVERY_ARTIFACT_MISSING');
    const actualArtifactHash = createHash('sha256').update(artifactBytes).digest('hex');
    if (actualArtifactHash !== store.ledger.artifact.hash) throw new Error("RECOVERY_ARTIFACT_HASH_MISMATCH");
    if (store.ledger.inputHash !== actualArtifactHash) throw new Error("RECOVERY_INPUT_ARTIFACT_HASH_MISMATCH");
    let artifact = JSON.parse(artifactBytes.toString('utf8'));
    const publish = async () => {
      if (!onBusinessVerified) return null;
      try { return await onBusinessVerified({ store }); }
      catch { return { status: 'pending', reason: 'research_publication_failed' }; }
    };
    let researchFeedback = await publish();
    const notificationRecovery = await resumeCompletedBusinessNotification({ store, ...notification, fsApi });
    if (notificationRecovery) {
      if (notificationRecovery.status === "completed") await finishRunGroup({ manifestPath: runGroupPath(runRoot, safeRunId), status: "completed", notificationRecovered: true, finishedAt: new Date().toISOString(), fsApi });
      return { runId: safeRunId, run_id: safeRunId, resume: true, ...notificationRecovery, ...(researchFeedback ? { researchFeedback } : {}) };
    }
    if (typeof beforeReconcile === "function") {
      const prepared = await beforeReconcile({ store, artifact, context });
      if (prepared?.artifact) artifact = prepared.artifact;
    }
    const reconcilers = await buildReconcilers({ store, artifact, context });
    const recovery = await reconcileOperationLedger({ store, reconcilers, context: { ...context, artifact } });
    researchFeedback = await publish();
    if (recovery.status === "completed") {
      await finishRunGroup({ manifestPath: runGroupPath(runRoot, safeRunId), status: "completed", finishedAt: new Date().toISOString() });
    }
    return { runId: safeRunId, run_id: safeRunId, resume: true, status: recovery.status, outcomes: recovery.outcomes, ...(researchFeedback ? { researchFeedback } : {}) };
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
