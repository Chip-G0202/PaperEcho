import fs from "node:fs/promises";
import path from "node:path";

import { OperationLedgerStore, validateRecoveryRunId } from "../recovery/operation_ledger.mjs";
import { emailTransportConfig } from "../stage5/email_sender.mjs";
import { createNotificationReceipt, notificationReceiptPathFor } from "../stage5/email_receipt.mjs";
import { deliverReliableNotification } from "./delivery.mjs";
import { completeLedgerNotification } from "./ledger_bridge.mjs";
import { emailDeliveryPolicy } from './policy.mjs';

function enabled(value) { return /^(1|true|yes|on)$/i.test(String(value || "")); }
function safeToken(value, fallback = "unknown") {
  return String(value || fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || fallback;
}
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

export function failureNotificationPayload({ runId, failureStage, recoverable, errorCategory }) {
  const stage = safeToken(failureStage, "pipeline");
  const category = safeToken(errorCategory, "pipeline_failed");
  const resume = recoverable ? `请通过原 launcher 执行 --resume ${runId}` : "关键 artifact 尚未安全持久化，本轮不可安全 resume。";
  const lines = [`PaperEcho 运行失败`, `runId: ${runId}`, `失败阶段: ${stage}`, `可恢复: ${recoverable ? "是" : "否"}`, `错误分类: ${category}`, resume];
  return {
    subject: `PaperEcho 运行失败：${stage}`,
    text: lines.join("\n"),
    html: `<p>PaperEcho 运行失败</p><p>runId: ${escapeHtml(runId)}</p><p>失败阶段: ${escapeHtml(stage)}</p><p>可恢复: ${recoverable ? "是" : "否"}</p><p>错误分类: ${escapeHtml(category)}</p><p>${escapeHtml(resume)}</p>`,
    attachments: [],
  };
}

export async function notifyRunFailure({
  runRoot,
  runId,
  failureStage,
  errorCategory,
  recipient,
  env = process.env,
  transport,
  fsApi = fs,
  clock = () => new Date(),
  hooks = {},
} = {}) {
  if (Number(env.PAPERECHO_CONFIG_SCHEMA_VERSION || 0) < 2 || !enabled(env.PAPERECHO_FAILURE_NOTIFIER_ENABLED) || !emailDeliveryPolicy('failure', { env }).required) return { status: "disabled", reason: "failure_notifier_disabled" };
  if (!String(recipient || "").trim()) return { status: "disabled", reason: "recipient_not_configured" };
  const smtp = emailTransportConfig(env);
  if (!transport && !smtp.configured) return { status: "disabled", reason: "smtp_configuration_incomplete", missing: smtp.missing };
  const safeRunId = validateRecoveryRunId(runId);
  const store = await OperationLedgerStore.load({ runRoot, runId: safeRunId }, { fsApi, clock });
  const recoverable = /^[a-f0-9]{64}$/.test(String(store.ledger.artifact?.hash || ""));
  const stage = safeToken(failureStage, "pipeline");
  const category = safeToken(errorCategory, "pipeline_failed");
  const payload = failureNotificationPayload({ runId: safeRunId, failureStage: stage, recoverable, errorCategory: category });
  const businessSubject = `${safeRunId}:${stage}`;
  const eventEpoch = `${safeRunId}:${stage}`;
  const plannedReceipt = createNotificationReceipt({ notificationType: "run_failure", runId: safeRunId, businessSubject, eventEpoch, payload, recipient, clock });
  const receiptRoot = path.resolve(env.PAPERECHO_NOTIFICATION_RECEIPT_ROOT || path.join(path.dirname(path.resolve(runRoot)), "notification_receipts"));
  const receiptPath = notificationReceiptPathFor(receiptRoot, plannedReceipt.receiptId);
  const operation = await store.planOperation({
    type: "notification",
    identity: "run",
    target: { id: plannedReceipt.receiptId, path: receiptPath, receiptPath },
    input: { notificationType: "run_failure", businessSubject, eventEpoch, payloadHash: plannedReceipt.payloadHash },
    inputVersion: "notification-receipt-v2",
    retryable: true,
    intent: { notificationType: "run_failure", failureStage: stage, recoverable, errorCategory: category, eventEpoch },
  });
  let current = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
  if (current.status === "conflict") return { status: "conflict", reason: "ledger_operation_conflict" };
  if (current.status === "pending" || current.status === "failed") await store.transition(current.idempotencyKey, "started");
  const delivery = await deliverReliableNotification({ receiptPath, notificationType: "run_failure", runId: safeRunId, businessSubject, eventEpoch, payload, recipient, ledgerOperationId: operation.idempotencyKey, retryFailed: enabled(env.PAPERECHO_NOTIFICATION_RETRY_FAILED || "true"), transport, env, fsApi, clock, hooks });
  await completeLedgerNotification(store, operation, delivery);
  return { ...delivery, recoverable, failureStage: stage };
}
