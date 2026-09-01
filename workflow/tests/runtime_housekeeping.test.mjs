import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  finishRunGroup,
  planRetentionCleanup,
  releaseMonthlyAggregation,
  resolveHousekeepingConfig,
  runRetentionCleanup,
  startRunGroup,
} from "../tools/lib/runtime_housekeeping.mjs";

async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-retention-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runtimeRoot = path.join(root, "runtime");
  const runRoot = path.join(runtimeRoot, "runs");
  const dataRoot = path.join(runtimeRoot, "data");
  await Promise.all([fs.mkdir(runRoot, { recursive: true }), fs.mkdir(dataRoot, { recursive: true })]);
  return { root, runtimeRoot, runRoot, dataRoot };
}

async function completedRun(ctx, runId, finishedAt, { artifact = runId, monthly = false, contents = "x" } = {}) {
  const target = path.join(ctx.dataRoot, artifact);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "artifact.json"), contents);
  const group = await startRunGroup({
    runRoot: ctx.runRoot, runId, pipelineMode: "local", startedAt: finishedAt,
    artifacts: [
      { kind: "run_state", rootKey: "runs", path: runId, retention: "30d" },
      { kind: "pipeline", rootKey: "data", path: artifact, retention: "30d" },
    ],
    references: { monthlyAggregationPending: monthly },
  });
  await finishRunGroup({ manifestPath: group.manifestPath, status: "completed", finishedAt, monthlyAggregationPending: monthly });
  return { ...group, target };
}

function planOptions(ctx, overrides = {}) {
  return {
    runtimeRoot: ctx.runtimeRoot,
    runRoot: ctx.runRoot,
    allowedRoots: { data: ctx.dataRoot },
    retentionDays: 30,
    now: new Date("2030-02-01T00:00:00.000Z"),
    processAlive: () => false,
    ...overrides,
  };
}

test("cleanup config has a 30-day default and zero disables cleanup", () => {
  assert.deepEqual(resolveHousekeepingConfig({}), { valid: true, enabled: true, retentionDays: 30, warnings: [] });
  assert.equal(resolveHousekeepingConfig({ PAPERFLOW_RETENTION_DAYS: "0" }).retentionDays, 0);
  assert.equal(resolveHousekeepingConfig({ PAPERFLOW_RETENTION_DAYS: "thirty" }).valid, false);
});

test("run-group manifest is atomic, relative, completed, and unlocks the run", async (t) => {
  const ctx = await sandbox(t);
  const group = await startRunGroup({
    runRoot: ctx.runRoot, runId: "run-a", pipelineMode: "local", startedAt: "2030-01-01T00:00:00.000Z",
    artifacts: [{ kind: "pipeline", rootKey: "data", path: "run-a", retention: "30d" }],
  });
  await finishRunGroup({ manifestPath: group.manifestPath, status: "completed", finishedAt: "2030-01-01T01:00:00.000Z" });
  const manifest = JSON.parse(await fs.readFile(group.manifestPath, "utf8"));
  assert.equal(manifest.status, "completed");
  assert.equal(path.isAbsolute(manifest.artifacts[0].path), false);
  await assert.rejects(fs.stat(group.lockPath), { code: "ENOENT" });
  assert.deepEqual((await fs.readdir(path.dirname(group.manifestPath))).filter((name) => name.endsWith(".tmp")), []);
});

test("retention is strict: exactly 30 days stays, older completes as one run group", async (t) => {
  const ctx = await sandbox(t);
  await completedRun(ctx, "exact", "2030-01-02T00:00:00.000Z");
  await completedRun(ctx, "old", "2030-01-01T23:59:59.000Z");
  const plan = await planRetentionCleanup(planOptions(ctx));
  assert.equal(plan.safe, true);
  assert.deepEqual(plan.candidates.map((item) => item.runId), ["old"]);
});

test("current, running, active-lock, monthly-pinned, and protected-file runs are retained", async (t) => {
  const ctx = await sandbox(t);
  await completedRun(ctx, "current", "2029-01-01T00:00:00.000Z");
  await completedRun(ctx, "monthly", "2029-01-01T00:00:00.000Z", { monthly: true });
  await completedRun(ctx, "protected", "2029-01-01T00:00:00.000Z");
  await fs.writeFile(path.join(ctx.dataRoot, "protected", "screening_standards.docx"), "keep");
  await startRunGroup({
    runRoot: ctx.runRoot, runId: "running", pipelineMode: "local", startedAt: "2029-01-01T00:00:00.000Z",
    artifacts: [{ kind: "pipeline", rootKey: "data", path: "running", retention: "30d" }],
  });
  await fs.mkdir(path.join(ctx.dataRoot, "running"));
  const plan = await planRetentionCleanup(planOptions(ctx, { currentRunId: "current", processAlive: () => true }));
  assert.equal(plan.candidates.length, 0);
  assert.ok(plan.skippedProtected >= 4);
});

