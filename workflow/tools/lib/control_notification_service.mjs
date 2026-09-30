import fs from 'node:fs/promises';
import path from 'node:path';
import { emailTransportConfig, isValidSmtpHost } from '../stage5/email_sender.mjs';
import { isValidRecipient } from '../stage5/main.mjs';
import { readNotificationReceipt, receiptPathFor, testNotificationReceiptPathFor } from '../stage5/email_receipt.mjs';
import { buildTestNotificationContent } from '../stage5/notification_content.mjs';
import { renderTestNotification } from '../stage5/test_notification_report.mjs';
import { deliverReliableNotification } from '../notification/delivery.mjs';
import { renderQqNotification } from '../notification/qq_renderer.mjs';
import { createQqClient } from '../notification/qq_transport.mjs';
import { qqRecipient } from '../notification/channel_delivery.mjs';

export function publicEmailDelivery(receipt) {
  if (!receipt) return { status: 'none', at: null, kind: null, error: null };
  const accepted = receipt.status === 'accepted' || receipt.status === 'sent';
  const category = receipt.lastSmtp?.category;
  const qqErrors = { qq_authentication: 'authentication_failed', qq_authorization: 'authorization_failed', qq_invalid_destination: 'destination_unavailable', qq_rate_limited: 'rate_limited', qq_network: 'connection_failed', qq_configuration_invalid: 'configuration_invalid', qq_invalid_payload: 'payload_invalid' };
  const error = accepted ? null : ['eauth', 'authentication_failed'].includes(category) ? 'authentication_failed'
    : ['enotfound', 'etimedout', 'esocket', 'econnreset', 'econnaborted', 'epipe'].includes(category) ? 'connection_failed'
      : ['transport_not_configured', 'smtp_config_invalid', 'recipient_invalid'].includes(category) ? 'configuration_invalid' : 'temporarily_unavailable';
  return { status: accepted ? 'success' : receipt.status === 'failed' ? 'failed' : 'pending', at: receipt.updatedAt || receipt.sentAt || receipt.createdAt,
    kind: receipt.notificationType === 'channel_test' ? 'test' : 'business', error: accepted ? null : qqErrors[category] || error };
}

