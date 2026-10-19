import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from 'node:url';

import { notifyRunFailure } from "../tools/notification/failure_notifier.mjs";
import { OperationLedgerStore } from "../tools/recovery/operation_ledger.mjs";
import { canonicalQueryHash, writeAtomicJson } from "../tools/stage1/source_state.mjs";
import { main as executeRunner } from "../tools/runner/main.mjs";
const runnerMain = (argv, dependencies = {}) => executeRunner(argv, { runtimeLog: { write: async () => ({ ok: true }) }, ...dependencies });

function sink() { let value = ""; return { write(chunk) { value += String(chunk); }, text() { return value; } }; }

async function ledgerFixture(t, { bound = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-failure-notifier-"));
  const runRoot = path.join(root, "runs");
  const runId = "run-failure-1";
  const artifactPath = path.join(runRoot, runId, "input_artifact.json");
  const store = await OperationLedgerStore.create({ runRoot, runId, mode: "local", profile: "standard", launcherId: "local-fixed-launcher/runner", configHash: canonicalQueryHash({ config: 1 }), inputHash: canonicalQueryHash({ input: 1 }), artifactPath, stages: ["stage1"] });
  if (bound) {
    await writeAtomicJson(artifactPath, { schemaVersion: 1, items: [] });
    await store.bindArtifact({ artifactPath, identities: [] });
  }
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runRoot, runId, store };
}

const env = { PAPERECHO_CONFIG_SCHEMA_VERSION: "2", PAPERECHO_FAILURE_NOTIFIER_ENABLED: "true", PAPERECHO_NOTIFICATION_RETRY_FAILED: "true" };

test("failure notifier is independent, sanitized, recoverable, and idempotent", async (t) => {
  const ctx = await ledgerFixture(t);
  const messages = [];
  const input = { runRoot: ctx.runRoot, runId: ctx.runId, failureStage: "stage2", errorCategory: "failed_stage2_writeback", recipient: "reader@example.test", env, transport: async (message) => { messages.push(message); return { accepted: true, acceptedCount: 1 }; } };
  const first = await notifyRunFailure(input);
  const second = await notifyRunFailure(input);
  assert.equal(first.status, "accepted");
  assert.equal(second.reason, "already_accepted");
  assert.equal(first.recoverable, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /--resume run-failure-1/);
  assert.doesNotMatch(messages[0].text, /[A-Z]:\\|\.mjs:\d+|secret/i);
  assert.equal(JSON.stringify(first.receipt).includes("reader@example.test"), false);
  const ledger = await OperationLedgerStore.load({ runRoot: ctx.runRoot, runId: ctx.runId });
  assert.equal(ledger.ledger.operations.find((operation) => operation.type === "notification").status, "verified");
});

test("unbound artifact is reported as not safely recoverable", async (t) => {
  const ctx = await ledgerFixture(t, { bound: false });
  let message;
  const result = await notifyRunFailure({ runRoot: ctx.runRoot, runId: ctx.runId, failureStage: "stage1", errorCategory: "artifact_write_failed", recipient: "reader@example.test", env, transport: async (value) => { message = value; return { accepted: true, acceptedCount: 1 }; } });
  assert.equal(result.recoverable, false);
  assert.match(message.text, /不可安全 resume/);
});

test("missing SMTP configuration disables notifier without creating a receipt", async (t) => {
  const ctx = await ledgerFixture(t);
  const result = await notifyRunFailure({ runRoot: ctx.runRoot, runId: ctx.runId, failureStage: "stage1", recipient: "reader@example.test", env });
  assert.equal(result.reason, "smtp_configuration_incomplete");
  assert.equal((await fs.readdir(path.dirname(ctx.runRoot))).includes("notification_receipts"), false);
});

async function runnerRoot(t) {
  const base = fileURLToPath(new URL('../../tests/runs/phase10/', import.meta.url)); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'notifier-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, 'runs');
}
function runnerDependencies({ runRoot, schema = 2, status = "failed_stage1", notifier }) {
  assert.ok(path.isAbsolute(runRoot));
  return {
    resolveRunnerConfigurationImpl: async () => ({ options: { action: "run", mode: "local", profile: "standard", email: "reader@example.test" }, env: { PAPERECHO_CONFIG_SCHEMA_VERSION: String(schema), PAPERECHO_FAILURE_NOTIFIER_ENABLED: "true" } }),
    runPreflightImpl: async () => ({ status: "ready", mode: "local", profile: "standard", requiredMissing: [], canRun: true }),
    buildExecutionPlanImpl: () => ({ entry: "local", args: [], childEnv: {}, cwd: ".", runRoot, runId: "run-stage-failure", mode: "local" }),
    runProductionImpl: async () => ({ code: 1, signal: null, stdout: JSON.stringify({ run_id: "run-stage-failure", status }), stderr: "" }),
    validateProductionResultImpl: async () => ({ ok: false, exitCode: 5 }),
    notifyRunFailureImpl: notifier,
    stdout: sink(), stderr: sink(),
  };
}

test("Runner routes Stage1-4 failures without depending on Stage5", async t => {
  const runRoot = await runnerRoot(t);
  const observed = [];
  for (const stage of ["stage1", "stage2", "stage3", "stage4"]) {
    const code = await runnerMain(["--run"], runnerDependencies({ runRoot, status: `failed_${stage}`, notifier: async (input) => { observed.push(input.failureStage); return { status: "accepted", attempted: true }; } }));
    assert.equal(code, 5);
  }
  assert.deepEqual(observed, ["stage1", "stage2", "stage3", "stage4"]);
});

test("notifier failure never replaces the original Runner failure and v1 never invokes it", async t => {
  const runRoot = await runnerRoot(t);
  let calls = 0;
  const broken = async () => { calls += 1; throw new Error("notifier failed"); };
  assert.equal(await runnerMain(["--run"], runnerDependencies({ runRoot, notifier: broken })), 5);
  assert.equal(await runnerMain(["--run"], runnerDependencies({ runRoot, schema: 1, notifier: broken })), 5);
  assert.equal(calls, 1);
});

test("Runner processes bounded health observations only for successful schema v2 runs", async t => {
  const runRoot = await runnerRoot(t);
  const observations = [{ kind: "llm", healthKey: "llm:stage1", degraded: true }];
  let captured;
  const dependencies = {
    resolveRunnerConfigurationImpl: async () => ({ options: { action: "run", mode: "local", profile: "standard", email: "reader@example.test" }, env: { PAPERECHO_CONFIG_SCHEMA_VERSION: "2", PAPERECHO_HEALTH_NOTIFIER_ENABLED: "true" } }),
    runPreflightImpl: async () => ({ status: "ready", mode: "local", profile: "standard", requiredMissing: [], canRun: true }),
    buildExecutionPlanImpl: () => ({ entry: "local", args: [], childEnv: {}, cwd: ".", runRoot, runId: "health-success", mode: "local" }),
    runProductionImpl: async () => ({ code: 0, signal: null, stdout: JSON.stringify({ run_id: "health-success", notification_health_observations: observations }), stderr: "" }),
    processHealthNotificationsImpl: async (input) => { captured = input; return { status: "processed", events: [], maxNotifications: 5 }; },
    validateProductionResultImpl: async () => ({ ok: true, exitCode: 0 }),
    stdout: sink(), stderr: sink(),
  };
  assert.equal(await runnerMain(["--run"], dependencies), 0);
  assert.deepEqual(captured.observations, observations);
  assert.equal(captured.runId, "health-success");
});
