import fs from "node:fs/promises";
import path from "node:path";

import { OperationLedgerStore } from "../recovery/operation_ledger.mjs";
import { canonicalQueryHash, writeAtomicJson } from "../stage1/source_state.mjs";
import { emailTransportConfig } from "../stage5/email_sender.mjs";
import { createNotificationReceipt, notificationReceiptPathFor } from "../stage5/email_receipt.mjs";
import { deliverReliableNotification } from "./delivery.mjs";
import { completeLedgerNotification } from "./ledger_bridge.mjs";
import { emailDeliveryPolicy } from './policy.mjs';

export const HEALTH_NOTIFICATION_STATE_SCHEMA_VERSION = 1;
export const MAX_HEALTH_NOTIFICATIONS_PER_RUN = 5;

function enabled(value) { return /^(1|true|yes|on)$/i.test(String(value || "")); }
function nowIso(clock) { return (clock ? clock() : new Date()).toISOString(); }
function safeToken(value, fallback = "unknown") { return String(value || fallback).replace(/[^A-Za-z0-9._:-]+/g, "_").slice(0, 180) || fallback; }
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }

export function healthStatePath(root, healthKey) {
  return path.join(path.resolve(root), `v${HEALTH_NOTIFICATION_STATE_SCHEMA_VERSION}`, `${canonicalQueryHash(String(healthKey || ""))}.json`);
}
export function validateHealthNotificationState(state) {
  if (state?.schemaVersion !== HEALTH_NOTIFICATION_STATE_SCHEMA_VERSION) throw new Error(`HEALTH_NOTIFICATION_SCHEMA_UNSUPPORTED_${state?.schemaVersion ?? "missing"}`);
  if (!new Set(["healthy", "degraded"]).has(state.status)) throw new Error("HEALTH_NOTIFICATION_STATUS_INVALID");
  if (!Number.isSafeInteger(state.consecutiveDegraded) || state.consecutiveDegraded < 0 || !Number.isSafeInteger(state.epoch) || state.epoch < 0) throw new Error("HEALTH_NOTIFICATION_COUNTER_INVALID");
  return state;
}

async function loadHealthState(filePath, healthKey, kind, fsApi) {
  try { return validateHealthNotificationState(JSON.parse(await fsApi.readFile(filePath, "utf8"))); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { schemaVersion: HEALTH_NOTIFICATION_STATE_SCHEMA_VERSION, healthKey, kind, status: "healthy", consecutiveDegraded: 0, epoch: 0, degradationNotified: false, pendingEvent: null, createdAt: null, updatedAt: null };
  }
}

export function advanceHealthNotificationState(previous, observation, { threshold = 2, clock = () => new Date() } = {}) {
  const now = nowIso(clock);
  const next = { ...previous, healthKey: observation.healthKey, kind: observation.kind, updatedAt: now, createdAt: previous.createdAt || now };
  if (next.pendingEvent) return validateHealthNotificationState(next);
  if (observation.degraded) {
    if (next.status === "degraded") return validateHealthNotificationState(next);
    next.consecutiveDegraded += 1;
    if (next.consecutiveDegraded >= threshold) {
      next.status = "degraded";
      next.epoch += 1;
      next.degradationNotified = false;
      next.pendingEvent = { type: "degradation", epoch: next.epoch, subject: observation.subject || {} };
    }
    return validateHealthNotificationState(next);
  }
  next.consecutiveDegraded = 0;
  if (next.status === "degraded") {
    next.status = "healthy";
    if (next.degradationNotified) next.pendingEvent = { type: "recovery", epoch: next.epoch, subject: observation.subject || {} };
  }
  return validateHealthNotificationState(next);
}

function eventNotificationType(kind, eventType) {
  const prefix = kind === "llm" ? "llm" : "source";
  return `${prefix}_${eventType}`;
}

function eventPayload(state) {
  const recovery = state.pendingEvent.type === "recovery";
  const label = state.kind === "llm" ? "LLM" : "来源";
  const subject = safeToken(state.pendingEvent.subject?.source || state.pendingEvent.subject?.label || state.healthKey);
  const status = recovery ? "恢复" : "连续降级";
  const lines = [`PaperEcho ${label}${status}`, `对象: ${subject}`, `事件轮次: ${state.epoch}`];
  return { subject: `PaperEcho ${label}${status}`, text: lines.join("\n"), html: `<p>PaperEcho ${label}${status}</p><p>对象: ${escapeHtml(subject)}</p><p>事件轮次: ${state.epoch}</p>`, attachments: [] };
}

