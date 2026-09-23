import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRunnerArgs } from "../tools/runner/args.mjs";
import { main as runnerMain } from "../tools/runner/main.mjs";
import { selectScheduledDailyRun } from "../tools/runner/scheduled_daily.mjs";
import { withRunnerProfile } from "../tools/runner/config_loader.mjs";
import { runZoteroLiteratureFilter } from "../tools/stage0/main.mjs";
import { buildStage4RuntimeStateUpdate, writeSuccessfulRuntimeState } from "../tools/stage4/export_io.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const day = (offset, hour = 7) => new Date(Date.UTC(2026, 8, 21 + offset, hour));
const baseline = { last_successful_scheduled_run_at: day(0).toISOString(), last_successful_full_run_at: day(0, 8).toISOString(), last_accepted_planned_slot_at: day(0).toISOString() };
const sink = () => ({ write() {} });
const missing = () => { const error = new Error("missing"); error.code = "ENOENT"; throw error; };
const stateFiles = (state) => ({ readFile: async (filePath) => filePath.endsWith("runtime_state.json") ? JSON.stringify(state) : missing() });
const resolved = (root, profile = "standard", extraEnv = {}) => ({
  options: { mode: "desktop", profile, action: "run", scheduledDaily: true, forceResend: false, resume: "", recoveryConfigHash: "a".repeat(64), configSummary: { profile }, email: "" },
  env: { ZOTERO_PROJECT_ROOT: root, ...extraEnv },
  config: { schemaVersion: 2, common: { radar: { enabled: true } } },
});

test("scheduled-daily parser rejects manual, Local, force-resend, and explicit Radar conflicts", () => {
  const parsed = parseRunnerArgs(["--run", "--mode", "desktop", "--scheduled-daily"]);
  assert.equal(parsed.scheduledDaily, true);
  for (const extra of [["--check"], ["--mode", "local"], ["--force-resend"], ["--profile", "radar"]]) {
    const argv = extra[0] === "--mode" ? ["--run", ...extra, "--scheduled-daily"] : ["--run", "--mode", "desktop", "--scheduled-daily", ...extra];
    assert.throws(() => parseRunnerArgs(argv), /RUNNER_/);
  }
});

test("daily selection uses only today's mode and rejects force, invalid state, and disabled Radar", async () => {
  const root = path.join(repoRoot, "workflow", "tests");
  const offDay = await selectScheduledDailyRun(resolved(root), { now: day(1), fsApi: stateFiles(baseline) });
  assert.equal(offDay.status, "ready");
  assert.equal(offDay.resolved.options.profile, "radar");
  const due = await selectScheduledDailyRun(resolved(root, "complete"), { now: day(7), fsApi: stateFiles(baseline) });
  assert.equal(due.resolved.options.profile, "complete");
  const early = await selectScheduledDailyRun(resolved(root), { now: day(1, 6), fsApi: stateFiles(baseline) });
  assert.equal(early.status, "before_scheduled_slot");
  const disabled = resolved(root);
  disabled.config.common.radar.enabled = false;
  assert.equal((await selectScheduledDailyRun(disabled, { now: day(1), fsApi: stateFiles(baseline) })).status, "scheduled_radar_disabled");
  assert.equal((await selectScheduledDailyRun(disabled, { now: day(7), fsApi: stateFiles(baseline) })).status, "ready");
  await assert.rejects(selectScheduledDailyRun(resolved(root, "standard", { FORCE_review_results_RUN: "true" }), { now: day(1), fsApi: stateFiles(baseline) }), /SCHEDULE_FORCE_CONFLICT/);
  await assert.rejects(selectScheduledDailyRun(resolved(root), { now: day(1), fsApi: stateFiles({ last_accepted_planned_slot_at: day(0).toISOString() }) }), /SCHEDULE_STATE_INVALID/);
});

test("Runner selects Radar before mode preflight; Weekly preflight failure never falls back to Radar", async () => {
  const root = path.join(repoRoot, "workflow", "tests");
  const modes = [];
  let productions = 0;
  const options = {
    cwd: root, env: {}, repoRoot,
    resolveRunnerConfigurationImpl: async () => resolved(root),
    selectScheduledDailyRunImpl: (configuration, { now }) => selectScheduledDailyRun(configuration, { now, fsApi: stateFiles(baseline) }),
    runPreflightImpl: async (selected) => { modes.push(selected.profile); return { status: selected.profile === "radar" ? "ready" : "blocked", mode: "desktop", profile: selected.profile, requiredMissing: selected.profile === "radar" ? [] : [{ name: "Zotero", category: "dependency" }], canRun: selected.profile === "radar" }; },
    buildExecutionPlanImpl: (selected) => ({ runId: "zlf-test", childEnv: {}, runRoot: root, profile: selected.profile }),
    runProductionImpl: async () => { productions++; return { status: "completed", code: 0, stdout: "{}" }; },
    validateProductionResultImpl: async () => ({ ok: true, exitCode: 0 }),
    stdout: sink(), stderr: sink(),
  };
  assert.equal(await runnerMain(["--run", "--mode", "desktop", "--scheduled-daily"], { ...options, clock: () => day(1) }), 0);
  assert.equal(await runnerMain(["--run", "--mode", "desktop", "--scheduled-daily"], { ...options, clock: () => day(7) }), 4);
  assert.deepEqual(modes, ["radar", "standard"]);
  assert.equal(productions, 1);
});

