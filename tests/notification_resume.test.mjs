import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRunRecoveryCoordinator, resumeRunFromLedger } from "../workflow/tools/recovery/run_recovery.mjs";
import { OperationLedgerStore } from "../workflow/tools/recovery/operation_ledger.mjs";
import { sendRadarAggregateNotification, radarNotificationReceiptPath } from "../workflow/tools/stage5/radar_notification.mjs";
import { runStage5Notification } from "../workflow/tools/stage5/main.mjs";
import { receiptPathFor, readNotificationReceipt, writeNotificationReceipt } from "../workflow/tools/stage5/email_receipt.mjs";
import { validateProductionResult } from "../workflow/tools/runner/result_validation.mjs";
import { buildExecutionPlan } from "../workflow/tools/runner/preflight.mjs";
import { canonicalQueryHash } from "../workflow/tools/stage1/source_state.mjs";
import { recordRadarNotificationOutcome, selectRadarNotificationCandidates } from "../workflow/tools/radar/state.mjs";

const hash = "a".repeat(64);
const recipient = "reader@example.test";
async function fixture(t, profile, { outcome = "failed", mode = "web", attachment = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "notification-resume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = `${profile}-fixture`;
  const state = path.join(root, runId);
  const coordinator = await createRunRecoveryCoordinator({ runRoot: root, runId, mode, profile, launcherId: `${mode}-fixed-launcher/runner`, configHash: hash, inputHash: hash, artifactPath: path.join(state, "business.json") });
  const items = [{ title: "Existing business title", translatedTitle: "已有业务标题", final_grade: "A", semantic_reason: "Existing recommendation reason" }];
  const audit = { candidateCount: 5, generatedAt: "2026-09-30T07:00:00Z" };
  await coordinator.persistArtifact(profile === "radar" ? audit : items, items);
  for (const stage of Object.keys(coordinator.store.ledger.stages).filter((name) => name !== "stage5_notification")) {
    await coordinator.store.setStage(stage, profile === "radar" && stage !== "stage1" ? "skipped" : "verified");
  }
  const artifactBefore = await fs.readFile(path.join(state, "business.json"), "utf8");
  await fs.writeFile(path.join(state, "run_group.json"), JSON.stringify({ schemaVersion: 1, runId, pipelineMode: mode, status: "failed_stage5_notification", artifacts: [] }));
  const notificationType = profile === "radar" ? "radar_business" : "run_summary";
  const indexPath = path.join(root, "fixture-index.json");
  const selected = (await selectRadarNotificationCandidates(indexPath, items)).selected;
  const receiptPath = profile === "radar" ? radarNotificationReceiptPath(state, runId, items, audit) : receiptPathFor(state);
  const op = await coordinator.prepareFileOperation({ type: "notification", targetId: notificationType, targetPath: receiptPath, input: { runId }, retryable: false, intent: { notificationType, eventEpoch: runId, ...(profile === "radar" ? { radarCompletionHash: canonicalQueryHash(selected) } : {}) } });
  const messages = [];
  const transport = async (message) => { messages.push(message); return outcome === "unknown" ? {} : { accepted: outcome === "accepted", rejectedCount: outcome === "failed" ? 1 : 0 }; };
  const attachments = [];
  if (attachment) { const file = path.join(state, "monthly.docx"); await fs.writeFile(file, "unchanged monthly report"); attachments.push({ kind: "monthly_docx", path: file }); }
  const initial = profile === "radar"
    ? await sendRadarAggregateNotification({ runId, urgentItems: items, audit, notificationSelection: selected, recipient, runStateRoot: state, ledgerOperationId: op.idempotencyKey, transport })
    : await runStage5Notification({ runSummary: { runId, pipelineMode: mode, finishedAt: audit.generatedAt, counts: { created: 1, grades: { A: 1 } }, artifacts: attachments, outputRoot: state }, recipient, transport, config: { runStateRoot: state, ledgerOperationId: op.idempotencyKey, env: {} } });
  assert.ok(["failed", "unknown", "sent", "accepted"].includes(initial.status));
  await coordinator.store.transition(op.idempotencyKey, "failed");
  await coordinator.store.setStage("stage5_notification", "failed");
  await coordinator.store.setRunStatus("failed", "failed_stage5_notification");
  const resume = (extra = {}) => resumeRunFromLedger({ runRoot: root, runId, mode, profile, configHash: hash,
    beforeReconcile: async () => assert.fail("business preparation must not run"),
    buildReconcilers: async () => assert.fail("retrieval / Zotero / export reconcilers must not run"),
    notification: { recipient, env: {}, recordRadarOutcome: (entries, result) => recordRadarNotificationOutcome(indexPath, entries, result), transport: async (message) => { messages.push(message); return { accepted: true }; }, ...extra },
  });
  return { root, runId, state, coordinator, receiptPath, messages, artifactBefore, resume, mode, indexPath, items };
}

for (const [profile, mode] of [["radar", "web"], ["standard", "web"], ["standard", "local"]]) {
  test(`${profile}/${mode}: formal resume retries only notification and repeated resume is idempotent`, async (t) => {
    const f = await fixture(t, profile, { mode });
    const first = await f.resume();
    assert.equal(first.status, "completed");
    assert.equal(first.notificationOnly, true);
    assert.deepEqual(f.messages[0], f.messages[1]);
    assert.match(f.messages[1].html, /PaperEcho/);
    assert.equal((await readNotificationReceipt(f.receiptPath)).status, "accepted");
    const store = await OperationLedgerStore.load({ runRoot: f.root, runId: f.runId });
    assert.equal(store.ledger.workflowStatus, "completed");
    assert.equal(store.ledger.stages.stage5_notification.status, "verified");
    assert.equal((await f.resume()).status, "completed");
    assert.equal(f.messages.length, 2);
    if (profile === "radar") assert.equal((await selectRadarNotificationCandidates(f.indexPath, f.items)).selected.length, 0);
    assert.equal(await fs.readFile(path.join(f.state, "business.json"), "utf8"), f.artifactBefore);
    const validated = await validateProductionResult({ options: { mode, resume: f.runId }, plan: { runRoot: f.root }, processResult: { code: 0, stdout: JSON.stringify(first) } });
    assert.equal(validated.ok, true, validated.reason);
  });
}

test("accepted receipt is adopted without resending after ledger interruption", async (t) => {
  const f = await fixture(t, "radar", { outcome: "accepted" });
  assert.equal((await f.resume()).status, "completed");
  assert.equal(f.messages.length, 1);
});

test("Runner passes the resolved recipient to notification resume without enabling force-resend", () => {
  const plan = buildExecutionPlan({ mode: "local", profile: "standard", resume: "local-fixture", outputRoot: path.resolve("tests/runs/local-fixture"), email: recipient }, { env: {}, repoRoot: process.cwd() });
  assert.equal(plan.childEnv.PAPERFLOW_REPORT_TO, recipient);
  assert.ok(plan.args.includes("--resume"));
  assert.equal(plan.args.includes("--force-resend"), false);
});

test("Radar completion fingerprint mismatch blocks before sending", async (t) => {
  const f = await fixture(t, "radar");
  const receipt = await readNotificationReceipt(f.receiptPath);
  receipt.recoveryData.radarSelection[0].fingerprint = "changed";
  await writeNotificationReceipt(f.receiptPath, receipt);
  assert.equal((await f.resume()).reason, "radar_notification_completion_unverified");
  assert.equal(f.messages.length, 1);
});

for (const status of ["unknown", "pending"]) test(`${status} after an attempt fails closed`, async (t) => {
  const f = await fixture(t, "radar", { outcome: "unknown" });
  const receipt = await readNotificationReceipt(f.receiptPath);
  await writeNotificationReceipt(f.receiptPath, { ...receipt, status });
  assert.equal((await f.resume()).reason, "notification_possibly_accepted");
  assert.equal(f.messages.length, 1);
});

test("pending receipt before an attempt can safely retry the same event", async (t) => {
  const f = await fixture(t, "radar");
  const receipt = await readNotificationReceipt(f.receiptPath);
  await writeNotificationReceipt(f.receiptPath, { ...receipt, status: "pending", attempts: 0 });
  assert.equal((await f.resume()).status, "completed");
  assert.equal(f.messages.length, 2);
});

test("unverified business stage blocks notification resume", async (t) => {
  const f = await fixture(t, "standard");
  await f.coordinator.store.setStage("stage4_exports", "failed");
  assert.equal((await f.resume()).reason, "notification_business_not_verified");
  assert.equal(f.messages.length, 1);
});

test("changed recipient cannot recover another recipient's notification", async (t) => {
  const f = await fixture(t, "standard");
  assert.equal((await f.resume({ recipient: "different@example.test" })).reason, "notification_receipt_identity_mismatch");
  assert.equal(f.messages.length, 1);
});

for (const change of ["missing", "content", "receipt"]) test(`recovery ${change} mismatch is not a new event`, async (t) => {
  const f = await fixture(t, "radar");
  const receipt = await readNotificationReceipt(f.receiptPath);
  if (change === "missing") delete receipt.recoveryData;
  if (change === "content") receipt.recoveryData.content.items[0].title = "Changed content";
  if (change === "receipt") receipt.ledgerOperationId = "b".repeat(64);
  await writeNotificationReceipt(f.receiptPath, receipt);
  assert.equal((await f.resume()).status, "blocked");
  assert.equal(f.messages.length, 1);
});

test("monthly attachment changes block recovery without re-exporting", async (t) => {
  const f = await fixture(t, "standard", { attachment: true });
  await fs.writeFile(path.join(f.state, "monthly.docx"), "user edited");
  assert.equal((await f.resume()).reason, "notification_attachment_changed");
  assert.equal(f.messages.length, 1);
});