// Email is the first real channel. Configuration, secrets and delivery keep their owners.
export class NotificationChannelService {
  #testing = false;
  #qqClient;
  #qqCredentials;
  constructor({ config, secrets, review, context, env = {}, transport, qqTransport, clock = () => new Date() }) {
    Object.assign(this, { config, secrets, review, context, env, transport, qqTransport, clock });
  }
  async configuration() {
    const owner = (await this.config.readOwnerOrTemplate('paperecho.config.json')).value;
    const email = structuredClone(owner.common?.email || {});
    email.smtp ||= {};
    if (owner.schemaVersion < 3) {
      for (const [field, key] of Object.entries({ host: 'SMTP_HOST', user: 'SMTP_USER', from: 'SMTP_FROM', port: 'SMTP_PORT', secure: 'SMTP_SECURE' })) if (email.smtp[field] == null && this.env[key] != null) email.smtp[field] = this.env[key];
      email.recipient ||= this.env.PAPERFLOW_REPORT_TO || this.env.NOTIFICATION_EMAIL || '';
    }
    const configuredRoot = owner.common?.notifications?.receiptStore?.root;
    const receiptRoot = configuredRoot ? path.resolve(path.dirname(this.config.ownerPath('paperecho.config.json')), configuredRoot)
      : this.env.PAPERECHO_NOTIFICATION_RECEIPT_ROOT || path.join(path.dirname(this.review.runRoot), 'notification_receipts');
    return { owner, email, qq: owner.common?.notifications?.channels?.qq || { enabled: false }, receiptRoot };
  }
  async client(qq) {
    return this.secrets.withCredential('QQ_BOT_APP_SECRET', secret => {
      if (!this.#qqCredentials || this.#qqCredentials.appId !== qq.appId || this.#qqCredentials.secret !== secret) {
        this.#qqCredentials = { appId: qq.appId, secret };
        this.#qqClient = createQqClient({ appId: qq.appId, clientSecret: secret });
      }
      return this.#qqClient;
    });
  }
  async qqReadiness(qq) {
    const credential = (await this.secrets.list()).find(entry => entry.id === 'QQ_BOT_APP_SECRET');
    const missing = ['appId', 'targetType', 'targetId'].filter(field => !String(qq[field] || '').trim()).map(field => `qq.${field}`);
    if (!credential.configured) missing.push('qq.secret');
    const invalid = ['appId', 'targetId'].some(field => qq[field] != null && (typeof qq[field] !== 'string' || /[\s\u0000-\u001f\u007f]/.test(qq[field]) || qq[field].length > 200))
      || Boolean(qq.targetType && !['user', 'group'].includes(qq.targetType));
    return { readiness: invalid ? 'invalid' : missing.length ? 'incomplete' : 'configured', missing, credential };
  }
  async readiness(email) {
    const credential = await this.secrets.smtpStatus(email.smtp.passwordEnv);
    const missing = ['host', 'user'].filter((field) => !String(email.smtp[field] || '').trim()).map((field) => `smtp.${field}`);
    if (!String(email.recipient || '').trim()) missing.push('email.recipient');
    if (!credential.configured) missing.push('smtp.password');
    const smtp = email.smtp;
    const invalid = Boolean(smtp.host && !isValidSmtpHost(smtp.host)) || Boolean(email.recipient && !isValidRecipient(email.recipient))
      || (smtp.port != null && (!Number.isInteger(Number(smtp.port)) || Number(smtp.port) < 1 || Number(smtp.port) > 65535))
      || (smtp.secure != null && !/^(true|false|1|0|yes|no|on|off)$/i.test(String(smtp.secure)))
      || Boolean((smtp.from || smtp.user) && !isValidRecipient(smtp.from || smtp.user));
    return { readiness: invalid ? 'invalid' : missing.length ? 'incomplete' : 'configured', missing, credential };
  }
  async readReceipt(file, root) {
    try {
      const real = await fs.realpath(file);
      const realRoot = await fs.realpath(root);
      const relative = path.relative(realRoot, real);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
      const stat = await fs.stat(real);
      if (!stat.isFile() || stat.size > 5 * 1024 * 1024) return null;
      return await readNotificationReceipt(real, { allowLegacy: true });
    } catch { return null; }
  }
  async latestDelivery(receiptRoot, channel = 'email') {
    const receipts = [];
    const add = async (file, root) => { const receipt = await this.readReceipt(file, root); if (receipt && (receipt.channel || 'email') === channel && Number.isFinite(Date.parse(receipt.updatedAt || receipt.sentAt || receipt.createdAt))) receipts.push(receipt); };
    const flat = async (root, pattern) => {
      const files = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const file of files) if (file.isFile() && pattern.test(file.name)) await add(path.join(root, file.name), root);
    };
    await flat(receiptRoot, /^nr-[a-f0-9]{32}\.json$/);
    await flat(path.join(receiptRoot, 'tests'), /^[a-zA-Z0-9_-]{1,80}\.json$/);
    await flat(path.join(receiptRoot, 'tests', 'qq'), /^[a-zA-Z0-9_-]{1,80}\.json$/);
    for (const run of await this.review.runs()) {
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(run.runId)) continue;
      const root = path.join(this.review.runRoot, run.runId);
      await add(receiptPathFor(root), root);
      await flat(root, /^nr-[a-f0-9]{32}\.json$/);
    }
    receipts.sort((a, b) => Date.parse(b.updatedAt || b.sentAt || b.createdAt) - Date.parse(a.updatedAt || a.sentAt || a.createdAt));
    return publicEmailDelivery(receipts[0]);
  }
  async settings() {
    const { owner, email, qq, receiptRoot } = await this.configuration();
    const readiness = await this.readiness(email);
    const qqReadiness = await this.qqReadiness(qq);
    return { channels: [{ id: 'email', displayName: '邮箱', availability: 'available', enabled: email.enabled !== false,
      ...readiness, testAvailable: readiness.readiness === 'configured', lastDelivery: await this.latestDelivery(receiptRoot) },
    { id: 'qq', displayName: 'QQ', availability: 'available', enabled: qq.enabled === true,
      ...qqReadiness, testAvailable: qqReadiness.readiness === 'configured', lastDelivery: await this.latestDelivery(receiptRoot, 'qq') }],
    preferences: { radar: owner.common?.notifications?.radar?.enabled !== false, weekly: owner.common?.notifications?.weekly?.enabled !== false,
      failure: owner.common?.notifications?.failure?.enabled === true, health: owner.common?.notifications?.health?.enabled === true } };
  }
  async test(input) {
    if (!input || !['email', 'qq'].includes(input.channel) || Object.keys(input).some((key) => !['channel', 'requestId'].includes(key))) throw new Error('NOTIFICATION_TEST_REQUEST_INVALID');
    // Validate before using the fixed receipt owner path; no caller-supplied file/recipient.
    testNotificationReceiptPathFor('.', input.requestId);
    if (this.#testing) return { status: 'busy', error: 'test_in_progress' };
    this.#testing = true;
    try {
      const { email, qq, receiptRoot } = await this.configuration();
      const { readiness } = input.channel === 'qq' ? await this.qqReadiness(qq) : await this.readiness(email);
      if (readiness !== 'configured') return { status: 'blocked', error: readiness === 'invalid' ? 'configuration_invalid' : 'configuration_incomplete' };
      const receiptPath = testNotificationReceiptPathFor(receiptRoot, input.requestId, input.channel);
      const previous = await readNotificationReceipt(receiptPath);
      if (previous && ((previous.channel || 'email') !== input.channel || previous.notificationType !== 'channel_test' || previous.businessSubject !== input.requestId || !previous.recoveryData?.content)) return { status: 'blocked', error: 'temporarily_unavailable' };
      const content = previous?.recoveryData?.content || buildTestNotificationContent({ generatedAt: this.clock().toISOString() });
      const payload = input.channel === 'qq' ? renderQqNotification(content) : { ...renderTestNotification(content), attachments: [] };
      const deliver = (env, transport, recipient) => deliverReliableNotification({ receiptPath, notificationType: 'channel_test', runId: '', businessSubject: input.requestId, eventEpoch: input.requestId,
        payload, recipient, recoveryData: { content }, env, transport, clock: this.clock, channel: input.channel });
      const client = input.channel === 'qq' && !this.qqTransport ? await this.client(qq) : null;
      const delivered = input.channel === 'qq' ? await deliver({}, this.qqTransport || (payload => client.sendNotification(qq.targetType, qq.targetId, payload)), qqRecipient(qq)) : await this.secrets.withSmtpEnvironment(email.smtp, async (env) => {
        if (!emailTransportConfig(env).configured) return null;
        return deliver(env, this.transport, email.recipient);
      });
      if (!delivered?.receipt) return { status: delivered?.reason === 'delivery_in_progress' ? 'busy' : 'blocked', error: 'temporarily_unavailable' };
      return publicEmailDelivery(delivered.receipt);
    } catch { return { status: 'blocked', error: 'temporarily_unavailable' }; }
    finally { this.#testing = false; }
  }
}
