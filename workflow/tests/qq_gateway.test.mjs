import test from 'node:test';
import assert from 'node:assert/strict';
import { QqGateway } from '../tools/remote/qq_gateway.mjs';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
test('explicitly unavailable WebSocket fails before discovery or timers even on supported Node', async () => {
  const forbidden = () => { throw new Error('listener must not start'); };
  const gateway = new QqGateway({ client: { getGateway: forbidden }, onEvent: forbidden, nodeVersion: '22.4.0', WebSocketCtor: undefined, timers: { setTimeout: forbidden, clearTimeout: forbidden } });
  await assert.rejects(gateway.start(), /QQ_REMOTE_RUNTIME_UNSUPPORTED/);
  assert.equal(gateway.running, false);
});
function fixture(onEvent = async () => {}) {
  let now = 0; let id = 0; const pending = new Map(); const sockets = []; let discovery = 0; let invalidated = 0;
  const timers = { setTimeout: (fn, ms) => { pending.set(++id, { fn, at: now + ms }); return id; }, clearTimeout: key => pending.delete(key) };
  const advance = async ms => { const end = now + ms; for (;;) { const next = [...pending].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0]; if (!next) break; now = next[1].at; pending.delete(next[0]); next[1].fn(); await flush(); } now = end; await flush(); };
  class FakeSocket {
    constructor(url) { this.url = url; this.readyState = 1; this.listeners = {}; this.sent = []; sockets.push(this); }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.readyState = 3; this.listeners.close?.({ code: 1000 }); }
    message(frame) { this.listeners.message({ data: JSON.stringify(frame) }); }
    disconnect(code = 1006) { this.readyState = 3; this.listeners.close?.({ code }); }
  }
  const client = { getGateway: async () => { discovery++; return 'wss://api.bot.qq.com/websocket/'; }, getAccessToken: async () => 'synthetic-token', invalidateToken: () => { invalidated++; } };
  const gateway = new QqGateway({ client, onEvent, nodeVersion: '22.4.0', WebSocketCtor: FakeSocket, timers, clock: () => now });
  const hello = async (socket = sockets.at(-1)) => { socket.message({ op: 10, d: { heartbeat_interval: 100 } }); await flush(); };
  const ready = async () => { sockets.at(-1).message({ op: 0, s: 1, t: 'READY', d: { session_id: 'synthetic-session' } }); await gateway.queue; };
  return { gateway, sockets, timers, pending, advance, hello, ready, client, discovery: () => discovery, invalidated: () => invalidated };
}
test('discovery → Hello → minimal Identify → Ready; heartbeat uses received sequence and ACK', async () => {
  const f = fixture(); await f.gateway.start(); assert.equal(f.discovery(), 1); assert.equal(f.gateway.status().connection, 'connecting');
  await f.hello(); assert.deepEqual(f.sockets[0].sent[0], { op: 2, d: { token: 'QQBot synthetic-token', intents: 1 << 25, shard: [0, 1] } });
  await f.ready(); assert.equal(f.gateway.status().connection, 'online'); assert.equal(f.gateway.processedSequence, 1);
  await f.advance(100); assert.deepEqual(f.sockets[0].sent.at(-1), { op: 1, d: 1 }); f.sockets[0].message({ op: 11 }); await flush();
  await f.advance(100); assert.equal(f.gateway.status().connection, 'online'); assert.equal(f.gateway.awaitingAck, true);
  f.sockets[0].message({ op: 1 }); await flush(); assert.deepEqual(f.sockets[0].sent.at(-1), { op: 1, d: 1 });
  await f.gateway.stop(); assert.equal(f.pending.size, 0); assert.equal(f.gateway.status().connection, 'not_running');
});
test('dispatch is C2C only and ignored group/channel/interactions advance completed sequence without action', async () => {
  const calls = []; const f = fixture(async frame => calls.push(frame.t)); await f.gateway.start(); await f.hello(); await f.ready();
  for (const [index, t] of ['GROUP_AT_MESSAGE_CREATE', 'AT_MESSAGE_CREATE', 'INTERACTION_CREATE', 'C2C_MESSAGE_CREATE'].entries()) { f.sockets[0].message({ op: 0, s: index + 2, t, d: { id: 'synthetic-message' } }); await f.gateway.queue; }
  assert.deepEqual(calls, ['C2C_MESSAGE_CREATE']); assert.equal(f.gateway.processedSequence, 5); await f.gateway.stop();
});
test('unfinished event is not acknowledged as processed; reconnect waits and Resume uses completed sequence', async () => {
  let complete; const f = fixture(() => new Promise(resolve => { complete = resolve; })); await f.gateway.start(); await f.hello(); await f.ready();
  f.sockets[0].message({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: {} }); await flush();
  assert.equal(f.gateway.receivedSequence, 2); assert.equal(f.gateway.processedSequence, 1);
  await f.advance(100); assert.deepEqual(f.sockets[0].sent.at(-1), { op: 1, d: 2 });
  f.sockets[0].disconnect(); await f.advance(1000); assert.equal(f.discovery(), 1);
  complete(); await f.gateway.queue; await flush(); assert.equal(f.discovery(), 2);
  await f.hello(); assert.deepEqual(f.sockets[1].sent[0], { op: 6, d: { token: 'QQBot synthetic-token', session_id: 'synthetic-session', seq: 2 } });
  f.sockets[1].message({ op: 0, s: 3, t: 'RESUMED', d: '' }); await f.gateway.queue; assert.equal(f.gateway.status().connection, 'online'); await f.gateway.stop();
});
test('server Reconnect and Invalid Session clear rejected session and fresh Identify', async () => {
  const f = fixture(); await f.gateway.start(); await f.hello(); await f.ready(); f.sockets[0].message({ op: 7 }); await flush(); await f.advance(1000); await f.hello(); assert.equal(f.sockets[1].sent[0].op, 6);
  f.sockets[1].message({ op: 9, d: false }); await flush(); await f.advance(2000); await f.hello(); assert.equal(f.sockets[2].sent[0].op, 2); assert.equal(f.gateway.processedSequence, null); await f.gateway.stop();
});
test('missing heartbeat ACK reconnects with bounded backoff using official Hello interval', async () => {
  const f = fixture(); await f.gateway.start(); await f.hello(); await f.ready(); await f.advance(200); assert.equal(f.gateway.status().connection, 'reconnecting'); assert.equal(f.discovery(), 1);
  await f.advance(999); assert.equal(f.discovery(), 1); await f.advance(1); assert.equal(f.discovery(), 2); await f.gateway.stop();
});
for (const code of [4006, 4007, 4900, 4913]) test(`official retryable close ${code} clears session and identifies`, async () => {
  const f = fixture(); await f.gateway.start(); await f.hello(); await f.ready(); f.sockets[0].disconnect(code); await f.advance(1000); await f.hello(); assert.equal(f.sockets[1].sent[0].op, 2); await f.gateway.stop();
});
test('session timeout resumes; token authentication failure invalidates only the shared cache', async () => {
  const f = fixture(); await f.gateway.start(); await f.hello(); await f.ready(); f.sockets[0].disconnect(4009); await f.advance(1000); await f.hello(); assert.equal(f.sockets[1].sent[0].op, 6);
  f.sockets[1].disconnect(4004); await f.advance(2000); await f.hello(); assert.equal(f.invalidated(), 1); assert.equal(f.sockets[2].sent[0].op, 6); await f.gateway.stop();
});
test('provider rate limit has a minute backoff, no tight retry or token refresh', async () => {
  const f = fixture(); await f.gateway.start(); f.sockets[0].disconnect(4008); await f.advance(59999); assert.equal(f.discovery(), 1); await f.advance(1); assert.equal(f.discovery(), 2); assert.equal(f.invalidated(), 0); await f.gateway.stop();
});
for (const code of [4001, 4002, 4010, 4011, 4012, 4013, 4014, 4914, 4915, 4999]) test(`official non-retry/unknown close ${code} stops safely`, async () => {
  const f = fixture(); await f.gateway.start(); f.sockets[0].disconnect(code); await flush(); await f.advance(100000); assert.equal(f.discovery(), 1); assert.equal(f.gateway.running, false); assert.equal(f.gateway.status().connection, 'error'); assert.equal(f.pending.size, 0);
});
test('reconnect budget survives repeated short-lived sessions; no unbounded loop', async () => {
  const f = fixture(); await f.gateway.start();
  for (const delay of [1000, 2000, 5000, 10000, 30000, 60000]) { f.sockets.at(-1).disconnect(); await f.advance(delay); }
  f.sockets.at(-1).disconnect(); await flush(); assert.equal(f.gateway.error, 'QQ_GATEWAY_RETRY_EXHAUSTED'); assert.equal(f.discovery(), 7); assert.equal(f.pending.size, 0);
});
test('Hello/Ready timeout, bad/oversized frames and action persistence errors never fake online', async () => {
  const f = fixture(); await f.gateway.start(); await f.advance(15000); assert.equal(f.gateway.status().connection, 'reconnecting'); await f.gateway.stop();
  for (const frame of [{ op: 10, d: { heartbeat_interval: 0 } }, { op: 0, s: 1, t: 'READY', d: {} }]) { const g = fixture(); await g.gateway.start(); g.sockets[0].message(frame); await flush(); assert.equal(g.gateway.status().connection, 'error'); }
  const oversized = fixture(); await oversized.gateway.start(); oversized.sockets[0].listeners.message({ data: 'x'.repeat(65537) }); await flush(); assert.equal(oversized.gateway.error, 'QQ_GATEWAY_PAYLOAD_INVALID');
  const failed = fixture(async () => { throw new Error('synthetic private persistence error'); }); await failed.gateway.start(); await failed.hello(); await failed.ready(); failed.sockets[0].message({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: {} }); await failed.gateway.queue; assert.equal(failed.gateway.processedSequence, 1); assert.equal(failed.gateway.running, false); assert.equal(failed.gateway.error, 'QQ_GATEWAY_PROCESSING_FAILED');
});
test('discovery network errors back off; auth/config rejection stop without reconnect', async () => {
  const f = fixture(); f.client.getGateway = async () => { throw new Error('network'); }; await f.gateway.start(); assert.equal(f.gateway.status().connection, 'reconnecting'); await f.gateway.stop();
  const denied = fixture(); denied.client.getGateway = async () => { throw new Error('QQ_GATEWAY_AUTH_FAILED'); }; await denied.gateway.start(); assert.equal(denied.gateway.status().connection, 'error'); assert.equal(denied.pending.size, 0);
});
