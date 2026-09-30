// Official protocol and close-code table:
// https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
// https://bot.q.qq.com/wiki/develop/api-v2/openapi/error/error.html
export function qqRemoteRuntime(options = {}) {
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const WebSocketCtor = Object.hasOwn(options, 'WebSocketCtor') ? options.WebSocketCtor : globalThis.WebSocket;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  const supported = Boolean(match && (Number(match[1]) > 22 || Number(match[1]) === 22 && Number(match[2]) >= 4) && typeof WebSocketCtor === 'function');
  return { supported, minimum: '22.4.0', ...(supported ? {} : { error: 'QQ_REMOTE_RUNTIME_UNSUPPORTED' }) };
}
const NON_RETRY = new Set([4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915]);
const DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
export class QqGateway {
  constructor(options) {
    const { client, onEvent, nodeVersion = process.versions.node, timers = { setTimeout, clearTimeout }, clock = () => Date.now() } = options;
    const WebSocketCtor = Object.hasOwn(options, 'WebSocketCtor') ? options.WebSocketCtor : globalThis.WebSocket;
    Object.assign(this, { client, onEvent, nodeVersion, WebSocketCtor, timers, clock });
    this.state = 'not_running'; this.error = null; this.running = false; this.queue = Promise.resolve(); this.queued = 0;
    this.sessionId = null; this.processedSequence = null; this.receivedSequence = null; this.attempts = 0; this.generation = 0;
  }
  status() { return { connection: this.state, error: this.error }; }
  async start() {
    if (!qqRemoteRuntime(this).supported) throw new Error('QQ_REMOTE_RUNTIME_UNSUPPORTED');
    if (this.running) return;
    this.running = true; this.state = 'connecting';
    await this.connect();
  }
  clearTimers() { for (const key of ['heartbeatTimer', 'handshakeTimer', 'reconnectTimer']) { this.timers.clearTimeout(this[key]); this[key] = null; } }
  async stop() {
    this.running = false; this.generation++; this.clearTimers();
    const ws = this.socket; this.socket = null;
    try { ws?.close(1000); } catch {}
    if (this.state !== 'error') this.state = 'not_running';
    await this.queue;
  }
  async fail(code) { this.error = code; this.state = 'error'; await this.stop(); }
  async connect() {
    if (!this.running) return;
    await this.queue;
    if (!this.running) return;
    if (!this.sessionId) { this.processedSequence = null; this.receivedSequence = null; }
    const generation = ++this.generation;
    try {
      const url = await this.client.getGateway();
      if (!this.running || generation !== this.generation) return;
      const socket = this.socket = new this.WebSocketCtor(url);
      this.connectedAt = this.clock(); this.awaitingAck = false;
      this.handshakeTimer = this.timers.setTimeout(() => this.reconnect(1006), 15000);
      socket.addEventListener('message', event => {
        if (!this.running || generation !== this.generation) return;
        let frame;
        try { if (typeof event.data !== 'string' || Buffer.byteLength(event.data, 'utf8') > 65536) throw new Error(); frame = JSON.parse(event.data); }
        catch { void this.fail('QQ_GATEWAY_PAYLOAD_INVALID'); return; }
        void this.frame(frame, generation).catch(() => { void this.fail('QQ_GATEWAY_PROCESSING_FAILED'); });
      });
      socket.addEventListener('close', event => { if (this.running && generation === this.generation) this.reconnect(event.code); });
      socket.addEventListener('error', () => { if (this.running && generation === this.generation) this.reconnect(1006); });
    } catch (error) {
      if (!this.running || generation !== this.generation) return;
      if (['QQ_GATEWAY_AUTH_FAILED', 'QQ_GATEWAY_URL_INVALID'].includes(error.message)) { void this.fail(error.message); return; }
      this.reconnect(1006);
    }
  }
  send(frame) { if (!this.socket || this.socket.readyState !== 1) throw new Error('QQ_GATEWAY_DISCONNECTED'); this.socket.send(JSON.stringify(frame)); }
  heartbeat() {
    if (!this.running) return;
    if (this.awaitingAck) { this.reconnect(1006); return; }
    try { this.send({ op: 1, d: this.receivedSequence }); this.awaitingAck = true; }
    catch { this.reconnect(1006); return; }
    this.heartbeatTimer = this.timers.setTimeout(() => this.heartbeat(), this.heartbeatInterval);
  }
  async frame(frame, generation) {
    if (!frame || !Number.isInteger(frame.op)) throw new Error('INVALID_FRAME');
    if (frame.op === 10) {
      const interval = frame.d?.heartbeat_interval;
      if (!Number.isSafeInteger(interval) || interval < 1 || interval > 86400000 || this.heartbeatInterval && this.socketHelloGeneration === generation) throw new Error('INVALID_HELLO');
      this.socketHelloGeneration = generation; this.heartbeatInterval = interval;
      const token = await this.client.getAccessToken();
      if (!this.running || generation !== this.generation) return;
      if (typeof token !== 'string') { void this.fail('QQ_GATEWAY_AUTH_FAILED'); return; }
      this.send(this.sessionId ? { op: 6, d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.processedSequence } }
        // QQ bundles C2C/group lifecycle events in bit 25. Only C2C is dispatched
        // to the application; no guild/group/interactions intents are added.
        : { op: 2, d: { token: `QQBot ${token}`, intents: 1 << 25, shard: [0, 1] } });
      this.heartbeatTimer = this.timers.setTimeout(() => this.heartbeat(), interval);
      return;
    }
    if (frame.op === 11) { this.awaitingAck = false; return; }
    if (frame.op === 1) { this.send({ op: 1, d: this.receivedSequence }); return; }
    if (frame.op === 7) { this.reconnect(4009); return; }
    if (frame.op === 9) { this.sessionId = null; this.processedSequence = null; this.reconnect(4006); return; }
    if (frame.op !== 0) throw new Error('UNSUPPORTED_OPCODE');
    if (!Number.isSafeInteger(frame.s) || frame.s < 0 || typeof frame.t !== 'string' || this.socketHelloGeneration !== generation) throw new Error('INVALID_DISPATCH');
    if (this.queued >= 32) { this.reconnect(4009); return; }
    this.receivedSequence = Math.max(this.receivedSequence ?? 0, frame.s); this.queued++;
    this.queue = this.queue.then(async () => {
      if (!this.running) return;
      if (frame.t === 'READY') {
        if (typeof frame.d?.session_id !== 'string' || !frame.d.session_id || frame.d.session_id.length > 512) throw new Error('INVALID_READY');
        this.sessionId = frame.d.session_id; this.state = 'online'; this.error = null;
        this.processedSequence = null; this.receivedSequence = frame.s;
        this.timers.clearTimeout(this.handshakeTimer);
      } else if (frame.t === 'RESUMED') {
        if (!this.sessionId) throw new Error('INVALID_RESUMED');
        this.state = 'online'; this.error = null; this.timers.clearTimeout(this.handshakeTimer);
      } else if (frame.t === 'C2C_MESSAGE_CREATE') {
        if (!this.sessionId) throw new Error('EVENT_BEFORE_READY');
        await this.onEvent(frame);
      }
      // Heartbeats carry receivedSequence; Resume carries only this completed
      // sequence. Persistent inbound receipts guard execution/reply replay.
      this.processedSequence = Math.max(this.processedSequence ?? 0, frame.s);
    }).catch(() => { this.error = 'QQ_GATEWAY_PROCESSING_FAILED'; this.state = 'error'; this.running = false; this.generation++; this.clearTimers(); try { this.socket?.close(1000); } catch {} })
      .finally(() => { this.queued--; });
    await this.queue;
  }
  reconnect(code) {
    if (!this.running) return;
    const knownRetry = [1001, 1005, 1006, 1011, 1012, 1013, 4004, 4006, 4007, 4008, 4009].includes(code) || code >= 4900 && code <= 4913;
    if (NON_RETRY.has(code) || !knownRetry) { void this.fail('QQ_GATEWAY_CONNECTION_REJECTED'); return; }
    if (this.clock() - this.connectedAt >= 60000 && this.state === 'online') this.attempts = 0;
    if (code === 4004) this.client.invalidateToken();
    if ([4006, 4007].includes(code) || code >= 4900 && code <= 4913) { this.sessionId = null; this.processedSequence = null; }
    this.generation++; this.clearTimers(); const ws = this.socket; this.socket = null;
    try { ws?.close(1000); } catch {}
    if (this.attempts >= DELAYS.length) { void this.fail('QQ_GATEWAY_RETRY_EXHAUSTED'); return; }
    const delay = Math.max(code === 4008 ? 60000 : 0, DELAYS[this.attempts++]);
    this.state = 'reconnecting'; this.reconnectTimer = this.timers.setTimeout(() => { void this.connect(); }, delay);
  }
}
