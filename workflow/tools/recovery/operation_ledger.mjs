import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertRestoreWritable } from './restore_transaction_status.mjs';
import { readBoundedJson } from '../lib/atomic_json.mjs';

import { canonicalQueryHash, writeAtomicJson } from "../stage1/source_state.mjs";

export const OPERATION_LEDGER_SCHEMA_VERSION = 1;
export const RUN_LEASE_SCHEMA_VERSION = 1;
export const OPERATION_STATES = new Set(["pending", "started", "remote_observed", "verified", "failed", "conflict"]);

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SECRET_KEY = /(^key$|api[-_]?key|token|password|secret|smtp|authorization|credential)/i;
const TRANSITIONS = Object.freeze({
  pending: new Set(["started", "failed", "conflict"]),
  started: new Set(["remote_observed", "verified", "failed", "conflict"]),
  remote_observed: new Set(["verified", "failed", "conflict"]),
  verified: new Set(),
  failed: new Set(["started", "remote_observed", "conflict"]),
  conflict: new Set(),
});

function iso(now = new Date()) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function safeValue(value) {
  if (Array.isArray(value)) return value.map(safeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, item]) => [key, safeValue(item)]));
  }
  return typeof value === "string" ? value.slice(0, 4000) : value;
}

export function validateRecoveryRunId(runId) {
  const value = String(runId || "").trim();
  if (!RUN_ID_RE.test(value)) throw new Error("RECOVERY_RUN_ID_INVALID");
  return value;
}

export function resolveRunStatePath(runRoot, runId, fileName = "operation_ledger.json") {
  const safeRunId = validateRecoveryRunId(runId);
  const root = path.resolve(runRoot);
  const candidate = path.resolve(root, safeRunId, fileName);
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("RECOVERY_PATH_OUTSIDE_RUN_ROOT");
  return candidate;
}

