import path from "node:path";

import { deliverReliableNotification } from "../notification/delivery.mjs";
import { notificationIdentity, notificationReceiptPathFor, notificationRecoveryData } from "./email_receipt.mjs";

import { buildRadarNotificationContent } from "./notification_content.mjs";
import { formatRadarReport } from "./radar_report.mjs";
import { emailDeliveryPolicy } from '../notification/policy.mjs';
import { channelDeliveryPolicy } from '../notification/policy.mjs';
import { deliverBusinessChannels } from '../notification/channel_delivery.mjs';
import { canonicalQueryHash } from '../stage1/source_state.mjs';

export function buildRadarAggregateMessage(items = [], context = {}) {
  return formatRadarReport(buildRadarNotificationContent(items, context));
}

export function radarNotificationReceiptPath(runStateRoot, runId, urgentItems = [], audit = {}) {
  const payload = buildRadarAggregateMessage(urgentItems, { runId, audit });
  const identity = notificationIdentity({ notificationType: "radar_business", businessSubject: "urgent_a_aggregate", eventEpoch: runId, payload });
  return notificationReceiptPathFor(path.resolve(runStateRoot), identity.receiptId);
}

export async function sendRadarAggregateNotification(options = {}) {
  if (Number((options.env || process.env).PAPERECHO_CONFIG_SCHEMA_VERSION) >= 5 || options.urgentItems?.length && channelDeliveryPolicy('qq', 'radar', { env: options.env || process.env }).required) {
    const content = buildRadarNotificationContent(options.urgentItems, { runId: options.runId, audit: options.audit });
    return deliverBusinessChannels({ content, env: options.env || process.env, runStateRoot: options.runStateRoot,
      recoveryCoordinator: options.recoveryCoordinator, qqTransport: options.qqTransport, fsApi: options.fsApi, clock: options.clock,
      radarSelection: options.notificationSelection || [], radarCompletionHash: canonicalQueryHash(options.notificationSelection || []),
      emailDelivery: () => sendEmailRadarAggregateNotification(options) });
  }
  return sendEmailRadarAggregateNotification(options);
}

async function sendEmailRadarAggregateNotification({
  runId,
  urgentItems = [],
  audit = {},
  notificationSelection = [],
  recipient,
  runStateRoot,
  transport,
  env = process.env,
  fsApi,
  clock,
  ledgerOperationId = "",
} = {}) {
  const policy = emailDeliveryPolicy('radar', { env });
  if (!policy.required) return { status: 'skipped', reason: policy.reason, attempted: false, attachments: [] };
  if (!urgentItems.length) return { status: "skipped", reason: "no_urgent_items", attempted: false, attachments: [] };
  if (!String(recipient || "").trim()) return { status: "skipped", reason: "recipient_not_configured", attempted: false, attachments: [] };
  const payload = buildRadarAggregateMessage(urgentItems, { runId, audit });
  const receiptPath = radarNotificationReceiptPath(runStateRoot, runId, urgentItems, audit);
  const delivered = await deliverReliableNotification({
    receiptPath,
    notificationType: "radar_business",
    runId,
    businessSubject: "urgent_a_aggregate",
    eventEpoch: runId,
    payload,
    recoveryData: { ...await notificationRecoveryData(buildRadarNotificationContent(urgentItems, { runId, audit })), radarSelection: notificationSelection },
    recipient,
    ledgerOperationId,
    transport,
    env,
    fsApi,
    clock,
  });
  return { ...delivered, attachments: [] };
}