test("a losing concurrent Runner reports the Stage0 claim as already claimed", async () => {
  const root = path.join(repoRoot, "workflow", "tests");
  let output = "";
  const code = await runnerMain(["--run", "--mode", "desktop", "--scheduled-daily"], {
    cwd: root, env: {}, clock: () => day(1), repoRoot,
    resolveRunnerConfigurationImpl: async () => resolved(root),
    selectScheduledDailyRunImpl: (configuration, { now }) => selectScheduledDailyRun(configuration, { now, fsApi: stateFiles(baseline) }),
    runPreflightImpl: async () => ({ status: "ready", mode: "desktop", profile: "radar", requiredMissing: [], canRun: true }),
    buildExecutionPlanImpl: () => ({ runId: "zlf-loser", childEnv: {}, runRoot: root }),
    runProductionImpl: async () => ({ status: "completed", code: 0, stdout: JSON.stringify({ status: "skipped", skipReport: { reason: "duplicate_schedule_trigger" }, schedule_decision: { businessRunId: "zlf-winner" } }) }),
    validateProductionResultImpl: async () => { throw new Error("duplicate must not enter ordinary validation"); },
    stdout: { write: (value) => { output += value; } }, stderr: sink(),
  });
  assert.equal(code, 0);
  assert.match(output, /"status":"already_claimed"/);
  assert.match(output, /zlf-winner/);
});

test("existing claim is never converted to another business run; ambiguous ledger fails closed", async () => {
  const root = path.join(repoRoot, "workflow", "tests");
  const claim = { schemaVersion: 1, dateKey: "2026-09-28", plannedSlotAt: day(7).toISOString(), decision: "weekly_takeover", businessRunId: "zlf-existing" };
  const fsApi = { readFile: async (filePath) => filePath.endsWith("2026-09-28.json") ? JSON.stringify(claim) : missing() };
  const pending = await selectScheduledDailyRun(resolved(root), { now: day(7), fsApi, loadLedger: async () => ({ ledger: { status: "running" } }) });
  assert.equal(pending.status, "recovery_required");
  assert.equal(pending.runId, "zlf-existing");
  const done = await selectScheduledDailyRun(resolved(root), { now: day(7), fsApi, loadLedger: async () => ({ ledger: { status: "completed" } }) });
  assert.equal(done.status, "already_completed");
  const configuration = resolved(root);
  const retry = await selectScheduledDailyRun(configuration, {
    now: day(7), fsApi,
    loadLedger: async () => ({ ledger: { status: "failed", mode: "desktop", profile: "standard", configHash: withRunnerProfile(configuration, "standard").options.recoveryConfigHash, artifact: { hash: "b".repeat(64) } } }),
  });
  assert.equal(retry.status, "resume");
  assert.equal(retry.resolved.options.resume, "zlf-existing");
  assert.equal(retry.resolved.options.profile, "standard");
});

test("Stage0 rejects a changed Runner decision before a claim or stage can run", async () => {
  const root = path.join(repoRoot, "workflow", "tests");
  let claimed = 0;
  await assert.rejects(runZoteroLiteratureFilter({
    config: { researchRoot: path.join(root, "review_results"), reviewRoot: path.join(root, "review_results", "文献评价"), pipelineDir: path.join(root, "review_results", "pipeline", "fixture"), repoRoot },
    clock: () => day(1),
    triggerMode: "scheduled", runMode: { isManualOrForce: false },
    env: { PAPERECHO_SCHEDULED_DAILY: "1", PAPERECHO_SCHEDULED_SLOT: day(1).toISOString(), PAPERECHO_SCHEDULED_FLOW: "weekly", PAPERECHO_SCHEDULED_WEEKLY_MODE: "standard", PAPERECHO_RUN_PROFILE: "standard", PAPERECHO_RADAR_ENABLED: "true" },
    scheduledRuntimeStateReader: async () => ({ statePresent: true, runtimeState: baseline }),
    scheduleDecisionClaimer: async () => { claimed++; },
  }), /SCHEDULE_STAGE0_DECISION_CHANGED/);
  assert.equal(claimed, 0);
});

test("Stage4 preserves the planned slot across midnight and never replaces corrupt state", async (t) => {
  const root = await fs.mkdtemp(path.join(repoRoot, "workflow", "tests", "scheduled-state-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, "runtime_state.json");
  const runReport = { triggerMode: "scheduled", current_planned_slot_at: day(0).toISOString() };
  const updated = buildStage4RuntimeStateUpdate({ runtimeState: {}, runReport, now: new Date("2026-09-21T16:30:00.000Z") });
  assert.equal(updated.last_successful_scheduled_run_at, day(0).toISOString());
  await writeSuccessfulRuntimeState({ runtimeStatePath: statePath, runReport, now: new Date("2026-09-21T16:30:00.000Z") });
  assert.equal(JSON.parse(await fs.readFile(statePath, "utf8")).last_successful_scheduled_run_at, day(0).toISOString());
  await fs.writeFile(statePath, "{broken", "utf8");
  await assert.rejects(writeSuccessfulRuntimeState({ runtimeStatePath: statePath, runReport }), /SCHEDULE_STATE_INVALID/);
  assert.equal(await fs.readFile(statePath, "utf8"), "{broken");
});