export async function hashFile(filePath, { fsApi = fs } = {}) {
  const data = await fsApi.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export function operationIdempotencyKey({ runId, type, identity = "run", targetId, inputHash }) {
  return canonicalQueryHash({
    runId: validateRecoveryRunId(runId),
    operationType: String(type || ""),
    identity: String(identity || "run"),
    targetId: String(targetId || ""),
    canonicalInputHash: String(inputHash || ""),
  });
}

function assertHash(value, code, { allowPending = false } = {}) {
  if (allowPending && value === "pending") return;
  if (!/^[a-f0-9]{64}$/.test(String(value || ""))) throw new Error(code);
}

export function validateOperationLedger(value, { expectedRunId = "" } = {}) {
  if (!value || value.schemaVersion !== OPERATION_LEDGER_SCHEMA_VERSION) throw new Error(`OPERATION_LEDGER_SCHEMA_UNSUPPORTED_${value?.schemaVersion ?? "missing"}`);
  const runId = validateRecoveryRunId(value.runId);
  if (expectedRunId && runId !== validateRecoveryRunId(expectedRunId)) throw new Error("OPERATION_LEDGER_RUN_ID_MISMATCH");
  if (!new Set(["desktop", "web", "local"]).has(value.mode)) throw new Error("OPERATION_LEDGER_MODE_INVALID");
  if (!new Set(["standard", "complete", "radar"]).has(value.profile)) throw new Error("OPERATION_LEDGER_PROFILE_INVALID");
  assertHash(value.configHash, "OPERATION_LEDGER_CONFIG_HASH_INVALID");
  assertHash(value.inputHash, "OPERATION_LEDGER_INPUT_HASH_INVALID");
  if (!value.artifact || typeof value.artifact.path !== "string") throw new Error("OPERATION_LEDGER_ARTIFACT_INVALID");
  assertHash(value.artifact.hash, "OPERATION_LEDGER_ARTIFACT_HASH_INVALID", { allowPending: true });
  if (!Array.isArray(value.identities) || !Array.isArray(value.operations)) throw new Error("OPERATION_LEDGER_CONTENT_INVALID");
  const keys = new Set();
  for (const operation of value.operations) {
    if (!OPERATION_STATES.has(operation?.status)) throw new Error("OPERATION_LEDGER_OPERATION_STATE_INVALID");
    if (operation.inputVersion === undefined || operation.inputVersion === null || operation.inputVersion === "") throw new Error("OPERATION_LEDGER_INPUT_VERSION_INVALID");
    if (!/^[a-f0-9]{64}$/.test(String(operation?.idempotencyKey || "")) || keys.has(operation.idempotencyKey)) throw new Error("OPERATION_LEDGER_IDEMPOTENCY_INVALID");
    keys.add(operation.idempotencyKey);
  }
  return value;
}

export function createOperationLedger({ runId, mode, profile, launcherId, configHash, inputHash, artifactPath, stages = [] }, { now = new Date() } = {}) {
  const createdAt = iso(now);
  return validateOperationLedger({
    schemaVersion: OPERATION_LEDGER_SCHEMA_VERSION,
    runId: validateRecoveryRunId(runId),
    mode,
    profile,
    launcherId: String(launcherId || "fixed-launcher/runner"),
    configHash,
    inputHash,
    artifact: { path: String(artifactPath || ""), hash: "pending", boundAt: null },
    createdAt,
    updatedAt: createdAt,
    status: "running",
    stages: Object.fromEntries(stages.map((name) => [name, { status: "pending", updatedAt: createdAt }])),
    identities: [],
    operations: [],
    leaseTakeovers: [],
  });
}

export class OperationLedgerStore {
  constructor(filePath, ledger, { fsApi = fs, atomicWriter = writeAtomicJson, clock = () => new Date() } = {}) {
    this.filePath = path.resolve(filePath);
    this.ledger = ledger;
    this.fsApi = fsApi;
    this.atomicWriter = atomicWriter;
    this.clock = clock;
    this.queue = Promise.resolve();
  }

  static async create({ runRoot, ...metadata }, dependencies = {}) {
    const fsApi = dependencies.fsApi || fs;
    const filePath = resolveRunStatePath(runRoot, metadata.runId);
    await fsApi.mkdir(path.dirname(filePath), { recursive: true });
    const createLock = `${filePath}.create.lock`;
    let handle;
    try {
      handle = await fsApi.open(createLock, "wx");
      try { await fsApi.access(filePath); throw new Error("OPERATION_LEDGER_ALREADY_EXISTS"); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      const ledger = createOperationLedger(metadata, { now: dependencies.clock?.() || new Date() });
      await (dependencies.atomicWriter || writeAtomicJson)(filePath, ledger, { fsApi });
      return new OperationLedgerStore(filePath, ledger, dependencies);
    } finally {
      if (handle) {
        await handle.close().catch(() => {});
        await fsApi.unlink(createLock).catch(() => {});
      }
    }
  }

  static async load({ runRoot, runId }, dependencies = {}) {
    const filePath = resolveRunStatePath(runRoot, runId);
    const value = await readBoundedJson(path.resolve(runRoot), filePath);
    if (!value) throw Object.assign(new Error('OPERATION_LEDGER_MISSING'), { code: 'ENOENT' });
    validateOperationLedger(value, { expectedRunId: runId });
    return new OperationLedgerStore(filePath, value, dependencies);
  }

  async mutate(mutator) {
    const task = this.queue.then(async () => {
      const next = structuredClone(this.ledger);
      await mutator(next);
      next.updatedAt = iso(this.clock());
      validateOperationLedger(next, { expectedRunId: this.ledger.runId });
      await this.atomicWriter(this.filePath, next, { fsApi: this.fsApi });
      this.ledger = next;
      return next;
    });
    this.queue = task.catch(() => {});
    return task;
  }

  async bindArtifact({ artifactPath = this.ledger.artifact.path, identities = [] } = {}) {
    const artifactHash = await hashFile(artifactPath, { fsApi: this.fsApi });
    await this.mutate((next) => {
      next.artifact = { path: path.resolve(artifactPath), hash: artifactHash, boundAt: iso(this.clock()) };
      next.inputHash = artifactHash;
      next.identities = [...new Set(identities.map(String).filter(Boolean))].sort();
    });
    return artifactHash;
  }

  async setStage(name, status, evidence = null) {
    await this.mutate((next) => {
      next.stages[String(name)] = { status: String(status), updatedAt: iso(this.clock()), ...(evidence ? { evidence: safeValue(evidence) } : {}) };
    });
  }

  async setRunStatus(status, workflowStatus) {
    await this.mutate((next) => {
      next.status = String(status);
      if (workflowStatus !== undefined) next.workflowStatus = String(workflowStatus);
      next.operationCount = next.operations.length;
    });
  }

  async planOperation({ type, identity = "run", target, input, inputHash = "", inputVersion = null, scope = "identity", dependsOn = [], retryable = true, intent = null }) {
    const targetValue = safeValue(target || {});
    const targetId = String(targetValue.id || targetValue.path || targetValue.itemKey || "");
    const canonicalInputHash = inputHash || canonicalQueryHash(input ?? intent ?? {});
    const idempotencyKey = operationIdempotencyKey({ runId: this.ledger.runId, type, identity, targetId, inputHash: canonicalInputHash });
    let operation;
    await this.mutate((next) => {
      operation = next.operations.find((item) => item.idempotencyKey === idempotencyKey);
      if (operation) return;
      operation = {
        idempotencyKey,
        type: String(type),
        identity: String(identity || "run"),
        target: targetValue,
        inputHash: canonicalInputHash,
        inputVersion: inputVersion ?? "canonical-input-v1",
        scope: scope === "global" ? "global" : "identity",
        dependsOn: [...new Set(dependsOn.map(String).filter(Boolean))],
        retryable: retryable !== false,
        status: "pending",
        attempts: 0,
        intent: intent == null ? null : safeValue(intent),
        verification: null,
        lastError: null,
        createdAt: iso(this.clock()),
        updatedAt: iso(this.clock()),
      };
      next.operations.push(operation);
    });
    return structuredClone(operation);
  }

  async transition(idempotencyKey, status, { verification = null, error = null, target = null, intent = undefined } = {}) {
    let updated;
    await this.mutate((next) => {
      const operation = next.operations.find((item) => item.idempotencyKey === idempotencyKey);
      if (!operation) throw new Error("OPERATION_LEDGER_OPERATION_MISSING");
      if (operation.status !== status && !TRANSITIONS[operation.status]?.has(status)) throw new Error(`OPERATION_LEDGER_TRANSITION_INVALID_${operation.status}_TO_${status}`);
      if (status === "started" && operation.status !== "started") operation.attempts += 1;
      operation.status = status;
      operation.updatedAt = iso(this.clock());
      if (verification != null) operation.verification = safeValue(verification);
      if (error != null) operation.lastError = String(error).slice(0, 500);
      if (target) operation.target = { ...operation.target, ...safeValue(target) };
      if (intent !== undefined) operation.intent = intent == null ? null : safeValue(intent);
      updated = operation;
    });
    return structuredClone(updated);
  }

  async recordLeaseTakeover(previous) {
    await this.mutate((next) => {
      next.leaseTakeovers.push({ ownerId: previous.ownerId, createdAt: previous.createdAt, expiresAt: previous.expiresAt, takenOverAt: iso(this.clock()) });
    });
  }
}

function ownerAlive(lease, { hostname, processAlive }) {
  if (lease.hostname !== hostname) return false;
  if (typeof processAlive === "function") return Boolean(processAlive(lease.pid));
  try { process.kill(Number(lease.pid), 0); return true; }
  catch (error) { if (error?.code === 'ESRCH') return false; if (error?.code === 'EPERM') return true; throw new Error('LEASE_OWNER_UNCONFIRMED'); }
}

// Inspection never takes over a lease. Remote/unverifiable owners remain unknown.
export function inspectWorkflowLease(lease, { now = new Date(), hostname = os.hostname(), processAlive } = {}) {
  if (!lease) return 'absent';
  if (lease.schemaVersion !== RUN_LEASE_SCHEMA_VERSION || !Number.isInteger(lease.pid) || lease.pid < 1
    || !Number.isFinite(Date.parse(lease.expiresAt)) || !lease.ownerId) return 'unknown';
  try { validateRecoveryRunId(lease.runId); } catch { return 'unknown'; }
  if (lease.hostname !== hostname) return 'unknown';
  if (ownerAlive(lease, { hostname, processAlive })) return 'running';
  return Date.parse(lease.expiresAt) <= new Date(now).getTime() ? 'stale' : 'unknown';
}

async function writeNewLease(leasePath, lease, fsApi) {
  assertRestoreWritable(leasePath);
  const handle = await fsApi.open(leasePath, "wx");
  try {
    try { assertRestoreWritable(leasePath); }
    catch (error) { await handle.close(); await fsApi.unlink(leasePath); throw error; }
    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, "utf8");
    if (typeof handle.sync === "function") await handle.sync();
  } finally { await handle.close(); }
}

// A deterministic, non-overwriting archive elects one stale-lease reclaimer.
// Interrupted claims remain evidence; never remove an unknown takeover archive.
async function preserveStaleLease(leasePath, previous, fsApi) {
  const historyPath = `${leasePath}.takeover.${canonicalQueryHash(previous)}.json`;
  let handle;
  try { handle = await fsApi.open(leasePath, 'r'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await handle.stat();
    if (before.nlink !== 1) return null;
    const buffer = Buffer.alloc(8193), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (!before.isFile() || before.size > 8192 || bytesRead > 8192
      || JSON.stringify(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))) !== JSON.stringify(previous)) throw new Error('LEASE_IDENTITY_UNCONFIRMED');
    assertRestoreWritable(leasePath);
    try { await fsApi.link(leasePath, historyPath); }
    catch (error) { if (['EEXIST', 'ENOENT'].includes(error.code)) return null; throw new Error('LEASE_TAKEOVER_UNAVAILABLE'); }
    const archive = await fsApi.lstat(historyPath), current = await fsApi.lstat(leasePath);
    if (!archive.isFile() || !current.isFile() || archive.isSymbolicLink() || current.isSymbolicLink()
      || current.dev !== before.dev || current.ino !== before.ino || archive.dev !== before.dev || archive.ino !== before.ino
      || current.nlink !== 2 || archive.nlink !== 2) throw new Error('LEASE_IDENTITY_UNCONFIRMED');
    assertRestoreWritable(leasePath);
    await fsApi.unlink(leasePath);
    return historyPath;
  } finally { await handle.close(); }
}

