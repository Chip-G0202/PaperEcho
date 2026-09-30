import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { readNotificationReceipt, notificationIdentity, recipientHash } from "../stage5/email_receipt.mjs";
import { renderWeeklyReport } from "../stage5/report_summary.mjs";
import { formatRadarReport } from "../stage5/radar_report.mjs";
import { deliverReliableNotification } from "../notification/delivery.mjs";
import { completeLedgerNotification } from "../notification/ledger_bridge.mjs";
import { canonicalQueryHash } from "../stage1/source_state.mjs";
import { channelDeliveryPolicy } from '../notification/policy.mjs';
import { CHANNEL_IDS, channelConfiguration, channelRecipient, createChannelTransport, renderChannelNotification } from '../notification/channels.mjs';

// Called only after the formal resume owner validates the run, lease and artifact.
export async function resumeCompletedBusinessNotification(options = {}) {
  const operations = options.store.ledger.operations.filter(item => item.type === 'notification');
  const channels = operations.map(item => item.intent?.channel || 'email');
  if (operations.length <= 1 && (channels[0] || 'email') === 'email') return resumeOneNotification(options);
  if (new Set(channels).size !== channels.length || channels.some(channel => !CHANNEL_IDS.includes(channel))) return { status: 'blocked', reason: 'notification_operation_ambiguous', notificationOnly: true };
  const results = [];
  for (const operation of operations) {
    const channel = operation.intent?.channel || 'email';
    let result;
    try { result = await resumeOneNotification({ ...options, operation }); }
    catch { result = { status: 'blocked', reason: 'notification_recovery_unavailable', notificationOnly: true }; }
    if (!result) return null;
    results.push({ channel, ...result });
  }
  const completed = results.every(result => result.status === 'completed');
  await options.store.setStage('stage5_notification', completed ? 'verified' : 'failed', { status: completed ? 'accepted' : 'incomplete' });
  await options.store.setRunStatus(completed ? 'completed' : 'incomplete', completed ? 'completed' : undefined);
  return { status: completed ? 'completed' : 'incomplete', businessStatus: 'success', notificationOnly: true,
    channels: results, outcomes: results.flatMap(result => result.outcomes || []), ...(!completed ? { reason: 'channel_delivery_incomplete' } : {}) };
}

