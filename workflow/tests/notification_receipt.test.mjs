import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { deliverReliableNotification } from "../tools/notification/delivery.mjs";
import { notificationIdentity, readNotificationReceipt } from "../tools/stage5/email_receipt.mjs";

const base = {
  notificationType: "run_failure",
  runId: "run-1",
  businessSubject: "run-1:stage2",
  eventEpoch: "run-1:stage2",
  payload: { subject: "failed", text: "safe", html: "<p>safe</p>", attachments: [] },
  recipient: "reader@example.test",
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperecho-receipt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return path.join(root, "receipt.json");
}

test("business dedupe and Message-ID are stable but change with semantic payload or epoch", () => {
  const first = notificationIdentity(base);
  const repeated = notificationIdentity(base);
  const changedPayload = notificationIdentity({ ...base, payload: { ...base.payload, text: "changed" } });
  const changedEpoch = notificationIdentity({ ...base, eventEpoch: "run-1:stage2:next" });
  assert.deepEqual(first, repeated);
  assert.notEqual(first.dedupeKey, changedPayload.dedupeKey);
  assert.notEqual(first.messageId, changedEpoch.messageId);
});

test("receipt exists atomically before the SMTP call", async (t) => {
  const receiptPath = await fixture(t);
  let observed;
  const result = await deliverReliableNotification({ ...base, receiptPath, transport: async () => {
    observed = await readNotificationReceipt(receiptPath);
    return { accepted: true, acceptedCount: 1 };
  } });
  assert.equal(observed.status, "pending");
  assert.equal(observed.attempts, 1);
  assert.equal(result.status, "accepted");
});

test("crash after pending but before request leaves a safely retryable receipt", async (t) => {
  const receiptPath = await fixture(t);
  await assert.rejects(deliverReliableNotification({ ...base, receiptPath, hooks: { afterPending: () => { throw new Error("crash-before-request"); } }, transport: async () => assert.fail("must not send") }), /crash-before-request/);
  assert.equal((await readNotificationReceipt(receiptPath)).attempts, 0);
  let calls = 0;
  const retried = await deliverReliableNotification({ ...base, receiptPath, transport: async () => { calls += 1; return { accepted: true, acceptedCount: 1 }; } });
  assert.equal(retried.status, "accepted");
  assert.equal(calls, 1);
});

test("interruption after attempt start is conservatively converted to unknown", async (t) => {
  const receiptPath = await fixture(t);
  await assert.rejects(deliverReliableNotification({ ...base, receiptPath, hooks: { afterAttemptStarted: () => { throw new Error("process-crash"); } }, transport: async () => assert.fail("must not send") }), /process-crash/);
  assert.equal((await readNotificationReceipt(receiptPath)).attempts, 1);
  let calls = 0;
  const resumed = await deliverReliableNotification({ ...base, receiptPath, transport: async () => { calls += 1; } });
  assert.equal(resumed.status, "unknown");
  assert.equal(calls, 0);
  assert.equal((await readNotificationReceipt(receiptPath)).status, "unknown");
});

test("explicit acceptance and rejection become accepted and failed", async (t) => {
  const acceptedPath = await fixture(t);
  const failedPath = await fixture(t);
  assert.equal((await deliverReliableNotification({ ...base, receiptPath: acceptedPath, transport: async () => ({ accepted: true, acceptedCount: 1, responseCode: 250 }) })).status, "accepted");
  assert.equal((await deliverReliableNotification({ ...base, receiptPath: failedPath, transport: async () => ({ accepted: false, rejectedCount: 1, responseCode: 550 }) })).status, "failed");
});

test("transient receipt rename after SMTP acceptance preserves the accepted outcome", async (t) => {
  const receiptPath = await fixture(t);
  const fsApi = Object.create(fs);
  let renames = 0;
  let sends = 0;
  fsApi.rename = async (source, target) => {
    renames += 1;
    if (renames === 3) throw Object.assign(new Error("transient rename contention"), { code: "EACCES" });
    return fs.rename(source, target);
  };
  const result = await deliverReliableNotification({
    ...base,
    receiptPath,
    fsApi,
    transport: async () => { sends += 1; return { accepted: true, acceptedCount: 1 }; },
  });
  assert.equal(result.status, "accepted");
  assert.equal((await readNotificationReceipt(receiptPath)).status, "accepted");
  assert.equal(sends, 1);
  assert.equal(renames, 4);
});

test("timeout and accepted-before-receipt crash become unknown", async (t) => {
  const timeoutPath = await fixture(t);
  const crashPath = await fixture(t);
  const timeout = await deliverReliableNotification({ ...base, receiptPath: timeoutPath, transport: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } });
  assert.equal(timeout.status, "unknown");
  const crashed = await deliverReliableNotification({ ...base, receiptPath: crashPath, transport: async () => ({ accepted: true, acceptedCount: 1 }), hooks: { afterAcceptedBeforeReceipt: () => { throw new Error("crash-after-accept"); } } });
  assert.equal(crashed.status, "unknown");
  assert.equal((await readNotificationReceipt(crashPath)).lastSmtp.category, "smtp_result_ambiguous");
});

test("accepted and unknown receipts never auto-resend", async (t) => {
  const acceptedPath = await fixture(t);
  const unknownPath = await fixture(t);
  let acceptedCalls = 0;
  const acceptedInput = { ...base, receiptPath: acceptedPath, transport: async () => { acceptedCalls += 1; return { accepted: true, acceptedCount: 1 }; } };
  await deliverReliableNotification(acceptedInput);
  await deliverReliableNotification(acceptedInput);
  assert.equal(acceptedCalls, 1);
  let unknownCalls = 0;
  const unknownInput = { ...base, receiptPath: unknownPath, transport: async () => { unknownCalls += 1; throw Object.assign(new Error("lost"), { code: "ECONNRESET" }); } };
  await deliverReliableNotification(unknownInput);
  const repeated = await deliverReliableNotification(unknownInput);
  assert.equal(repeated.status, "unknown");
  assert.equal(unknownCalls, 1);
});

test("failed receipt retries with the same stable Message-ID", async (t) => {
  const receiptPath = await fixture(t);
  const ids = [];
  let attempt = 0;
  const result = async (message) => { ids.push(message.messageId); attempt += 1; return attempt === 1 ? { accepted: false, rejectedCount: 1 } : { accepted: true, acceptedCount: 1 }; };
  assert.equal((await deliverReliableNotification({ ...base, receiptPath, transport: result })).status, "failed");
  assert.equal((await deliverReliableNotification({ ...base, receiptPath, transport: result })).status, "accepted");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
});

test("receipt persistence failure prevents SMTP", async (t) => {
  const receiptPath = await fixture(t);
  let calls = 0;
  const fsApi = { ...fs, rename: async () => { throw new Error("receipt-rename-failed"); } };
  await assert.rejects(deliverReliableNotification({ ...base, receiptPath, fsApi, transport: async () => { calls += 1; } }), /receipt-rename-failed/);
  assert.equal(calls, 0);
});

test("unknown receipt schema is rejected without overwrite or SMTP", async (t) => {
  const receiptPath = await fixture(t);
  const raw = '{"schemaVersion":999,"status":"accepted"}\n';
  await fs.writeFile(receiptPath, raw);
  let calls = 0;
  await assert.rejects(deliverReliableNotification({ ...base, receiptPath, transport: async () => { calls += 1; } }), /NOTIFICATION_RECEIPT_SCHEMA_UNSUPPORTED_999/);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(receiptPath, "utf8"), raw);
});