test("a protected run sharing an artifact pins the complete artifact group", async (t) => {
  const ctx = await sandbox(t);
  await completedRun(ctx, "old", "2029-01-01T00:00:00.000Z", { artifact: "shared" });
  await completedRun(ctx, "new", "2030-01-31T00:00:00.000Z", { artifact: "shared" });
  const plan = await planRetentionCleanup(planOptions(ctx));
  assert.equal(plan.candidates.length, 0);
  assert.ok(plan.warnings.includes("RUN_ARTIFACT_SHARED_WITH_PROTECTED_RUN"));
});

test("path escape and dangerous roots fail closed", async (t) => {
  const ctx = await sandbox(t);
  const old = await completedRun(ctx, "escape", "2029-01-01T00:00:00.000Z");
  const manifest = JSON.parse(await fs.readFile(old.manifestPath, "utf8"));
  manifest.artifacts[0].path = `..${path.sep}outside`;
  await fs.writeFile(old.manifestPath, JSON.stringify(manifest));
  const escaped = await planRetentionCleanup(planOptions(ctx));
  assert.equal(escaped.candidates.length, 0);
  assert.ok(escaped.warnings.includes("HOUSEKEEPING_PATH_OUTSIDE_ROOT"));
  const dangerous = await planRetentionCleanup(planOptions(ctx, { runtimeRoot: path.parse(ctx.root).root }));
  assert.equal(dangerous.safe, false);
  assert.ok(dangerous.warnings.includes("HOUSEKEEPING_DANGEROUS_ROOT"));
});

test("monthly aggregation pins can be released by month", async (t) => {
  const ctx = await sandbox(t);
  const jan = await completedRun(ctx, "jan", "2030-01-01T00:00:00.000Z", { monthly: true });
  await completedRun(ctx, "feb", "2030-02-01T00:00:00.000Z", { monthly: true });
  assert.equal((await releaseMonthlyAggregation({ runRoot: ctx.runRoot, monthPrefix: "2030-01" })).updated, 1);
  const manifest = JSON.parse(await fs.readFile(jan.manifestPath, "utf8"));
  assert.equal(manifest.references.monthlyAggregationPending, false);
});

test("dry-run records candidates without deletion; apply deletes only eligible groups", async (t) => {
  const ctx = await sandbox(t);
  const old = await completedRun(ctx, "old", "2029-01-01T00:00:00.000Z");
  const base = { ...planOptions(ctx), force: true, config: { valid: true, enabled: true, retentionDays: 30, warnings: [] } };
  const dry = await runRetentionCleanup({ ...base, dryRun: true });
  assert.equal(dry.eligibleRuns, 1);
  assert.equal(dry.deletedRuns, 0);
  assert.equal((await fs.stat(old.target)).isDirectory(), true);
  const applied = await runRetentionCleanup({ ...base, dryRun: false, now: new Date("2030-02-01T00:00:01.000Z") });
  assert.equal(applied.deletedRuns, 1);
  await assert.rejects(fs.stat(old.target), { code: "ENOENT" });
  const receipt = JSON.parse(await fs.readFile(path.join(ctx.runtimeRoot, "housekeeping", "last_cleanup.json"), "utf8"));
  assert.equal(receipt.deletedRuns, 1);
});

test("full retention scans run at most once per 24 hours unless forced", async (t) => {
  const ctx = await sandbox(t);
  const base = { ...planOptions(ctx), dryRun: true, config: { valid: true, enabled: true, retentionDays: 30, warnings: [] } };
  await runRetentionCleanup({ ...base, force: true });
  const second = await runRetentionCleanup({ ...base, now: new Date("2030-02-01T01:00:00.000Z") });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "scan_interval_not_reached");
  const forced = await runRetentionCleanup({ ...base, force: true, now: new Date("2030-02-01T01:00:01.000Z") });
  assert.equal(forced.skipped, undefined);
});