async function resumeOneNotification({ store, recipient = "", transport, qqTransport, channelTransports = {}, recordRadarOutcome, env = process.env, fsApi = fs, operation: selectedOperation } = {}) {
  const { ledger } = store;
  const operations = ledger.operations.filter((item) => item.type === "notification");
  if (!operations.length || ledger.operations.some((item) => item.type !== "notification" && item.status !== "verified")) return null;
  const blocked = (reason) => ({ status: "blocked", reason, notificationOnly: true });
  const stages = ledger.stages || {};
  const required = ledger.profile === "radar" ? ["stage1"] : ledger.mode === "local" ? ["stage1", "state_persist", "stage4_exports"] : ["stage1", "stage2_writeback", "stage3_translation", "stage4_exports"];
  if (!required.every((name) => stages[name]?.status === "verified")) return blocked("notification_business_not_verified");
  if (ledger.profile === "radar" && !["stage2_writeback", "stage3_translation", "stage4_exports"].every((name) => stages[name]?.status === "skipped")) return blocked("radar_business_not_verified");
  if ((!selectedOperation && operations.length !== 1) || (selectedOperation || operations[0]).status === "conflict") return blocked("notification_operation_ambiguous");
  const operation = selectedOperation || operations[0];
  const channel = operation.intent?.channel || 'email';
  if (!CHANNEL_IDS.includes(channel)) return blocked('notification_operation_ambiguous');
  if (channel !== 'email') {
    const configuration = channelConfiguration(channel, { env });
    recipient = channelRecipient(channel, configuration, env);
    transport = channelTransports[channel] || (channel === 'qq' ? qqTransport : null) || createChannelTransport(channel, configuration, env);
  }
  const expectedType = ledger.profile === "radar" ? "radar_business" : "run_summary";
  if (operation.intent?.notificationType !== expectedType || operation.intent?.eventEpoch !== ledger.runId) return blocked("notification_event_mismatch");
  const receiptPath = path.resolve(operation.target.receiptPath || operation.target.path || "");
  const relative = path.relative(path.dirname(store.filePath), receiptPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return blocked("notification_receipt_path_invalid");
  let receipt;
  try { receipt = await readNotificationReceipt(receiptPath, { fsApi }); }
  catch { return blocked("notification_receipt_unreadable"); }
  if (!receipt || receipt.runId !== ledger.runId || receipt.notificationType !== expectedType || receipt.eventEpoch !== ledger.runId
    || receipt.businessSubject !== (ledger.profile === "radar" ? "urgent_a_aggregate" : ledger.runId)
    || (receipt.channel || 'email') !== channel || receipt.ledgerOperationId !== operation.idempotencyKey || !recipient || receipt.recipientHash !== recipientHash(recipient, channel)) return blocked("notification_receipt_identity_mismatch");
  if (receipt.status === "unknown" || (receipt.status === "pending" && receipt.attempts > 0)) return blocked("notification_possibly_accepted");
  if (operation.status === "verified" && receipt.status !== "accepted") return blocked("notification_receipt_ledger_conflict");
  const radarSelection = receipt.recoveryData?.radarSelection;
  if (operation.intent.radarCompletionHash && (!Array.isArray(radarSelection) || canonicalQueryHash(radarSelection) !== operation.intent.radarCompletionHash || typeof recordRadarOutcome !== "function")) return blocked("radar_notification_completion_unverified");
  let delivered = { status: "accepted", receipt, receiptPath, attempted: false };
  if (receipt.status !== "accepted") {
    if (channel !== 'email' && !channelDeliveryPolicy(channel, ledger.profile === 'radar' ? 'radar' : 'weekly', { env }).required) return blocked('notification_channel_disabled');
    const data = receipt.recoveryData;
    const eventType = ledger.profile === "radar" ? "radar_completed" : "weekly_completed";
    if (!data || data.content?.eventType !== eventType || data.content.runId !== ledger.runId || !Array.isArray(data.attachments) || !Array.isArray(data.attachmentHashes)) return blocked("notification_recovery_content_missing");
    let payload;
    try {
      payload = channel !== 'email' ? renderChannelNotification(channel, data.content) : { ...(eventType === "radar_completed" ? formatRadarReport(data.content) : renderWeeklyReport(data.content)), attachments: data.attachments };
      const identity = notificationIdentity({ notificationType: receipt.notificationType, businessSubject: receipt.businessSubject, eventEpoch: receipt.eventEpoch, payload, channel });
      if (["payloadHash", "dedupeKey", "receiptId", "messageId"].some((key) => identity[key] !== receipt[key])) return blocked("notification_payload_changed");
      if (data.attachments.length !== data.attachmentHashes.length) return blocked("notification_attachment_changed");
      for (const [index, item] of data.attachments.entries()) {
        const actualHash = createHash("sha256").update(await fsApi.readFile(item.path)).digest("hex");
        if (actualHash !== data.attachmentHashes[index]) return blocked("notification_attachment_changed");
      }
    } catch { return blocked("notification_recovery_content_invalid"); }
    delivered = await deliverReliableNotification({ receiptPath, notificationType: receipt.notificationType, runId: ledger.runId, businessSubject: receipt.businessSubject, eventEpoch: receipt.eventEpoch, payload, recipient, ledgerOperationId: operation.idempotencyKey, transport, env, fsApi, channel });
  }
  if (operation.intent.radarCompletionHash) {
    const recorded = await recordRadarOutcome(radarSelection, delivered);
    if (recorded?.ok !== true) return blocked("radar_notification_completion_failed");
  }
  await completeLedgerNotification(store, operation, delivered);
  await store.setStage("stage5_notification", delivered.status === "accepted" ? "verified" : "failed", { status: delivered.status });
  if (delivered.status !== "accepted") return { status: "incomplete", notificationOnly: true, reason: delivered.reason };
  await store.setRunStatus("completed", "completed");
  return { status: "completed", notificationOnly: true, outcomes: [{ idempotencyKey: operation.idempotencyKey, status: "verified", action: delivered.attempted ? "notification_retried" : "already_accepted" }] };
}