export async function acquireRunLease({ runRoot, runId, ttlMs = 60_000, ownerId = randomUUID() }, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  const clock = dependencies.clock || (() => new Date());
  const hostname = dependencies.hostname || os.hostname();
  const processAlive = dependencies.processAlive;
  const leasePath = resolveRunStatePath(runRoot, runId, "resume.lease.json");
  assertRestoreWritable(leasePath);
  await fsApi.mkdir(path.dirname(leasePath), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = clock();
    const lease = {
      schemaVersion: RUN_LEASE_SCHEMA_VERSION,
      runId: validateRecoveryRunId(runId),
      ownerId,
      hostname,
      pid: process.pid,
      createdAt: iso(now),
      heartbeatAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + ttlMs)),
    };
    try {
      await writeNewLease(leasePath, lease, fsApi);
      return { acquired: true, leasePath, lease, takeover: null };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let previous;
    try { previous = await readBoundedJson(path.resolve(runRoot), leasePath, { maxBytes: 8192 }); if (!previous) continue; }
    catch {
      if (attempt < 4) { await new Promise((resolve) => setTimeout(resolve, 5)); continue; }
      throw new Error("RUN_LEASE_UNREADABLE");
    }
    if (previous.schemaVersion !== RUN_LEASE_SCHEMA_VERSION || previous.runId !== runId) throw new Error("RUN_LEASE_INVALID");
    if (inspectWorkflowLease(previous, { now, hostname, processAlive }) !== 'stale') return { acquired: false, reason: "active_lease", leasePath, lease: previous, takeover: null };
    const historyPath = await preserveStaleLease(leasePath, previous, fsApi);
    if (!historyPath) return { acquired: false, reason: 'lease_race', leasePath, lease: previous, takeover: null };
    try {
      await writeNewLease(leasePath, lease, fsApi);
      return { acquired: true, leasePath, lease, takeover: { previous, historyPath } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return { acquired: false, reason: "lease_race", leasePath, lease: null, takeover: null };
}

export async function releaseRunLease(lease, { fsApi = fs } = {}) {
  if (lease?.borrowed) return { released: false, reason: 'borrowed_parent' };
  if (!lease?.acquired) return { released: false, reason: "not_owner" };
  let current;
  try { current = JSON.parse(await fsApi.readFile(lease.leasePath, "utf8")); }
  catch (error) { return { released: false, reason: error?.code === "ENOENT" ? "already_released" : "unreadable" }; }
  if (current.ownerId !== lease.lease.ownerId) return { released: false, reason: "owner_changed" };
  await fsApi.unlink(lease.leasePath);
  return { released: true };
}

export async function acquireWorkflowLease({ runRoot, runId, profile, ttlMs = 60_000, ownerId = randomUUID(), allowTakeover = true, parentOwnerId = '' }, dependencies = {}) {
  const fsApi = dependencies.fsApi || fs;
  const clock = dependencies.clock || (() => new Date());
  const hostname = dependencies.hostname || os.hostname();
  const processAlive = dependencies.processAlive;
  const leasePath = path.join(path.resolve(runRoot), ".workflow.lease.json");
  assertRestoreWritable(leasePath);
  if (parentOwnerId) {
    const lease = await readBoundedJson(path.resolve(runRoot), leasePath, { maxBytes: 8192 });
    if (!lease || lease.ownerId !== parentOwnerId || lease.pid !== process.ppid || lease.runId !== runId || lease.profile !== profile
      || inspectWorkflowLease(lease, { now: clock(), hostname, processAlive }) !== 'running') return { acquired: false, reason: 'parent_lease_unconfirmed', leasePath };
    return { acquired: true, borrowed: true, leasePath, lease, takeover: null };
  }
  await fsApi.mkdir(path.dirname(leasePath), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = clock();
    const lease = {
      schemaVersion: RUN_LEASE_SCHEMA_VERSION,
      runId: validateRecoveryRunId(runId),
      profile: String(profile || "standard"),
      ownerId,
      hostname,
      pid: process.pid,
      createdAt: iso(now),
      heartbeatAt: iso(now),
      expiresAt: iso(new Date(now.getTime() + ttlMs)),
    };
    try {
      await writeNewLease(leasePath, lease, fsApi);
      return { acquired: true, leasePath, lease, takeover: null };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let previous;
    try { previous = await readBoundedJson(path.resolve(runRoot), leasePath, { maxBytes: 8192 }); if (!previous) continue; }
    catch {
      if (attempt < 4) { await new Promise((resolve) => setTimeout(resolve, 5)); continue; }
      throw new Error("WORKFLOW_LEASE_UNREADABLE");
    }
    if (!allowTakeover) return { acquired: false, reason: 'existing_workflow_lease', leasePath };
    if (previous.schemaVersion !== RUN_LEASE_SCHEMA_VERSION || !previous.runId) throw new Error("WORKFLOW_LEASE_INVALID");
    if (inspectWorkflowLease(previous, { now, hostname, processAlive }) !== 'stale') return { acquired: false, reason: "active_lease", leasePath, lease: previous, takeover: null };
    const historyPath = await preserveStaleLease(leasePath, previous, fsApi);
    if (!historyPath) return { acquired: false, reason: 'lease_race', leasePath, lease: previous, takeover: null };
    try {
      await writeNewLease(leasePath, lease, fsApi);
      return { acquired: true, leasePath, lease, takeover: { previous, historyPath } };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  return { acquired: false, reason: "lease_race", leasePath, lease: null, takeover: null };
}
