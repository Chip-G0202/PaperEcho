import path from 'node:path';
import { channelDeliveryPolicy, qqChannelConfiguration } from './policy.mjs';
import { renderQqNotification } from './qq_renderer.mjs';
import { createQqTransport } from './qq_transport.mjs';
import { deliverReliableNotification } from './delivery.mjs';
import { completeLedgerNotification } from './ledger_bridge.mjs';
import { notificationIdentity, notificationReceiptPathFor, notificationRecoveryData, recipientHash } from '../stage5/email_receipt.mjs';

export function qqRecipient(qq) { return `${qq.targetType || ''}:${qq.targetId || ''}`; }

// Shared fan-out owner. Business results/content are supplied once by Stage5.
// Email keeps its existing renderer/delivery contract and historical identities.
export async function deliverBusinessChannels({ content, emailDelivery, env = {}, runStateRoot, recoveryCoordinator,
  qqTransport, fsApi, clock, radarSelection = [], radarCompletionHash = '' }) {
  const event = content.eventType === 'radar_completed' ? 'radar' : 'weekly';
  if (event === 'radar' && !content.items?.length) return { status: 'skipped', reason: 'no_urgent_items', businessStatus: 'success', notificationStatus: 'completed',
    channels: { email: { status: 'skipped', reason: 'no_urgent_items' }, qq: { status: 'skipped', reason: 'no_urgent_items' } }, attachments: [] };
  const channels = {};
  let qqDelivery; let operation;
  if (channelDeliveryPolicy('qq', event, { env }).required) {
    try {
    const qq = qqChannelConfiguration({ env });
    const payload = renderQqNotification(content);
    const notificationType = event === 'radar' ? 'radar_business' : 'run_summary';
    const businessSubject = event === 'radar' ? 'urgent_a_aggregate' : content.runId;
    const identity = notificationIdentity({ notificationType, businessSubject, eventEpoch: content.runId, payload, channel: 'qq' });
    const receiptPath = notificationReceiptPathFor(path.resolve(runStateRoot), identity.receiptId);
    const recipient = qqRecipient(qq);
    operation = recoveryCoordinator ? await recoveryCoordinator.prepareFileOperation({ type: 'notification', targetId: recipientHash(recipient, 'qq'), targetPath: receiptPath,
      input: { runId: content.runId, channel: 'qq', payloadHash: identity.payloadHash }, retryable: false,
      intent: { notificationType, eventEpoch: content.runId, channel: 'qq', ...(radarCompletionHash ? { radarCompletionHash } : {}) } }) : null;
    qqDelivery = { channel: 'qq', receiptPath, notificationType, businessSubject, runId: content.runId, eventEpoch: content.runId,
        payload, recipient, ledgerOperationId: operation?.idempotencyKey || '', recoveryData: { ...await notificationRecoveryData(content), ...(event === 'radar' ? { radarSelection } : {}) },
        transport: qqTransport || createQqTransport({ ...qq, clientSecret: env.QQ_BOT_APP_SECRET || '' }), env, fsApi, clock };
    // Persist replay input before any channel send. A process interruption after
    // Email cannot lose the not-yet-attempted QQ event or trigger business replay.
    await deliverReliableNotification({ ...qqDelivery, prepareOnly: true });
    } catch { channels.qq = { status: 'failed', reason: 'notification_receipt_or_payload_failed', receiptPath: qqDelivery?.receiptPath }; qqDelivery = null; }
  } else channels.qq = { status: 'skipped', reason: channelDeliveryPolicy('qq', event, { env }).reason };
  if (channelDeliveryPolicy('email', event, { env }).required) {
    try { channels.email = await emailDelivery(); }
    catch { channels.email = { status: 'failed', reason: 'notification_receipt_or_payload_failed' }; }
  } else channels.email = { status: 'skipped', reason: channelDeliveryPolicy('email', event, { env }).reason };
  if (qqDelivery) {
    try { channels.qq = await deliverReliableNotification(qqDelivery); }
    catch { channels.qq = { status: 'failed', reason: 'notification_receipt_or_payload_failed', receiptPath: qqDelivery.receiptPath }; }
  }
  if (operation) await completeLedgerNotification(recoveryCoordinator.store, operation, channels.qq);
  const accepted = value => value.status === 'accepted' || value.status === 'sent' || value.status === 'skipped' && value.reason === 'already_sent';
  const pending = Object.values(channels).some(value => !accepted(value) && value.status !== 'skipped');
  const skipped = Object.values(channels).every(value => value.status === 'skipped' && !accepted(value));
  return { status: skipped ? 'skipped' : event === 'radar' ? pending ? 'partial' : 'accepted' : pending ? 'partial' : 'sent', businessStatus: 'success', notificationStatus: pending ? 'incomplete' : 'completed',
    reason: pending ? 'channel_delivery_incomplete' : 'channels_completed', channels, attachments: channels.email.attachments || [] };
}
