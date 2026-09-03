import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireRunLease,
  acquireWorkflowLease,
  createOperationLedger,
  OperationLedgerStore,
  operationIdempotencyKey,
  releaseRunLease,
  resolveRunStatePath,
  validateOperationLedger,
  validateRecoveryRunId,
} from "../tools/recovery/operation_ledger.mjs";
import { canonicalQueryHash } from "../tools/stage1/source_state.mjs";

const HASH = canonicalQueryHash({ stable: true });

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-ledger-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeStore(t, overrides = {}) {
  const runRoot = await sandbox(t);
  const artifactPath = path.join(runRoot, "artifact.json");
  await fs.writeFile(artifactPath, "[]\n");
  const store = await OperationLedgerStore.create({
    runRoot,
    runId: "zlf-run-1",
    mode: "desktop",
    profile: "standard",
    launcherId: "desktop-fixed-launcher/runner",
    configHash: HASH,
    inputHash: HASH,
    artifactPath,
    stages: ["stage1", "stage2"],
    ...overrides,
  });
  return { runRoot, artifactPath, store };
}

test("ledger is atomically created before operations and binds immutable artifact facts", async (t) => {
  const { artifactPath, store } = await makeStore(t);
  assert.equal(store.ledger.operations.length, 0);
  assert.equal(store.ledger.artifact.hash, "pending");
  await store.bindArtifact({ artifactPath, identities: ["doi:10.1/test", "doi:10.1/test"] });
  assert.match(store.ledger.artifact.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(store.ledger.identities, ["doi:10.1/test"]);
  assert.equal(JSON.parse(await fs.readFile(store.filePath, "utf8")).schemaVersion, 1);
});

test("ledger creation failure prevents callers from reaching a side effect", async (t) => {
  const runRoot = await sandbox(t);
  let sideEffects = 0;
  const failingWriter = async () => { throw new Error("atomic_write_failed"); };
  await assert.rejects(async () => {
    await OperationLedgerStore.create({ runRoot, runId: "run-fail", mode: "local", profile: "standard", configHash: HASH, inputHash: HASH, artifactPath: "pending" }, { atomicWriter: failingWriter });
    sideEffects += 1;
  }, /atomic_write_failed/);
  assert.equal(sideEffects, 0);
});

test("idempotency keys are stable, input-sensitive, and secret fields are absent", async (t) => {
  const { store } = await makeStore(t);
  const a = await store.planOperation({ type: "metadata", identity: "doi:x", target: { itemKey: "I1" }, input: { shortTitle: "A", token: "do-not-store" }, intent: { fields: { shortTitle: "A" }, SMTP_PASS: "do-not-store" } });
  const b = await store.planOperation({ type: "metadata", identity: "doi:x", target: { itemKey: "I1" }, input: { token: "changed", shortTitle: "A" } });
  const c = await store.planOperation({ type: "metadata", identity: "doi:x", target: { itemKey: "I1" }, input: { shortTitle: "B" } });
  assert.equal(a.idempotencyKey, b.idempotencyKey);
  assert.notEqual(a.idempotencyKey, c.idempotencyKey);
  assert.equal(JSON.stringify(store.ledger).includes("do-not-store"), false);
  assert.equal(operationIdempotencyKey({ runId: "run-1", type: "x", identity: "i", targetId: "t", inputHash: HASH }), operationIdempotencyKey({ runId: "run-1", type: "x", identity: "i", targetId: "t", inputHash: HASH }));
});

test("runId traversal and unknown schemas fail closed without overwriting", async (t) => {
  const runRoot = await sandbox(t);
  for (const value of ["../escape", "..", "a/b", "a\\b", ""]) assert.throws(() => validateRecoveryRunId(value), /RUN_ID_INVALID/);
  assert.throws(() => resolveRunStatePath(runRoot, "../escape"), /RUN_ID_INVALID/);
  const filePath = resolveRunStatePath(runRoot, "run-schema");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ schemaVersion: 99, runId: "run-schema" }));
  const before = await fs.readFile(filePath, "utf8");
  await assert.rejects(() => OperationLedgerStore.load({ runRoot, runId: "run-schema" }), /SCHEMA_UNSUPPORTED/);
  assert.equal(await fs.readFile(filePath, "utf8"), before);
});

