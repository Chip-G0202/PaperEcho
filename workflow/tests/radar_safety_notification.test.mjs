import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getDefaultZoteroLibraryIndexPath, updateSharedLiteratureRecordState } from "../tools/lib/zotero_library_index_store.mjs";
import { finishRunGroup, runGroupPath, startRunGroup } from "../tools/lib/runtime_housekeeping.mjs";
import { loadRadarUrgentQueue, enqueueRadarUrgent, recordRadarNotificationOutcome, selectRadarNotificationCandidates } from "../tools/radar/state.mjs";
import { runZoteroLiteratureFilter } from "../tools/stage0/main.mjs";
import { sendRadarAggregateNotification } from "../tools/stage5/radar_notification.mjs";

const urgent = (extra = {}) => ({ title: "Urgent", journal: "Journal", doi: "10.1000/notify", url: "https://doi.org/10.1000/notify", grade: "A", rule_grade: "A", final_grade: "A", llm_review_grade: "A", semantic_grade: "A", semantic_source: "llm_title_review", semantic_reason: "confirmed", ...extra });

test("Radar Stage2/Stage3 capability boundary rejects every Zotero write path", async () => {
  const previous = process.env.PAPERECHO_RUN_PROFILE;
  process.env.PAPERECHO_RUN_PROFILE = "radar";
  let launchCount = 0;
  try {
    const { runZoteroWriteback } = await import("../tools/stage2/main.mjs");
    const { runZoteroTranslationBackfill } = await import("../tools/stage3/main.mjs");
    await assert.rejects(runZoteroWriteback({ launchDesktop: async () => { launchCount += 1; } }), /radar_no_writeback/);
    await assert.rejects(runZoteroTranslationBackfill(), /radar_no_writeback/);
    assert.equal(launchCount, 0);
  } finally {
    if (previous === undefined) delete process.env.PAPERECHO_RUN_PROFILE; else process.env.PAPERECHO_RUN_PROFILE = previous;
  }
});

test("Radar Stage4 capability boundary prevents XLSX generation", async () => {
  const previous = process.env.PAPERECHO_RUN_PROFILE;
  process.env.PAPERECHO_RUN_PROFILE = "radar";
  try {
    const { finalizeResearchOsExports } = await import("../tools/stage4/main.mjs");
    await assert.rejects(finalizeResearchOsExports(), /radar_no_writeback:xlsxWrite/);
  } finally {
    if (previous === undefined) delete process.env.PAPERECHO_RUN_PROFILE; else process.env.PAPERECHO_RUN_PROFILE = previous;
  }
});

test("Radar orchestrator skips write/export stages and never releases Weekly monthly state", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-orchestrator-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const now = new Date("2026-08-31T07:00:00.000Z");
  const researchRoot = path.join(root, "review_results");
  const reviewRoot = path.join(researchRoot, "文献评价");
  const runRoot = path.join(reviewRoot, "runs");
  const prior = await startRunGroup({ runRoot, runId: "weekly-prior", pipelineMode: "desktop", startedAt: now.toISOString(), references: { monthlyAggregationPending: true } });
  await finishRunGroup({ manifestPath: prior.manifestPath, status: "completed", finishedAt: now.toISOString(), pipelineMode: "desktop", monthlyAggregationPending: true });
  const auditPath = path.join(root, "radar_audit.json");
  await fs.writeFile(auditPath, "{}", "utf8");
  let stage5Calls = 0;
  const report = await runZoteroLiteratureFilter({
    config: { platform: "win32", repoRoot: root, projectRoot: root, researchRoot, reviewRoot, pipelineDir: path.join(researchRoot, "pipeline", "26.8.31"), now },
    runId: "radar-current",
    triggerMode: "manual",
    runMode: { triggerMode: "manual", isScheduled: false, isManualOrForce: true, forceRun: true, explicitForceRun: false },
    clock: () => now,
    env: { PAPERECHO_RUN_PROFILE: "radar", ZOTERO_BACKEND: "desktop_cli", PAPERFLOW_REPORT_TO: "reader@example.test" },
    argv: ["--email=reader@example.test"],
    readJson: async () => ({}),
    writeJson: async () => {},
    writeReport: async () => {},
    statArtifact: async (value) => value === auditPath ? { exists: true, mtimeMs: now.getTime() } : { exists: false, mtimeMs: 0 },
    runStage: async (stage) => {
      assert.equal(stage.name, "stage1");
      return { exitCode: 0, stdout: "", stderr: "", data: { triagedAll: [urgent()], radar: { auditPath, audit: { candidateCount: 1, zoteroWriteCount: 0, xlsxWriteCount: 0 }, urgentItems: [urgent()] } } };
    },
    radarStage5Runner: async () => { stage5Calls += 1; return { status: "accepted", receipt: { messageId: "radar-test" } }; },
  });
  assert.equal(report.status, "completed");
  assert.equal(stage5Calls, 1);
  assert.equal(report.stages.find((stage) => stage.name === "stage2_writeback").skipReason, "radar_no_writeback");
  assert.equal(report.stages.find((stage) => stage.name === "stage4_exports").skipReason, "radar_json_only");
  const priorAfter = JSON.parse(await fs.readFile(prior.manifestPath, "utf8"));
  const radarManifest = JSON.parse(await fs.readFile(runGroupPath(runRoot, "radar-current"), "utf8"));
  assert.equal(priorAfter.references.monthlyAggregationPending, true);
  assert.equal(radarManifest.references.monthlyAggregationPending, false);
});

