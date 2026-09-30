import path from 'node:path';
import { QqGateway, qqRemoteRuntime } from './qq_gateway.mjs';
import { RemoteActionService, RemoteRateLimiter, parseRemoteCommand, renderRemoteQqReply } from './actions.mjs';
import { InboundReceiptStore, identityDigest } from './inbound_receipt.mjs';

export class QqRemoteService {
  constructor({ config, secrets, review, schedule, notifications, runtime = {}, gatewayFactory = options => new QqGateway(options), getClient = qq => notifications.client(qq), receiptStore, limiter = new RemoteRateLimiter() }) {
    Object.assign(this, { config, secrets, review, runtime, gatewayFactory, getClient, receiptStore, limiter });
    this.actions = new RemoteActionService({ review, schedule }); this.reconciliation = Promise.resolve(); this.closed = false;
  }
  async configuration() {
    const owner = (await this.config.readOwnerOrTemplate('paperecho.config.json')).value;
    const qq = owner.common?.notifications?.channels?.qq || {};
    const remote = owner.schemaVersion >= 6 ? qq.remoteInteraction || {} : {};
    return { qq, remote };
  }
  async settings() {
    const { qq, remote } = await this.configuration();
    const credential = (await this.secrets.list()).find(entry => entry.id === 'QQ_BOT_APP_SECRET');
    const runtime = qqRemoteRuntime(this.runtime);
    const authorized = typeof remote.authorizedUser === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(remote.authorizedUser);
    const configured = Boolean(authorized && qq.appId && credential?.configured);
    const enabled = remote.enabled === true;
    const actual = this.gateway?.status() || { connection: this.startError ? 'error' : 'not_running', error: this.startError || null };
    return { configured, enabled, authorized: authorized ? 'configured' : 'incomplete', runtimeSupported: runtime.supported,
      connection: !runtime.supported && enabled ? 'error' : enabled && configured ? actual.connection : 'not_running',
      error: !runtime.supported ? runtime.error : actual.error, minimumNode: runtime.minimum, lifecycle: 'control_center' };
  }
  reconcile() {
    this.reconciliation = this.reconciliation.then(async () => {
      if (this.closed) return;
      const { qq, remote } = await this.configuration(); const state = await this.settings();
      if (this.closed) return;
      if (!state.enabled || !state.configured || !state.runtimeSupported) { await this.gateway?.stop(); this.gateway = null; this.startError = null; return; }
      const client = await this.getClient(qq); const identity = identityDigest(qq.appId, remote.authorizedUser);
      if (this.closed) return;
      if (this.gateway && this.client === client && this.connectionIdentity === identity) return;
      await this.gateway?.stop();
      if (this.closed) return;
      this.startError = null;
      this.client = client; this.connectionIdentity = identity;
      this.gateway = this.gatewayFactory({ ...this.runtime, client, onEvent: frame => this.handle(frame, { client, appId: qq.appId }) });
      await this.gateway.start();
    }).catch(() => { this.startError = 'QQ_REMOTE_START_FAILED'; if (this.gateway) { this.gateway.error = this.startError; this.gateway.state = 'error'; void this.gateway.stop(); } });
    return this.reconciliation;
  }
  async stop() { this.closed = true; await this.gateway?.stop(); await this.reconciliation; await this.gateway?.stop(); }
  async handle(frame, { client, appId } = {}) {
    const { qq, remote } = await this.configuration();
    if (this.closed || !qqRemoteRuntime(this.runtime).supported || remote.enabled !== true || frame?.t !== 'C2C_MESSAGE_CREATE' || frame.op !== 0 || appId !== qq.appId) return { ignored: true };
    const user = frame.d?.author?.user_openid;
    if (typeof user !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(user) || user !== remote.authorizedUser) return { ignored: true };
    const messageId = frame.d?.id;
    if (typeof messageId !== 'string' || !messageId || messageId.length > 512 || /[\s\u0000-\u001f]/.test(messageId)) return { ignored: true };
    const textOnly = ['attachments', 'embeds'].every(field => frame.d[field] === undefined || Array.isArray(frame.d[field]) && frame.d[field].length === 0)
      && !frame.d.ark && !frame.d.markdown && !frame.d.keyboard && !frame.d.media && !frame.d.card;
    const { action } = textOnly ? parseRemoteCommand(frame.d.content) : { action: 'unsupported' };
    const identity = identityDigest('qq', qq.appId, user, messageId);
    const subject = identityDigest('qq', qq.appId, user);
    const store = this.receiptStore || new InboundReceiptStore({ root: path.join(path.dirname(this.review.runRoot), 'remote_interaction', 'qq', identityDigest(qq.appId)) });
    return store.process(identity, { action, subject }, async (receipt, save) => {
      if (!this.limiter.allow(subject)) { receipt.execution = 'rate_limited'; await save(); return; }
      let result;
      try { result = await this.actions.execute(action); receipt.execution = action === 'unsupported' ? 'unsupported' : 'completed'; }
      catch { receipt.execution = 'failed'; result = { kind: 'failed' }; }
      // Execution completes durably before the first reply attempt. A started
      // reply left by a crash is unknown and is held by the receipt owner.
      await save();
      const content = renderRemoteQqReply(result, text => this.secrets.redact(text).split(user).join('[身份已隐藏]'));
      receipt.reply = 'started'; await save();
      try { const sent = await client.sendPassiveReply({ userId: user, messageId, content }); receipt.reply = sent?.accepted === true ? 'accepted' : sent?.accepted === false ? 'failed' : 'unknown'; }
      catch { receipt.reply = 'unknown'; }
      await save();
    });
  }
}
