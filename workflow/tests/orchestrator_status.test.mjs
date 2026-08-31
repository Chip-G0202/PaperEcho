import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { runZoteroLiteratureFilter } from "../tools/stage0/main.mjs";
import {
  ensureWorkflowStartupReady,
  createStartupError,
  restartWorkflowProcess,
} from "../tools/lib/workflow_startup_ready.mjs";
import { launchZoteroDesktop, resolveZoteroLaunchTarget } from "../tools/lib/zotero_desktop_launcher.mjs";
import {
  buildIntervalGateDiagnostics,
  evaluateRunInterval,
  resolveRuntimeStateReference,
  RUNTIME_STATE_FIELD_OWNERSHIP,
} from "../tools/lib/schedule_support.mjs";
import { parseForceRun } from "../tools/stage0/interval_gate.mjs";

// ── Tests: workflow startup bootstrap ───────────────────────────────────────

function startupOk(name, extra = {}) {
  return {
    ok: true,
    attempts: 1,
    started_now: false,
    diagnostics: { name },
    ...extra,
  };
}

describe("ensureWorkflowStartupReady", () => {
  it("temporarily disables external launcher mode while starting Zotero", async () => {
    const original = process.env.ZOTERO_EXTERNAL_LAUNCHER;
    process.env.ZOTERO_EXTERNAL_LAUNCHER = "desktop_commander";
    const seen = [];
    try {
      const result = await ensureWorkflowStartupReady({
        dependencies: {
          ensureZoteroBackendReady: async () => {
            seen.push(process.env.ZOTERO_EXTERNAL_LAUNCHER || "");
            return startupOk("zotero");
          },
        },
      });

      assert.equal(result.ok, true);
      assert.deepEqual(seen, [""]);
      assert.equal(process.env.ZOTERO_EXTERNAL_LAUNCHER, "desktop_commander");
    } finally {
      if (original === undefined) delete process.env.ZOTERO_EXTERNAL_LAUNCHER;
      else process.env.ZOTERO_EXTERNAL_LAUNCHER = original;
    }
  });

  it("uses an extended Zotero backend wait window for startup", async () => {
    let options = null;
    const result = await ensureWorkflowStartupReady({
      dependencies: {
        ensureZoteroBackendReady: async (opts) => {
          options = opts;
          return startupOk("zotero");
        },
      },
    });

    assert.equal(result.ok, true);
    assert.ok(options.retries >= 30);
    assert.equal(options.postStartDelayMs, 5000);
  });

  it("uses strong recovery after Zotero readiness fails once", async () => {
    let zoteroCalls = 0;
    const restarts = [];
    const result = await ensureWorkflowStartupReady({
      dependencies: {
        ensureZoteroBackendReady: async () => {
          zoteroCalls += 1;
          if (zoteroCalls === 1) throw createStartupError("MCP_NOT_READY_WITH_RUNNING_ZOTERO", "stuck");
          return startupOk("zotero", { started_now: true });
        },
        restartProcess: async (target) => {
          restarts.push(target);
          return { target, killed: true, started: true };
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.zotero.recovered, true);
    assert.equal(result.zotero.attempts.length, 2);
    assert.deepEqual(restarts, ["zotero"]);
  });

  it("returns clear diagnostics when all recovery attempts fail", async () => {
    await assert.rejects(
      () => ensureWorkflowStartupReady({
        dependencies: {
        ensureZoteroBackendReady: async () => {
            throw createStartupError("MCP_NOT_READY_AFTER_ZOTERO_START", "not ready");
          },
          restartProcess: async (target) => ({ target, killed: true, started: true }),
        },
      }),
      (err) => {
        assert.equal(err.code, "WORKFLOW_STARTUP_FAILED");
        assert.equal(err.details.zotero.ready, false);
        assert.equal(err.details.ollama.ready, null);
        return true;
      },
    );
  });

  it("classifies startup failure as process_permission_denied when recovery hits EPERM", async () => {
    await assert.rejects(
      () => ensureWorkflowStartupReady({
        dependencies: {
          ensureZoteroBackendReady: async () => {
            throw createStartupError("MCP_NOT_READY_AFTER_ZOTERO_START", "not ready", {
              launchMethodsTried: [{ method: "launch_powershell.exe", code: "EPERM" }],
            });
          },
          restartProcess: async (target) => ({
            target,
            killed: false,
            commands: [{ method: "restart_zotero_taskkill", error: "Error: spawnSync taskkill EPERM" }],
          }),
        },
      }),
      (err) => {
        assert.equal(err.code, "WORKFLOW_STARTUP_FAILED");
        assert.equal(err.details.failureClass, "process_permission_denied");
        return true;
      },
    );
  });
});

describe("launchZoteroDesktop fallback", () => {
  it("uses system command launch on Windows", async () => {
    const launchMethods = [];
    let processChecks = 0;

    const result = await launchZoteroDesktop({
        platform: "win32",
        postStartDelayMs: 1,
        log: () => {},
        resolvedExecutable: { path: "D:/Zotero/zotero.exe", source: "test", exists: true },
        dependencies: {
          detectDesktopProcess: () => ({ running: ++processChecks > 1, method: "test" }),
          startWithSystemCommand: () => {
            launchMethods.push("system_command");
            return {
              method: "system_command_win32",
              command: "powershell Start-Process zotero",
              success: true,
              code: null,
              stderr: "",
              stdout: "spawned",
            };
          },
          wait: async () => {},
        },
      });

    assert.equal(result.ok, true);
    assert.deepEqual(launchMethods, ["system_command"]);
    assert.equal(processChecks, 2);
  });

  it("does not launch when Zotero is already running", async () => {
    const result = await launchZoteroDesktop({
      platform: "win32",
      postStartDelayMs: 1,
      log: () => {},
      dependencies: {
        detectDesktopProcess: () => ({ running: true, method: "test" }),
        startWithSystemCommand: () => {
          throw new Error("launch should not be called when Zotero is already running");
        },
        wait: async () => {
          throw new Error("post-start wait should not run when Zotero is already running");
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.started_now, false);
    assert.equal(result.was_running, true);
    assert.equal(result.diagnostics.launchAttempted, false);
    assert.equal(result.diagnostics.alreadyRunning, true);
  });

  it("returns launch failure when system spawn emits an async error", async () => {
    const result = await launchZoteroDesktop({
      platform: "win32",
      postStartDelayMs: 0,
      log: () => {},
      dependencies: {
        detectDesktopProcess: () => ({ running: false, method: "test" }),
        spawn: () => ({
          once(event, handler) {
            if (event === "error") setTimeout(() => handler(new Error("spawn ENOENT")), 0);
            return this;
          },
          unref() {
            throw new Error("unref should not run after spawn error");
          },
        }),
        wait: async () => {},
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.diagnostics.launchMethodsTried[0].error, /spawn ENOENT/);
  });

  it("uses configured Zotero executable in Windows direct launch command", async () => {
    let seen = null;
    let processChecks = 0;
    const result = await launchZoteroDesktop({
      platform: "win32",
      zoteroExe: "C:/Program Files/Zotero/zotero.exe",
      postStartDelayMs: 0,
      log: () => {},
      dependencies: {
        detectDesktopProcess: () => ({ running: ++processChecks > 1, method: "test" }),
        spawn: (command, args) => {
          seen = { command, args };
          return {
            once(event, handler) {
              if (event === "spawn") setTimeout(handler, 0);
              return this;
            },
            unref() {},
          };
        },
        wait: async () => {},
      },
    });

    assert.equal(result.ok, true);
    assert.equal(seen.command, "C:/Program Files/Zotero/zotero.exe");
    assert.deepEqual(seen.args, []);
    assert.equal(result.diagnostics.launchMethodsTried[0].method, "direct_executable_win32");
    assert.match(result.diagnostics.launchMethodsTried[0].resolvedTarget.target, /Zotero\/zotero\.exe/);
  });

  it("auto-discovers Windows Zotero from common install paths before bare command fallback", () => {
    const target = "C:\\Program Files\\Zotero\\zotero.exe";
    const resolved = resolveZoteroLaunchTarget({
      platform: "win32",
      env: {
        ProgramFiles: "C:\\Program Files",
        LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      },
      existsSync: (p) => p === target,
      execFileSyncFn: () => {
        throw new Error("PATH should not be checked when common path exists");
      },
    });

    assert.deepEqual(resolved, {
      target,
      source: "common_install_path",
      exists: true,
    });
  });

  it("uses common path auto-discovery when ZOTERO_EXE is not configured", () => {
    const target = "C:\\Program Files\\Zotero\\zotero.exe";
    const resolved = resolveZoteroLaunchTarget({
      platform: "win32",
      zoteroExe: "",
      env: {
        ProgramFiles: "C:\\Program Files",
      },
      existsSync: (p) => p === target,
      execFileSyncFn: () => {
        throw new Error("PATH should not be checked when common path exists");
      },
    });

    assert.deepEqual(resolved, {
      target,
      source: "common_install_path",
      exists: true,
    });
  });

  it("uses auto-discovered Windows Zotero executable in direct launch command", async () => {
    let seen = null;
    let processChecks = 0;
    const result = await launchZoteroDesktop({
      platform: "win32",
      postStartDelayMs: 0,
      log: () => {},
      dependencies: {
        detectDesktopProcess: () => ({ running: ++processChecks > 1, method: "test" }),
        env: {
          ProgramFiles: "C:\\Program Files",
        },
        existsSync: (p) => p === "C:\\Program Files\\Zotero\\zotero.exe",
        spawn: (command, args) => {
          seen = { command, args };
          return {
            once(event, handler) {
              if (event === "spawn") setTimeout(handler, 0);
              return this;
            },
            unref() {},
          };
        },
        wait: async () => {},
      },
    });

    assert.equal(result.ok, true);
    assert.equal(seen.command, "C:\\Program Files\\Zotero\\zotero.exe");
    assert.deepEqual(seen.args, []);
    assert.equal(result.diagnostics.launchMethodsTried[0].method, "direct_executable_win32");
    assert.equal(result.diagnostics.launchMethodsTried[0].resolvedTarget.source, "common_install_path");
  });

  it("continues after launch command when process detection remains absent", async () => {
    const result = await launchZoteroDesktop({
      platform: "win32",
      postStartDelayMs: 0,
      log: () => {},
      dependencies: {
        detectDesktopProcess: () => ({ running: false, method: "test" }),
        startWithSystemCommand: () => ({
          method: "system_command_win32",
          command: "powershell Start-Process zotero",
          success: true,
        }),
        wait: async () => {},
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.started_now, true);
    assert.equal(result.diagnostics.processDetectionAfterLaunchUnreliable, true);
    assert.equal(result.diagnostics.postLaunchProcessCheck.running, false);
  });

});

describe("interval gate parsing", () => {
  it("ORs legacy and current force-run flags after boolean parsing", () => {
    assert.equal(parseForceRun({ FORCE_review_results_RUN: "false", review_results_FORCE_RUN: "true" }), true);
    assert.equal(parseForceRun({ FORCE_review_results_RUN: "true", review_results_FORCE_RUN: "false" }), true);
    assert.equal(parseForceRun({ FORCE_review_results_RUN: "false", review_results_FORCE_RUN: "false" }), false);
  });

  it("falls back to seven days for invalid interval values", () => {
    const intervalInfo = evaluateRunInterval({
      now: new Date("2026-07-08T07:17:00.000Z"),
      lastSuccessfulRunAt: "2026-07-02T07:00:00.000Z",
      intervalDays: Number("not-a-number"),
    });

    assert.equal(intervalInfo.run_interval_days, 7);
    assert.equal(intervalInfo.next_eligible_run_at, "2026-07-09T07:00:00.000Z");
  });
});

describe("restartWorkflowProcess", () => {
  it("attempts taskkill on Windows instead of skipping", async () => {
    let spawnSyncCalled = false;
    const result = await restartWorkflowProcess("zotero", {
      platform: "win32",
      spawnSyncFn: (cmd, args) => {
        spawnSyncCalled = true;
        assert.equal(cmd, "cmd");
        assert.deepEqual(args, ["/c", "taskkill", "/f", "/im", "zotero.exe"]);
        return { status: 0, stdout: "SUCCESS", stderr: "", error: null, signal: null };
      },
    });

    assert.equal(result.target, "zotero");
    assert.equal(spawnSyncCalled, true);
    assert.equal(result.killed, true);
    assert.ok(result.commands[0].method.includes("taskkill"));
  });

  it("returns killed=true on macOS when pkill succeeds", async () => {
    const result = await restartWorkflowProcess("zotero", {
      platform: "darwin",
      spawnSyncFn: (cmd, args) => {
        if (cmd === "pkill") return { status: 0, stdout: "", stderr: "", error: null, signal: null };
        return { status: 1, stdout: "", stderr: "", error: null, signal: null };
      },
    });

    assert.equal(result.killed, true);
  });
});

function startupRuntimeConfig() {
  return {
    platform: "win32",
    repoRoot: "C:/repo",
    researchRoot: "C:/repo/review_results",
    reviewRoot: "C:/repo/review_results/文献评价",
    pipelineDir: "C:/repo/review_results/pipeline/26.6.4",
  };
}

async function claimFixtureScheduleDecision({ weeklyDue, runId }) {
  return {
    decision: weeklyDue ? "weekly_takeover" : "radar",
    businessRunId: runId,
    duplicateTrigger: false,
  };
}

function runStartupFixture(options) {
  return runZoteroLiteratureFilter({ scheduleDecisionClaimer: claimFixtureScheduleDecision, ...options });
}

function scheduledRunMode() {
  return {
    triggerMode: "scheduled",
    isScheduled: true,
    isManualOrForce: false,
    forceRun: false,
    explicitForceRun: false,
  };
}

function manualRunMode() {
  return {
    triggerMode: "manual",
    isScheduled: false,
    isManualOrForce: true,
    forceRun: true,
    explicitForceRun: false,
  };
}

function forceScheduledRunMode() {
  return {
    triggerMode: "scheduled",
    isScheduled: true,
    isManualOrForce: true,
    forceRun: true,
    explicitForceRun: true,
  };
}

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("runZoteroLiteratureFilter startup bootstrap", () => {
  it("documents runtime state field ownership for gate-sensitive fields", () => {
    assert.ok(RUNTIME_STATE_FIELD_OWNERSHIP.last_successful_full_run_at);
    assert.ok(RUNTIME_STATE_FIELD_OWNERSHIP.last_accepted_planned_slot_at);
    assert.ok(RUNTIME_STATE_FIELD_OWNERSHIP.last_translation_pool_scan_at);
    assert.ok(RUNTIME_STATE_FIELD_OWNERSHIP.last_translation_pool_scan_planned_slot_at);
    assert.equal(RUNTIME_STATE_FIELD_OWNERSHIP.last_translation_pool_scan_planned_slot_at.legacy, true);
    assert.match(RUNTIME_STATE_FIELD_OWNERSHIP.last_translation_pool_scan_planned_slot_at.write_boundary, /no longer written/i);
  });

  it("uses a seven-day interval by default", () => {
    const intervalInfo = evaluateRunInterval({
      now: new Date("2026-07-08T07:17:00.000Z"),
      lastSuccessfulRunAt: "2026-07-02T07:00:00.000Z",
    });

    assert.equal(intervalInfo.run_interval_days, 7);
    assert.equal(intervalInfo.run_due, false);
    assert.equal(intervalInfo.next_eligible_run_at, "2026-07-09T07:00:00.000Z");
  });

  it("does not start dependencies when interval gate skips the run", async () => {
    let startupCalls = 0;
    const written = new Map();

    const report = await withEnv({
      review_results_RUN_INTERVAL_DAYS: "2",
      review_results_FORCE_RUN: undefined,
      FORCE_review_results_RUN: undefined,
    }, () => runStartupFixture({
        config: startupRuntimeConfig(),
        triggerMode: "scheduled",
        runMode: scheduledRunMode(),
        clock: () => new Date("2026-06-04T07:17:00.000Z"),
        readJson: async () => ({ last_successful_full_run_at: "2026-06-04T07:00:00.000Z" }),
        writeJson: async (p, data) => { written.set(p, data); },
        writeReport: async () => {},
        runStage: async () => { throw new Error("stage should not run"); },
        ensureStartupReady: async () => {
          startupCalls += 1;
          return { ok: true };
        },
      }));

    const diagnostics = report.interval_gate_diagnostics;
    const skipReport = [...written.entries()].find(([p]) => p.endsWith("run_skip_report.json"))?.[1];
    assert.ok(diagnostics);
    assert.equal(diagnostics.gate_name, "orchestrator_interval_gate");
    assert.equal(diagnostics.trigger, "scheduled");
    assert.equal(diagnostics.force_run, false);
    assert.equal(diagnostics.manual_trigger, false);
    assert.equal(diagnostics.skipped_due_to_interval, true);
    assert.equal(diagnostics.run_due, false);
    assert.equal(diagnostics.reference_state_field, "last_successful_full_run_at");
    assert.equal(diagnostics.last_reference_time, "2026-06-04T07:00:00.000Z");
    assert.equal(diagnostics.runtime_state_diagnostics.reference_state_field, "last_successful_full_run_at");
    assert.deepEqual(diagnostics.runtime_state_diagnostics.written_state_fields, []);
    assert.equal(
      diagnostics.runtime_state_diagnostics.field_ownership.last_successful_full_run_at.owner,
      RUNTIME_STATE_FIELD_OWNERSHIP.last_successful_full_run_at.owner,
    );
    assert.equal(diagnostics.runtime_state_diagnostics.last_successful_full_run_at, undefined);
    assert.equal(diagnostics.interval_days, 2);
    assert.equal(diagnostics.skip_reason, "interval_not_reached");
    assert.equal(diagnostics.planned_slot, "2026-06-04T07:00:00.000Z");
    assert.equal(skipReport.interval_gate_diagnostics.skip_reason, "interval_not_reached");
    assert.equal(skipReport.interval_gate_diagnostics.skipped_due_to_interval, true);

    assert.equal(report.status, "skipped");
    assert.equal(startupCalls, 0);
    assert.equal(report.startup, undefined);
  });

  it("records manual trigger bypass diagnostics without reporting interval skip", async () => {
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");

    const report = await withEnv({
      review_results_FORCE_RUN: undefined,
      FORCE_review_results_RUN: undefined,
    }, () => runStartupFixture({
        config: startupRuntimeConfig(),
        triggerMode: "manual",
        runMode: manualRunMode(),
        clock: () => testStartedAt,
        readJson: async (p) => {
          if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-06-04T07:00:00.000Z" };
          return {};
        },
        statArtifact: async (p) => {
          if (p.includes("writeback_ready_items")) return { exists: false, mtimeMs: null };
          return { exists: false, mtimeMs: null };
        },
        writeJson: async () => {},
        writeReport: async () => {},
        ensureStartupReady: async () => ({ ok: true }),
        runStage: async (stage) => {
          if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      }));

    assert.equal(report.interval_gate_diagnostics.manual_trigger, true);
    assert.equal(report.interval_gate_diagnostics.force_run, true);
    assert.equal(report.interval_gate_diagnostics.skipped_due_to_interval, false);
    assert.equal(report.interval_gate_diagnostics.skip_reason, "manual_bypass");
    assert.notEqual(report.run_outcome.skipped_reason, "interval_not_reached");
  });

  it("records force-run scheduled bypass diagnostics without reporting interval skip", async () => {
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");

    const report = await withEnv({
      review_results_FORCE_RUN: "true",
      FORCE_review_results_RUN: undefined,
    }, () => runStartupFixture({
        config: startupRuntimeConfig(),
        triggerMode: "scheduled",
        runMode: forceScheduledRunMode(),
        clock: () => testStartedAt,
        readJson: async (p) => {
          if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-06-04T07:00:00.000Z" };
          return {};
        },
        statArtifact: async (p) => {
          if (p.includes("writeback_ready_items")) return { exists: false, mtimeMs: null };
          return { exists: false, mtimeMs: null };
        },
        writeJson: async () => {},
        writeReport: async () => {},
        ensureStartupReady: async () => ({ ok: true }),
        runStage: async (stage) => {
          if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
          return { exitCode: 1, stdout: "", stderr: "" };
        },
      }));

    assert.equal(report.interval_gate_diagnostics.trigger, "scheduled");
    assert.equal(report.interval_gate_diagnostics.force_run, true);
    assert.equal(report.interval_gate_diagnostics.manual_trigger, false);
    assert.equal(report.interval_gate_diagnostics.skipped_due_to_interval, false);
    assert.equal(report.interval_gate_diagnostics.skip_reason, "force_run_bypass");
  });

  it("records scheduled due-run diagnostics before continuing existing path", async () => {
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");

    const report = await runStartupFixture({
      config: startupRuntimeConfig(),
      triggerMode: "scheduled",
      runMode: scheduledRunMode(),
      clock: () => testStartedAt,
      readJson: async (p) => {
        if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-05-28T07:00:00.000Z" };
        if (p.includes("writeback_ready_items")) return [];
        return {};
      },
      statArtifact: async (p) => {
        if (p.includes("writeback_ready_items")) return { exists: true, mtimeMs: testStartedAt.getTime() };
        return { exists: false, mtimeMs: null };
      },
      writeJson: async () => {},
      writeReport: async () => {},
      ensureStartupReady: async () => ({ ok: true }),
      runStage: async (stage) => {
        if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "mock mcp failure" };
      },
    });

    assert.equal(report.status, "degraded_due_to_zotero_backend_unavailable");
    assert.equal(report.interval_gate_diagnostics.run_due, true);
    assert.equal(report.interval_gate_diagnostics.skipped_due_to_interval, false);
    assert.equal(report.interval_gate_diagnostics.skip_reason, "run_due");
  });

  it("records no-previous-run diagnostics without reporting interval skip", async () => {
    const report = await runStartupFixture({
      config: startupRuntimeConfig(),
      triggerMode: "scheduled",
      runMode: scheduledRunMode(),
      clock: () => new Date("2026-06-04T07:17:00.000Z"),
      readJson: async (p) => {
        if (p.includes("runtime_state")) throw new Error("missing runtime_state");
        return {};
      },
      writeJson: async () => {},
      writeReport: async () => {},
      runStage: async () => { throw new Error("stage should not run after startup failure"); },
      ensureStartupReady: async () => {
        throw createStartupError("WORKFLOW_STARTUP_FAILED", "not ready", {
          failureClass: "process_permission_denied",
        });
      },
    });

    assert.equal(report.status, "failed_due_to_config_or_dependency");
    assert.equal(report.interval_gate_diagnostics.last_reference_time, null);
    assert.equal(report.interval_gate_diagnostics.run_due, true);
    assert.equal(report.interval_gate_diagnostics.skipped_due_to_interval, false);
    assert.equal(report.interval_gate_diagnostics.skip_reason, "no_previous_run");
  });

  it("starts dependencies before Stage 1 when a scheduled run is due", async () => {
    const order = [];
    let capturedReport = null;
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");

    const report = await runStartupFixture({
      config: startupRuntimeConfig(),
      triggerMode: "scheduled",
      runMode: scheduledRunMode(),
      clock: () => testStartedAt,
      readJson: async (p) => {
        if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-05-28T07:00:00.000Z" };
        if (p.includes("writeback_ready_items")) return [];
        return {};
      },
      statArtifact: async (p) => {
        if (p.includes("writeback_ready_items")) return { exists: true, mtimeMs: testStartedAt.getTime() };
        return { exists: false, mtimeMs: null };
      },
      writeJson: async () => {},
      writeReport: async (data) => { capturedReport = data; },
      ensureStartupReady: async () => {
        order.push("startup");
        return { ok: true, strategy: "repo_bootstrap_with_strong_recovery" };
      },
      runStage: async (stage) => {
        order.push(stage.name);
        if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "mock mcp failure" };
      },
    });

    assert.deepEqual(order.slice(0, 2), ["startup", "stage1"]);
    assert.equal(report.status, "degraded_due_to_zotero_backend_unavailable");
    assert.equal(report.startup.ok, true);
    assert.equal(report.interval_gate_diagnostics.run_due, true);
    assert.equal(report.interval_gate_diagnostics.skipped_due_to_interval, false);
    assert.equal(capturedReport.startup.strategy, "repo_bootstrap_with_strong_recovery");
  });

  it("dry-run skips external startup, Stage 3 translation, and Stage 4 exports", async () => {
    const order = [];
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");

    const report = await withEnv({
      review_results_DRY_RUN: "true",
      review_results_FORCE_RUN: undefined,
      FORCE_review_results_RUN: undefined,
    }, () => runStartupFixture({
        config: startupRuntimeConfig(),
        triggerMode: "manual",
        runMode: manualRunMode(),
        clock: () => testStartedAt,
        readJson: async (p) => {
          if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-06-02T07:00:00.000Z" };
          if (p.includes("writeback_ready_items")) return [{ title: "A item", grade: "A" }];
          if (p.includes("zotero_writeback_dry_run_summary")) {
            return {
              writeback_side_effect_summary: {
                dry_run: true,
                external_write_performed: false,
                items_planned_count: 1,
                items_attempted_count: 0,
                would_write_items_count: 1,
                actual_write_items_count: 0,
              },
            };
          }
          return {};
        },
        statArtifact: async (p) => {
          if (p.includes("writeback_ready_items")) return { exists: true, mtimeMs: testStartedAt.getTime() };
          if (p.includes("zotero_writeback_dry_run_summary")) return { exists: true, mtimeMs: testStartedAt.getTime() };
          if (p.includes("zotero_writeback_summary")) throw new Error("formal writeback summary should not be inspected in dry-run");
          return { exists: false, mtimeMs: null };
        },
        writeJson: async () => {},
        writeReport: async () => {},
        ensureStartupReady: async () => {
          throw new Error("startup should be skipped in dry-run");
        },
        runStage: async (stage) => {
          order.push(stage.name);
          if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
          if (stage.name === "stage2_writeback") return { exitCode: 0, stdout: "", stderr: "" };
          throw new Error(`${stage.name} should not run in dry-run`);
        },
      }));

    assert.deepEqual(order, ["stage1", "stage2_writeback"]);
    assert.equal(report.startup.skipped_due_to_dry_run, true);
    assert.equal(report.dry_run_summary.dry_run, true);
    assert.equal(report.dry_run_summary.zotero_write_blocked, true);
    assert.equal(report.dry_run_summary.translation_api_blocked, true);
    assert.equal(report.dry_run_summary.file_exports_blocked, true);
    assert.equal(report.external_call_summary.zotero_backend_writeback.triggered, false);
    assert.equal(report.external_call_summary.translation_api.triggered, false);
    assert.equal(report.external_call_summary.file_exports.triggered, false);
    assert.equal(report.stages.find((s) => s.name === "zotero_backend_ready").skipReason, "dry_run");
    assert.equal(report.stages.find((s) => s.name === "stage3_translation").skipReason, "dry_run");
    assert.equal(report.stages.find((s) => s.name === "stage4_exports").skipReason, "dry_run");
  });

  it("reports startup failureClass for automation fallback decisions", async () => {
    const report = await runStartupFixture({
      config: startupRuntimeConfig(),
      triggerMode: "scheduled",
      runMode: scheduledRunMode(),
      clock: () => new Date("2026-06-04T07:17:00.000Z"),
      readJson: async () => ({ last_successful_full_run_at: "2026-05-28T07:00:00.000Z" }),
      writeJson: async () => {},
      writeReport: async () => {},
      runStage: async () => { throw new Error("stage should not run"); },
      ensureStartupReady: async () => {
        throw createStartupError("WORKFLOW_STARTUP_FAILED", "not ready", {
          failureClass: "process_permission_denied",
          zotero: { ready: false },
        });
      },
    });

    assert.equal(report.status, "failed_due_to_config_or_dependency");
    assert.equal(report.startup.failureClass, "process_permission_denied");
    assert.equal(report.stages.every((s) => s.skipReason === "startup_failed"), true);
    assert.equal(report.interval_gate_diagnostics.run_due, true);
    assert.equal(report.interval_gate_diagnostics.skipped_due_to_interval, false);
  });



  it("reports stage1_artifact_reason=stage1_artifacts_missing when writeback_ready_items.json does not exist", async () => {
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");
    const report = await runStartupFixture({
      config: startupRuntimeConfig(),
      triggerMode: "scheduled",
      runMode: scheduledRunMode(),
      clock: () => testStartedAt,
      readJson: async (p) => {
        if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-05-28T07:00:00.000Z" };
        if (p.includes("writeback_ready_items")) return [];
        return {};
      },
      statArtifact: async (p) => {
        if (p.includes("writeback_ready_items")) return { exists: false, mtimeMs: null };
        return { exists: false, mtimeMs: null };
      },
      writeJson: async () => {},
      writeReport: async () => {},
      ensureStartupReady: async () => ({ ok: true, strategy: "repo_bootstrap_with_strong_recovery" }),
      runStage: async (stage) => {
        if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    assert.equal(report.status, "failed_stage1");
    assert.equal(report.stage1_artifact_reason, "stage1_artifacts_missing");
    assert.equal(report.run_outcome.failed_stage, "stage1");
    assert.equal(report.run_outcome.skipped_reason, "stage1_artifacts_missing");
    assert.match(report.run_outcome.user_facing_reason, /stage1_artifacts_missing/);
  });

  it("reports stage1_artifact_reason=stage1_artifacts_stale when writeback_ready_items.json is stale", async () => {
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");
    const report = await runStartupFixture({
      config: startupRuntimeConfig(),
      triggerMode: "scheduled",
      runMode: scheduledRunMode(),
      clock: () => testStartedAt,
      readJson: async (p) => {
        if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-05-28T07:00:00.000Z" };
        if (p.includes("writeback_ready_items")) return [];
        return {};
      },
      statArtifact: async (p) => {
        if (p.includes("writeback_ready_items")) return { exists: true, mtimeMs: 0 };
        return { exists: false, mtimeMs: null };
      },
      writeJson: async () => {},
      writeReport: async () => {},
      ensureStartupReady: async () => ({ ok: true, strategy: "repo_bootstrap_with_strong_recovery" }),
      runStage: async (stage) => {
        if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    assert.equal(report.status, "failed_stage1");
    assert.equal(report.stage1_artifact_reason, "stage1_artifacts_stale");
    assert.equal(report.run_outcome.failed_stage, "stage1");
    assert.equal(report.run_outcome.skipped_reason, "stage1_artifacts_stale");
    assert.match(report.run_outcome.user_facing_reason, /stage1_artifacts_stale/);
  });

  it("reports stage1_artifact_reason=stage1_internal_skip when run_skip_report.json confirms skip", async () => {
    const testStartedAt = new Date("2026-06-04T07:17:00.000Z");
    const report = await runStartupFixture({
      config: startupRuntimeConfig(),
      triggerMode: "scheduled",
      runMode: scheduledRunMode(),
      clock: () => testStartedAt,
      readJson: async (p) => {
        if (p.includes("runtime_state")) return { last_successful_full_run_at: "2026-05-28T07:00:00.000Z" };
        if (p.includes("run_skip_report")) return { skipped: true };
        return {};
      },
      statArtifact: async (p) => {
        if (p.includes("writeback_ready_items")) return { exists: false, mtimeMs: null };
        return { exists: false, mtimeMs: null };
      },
      writeJson: async () => {},
      writeReport: async () => {},
      ensureStartupReady: async () => ({ ok: true, strategy: "repo_bootstrap_with_strong_recovery" }),
      runStage: async (stage) => {
        if (stage.name === "stage1") return { exitCode: 0, stdout: "", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    });
    assert.equal(report.status, "failed_stage1");
    assert.equal(report.stage1_artifact_reason, "stage1_internal_skip");
    assert.equal(report.run_outcome.failed_stage, "stage1");
    assert.equal(report.run_outcome.skipped_reason, "stage1_internal_skip");
    assert.match(report.run_outcome.user_facing_reason, /stage1_internal_skip/);
  });
});

describe("Stage 1 internal interval gate diagnostics", () => {
  it("resolves Stage 1 runtime reference field without changing fallback order", () => {
    assert.deepEqual(resolveRuntimeStateReference({
      last_accepted_planned_slot_at: "2026-06-04T07:00:00.000Z",
      last_successful_full_run_at: "2026-06-02T07:00:00.000Z",
    }, ["last_accepted_planned_slot_at", "last_successful_full_run_at"]), {
      reference_state_field: "last_accepted_planned_slot_at",
      last_reference_time: "2026-06-04T07:00:00.000Z",
    });

    assert.deepEqual(resolveRuntimeStateReference({
      last_successful_full_run_at: "2026-06-02T07:00:00.000Z",
    }, ["last_accepted_planned_slot_at", "last_successful_full_run_at"]), {
      reference_state_field: "last_successful_full_run_at",
      last_reference_time: "2026-06-02T07:00:00.000Z",
    });

    assert.deepEqual(resolveRuntimeStateReference({}, ["last_accepted_planned_slot_at", "last_successful_full_run_at"]), {
      reference_state_field: null,
      last_reference_time: null,
    });
  });

  it("builds force-run and no-history diagnostics without reporting interval skip", () => {
    const forceIntervalInfo = evaluateRunInterval({
      now: new Date("2026-06-04T07:17:00.000Z"),
      lastSuccessfulRunAt: "2026-06-04T07:00:00.000Z",
      intervalDays: 2,
      forceRun: true,
    });
    const forceDiagnostics = buildIntervalGateDiagnostics({
      gateName: "stage1_internal_interval_gate",
      trigger: "scheduled",
      forceRun: true,
      manualTrigger: false,
      intervalInfo: forceIntervalInfo,
      referenceStateField: "last_accepted_planned_slot_at",
      lastReferenceTime: "2026-06-04T07:00:00.000Z",
      skipReason: "force_run_bypass",
      source: "runResearchOsPipeline",
    });
    assert.equal(forceDiagnostics.force_run, true);
    assert.equal(forceDiagnostics.skipped_due_to_interval, false);
    assert.equal(forceDiagnostics.skip_reason, "force_run_bypass");
    assert.equal(forceDiagnostics.gate_name, "stage1_internal_interval_gate");

    const noHistoryIntervalInfo = evaluateRunInterval({
      now: new Date("2026-06-04T07:17:00.000Z"),
      lastSuccessfulRunAt: null,
      intervalDays: 2,
      forceRun: false,
    });
    const noHistoryDiagnostics = buildIntervalGateDiagnostics({
      gateName: "stage1_internal_interval_gate",
      trigger: "scheduled",
      forceRun: false,
      manualTrigger: false,
      intervalInfo: noHistoryIntervalInfo,
      referenceStateField: null,
      lastReferenceTime: null,
      skipReason: "no_previous_run",
      source: "runResearchOsPipeline",
    });
    assert.equal(noHistoryDiagnostics.reference_state_field, null);
    assert.equal(noHistoryDiagnostics.last_reference_time, null);
    assert.equal(noHistoryDiagnostics.skipped_due_to_interval, false);
    assert.equal(noHistoryDiagnostics.skip_reason, "no_previous_run");
  });

  it("writes Stage 1 interval skip diagnostics to run_skip_report and run_report", async () => {
    const tmpRoot = path.resolve(".tmp-stage1-interval-gate-test");
    await fs.rm(tmpRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(tmpRoot, "review_results"), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, "review_results", "runtime_state.json"), JSON.stringify({
      last_accepted_planned_slot_at: "2026-06-04T07:00:00.000Z",
      last_successful_full_run_at: "2026-06-02T07:00:00.000Z",
    }, null, 2), "utf8");

    await withEnv({
      review_results_OUTPUT_ROOT: tmpRoot,
      ZOTERO_PROJECT_ROOT: process.cwd(),
      review_results_OVERRIDE_DATE: "2026-06-04T07:17:00.000Z",
      review_results_RUN_INTERVAL_DAYS: "2",
      review_results_ORCHESTRATOR_TRIGGER: "scheduled",
      review_results_FORCE_RUN: undefined,
      FORCE_review_results_RUN: undefined,
    }, async () => {
      const mod = await import(`../tools/stage1/main.mjs?stage1diag=${Date.now()}`);
      const originalLog = console.log;
      console.log = () => {};
      try {
        await mod.runResearchOsPipeline({ argv: ["node", "tools/stage1/main.mjs"] });
      } finally {
        console.log = originalLog;
      }
    });

    const pipelineDir = path.join(tmpRoot, "review_results", "pipeline", "26.6.4");
    const skipReport = JSON.parse(await fs.readFile(path.join(pipelineDir, "run_skip_report.json"), "utf8"));
    const runReport = JSON.parse(await fs.readFile(path.join(pipelineDir, "run_report.json"), "utf8"));
    for (const report of [skipReport, runReport]) {
      const diagnostics = report.interval_gate_diagnostics;
      assert.equal(diagnostics.gate_name, "stage1_internal_interval_gate");
      assert.equal(diagnostics.trigger, "scheduled");
      assert.equal(diagnostics.force_run, false);
      assert.equal(diagnostics.manual_trigger, false);
      assert.equal(diagnostics.interval_days, 2);
      assert.equal(diagnostics.reference_state_field, "last_accepted_planned_slot_at");
      assert.equal(diagnostics.last_reference_time, "2026-06-04T07:00:00.000Z");
      assert.equal(diagnostics.planned_slot, "2026-06-04T07:00:00.000Z");
      assert.equal(diagnostics.run_due, false);
      assert.equal(diagnostics.skipped_due_to_interval, true);
      assert.equal(diagnostics.skip_reason, "interval_not_reached");
      assert.equal(diagnostics.next_eligible_run_at, "2026-06-06T07:00:00.000Z");
      assert.equal(diagnostics.source, "runResearchOsPipeline");
      assert.equal(diagnostics.runtime_state_diagnostics.reference_state_field, "last_accepted_planned_slot_at");
      assert.deepEqual(diagnostics.runtime_state_diagnostics.written_state_fields, []);
      assert.equal(diagnostics.runtime_state_diagnostics.last_accepted_planned_slot_at, undefined);
    }

    await fs.rm(tmpRoot, { recursive: true, force: true });
  });
});
