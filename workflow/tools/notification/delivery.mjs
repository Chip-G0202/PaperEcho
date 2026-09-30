import fs from "node:fs/promises";

import {
  createNotificationReceipt,
  readNotificationReceipt,
  validateNotificationReceipt,
  withReceiptLock,
  writeNotificationReceipt,
} from "../stage5/email_receipt.mjs";
import { sendStage5Email } from "../stage5/email_sender.mjs";

const DEFINITIVE_FAILURE_CATEGORIES = new Set([
  "attachment_blocked", "attachment_limit", "attachment_path_blocked", "attachment_unreadable",
  "recipient_invalid", "smtp_config_invalid", "transport_not_configured",
]);
const DEFINITIVE_FAILURE_CODES = new Set(["EAUTH", "EENVELOPE", "EMESSAGE", "ENOTFOUND"]);
const AMBIGUOUS_CODES = new Set(["ETIMEDOUT", "ESOCKET", "ECONNRESET", "ECONNABORTED", "EPIPE"]);

function nowIso(clock) { return (clock ? clock() : new Date()).toISOString(); }
function safeCategory(value, fallback) {
  const normalized = String(value || fallback).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 80);
  return normalized || fallback;
}

function smtpSummary(outcome, details = {}) {
  return {
    outcome,
    category: safeCategory(details.category, outcome),
    responseCode: Number.isInteger(details.responseCode) ? details.responseCode : null,
    acceptedCount: Number.isInteger(details.acceptedCount) ? details.acceptedCount : 0,
    rejectedCount: Number.isInteger(details.rejectedCount) ? details.rejectedCount : 0,
  };
}
function providerMetadata(result) {
  if (result?.provider !== 'wxpusher' || !Array.isArray(result.sendRecordIds) || !result.sendRecordIds.every(id => Number.isSafeInteger(id) && id > 0) || result.sendRecordIds.length > 10) return undefined;
  return { provider: 'wxpusher', sendRecordIds: [...result.sendRecordIds] };
}

function acceptedResult(result) {
  if (result?.accepted === true) return true;
  if (Array.isArray(result?.accepted)) return result.accepted.length > 0;
  return Number(result?.acceptedCount || 0) > 0;
}

function definitiveRejected(result) {
  return result?.accepted === false || (Array.isArray(result?.accepted) && result.accepted.length === 0 && Number(result?.rejectedCount ?? result?.rejected?.length ?? 0) > 0);
}

function errorOutcome(error) {
  const category = safeCategory(error?.category || error?.code, "smtp_result_ambiguous");
  if (DEFINITIVE_FAILURE_CATEGORIES.has(category) || DEFINITIVE_FAILURE_CODES.has(String(error?.code || ""))) return { status: "failed", category };
  if (AMBIGUOUS_CODES.has(String(error?.code || "")) || /timeout|timed_out|disconnect|connection_lost/i.test(category)) return { status: "unknown", category };
  return { status: "unknown", category };
}

function sameReceipt(previous, planned) {
  return previous?.schemaVersion === planned.schemaVersion
    && previous.receiptId === planned.receiptId
    && previous.dedupeKey === planned.dedupeKey
    && previous.payloadHash === planned.payloadHash
    && previous.recipientHash === planned.recipientHash;
}

