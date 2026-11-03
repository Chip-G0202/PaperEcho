import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { advanceHealthNotificationState, healthStatePath, MAX_HEALTH_NOTIFICATIONS_PER_RUN, processHealthNotifications } from "../tools/notification/health_notifier.mjs";
import { OperationLedgerStore } from "../tools/recovery/operation_ledger.mjs";
import { canonicalQueryHash } from "../tools/stage1/source_state.mjs";

async function rootFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-health-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, runRoot: path.join(root, "runs") };
}

async function createRun(runRoot, runId) {
  await OperationLedgerStore.create({ runRoot, runId, mode: "local", profile: "standard", launcherId: "local-fixed-launcher/runner", configHash: canonicalQueryHash({ config: 1 }), inputHash: canonicalQueryHash({ input: runId }), artifactPath: path.join(runRoot, runId, "input_artifact.json"), stages: [] });
}

const healthEnv = { PAPERECHO_CONFIG_SCHEMA_VERSION: "2", PAPERECHO_HEALTH_NOTIFIER_ENABLED: "true", PAPERECHO_HEALTH_DEGRADATION_THRESHOLD: "2", PAPERECHO_NOTIFICATION_RETRY_FAILED: "true" };
const source = { kind: "source_availability", healthKey: `source:weekly:rss:${"a".repeat(64)}:availability`, degraded: true, subject: { source: "rss", profile: "weekly" } };

for (const schemaVersion of ['2', '3', '4']) test(`schema ${schemaVersion} source degradation alerts on the second observation, once per epoch, and recovery once`, async (t) => {
  const ctx = await rootFixture(t);
  let sends = 0;
  const transport = async () => { sends += 1; return { accepted: true, acceptedCount: 1 }; };
  const observe = async (index, observation) => {
    const runId = `health-run-${index}`;
    await createRun(ctx.runRoot, runId);
    return processHealthNotifications({ runRoot: ctx.runRoot, runId, observations: [observation], recipient: "reader@example.test", env: { ...healthEnv, PAPERECHO_CONFIG_SCHEMA_VERSION: schemaVersion }, transport });
  };
  assert.equal((await observe(1, source)).events.length, 0);
  assert.equal((await observe(2, source)).events[0].status, "accepted");
  assert.equal((await observe(3, source)).events.length, 0);
  assert.equal((await observe(4, { ...source, degraded: false })).events[0].status, "accepted");
  assert.equal((await observe(5, { ...source, degraded: false })).events.length, 0);
  assert.equal((await observe(6, source)).events.length, 0);
  assert.equal((await observe(7, source)).events[0].status, "accepted");
  assert.equal(sends, 3);
});

test("LLM follows the same threshold while availability, yield, and LLM keys stay independent", () => {
  const base = { schemaVersion: 1, healthKey: "llm:stage1", kind: "llm", status: "healthy", consecutiveDegraded: 0, epoch: 0, degradationNotified: false, pendingEvent: null, createdAt: null, updatedAt: null };
  const llm = { kind: "llm", healthKey: "llm:stage1", degraded: true, subject: { label: "stage1_llm" } };
  const first = advanceHealthNotificationState(base, llm);
  const second = advanceHealthNotificationState(first, llm);
  assert.equal(first.pendingEvent, null);
  assert.equal(second.pendingEvent.type, "degradation");
  assert.notEqual(source.healthKey, llm.healthKey);
  assert.notEqual(source.healthKey.replace(/availability$/, "yield"), llm.healthKey);
});

test("unknown health receipt is held without automatic resend", async (t) => {
  const ctx = await rootFixture(t);
  let calls = 0;
  const run = async (index) => {
    const runId = `unknown-health-${index}`;
    await createRun(ctx.runRoot, runId);
    return processHealthNotifications({ runRoot: ctx.runRoot, runId, observations: [source], recipient: "reader@example.test", env: healthEnv, transport: async () => { calls += 1; throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } });
  };
  await run(1);
  const second = await run(2);
  const third = await run(3);
  assert.equal(second.events[0].status, "unknown");
  assert.equal(third.events.length, 0);
  assert.equal(calls, 1);
});

test("one run has a tested maximum of five health notification sends", async (t) => {
  const ctx = await rootFixture(t);
  const observations = Array.from({ length: 7 }, (_, index) => ({ ...source, healthKey: `${source.healthKey}:${index}`, subject: { source: `rss-${index}` } }));
  await createRun(ctx.runRoot, "bounded-health-1");
  await processHealthNotifications({ runRoot: ctx.runRoot, runId: "bounded-health-1", observations, recipient: "reader@example.test", env: healthEnv, transport: async () => ({ accepted: true, acceptedCount: 1 }) });
  await createRun(ctx.runRoot, "bounded-health-2");
  let sends = 0;
  const result = await processHealthNotifications({ runRoot: ctx.runRoot, runId: "bounded-health-2", observations, recipient: "reader@example.test", env: healthEnv, transport: async () => { sends += 1; return { accepted: true, acceptedCount: 1 }; } });
  assert.equal(MAX_HEALTH_NOTIFICATIONS_PER_RUN, 5);
  assert.equal(result.maxNotifications, 5);
  assert.equal(sends, 5);
  assert.equal(result.events.filter((event) => event.status === "bounded").length, 2);
});

test("unknown health state schema is rejected without notification", async (t) => {
  const ctx = await rootFixture(t);
  const healthRoot = path.join(ctx.root, "health");
  const statePath = healthStatePath(healthRoot, source.healthKey);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, '{"schemaVersion":999}\n');
  await createRun(ctx.runRoot, "unknown-health-schema");
  let sends = 0;
  await assert.rejects(processHealthNotifications({ runRoot: ctx.runRoot, runId: "unknown-health-schema", observations: [source], recipient: "reader@example.test", env: { ...healthEnv, PAPERECHO_NOTIFICATION_HEALTH_ROOT: healthRoot }, transport: async () => { sends += 1; } }), /HEALTH_NOTIFICATION_SCHEMA_UNSUPPORTED_999/);
  assert.equal(sends, 0);
  assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).schemaVersion, 999);
});