test("no urgent item keeps business Radar mail silent", async () => {
  let calls = 0;
  const result = await sendRadarAggregateNotification({ urgentItems: [], transport: async () => { calls += 1; } });
  assert.equal(result.reason, "no_urgent_items");
  assert.equal(calls, 0);
});

test("all urgent items are sent in one aggregate mail without attachments", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-mail-"));
  let calls = 0;
  let message;
  const result = await sendRadarAggregateNotification({
    runId: "radar-mail",
    urgentItems: [urgent(), urgent({ title: "Second", doi: "10.1000/second" })],
    recipient: "reader@example.test",
    runStateRoot: root,
    transport: async (value) => { calls += 1; message = value; return { accepted: true, acceptedCount: 1 }; },
  });
  assert.equal(result.status, "accepted");
  assert.equal(calls, 1);
  assert.equal(message.attachments.length, 0);
  assert.match(message.text, /Urgent/);
  assert.match(message.text, /Second/);
});

test("SMTP failed or unknown outcome never removes the urgent queue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-mail-queue-"));
  const queuePath = path.join(root, "urgent_queue.json");
  await enqueueRadarUrgent(queuePath, [urgent()], { runId: "radar-queue" });
  const result = await sendRadarAggregateNotification({ runId: "radar-queue", urgentItems: [urgent()], recipient: "reader@example.test", runStateRoot: path.join(root, "run"), transport: async () => ({}) });
  assert.equal(result.status, "unknown");
  assert.equal(Object.keys((await loadRadarUrgentQueue(queuePath)).items).length, 1);
});

test("same identity and fingerprint is not selected for repeat notification", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-dedupe-mail-"));
  const indexPath = getDefaultZoteroLibraryIndexPath(root);
  const first = await selectRadarNotificationCandidates(indexPath, [urgent()]);
  await recordRadarNotificationOutcome(indexPath, first.selected, { status: "accepted" });
  const second = await selectRadarNotificationCandidates(indexPath, [urgent()]);
  assert.equal(second.selected.length, 0);
  assert.equal(second.suppressed[0].reason, "already_delivered");
});

test("unknown SMTP receipt is held against automatic repeat", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-unknown-mail-"));
  const indexPath = getDefaultZoteroLibraryIndexPath(root);
  const first = await selectRadarNotificationCandidates(indexPath, [urgent()]);
  await recordRadarNotificationOutcome(indexPath, first.selected, { status: "unknown" });
  const second = await selectRadarNotificationCandidates(indexPath, [urgent()]);
  assert.equal(second.selected.length, 0);
  assert.equal(second.suppressed[0].reason, "unknown_held");
});

test("material grade or metadata change permits a new notification decision", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-change-mail-"));
  const indexPath = getDefaultZoteroLibraryIndexPath(root);
  const first = await selectRadarNotificationCandidates(indexPath, [urgent()]);
  await recordRadarNotificationOutcome(indexPath, first.selected, { status: "accepted" });
  assert.equal((await selectRadarNotificationCandidates(indexPath, [urgent({ journal: "Changed" })])).selected.length, 1);
});

test("integrity-only state change does not retrigger Daily Radar", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "radar-integrity-isolation-"));
  const indexPath = getDefaultZoteroLibraryIndexPath(root);
  const first = await selectRadarNotificationCandidates(indexPath, [urgent()]);
  await recordRadarNotificationOutcome(indexPath, first.selected, { status: "accepted" });
  await updateSharedLiteratureRecordState(indexPath, [{ item: urgent(), patch: { integrity: { status: "confirmed", evidenceFingerprint: "integrity-only" } } }]);
  assert.equal((await selectRadarNotificationCandidates(indexPath, [urgent()])).selected.length, 0);
});
