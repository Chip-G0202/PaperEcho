import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildRuntimeConfig } from "../tools/lib/runtime_config.mjs";
import { runZoteroLiteratureFilter } from "../tools/stage0/main.mjs";
import { runStage5Notification } from '../tools/stage5/main.mjs';
import { createRunRecoveryCoordinator } from '../tools/recovery/run_recovery.mjs';

async function runMode(backend, stage5Result = { status: "sent", reason: "sent", attachments: ["周报.xlsx"] }, resolvedBackend = backend === "auto" ? "web_api" : backend, notificationEnv = {}, trackRecovery = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperflow-stage5-integration-"));
  const now = new Date("2026-07-13T07:00:00.000Z");
  const config = buildRuntimeConfig({ cwd: process.cwd(), now, env: { ...process.env, review_results_OUTPUT_ROOT: root, ZOTERO_BACKEND: backend } });
  const xlsx = path.join(root, "周报.xlsx");
  await fs.writeFile(xlsx, "xlsx");
  const runSummary = { schemaVersion: 1, runId: "injected", pipelineMode: backend === "web_api" ? "web" : "desktop", status: "success", startedAt: now.toISOString(), finishedAt: now.toISOString(), durationMs: 1, counts: { retrieved: null, created: 1, updated: null, deduped: null, feedback: null, translated: null, grades: { A: 1, B: 0, C: 0, D: 0 } }, warnings: [], errors: [], artifacts: [{ kind: "weekly_xlsx", path: xlsx, displayName: "周报.xlsx", sizeBytes: 4 }], outputRoot: root };
  const literatureItems = [{ title: "Current run item", abstract: "", grade: "A", source: "database" }];
  const exportAudit = { stage4_export_status: "success", actual_output_path: xlsx, export_root: root };
  const runReport = { started_at: now.toISOString(), counts: {}, steps: { stage4_export_audit: exportAudit } };
  const readJson = async (filePath) => {
    if (filePath.includes("runtime_state")) return { last_successful_full_run_at: "2026-07-01T07:00:00.000Z" };
    if (filePath.includes("writeback_ready_items")) return [{ title: "A", grade: "A" }];
    if (filePath.includes("zotero_writeback_summary")) return { writeback_items: [{ title: "A", grade: "A", itemKey: "K1" }] };
    if (filePath.includes("abc_translation_backfill")) return { success_count: 1 };
    if (filePath.includes("desktop_daily_review_source")) return [{ title: "A", grade: "A", itemKey: "K1" }];
    if (filePath.includes("run_report")) return runReport;
    return {};
  };
  const statArtifact = async (filePath) => ({ exists: ["writeback_ready_items", "zotero_writeback_summary", "abc_translation_backfill", "run_report", "周报.xlsx"].some((name) => filePath.includes(name)), mtimeMs: now.getTime() });
  const calls = [];
  const recoveryCoordinator = trackRecovery ? await createRunRecoveryCoordinator({ runRoot: path.join(config.reviewRoot, 'runs'), runId: 'disabled-weekly', mode: backend === 'web_api' ? 'web' : 'desktop', profile: 'standard', launcherId: 'fixture', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(config.reviewRoot, 'runs/disabled-weekly/recovery/artifact.json') }) : null;
  const report = await runZoteroLiteratureFilter({
    ...(recoveryCoordinator ? { recoveryCoordinator, runId: 'disabled-weekly' } : {}),
    config, triggerMode: "manual", runMode: { explicitForceRun: true, isManualOrForce: true, stage1Only: false }, clock: () => now,
    argv: ["--email", "reader@example.test"], env: { ZOTERO_BACKEND: backend, ...notificationEnv }, readJson, statArtifact, writeJson: async () => {}, writeReport: async () => {}, ensureStartupReady: async () => ({ ok: true }),
    runStage: async (stage) => ({ exitCode: 0, stdout: "", stderr: "", data: stage.name === "stage4_exports" ? { runSummary, literatureItems } : stage.name === "zotero_backend_ready" ? { backend: resolvedBackend } : null }),
    stage5Runner: async (input) => { calls.push(input); return stage5Result || runStage5Notification({ ...input, transport: async () => { throw new Error('disabled transport must not run'); } }); },
  });
  return { report, calls, xlsx, config, recoveryCoordinator };
}

test("Desktop and Web share the Stage5 call after successful Stage4", async () => {
  for (const [backend, mode] of [["cli", "desktop"], ["web_api", "web"]]) {
    const { report, calls, config } = await runMode(backend);
    assert.equal(report.status, "completed");
    assert.equal(report.steps.stage5_notification.status, "sent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].runSummary.pipelineMode, mode);
    assert.equal(calls[0].runSummary.finishedAt, "2026-07-13T07:00:00.000Z");
    assert.deepEqual(calls[0].runSummary.counts.grades, { A: 1, B: 0, C: 0, D: 0 });
    assert.deepEqual(calls[0].literatureItems, [{ title: "Current run item", abstract: "", grade: "A", source: "database" }]);
    assert.equal(calls[0].recipient, "reader@example.test");
    assert.match(calls[0].config.runStateRoot, new RegExp(`runs[\\\\/]${report.runId}$`));
    const manifest = JSON.parse(await fs.readFile(path.join(config.reviewRoot, "runs", report.runId, "run_group.json"), "utf8"));
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.pipelineMode, mode);
  }
});

test("auto backend uses the actually resolved Web mode", async () => {
  const { calls } = await runMode("auto", undefined, "web_api");
  assert.equal(calls[0].runSummary.pipelineMode, "web");
});

test("Stage5 failure keeps Stage4 output and makes orchestrator status non-success", async () => {
  const { report, xlsx } = await runMode("cli", { status: "failed", reason: "mock_failure", attachments: [] });
  assert.equal(report.status, "failed_stage5_notification");
  assert.equal(await fs.readFile(xlsx, "utf8"), "xlsx");
});
for (const backend of ['cli', 'web_api']) for (const notificationEnv of [{ PAPERECHO_EMAIL_ENABLED: 'false' }, { PAPERECHO_NOTIFY_WEEKLY: 'false' }]) test(`${backend} disabled notification preserves business/export success without a recovery operation`, async () => {
  const { report, calls, xlsx, recoveryCoordinator } = await runMode(backend, null, backend, notificationEnv, true);
  assert.equal(report.status, 'completed'); assert.equal(report.steps.stage5_notification.status, 'skipped');
  assert.equal(calls[0].recipient, ''); assert.equal(await fs.readFile(xlsx, 'utf8'), 'xlsx');
  assert.equal(recoveryCoordinator.store.ledger.operations.some((operation) => operation.type === 'notification'), false);
  assert.equal(recoveryCoordinator.store.ledger.stages.stage5_notification.status, 'verified');
});