test("active lease admits one owner and expired unavailable owner is preserved on takeover", async (t) => {
  const runRoot = await sandbox(t);
  let now = new Date("2030-01-01T00:00:00.000Z");
  const deps = { clock: () => now, hostname: "test-host", processAlive: () => false };
  const first = await acquireRunLease({ runRoot, runId: "run-lease", ttlMs: 1_000, ownerId: "owner-a" }, deps);
  const second = await acquireRunLease({ runRoot, runId: "run-lease", ttlMs: 1_000, ownerId: "owner-b" }, deps);
  assert.equal(first.acquired, true);
  assert.deepEqual({ acquired: second.acquired, reason: second.reason }, { acquired: false, reason: "active_lease" });
  now = new Date("2030-01-01T00:00:02.000Z");
  const takeover = await acquireRunLease({ runRoot, runId: "run-lease", ttlMs: 1_000, ownerId: "owner-c" }, deps);
  assert.equal(takeover.acquired, true);
  assert.equal(takeover.takeover.previous.ownerId, "owner-a");
  assert.equal((await fs.stat(takeover.takeover.historyPath)).isFile(), true);
  assert.deepEqual(await releaseRunLease(first), { released: false, reason: "owner_changed" });
  assert.deepEqual(await releaseRunLease(takeover), { released: true });
});

test("an expired lease is not taken over while its same-host process is alive", async (t) => {
  const runRoot = await sandbox(t);
  let now = new Date("2030-01-01T00:00:00.000Z");
  const first = await acquireRunLease({ runRoot, runId: "run-live", ttlMs: 1, ownerId: "owner-a" }, { clock: () => now, hostname: "host", processAlive: () => false });
  assert.equal(first.acquired, true);
  now = new Date("2030-01-01T00:00:10.000Z");
  const blocked = await acquireRunLease({ runRoot, runId: "run-live", ttlMs: 1, ownerId: "owner-b" }, { clock: () => now, hostname: "host", processAlive: () => true });
  assert.equal(blocked.acquired, false);
  assert.equal(blocked.reason, "active_lease");
  await releaseRunLease(first);
});

test("two simultaneous resume attempts admit exactly one lease owner", async (t) => {
  const runRoot = await sandbox(t);
  const attempts = await Promise.all([
    acquireRunLease({ runRoot, runId: "run-concurrent", ownerId: "owner-a" }, { hostname: "host", processAlive: () => false }),
    acquireRunLease({ runRoot, runId: "run-concurrent", ownerId: "owner-b" }, { hostname: "host", processAlive: () => false }),
  ]);
  assert.equal(attempts.filter((item) => item.acquired).length, 1);
  assert.equal(attempts.filter((item) => !item.acquired && item.reason === "active_lease").length, 1);
  await releaseRunLease(attempts.find((item) => item.acquired));
});

test("one workflow lease serializes Radar, Weekly, manual, and resume run identities", async (t) => {
  const runRoot = await sandbox(t);
  const attempts = await Promise.all([
    acquireWorkflowLease({ runRoot, runId: "radar-run", profile: "radar", ownerId: "radar-owner" }, { hostname: "host", processAlive: () => false }),
    acquireWorkflowLease({ runRoot, runId: "weekly-run", profile: "standard", ownerId: "weekly-owner" }, { hostname: "host", processAlive: () => false }),
  ]);
  assert.equal(attempts.filter((item) => item.acquired).length, 1);
  const blocked = attempts.find((item) => !item.acquired);
  assert.equal(blocked.reason, "active_lease");
  assert.equal(blocked.leasePath, attempts.find((item) => item.acquired).leasePath);
  await releaseRunLease(attempts.find((item) => item.acquired));
});

test("ledger validator rejects malformed operation states", () => {
  const ledger = createOperationLedger({ runId: "run-valid", mode: "web", profile: "complete", launcherId: "web", configHash: HASH, inputHash: HASH, artifactPath: "artifact.json" });
  ledger.operations.push({ idempotencyKey: HASH, status: "unknown" });
  assert.throws(() => validateOperationLedger(ledger), /OPERATION_STATE_INVALID/);
});

test("verified operation rejects every backward transition", async (t) => {
  const { store } = await makeStore(t);
  const operation = await store.planOperation({ type: "zotero_collection_add", identity: "doi:x", target: { itemKey: "I1", collectionId: "C1" }, input: {} });
  await store.transition(operation.idempotencyKey, "started");
  await store.transition(operation.idempotencyKey, "verified");
  for (const status of ["pending", "started", "remote_observed", "failed", "conflict"]) {
    await assert.rejects(() => store.transition(operation.idempotencyKey, status), new RegExp(`verified_TO_${status}`, "i"));
  }
  assert.equal(store.ledger.operations[0].status, "verified");
});