export async function processHealthNotifications({
  runRoot,
  runId,
  observations = [],
  recipient,
  env = process.env,
  transport,
  fsApi = fs,
  clock = () => new Date(),
} = {}) {
  if (Number(env.PAPERECHO_CONFIG_SCHEMA_VERSION || 0) < 2 || !enabled(env.PAPERECHO_HEALTH_NOTIFIER_ENABLED) || !emailDeliveryPolicy('health', { env }).required) return { status: "disabled", reason: "health_notifier_disabled", events: [] };
  const healthRoot = path.resolve(env.PAPERECHO_NOTIFICATION_HEALTH_ROOT || path.join(path.dirname(path.resolve(runRoot)), "notification_health"));
  const receiptRoot = path.resolve(env.PAPERECHO_NOTIFICATION_RECEIPT_ROOT || path.join(path.dirname(path.resolve(runRoot)), "notification_receipts"));
  const threshold = Math.max(2, Number(env.PAPERECHO_HEALTH_DEGRADATION_THRESHOLD || 2) || 2);
  const smtp = emailTransportConfig(env);
  const canSend = Boolean(String(recipient || "").trim() && (transport || smtp.configured));
  const store = await OperationLedgerStore.load({ runRoot, runId }, { fsApi, clock });
  const events = [];
  const unique = new Map(observations.filter((item) => item?.healthKey && ["source_availability", "source_yield", "llm"].includes(item.kind)).map((item) => [item.healthKey, item]));
  for (const observation of unique.values()) {
    const statePath = healthStatePath(healthRoot, observation.healthKey);
    const previous = await loadHealthState(statePath, observation.healthKey, observation.kind, fsApi);
    let state = advanceHealthNotificationState(previous, observation, { threshold, clock });
    await writeAtomicJson(statePath, state, { fsApi });
    if (!state.pendingEvent) continue;
    if (!canSend || events.length >= MAX_HEALTH_NOTIFICATIONS_PER_RUN) {
      events.push({ healthKey: observation.healthKey, status: canSend ? "bounded" : "configuration_incomplete", event: state.pendingEvent.type });
      continue;
    }
    const notificationType = eventNotificationType(state.kind, state.pendingEvent.type);
    const payload = eventPayload(state);
    const businessSubject = state.healthKey;
    const eventEpoch = `${state.epoch}:${state.pendingEvent.type}`;
    const plannedReceipt = createNotificationReceipt({ notificationType, runId, businessSubject, eventEpoch, payload, recipient, clock });
    const receiptPath = notificationReceiptPathFor(receiptRoot, plannedReceipt.receiptId);
    const operation = await store.planOperation({
      type: "notification",
      identity: "run",
      target: { id: plannedReceipt.receiptId, path: receiptPath, receiptPath },
      input: { notificationType, businessSubject, eventEpoch, payloadHash: plannedReceipt.payloadHash },
      inputVersion: "notification-receipt-v2",
      retryable: true,
      intent: { notificationType, healthKey: state.healthKey, eventEpoch },
    });
    const current = store.ledger.operations.find((item) => item.idempotencyKey === operation.idempotencyKey);
    if (current.status === "pending" || current.status === "failed") await store.transition(current.idempotencyKey, "started");
    const delivery = await deliverReliableNotification({ receiptPath, notificationType, runId, businessSubject, eventEpoch, payload, recipient, ledgerOperationId: operation.idempotencyKey, retryFailed: enabled(env.PAPERECHO_NOTIFICATION_RETRY_FAILED || "true"), transport, env, fsApi, clock });
    await completeLedgerNotification(store, operation, delivery);
    if (["accepted", "unknown"].includes(delivery.status)) {
      state = { ...state, degradationNotified: state.pendingEvent.type === "degradation" ? true : state.degradationNotified, pendingEvent: null, updatedAt: nowIso(clock), lastDeliveryStatus: delivery.status };
      await writeAtomicJson(statePath, validateHealthNotificationState(state), { fsApi });
    }
    events.push({ healthKey: observation.healthKey, status: delivery.status, event: state.pendingEvent?.type || notificationType });
  }
  return { status: "processed", events, maxNotifications: MAX_HEALTH_NOTIFICATIONS_PER_RUN };
}
