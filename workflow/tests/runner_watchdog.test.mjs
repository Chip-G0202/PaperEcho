import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watchProductionChild, forceChildTree } from "../tools/runner/child_watchdog.mjs";
import { runProduction } from "../tools/runner/main.mjs";
import { validateProductionResult } from "../tools/runner/result_validation.mjs";
import { installWorkflowCancellation, throwIfWorkflowCanceled } from "../tools/lib/workflow_cancellation.mjs";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const silent = { write() {} };

test("normal child exits clear watchdog and signal listeners", async () => {
  const processApi = new EventEmitter();
  const result = await runProduction({ entry: "-e", args: ["console.log('done')"], childEnv: process.env }, { processApi, stdout: silent, stderr: silent, watchdogTimeoutMs: 3000 });
  assert.equal(result.code, 0); assert.equal(result.status, "completed");
  assert.equal(processApi.listenerCount("SIGINT"), 0);
});

test("watchdog requests cooperative stop then force only its child, nonzero timed_out", async () => {
  const processApi = new EventEmitter(); let child, forced = 0;
  const result = await runProduction({ entry: "fixture", args: [], childEnv: {} }, {
    processApi, stdout: silent, stderr: silent, watchdogTimeoutMs: 20, graceMs: 10,
    spawnImpl() { child = new EventEmitter(); child.pid = 123; child.connected = true; child.send = (message, cb) => { assert.equal(message.status, "timed_out"); cb(); }; return child; },
    forceChildTree(target) { assert.equal(target, child); forced++; child.emit("close", 1, null); },
  });
  assert.equal(forced, 1); assert.equal(result.status, "timed_out"); assert.notEqual(result.code, 0);
  assert.equal(processApi.listenerCount("SIGTERM"), 0);
  const validation = await validateProductionResult({ processResult: { ...result, code: 0 } });
  assert.equal(validation.ok, false);
});

test("SIGINT reports interrupted, graceful exit prevents delayed force", async () => {
  const processApi = new EventEmitter(); let forced = 0;
  const child = { pid: 123, connected: true, send(message, cb) { assert.equal(message.status, "interrupted"); cb(); } };
  const guard = watchProductionChild(child, { timeoutMs: 100, graceMs: 10, processApi, force: () => forced++ });
  processApi.emit("SIGINT"); assert.equal(guard.status, "interrupted");
  guard.cleanup(); processApi.emit("SIGINT"); await wait(120);
  assert.equal(forced, 0); assert.equal(processApi.listenerCount("SIGINT"), 0);
});

test("Windows tree command is bounded PID only; already exited child is untouched", () => {
  const seen = [];
  const spawnImpl = (command, args, options) => { seen.push({ command, args, options }); return new EventEmitter(); };
  forceChildTree({ pid: 456, exitCode: null }, { platform: "win32", spawnImpl });
  forceChildTree({ pid: 789, exitCode: 0 }, { platform: "win32", spawnImpl });
  assert.equal(seen.length, 1); assert.equal(seen[0].command, "taskkill");
  assert.deepEqual(seen[0].args, ["/PID", "456", "/T", "/F"]);
  assert.equal(seen[0].options.shell, false);
});

test("cooperative cancellation blocks subsequent stages/backend calls and releases listeners", () => {
  const processApi = new EventEmitter(); const cancellation = installWorkflowCancellation(processApi);
  try { processApi.emit("message", { type: "paperecho_cancel", status: "interrupted" }); assert.throws(throwIfWorkflowCanceled, { code: "WORKFLOW_CANCELED", status: "interrupted" }); }
  finally { cancellation.dispose(); }
  assert.equal(processApi.listenerCount("message"), 0); throwIfWorkflowCanceled();
});