test("active completed locks are protected while stale dead locks are eligible", async (t) => {
  const ctx = await sandbox(t);
  const active = await completedRun(ctx, "active", "2029-01-01T00:00:00.000Z");
  const stale = await completedRun(ctx, "stale", "2029-01-01T00:00:00.000Z");
  await fs.writeFile(active.lockPath, JSON.stringify({ pid: 100, createdAt: "2030-01-31T23:00:00.000Z" }));
  await fs.writeFile(stale.lockPath, JSON.stringify({ pid: 200, createdAt: "2029-01-01T00:00:00.000Z" }));
  const plan = await planRetentionCleanup(planOptions(ctx, { processAlive: (pid) => pid === 100 }));
  assert.deepEqual(plan.candidates.map((item) => item.runId), ["stale"]);
});

test("a single unreadable candidate is skipped without hiding another safe candidate", async (t) => {
  const ctx = await sandbox(t);
  await completedRun(ctx, "blocked", "2029-01-01T00:00:00.000Z");
  await completedRun(ctx, "safe", "2029-01-01T00:00:00.000Z");
  const fsApi = new Proxy(fs, {
    get(target, key) {
      if (key === "lstat") return async (value) => {
        if (String(value).includes(`${path.sep}data${path.sep}blocked`)) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        return target.lstat(value);
      };
      return target[key];
    },
  });
  const plan = await planRetentionCleanup(planOptions(ctx, { fsApi }));
  assert.deepEqual(plan.candidates.map((item) => item.runId), ["safe"]);
  assert.ok(plan.warnings.includes("permission denied"));
});

test("all permanent state names and monthly DOCX block retention deletion", async (t) => {
  const protectedNames = [
    "screening_standards.docx", "screening_standards.backup.docx", "screening_standards.before_llm_refine.docx",
    "月报-2030-01.docx", "current_literature_index.json", "current_library_index.json", "papers.json",
    "dedupe-index.json", "learning-state.json", "events.jsonl", "translation_cache.json", "runtime_state.json",
    "urgent_queue.json", "review_backlog.json", "operation_ledger.json", "email_receipt.json", "notification_receipt.json",
  ];
  for (const name of protectedNames) {
    const ctx = await sandbox(t);
    await completedRun(ctx, `protected-${protectedNames.indexOf(name)}`, "2029-01-01T00:00:00.000Z");
    await fs.writeFile(path.join(ctx.dataRoot, `protected-${protectedNames.indexOf(name)}`, name), "keep");
    const plan = await planRetentionCleanup(planOptions(ctx));
    assert.equal(plan.candidates.length, 0, name);
  }
});

test("cleanup deletes an owned old audit without touching queue backlog index source state ledger or receipt", async (t) => {
  const ctx = await sandbox(t);
  const old = await completedRun(ctx, "old-audit", "2029-01-01T00:00:00.000Z");
  const durable = [
    path.join(ctx.runtimeRoot, "radar", "urgent_queue.json"),
    path.join(ctx.runtimeRoot, "radar", "review_backlog.json"),
    path.join(ctx.runtimeRoot, "shared", "current_library_index.json"),
    path.join(ctx.runtimeRoot, "source_state", "weekly-watermark.json"),
    path.join(ctx.runtimeRoot, "recovery", "operation_ledger.json"),
    path.join(ctx.runtimeRoot, "receipts", "nr-0123456789abcdef0123456789abcdef.json"),
  ];
  for (const filePath of durable) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "keep", "utf8");
  }
  const result = await runRetentionCleanup({
    ...planOptions(ctx),
    dryRun: false,
    force: true,
    config: { valid: true, enabled: true, retentionDays: 30, warnings: [] },
  });
  assert.equal(result.deletedRuns, 1);
  await assert.rejects(fs.stat(old.target), { code: "ENOENT" });
  for (const filePath of durable) assert.equal(await fs.readFile(filePath, "utf8"), "keep");
});

test("registered candidates containing symlinks make the whole plan fail closed", async (t) => {
  const ctx = await sandbox(t);
  await completedRun(ctx, "safe", "2029-01-01T00:00:00.000Z");
  await completedRun(ctx, "linked", "2029-01-01T00:00:00.000Z");
  const outside = path.join(ctx.root, "outside.txt");
  await fs.writeFile(outside, "outside");
  try { await fs.symlink(outside, path.join(ctx.dataRoot, "linked", "link.txt"), "file"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error?.code)) return; throw error; }
  const plan = await planRetentionCleanup(planOptions(ctx));
  assert.equal(plan.safe, false);
  assert.equal(plan.candidates.length, 0);
  assert.equal(await fs.readFile(outside, "utf8"), "outside");
});