export async function deliverReliableNotification({
  receiptPath,
  legacyReceiptPath = "",
  notificationType,
  runId,
  businessSubject,
  eventEpoch,
  payload,
  recipient,
  ledgerOperationId = "",
  retryFailed = true,
  force = false,
  transport,
  env = process.env,
  fsApi = fs,
  clock = () => new Date(),
  hooks = {},
  recoveryData = null,
  channel = 'email',
  prepareOnly = false,
} = {}) {
  const planned = createNotificationReceipt({ notificationType, runId, businessSubject, eventEpoch, payload, ledgerOperationId, recipient, clock, channel });
  if (recoveryData) planned.recoveryData = structuredClone(recoveryData);
  const locked = await withReceiptLock(receiptPath, async () => {
    let previous = await readNotificationReceipt(receiptPath, { fsApi, allowLegacy: true })
      || (legacyReceiptPath && legacyReceiptPath !== receiptPath ? await readNotificationReceipt(legacyReceiptPath, { fsApi, allowLegacy: true }) : null);
    if (previous?.schemaVersion === 1) {
      if (!force && previous.status === "sent" && previous.runId === runId && previous.recipientHash === planned.recipientHash) {
        return { status: "accepted", reason: "already_accepted", receipt: previous, receiptPath, attempted: false };
      }
      previous = null;
    }
    if (previous && !sameReceipt(previous, planned)) throw new Error("NOTIFICATION_RECEIPT_DEDUPE_CONFLICT");
    if (previous?.status === "accepted" && !force) return { status: "accepted", reason: "already_accepted", receipt: previous, receiptPath, attempted: false };
    if (previous?.status === "unknown" && !force) return { status: "unknown", reason: "possibly_accepted_no_retry", receipt: previous, receiptPath, attempted: false };
    if (previous?.status === "pending" && previous.attempts > 0 && !force) {
      const uncertain = validateNotificationReceipt({ ...previous, status: "unknown", updatedAt: nowIso(clock), lastSmtp: smtpSummary("unknown", { category: "interrupted_after_attempt_started" }) });
      await writeNotificationReceipt(receiptPath, uncertain, { fsApi });
      return { status: "unknown", reason: "possibly_accepted_no_retry", receipt: uncertain, receiptPath, attempted: false };
    }
    if (previous?.status === "failed" && !retryFailed) return { status: "failed", reason: "retry_disabled", receipt: previous, receiptPath, attempted: false };

    let receipt = previous && !force ? previous : planned;
    if (!previous || force) await writeNotificationReceipt(receiptPath, receipt, { fsApi });
    if (prepareOnly) return { status: receipt.status, reason: 'delivery_prepared', receipt, receiptPath, attempted: false };
    await hooks.afterPending?.({ receipt: structuredClone(receipt), receiptPath });

    receipt = validateNotificationReceipt({
      ...receipt,
      status: "pending",
      attempts: receipt.attempts + 1,
      updatedAt: nowIso(clock),
      lastSmtp: smtpSummary("started", { category: "smtp_call_started" }),
    });
    await writeNotificationReceipt(receiptPath, receipt, { fsApi });
    await hooks.afterAttemptStarted?.({ receipt: structuredClone(receipt), receiptPath });

    try {
      const send = transport || ((message) => sendStage5Email(message, { env }));
      let result;
      if (Array.isArray(payload.messages)) {
        if (!payload.messages.length || payload.messages.length > 10) throw new Error('NOTIFICATION_PARTS_INVALID');
        receipt.parts ||= payload.messages.map((_, index) => ({ index, status: 'pending' }));
        if (receipt.parts.length !== payload.messages.length) throw new Error('NOTIFICATION_PARTS_INVALID');
        for (const [index, message] of payload.messages.entries()) {
          const part = receipt.parts[index];
          if (part.status === 'accepted') continue;
          if (['unknown', 'started'].includes(part.status)) { result = { category: 'provider_response_ambiguous' }; break; }
          part.status = 'started'; part.at = nowIso(clock); await writeNotificationReceipt(receiptPath, receipt, { fsApi });
          result = await send({ ...message, to: recipient, messageId: receipt.messageId });
          part.status = acceptedResult(result) ? 'accepted' : definitiveRejected(result) ? 'failed' : 'unknown';
          part.at = nowIso(clock); const metadata = providerMetadata(result); if (metadata) part.provider = metadata;
          await writeNotificationReceipt(receiptPath, receipt, { fsApi });
          if (part.status !== 'accepted') break;
        }
        if (receipt.parts.every(part => part.status === 'accepted')) result = { accepted: true };
      } else result = await send({ ...payload, to: recipient, messageId: receipt.messageId });
      if (acceptedResult(result)) {
        await hooks.afterAcceptedBeforeReceipt?.({ result, receipt: structuredClone(receipt), receiptPath });
        const accepted = validateNotificationReceipt({
          ...receipt,
          status: "accepted",
          updatedAt: nowIso(clock),
          lastSmtp: smtpSummary("accepted", result),
        });
        await writeNotificationReceipt(receiptPath, accepted, { fsApi });
        return { status: "accepted", reason: "accepted", receipt: accepted, receiptPath, attempted: true };
      }
      const status = definitiveRejected(result) ? "failed" : "unknown";
      const updated = validateNotificationReceipt({
        ...receipt,
        status,
        updatedAt: nowIso(clock),
        lastSmtp: smtpSummary(status, { ...result, category: channel !== 'email' && /^(?:qq_(authentication|authorization|invalid_destination|rate_limited|invalid_payload|provider_unavailable|unknown|network|response_ambiguous|configuration_invalid)|provider_(configuration_invalid|payload_invalid|rejected|rate_limited|network|response_ambiguous))$/.test(result?.category) ? result.category : status === "failed" ? "smtp_rejected" : "smtp_result_ambiguous" }),
      });
      await writeNotificationReceipt(receiptPath, updated, { fsApi });
      return { status, reason: updated.lastSmtp.category, receipt: updated, receiptPath, attempted: true };
    } catch (error) {
      const outcome = errorOutcome(error);
      const updated = validateNotificationReceipt({
        ...receipt,
        status: outcome.status,
        updatedAt: nowIso(clock),
        lastSmtp: smtpSummary(outcome.status, { category: outcome.category }),
      });
      await writeNotificationReceipt(receiptPath, updated, { fsApi });
      return { status: outcome.status, reason: outcome.category, receipt: updated, receiptPath, attempted: true };
    }
  }, { fsApi });
  return locked.locked ? locked.value : { status: "pending", reason: "delivery_in_progress", receiptPath, attempted: false };
}
