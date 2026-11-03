import path from 'node:path';
import { channelDeliveryPolicy } from './policy.mjs';
import { deliverReliableNotification } from './delivery.mjs';
import { completeLedgerNotification } from './ledger_bridge.mjs';
import { notificationIdentity, notificationReceiptPathFor, notificationRecoveryData, recipientHash } from '../stage5/email_receipt.mjs';
import { CHANNEL_IDS, channelConfiguration, channelRecipient, renderChannelNotification, createChannelTransport } from './channels.mjs';

export function qqRecipient(qq) { return `${qq.targetType || ''}:${qq.targetId || ''}`; }

// Shared fan-out owner. Business results/content are supplied once by Stage5.
// Email keeps its existing renderer/delivery contract and historical identities.
export async function deliverBusinessChannels({ content, emailDelivery, env = {}, runStateRoot, recoveryCoordinator,
  qqTransport, channelTransports = {}, fsApi, clock, radarSelection = [], radarCompletionHash = '' }) {
  const event = content.eventType === 'radar_completed' ? 'radar' : 'weekly';
  if (event === 'radar' && !content.items?.length) return { status: 'skipped', reason: 'no_urgent_items', businessStatus: 'success', notificationStatus: 'completed',
    channels: Object.fromEntries(CHANNEL_IDS.map(channel => [channel, { status: 'skipped', reason: 'no_urgent_items' }])), attachments: [] };
  const channels = {};
  const plans = [];
  for (const channel of CHANNEL_IDS.filter(id => id !== 'email')) {
  let delivery; let operation;
  if (channelDeliveryPolicy(channel, event, { env }).required) {
    try {
    const configuration = channelConfiguration(channel, { env });
    const payload = renderChannelNotification(channel, content);
    const notificationType = event === 'radar' ? 'radar_business' : 'run_summary';
    const businessSubject = event === 'radar' ? 'urgent_a_aggregate' : content.runId;
    const identity = notificationIdentity({ notificationType, businessSubject, eventEpoch: content.runId, payload, channel });
    const receiptPath = notificationReceiptPathFor(path.resolve(runStateRoot), identity.receiptId);
    const recipient = channelRecipient(channel, configuration, env);
    operation = recoveryCoordinator ? await recoveryCoordinator.prepareFileOperation({ type: 'notification', targetId: recipientHash(recipient, channel), targetPath: receiptPath,
      input: { runId: content.runId, channel, payloadHash: identity.payloadHash }, retryable: false,
      intent: { notificationType, eventEpoch: content.runId, channel, ...(radarCompletionHash ? { radarCompletionHash } : {}) } }) : null;
    delivery = { channel, receiptPath, notificationType, businessSubject, runId: content.runId, eventEpoch: content.runId,
        payload, recipient, ledgerOperationId: operation?.idempotencyKey || '', recoveryData: { ...await notificationRecoveryData(content), ...(event === 'radar' ? { radarSelection } : {}) },
        transport: channelTransports[channel] || (channel === 'qq' ? qqTransport : null) || createChannelTransport(channel, configuration, env), env, fsApi, clock };
    // Persist replay input before any channel send. A process interruption after
    // Email cannot lose unattempted channels or trigger business replay.
    await deliverReliableNotification({ ...delivery, prepareOnly: true });
    plans.push({ channel, delivery, operation });
    } catch { channels[channel] = { status: 'failed', reason: 'notification_receipt_or_payload_failed', receiptPath: delivery?.receiptPath }; }
  } else channels[channel] = { status: 'skipped', reason: channelDeliveryPolicy(channel, event, { env }).reason };
  }
  if (channelDeliveryPolicy('email', event, { env }).required) {
    try { channels.email = await emailDelivery(); }
    catch { channels.email = { status: 'failed', reason: 'notification_receipt_or_payload_failed' }; }
  } else channels.email = { status: 'skipped', reason: channelDeliveryPolicy('email', event, { env }).reason };
  for (const { channel, delivery, operation } of plans) {
    try { channels[channel] = await deliverReliableNotification(delivery); }
    catch { channels[channel] = { status: 'failed', reason: 'notification_receipt_or_payload_failed', receiptPath: delivery.receiptPath }; }
    if (operation) await completeLedgerNotification(recoveryCoordinator.store, operation, channels[channel]);
  }
  const accepted = value => value.status === 'accepted' || value.status === 'sent' || value.status === 'skipped' && value.reason === 'already_sent';
  const pending = Object.values(channels).some(value => !accepted(value) && value.status !== 'skipped');
  const skipped = Object.values(channels).every(value => value.status === 'skipped' && !accepted(value));
  return { status: skipped ? 'skipped' : event === 'radar' ? pending ? 'partial' : 'accepted' : pending ? 'partial' : 'sent', businessStatus: 'success', notificationStatus: pending ? 'incomplete' : 'completed',
    reason: pending ? 'channel_delivery_incomplete' : 'channels_completed', channels, attachments: channels.email.attachments || [] };
}
