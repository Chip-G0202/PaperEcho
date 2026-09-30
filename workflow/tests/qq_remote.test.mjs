import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { qqRemoteRuntime, QqGateway } from '../tools/remote/qq_gateway.mjs';
import { QqRemoteService } from '../tools/remote/qq_remote_service.mjs';
import { RemoteActionService, RemoteRateLimiter, parseRemoteCommand, renderRemoteQqReply } from '../tools/remote/actions.mjs';
import { InboundReceiptStore, identityDigest } from '../tools/remote/inbound_receipt.mjs';
import { createQqClient } from '../tools/notification/qq_transport.mjs';

const base = fileURLToPath(new URL('./.qq-remote-test-tmp/', import.meta.url));
async function setup(t, { enabled = true, atomicWriter, runtime = { nodeVersion: '22.4.0', WebSocketCtor: class {} } } = {}) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'case-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const value = { schemaVersion: 6, common: { notifications: { channels: { qq: { appId: 'fixture-app', targetId: 'outbound-target', remoteInteraction: { enabled, authorizedUser: 'explicit-user' } } } } } };
  const calls = []; const replies = []; const counts = [];
  const review = { runRoot: path.join(root, 'runs'), status: async () => { calls.push('status'); return { lastRun: { at: '2026-09-30T00:00:00Z', status: 'completed' }, lastRadar: null, lastWeekly: null }; },
    latestLiteratureSummary: async () => { calls.push('latest'); return { total: 1, items: [{ title: 'private fixture paper C:\\private\\data fixture-secret https://private.example/data' }] }; },
    radarSummary: async () => { calls.push('radar'); return null; }, weeklySummary: async () => { calls.push('weekly'); return null; } };
  const client = { sendPassiveReply: async payload => { replies.push(payload); return { accepted: true }; } };
  const service = new QqRemoteService({ config: { readOwnerOrTemplate: async () => ({ value }) }, secrets: { list: async () => [{ id: 'QQ_BOT_APP_SECRET', configured: true }], redact: text => text.replaceAll('fixture-secret', '[REDACTED]') }, review,
    schedule: { status: async () => { calls.push('schedule'); return { notification: 'pending' }; } }, runtime,
    getClient: async () => client, receiptStore: new InboundReceiptStore({ root: path.join(root, 'receipts'), atomicWriter }),
    limiter: new RemoteRateLimiter({ perUser: 20, global: 40 }) });
  const execute = service.actions.execute.bind(service.actions); service.actions.execute = action => { counts.push(action); return execute(action); };
  const event = (id = 'message-1', content = '/status', author = { user_openid: 'explicit-user' }) => ({ op: 0, t: 'C2C_MESSAGE_CREATE', s: 2, id: 'outer-event', d: { id, content, author } });
  const handle = frame => service.handle(frame, { client, appId: 'fixture-app' });
  return { root, value, service, client, event, handle, calls, replies, counts };
}

for (const version of ['18.20.8', '20.10.0', '21.7.3', '22.0.0', '22.1.0', '22.2.0', '22.3.0', '22.4.0', '23.0.0', '24.15.0']) test(`QQ remote runtime boundary ${version}`, async () => {
  let constructed = 0; const WebSocketCtor = class { constructor() { constructed++; } };
  const supported = Number(version.split('.')[0]) > 22 || version === '22.4.0';
  assert.equal(qqRemoteRuntime({ nodeVersion: version, WebSocketCtor }).supported, supported);
  if (!supported) { const gateway = new QqGateway({ nodeVersion: version, WebSocketCtor }); await assert.rejects(gateway.start(), /QQ_REMOTE_RUNTIME_UNSUPPORTED/); assert.equal(gateway.running, false); }
  assert.equal(constructed, 0);
});
test('new runtime with disabled/unavailable WebSocket and malformed versions fails closed', () => {
  for (const nodeVersion of ['22.4.0', '24.0.0', 'bad', '22.4.0-pre']) assert.equal(qqRemoteRuntime({ nodeVersion, WebSocketCtor: undefined }).supported, false);
});
test('simulated Node 18 core imports and ordinary loopback runtime do not instantiate WebSocket', () => {
  const child = `Object.defineProperty(process.versions, 'node', { value: '18.20.8' }); globalThis.WebSocket = undefined;
    for (const p of ['./workflow/tools/web/server.mjs','./workflow/tools/stage0/main.mjs','./workflow/tools/local/main.mjs','./workflow/tools/stage5/main.mjs','./workflow/tools/notification/qq_transport.mjs']) await import(p);
    const { startControlCenter } = await import('./workflow/tools/web/server.mjs');
    const app = await startControlCenter({port:0,services:{secrets:{redact:String}}});
    await new Promise(r=>app.server.close(r)); console.log('simulated-node18-core-loaded');`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', child], { cwd: path.resolve(base, '../../..'), env: { ...process.env, PAPERECHO_SKIP_DOTENV: '1' }, encoding: 'utf8' });
  assert.match(output, /simulated-node18-core-loaded/);
});
test('deterministic parser accepts five exact commands and rejects all arguments/write verbs', () => {
  for (const action of ['help', 'status', 'latest', 'radar', 'weekly']) assert.deepEqual(parseRemoteCommand(` /${action} `), { action });
  for (const text of ['/status C:\\private', '/status https://example.test', '/status; whoami', '/status\n/etc/passwd', '/feedback', '/resume', '/run', '/latest query', 'status', { text: '/help' }, '中'.repeat(100), '\ud800']) assert.equal(parseRemoteCommand(text).action, 'unsupported');
});
test('actions use only existing read service interfaces and fixed allowlist dispatch', async () => {
  const calls = []; const read = name => async () => { calls.push(name); return ['status', 'schedule'].includes(name) ? {} : null; };
  const review = new Proxy({ status: read('status'), latestLiteratureSummary: read('latest'), radarSummary: read('radar'), weeklySummary: read('weekly') }, { get: (o, k) => { assert.ok(k in o, `mutation/unrecognized owner accessed: ${String(k)}`); return o[k]; } });
  const service = new RemoteActionService({ review, schedule: { status: read('schedule') } });
  for (const action of ['status', 'latest', 'radar', 'weekly', 'help', 'constructor', '/run', 'feedback']) await service.execute(action);
  assert.deepEqual(calls, ['status', 'schedule', 'latest', 'radar', 'weekly']);
  for (const kind of ['latest', 'radar', 'weekly']) assert.match(renderRemoteQqReply({ kind, data: null }), /暂无数据/);
});
test('disabled and unsupported runtime ignore before any private read, receipt or HTTP', async t => {
  for (const options of [{ enabled: false }, { runtime: { nodeVersion: '18.20.8', WebSocketCtor: class {} } }]) {
    const f = await setup(t, options); assert.deepEqual(await f.handle(f.event()), { ignored: true }); assert.equal(f.calls.length + f.replies.length, 0); assert.deepEqual(await fs.readdir(f.root), []);
  }
});
test('unknown/missing/spoofed user, outbound destination and group fail closed silently', async t => {
  const f = await setup(t);
  for (const author of [{ user_openid: 'unknown-user' }, {}, { username: 'explicit-user' }, { user_openid: 'outbound-target' }, { user_openid: 'explicit-user ', username: 'explicit-user' }]) assert.deepEqual(await f.handle(f.event('message-1', '/status', author)), { ignored: true });
  assert.deepEqual(await f.handle({ ...f.event(), t: 'GROUP_AT_MESSAGE_CREATE' }), { ignored: true });
  assert.deepEqual(await f.service.handle(f.event(), { client: f.client, appId: 'different-bot' }), { ignored: true });
  assert.equal(f.calls.length + f.replies.length, 0); assert.deepEqual(await fs.readdir(f.root), []);
});
test('authorized C2C status uses read owners, passive identity, redacted finite audit', async t => {
  const f = await setup(t); await f.handle(f.event());
  assert.deepEqual(f.calls, ['status', 'schedule']); assert.equal(f.replies.length, 1); assert.equal(f.replies[0].messageId, 'message-1'); assert.match(f.replies[0].content, /待恢复通知：有/);
  const names = await fs.readdir(path.join(f.root, 'receipts')); assert.equal(names.length, 1);
  const text = await fs.readFile(path.join(f.root, 'receipts', names[0]), 'utf8');
  for (const privateText of ['explicit-user', 'fixture-app', 'message-1', 'outer-event', '/status', 'fixture-secret', 'private fixture paper']) assert.ok(!text.includes(privateText));
  assert.equal(JSON.parse(text).reply, 'accepted');
});
test('message identity dedupe survives replay/restart/concurrency; same text different ID remains independent', async t => {
  const f = await setup(t); await Promise.all([f.handle(f.event()), f.handle(f.event())]);
  await f.handle({ ...f.event(), id: 'different-outer-id', s: 200 });
  const old = f.service.receiptStore; f.service.receiptStore = new InboundReceiptStore({ root: old.root }); await f.handle(f.event());
  assert.equal(f.counts.length, 1); assert.equal(f.replies.length, 1);
  await f.handle(f.event('message-2')); assert.equal(f.counts.length, 2); assert.equal(f.replies.length, 2);
});
test('arguments, shell, huge input and attachments return only short usage without reading', async t => {
  const f = await setup(t);
  const values = ['/status C:\\secret', '/status; whoami', '/latest https://example.test', '中'.repeat(1000), null];
  for (const [index, text] of values.entries()) await f.handle(f.event(`input-${index}`, text));
  const attachment = f.event('attachment'); attachment.d.attachments = [{ url: 'https://secret.test' }]; await f.handle(attachment);
  assert.equal(f.calls.length, 0); assert.equal(f.replies.length, 6);
  for (const reply of f.replies) assert.match(reply.content, /仅支持/);
  const malformed = f.event('malformed-attachment'); malformed.d.attachments = {}; await f.handle(malformed); assert.equal(f.calls.length, 0);
});
test('titles are bounded and redact secrets/paths/URLs; owner failure has no stack/payload', async t => {
  const f = await setup(t); await f.handle(f.event('latest', '/latest'));
  const reply = f.replies[0].content; for (const value of ['fixture-secret', 'C:\\private', 'https://private']) assert.ok(!reply.includes(value)); assert.ok(Buffer.byteLength(reply) < 1600);
  f.service.actions.review.status = async () => { throw new Error('fixture-secret private-stack'); }; await f.handle(f.event('failed'));
  assert.equal(f.replies[1].content, '暂时无法读取，请在本机检查。');
  const rendered = renderRemoteQqReply({ kind: 'latest', data: { total: 1, items: [{ title: 'x /data/private/secret /Volumes/private/file' }] } }); assert.ok(!rendered.includes('/data/')); assert.ok(!rendered.includes('/Volumes/'));
  assert.ok(Buffer.byteLength(renderRemoteQqReply({ kind: 'help' }, text => text.repeat(100))) <= 1600);
});

test('closing during asynchronous startup cannot start a listener after closure', async t => {
  const f = await setup(t); let release; let gateways = 0;
  f.service.configuration = () => new Promise(resolve => { release = () => resolve({ qq: f.value.common.notifications.channels.qq, remote: { enabled: true, authorizedUser: 'explicit-user' } }); });
  f.service.settings = async () => ({ enabled: true, configured: true, runtimeSupported: true });
  f.service.gatewayFactory = () => { gateways++; throw new Error('listener should not start'); };
  const reconciling = f.service.reconcile(); await Promise.resolve(); const stopping = f.service.stop(); release(); await reconciling; await stopping; assert.equal(gateways, 0);
});
test('uncertain/failed reply outcome is held and never repeats action or send', async t => {
  for (const outcome of [undefined, { accepted: false }]) {
    const f = await setup(t); f.client.sendPassiveReply = async payload => { f.replies.push(payload); if (!outcome) throw new Error('lost response'); return outcome; };
    const result = await f.handle(f.event()); assert.equal(result.receipt.reply, outcome ? 'failed' : 'unknown'); await f.handle(f.event()); assert.equal(f.counts.length, 1); assert.equal(f.replies.length, 1);
  }
});
test('crash after action or after reply-start persistence cannot repeat either', async t => {
  for (const failureAt of [2, 4]) {
    let writes = 0;
    const f = await setup(t, { atomicWriter: async (file, value) => { if (++writes === failureAt) throw new Error('injected crash'); await fs.writeFile(file, JSON.stringify(value)); } });
    await assert.rejects(f.handle(f.event()), /injected crash/);
    const sent = f.replies.length; await f.handle(f.event()); assert.equal(f.counts.length, 1); assert.equal(f.replies.length, sent);
  }
});
test('fixed per-user/global rate limits use fake clock; duplicate event consumes no quota', async t => {
  let now = 0; const limiter = new RemoteRateLimiter({ clock: () => now, perUser: 2, global: 3 });
  assert.equal(limiter.allow('one'), true); assert.equal(limiter.allow('one'), true); assert.equal(limiter.allow('one'), false); assert.equal(limiter.allow('two'), true); assert.equal(limiter.allow('three'), false);
  now = 60000; assert.equal(limiter.allow('one'), true);
  const f = await setup(t); f.service.limiter = new RemoteRateLimiter({ perUser: 1 });
  await f.handle(f.event()); await f.handle(f.event()); const blocked = await f.handle(f.event('other')); assert.equal(blocked.receipt.execution, 'rate_limited'); assert.equal(f.calls.length, 2); assert.equal(f.replies.length, 1);
});
test('receipt mismatch fails closed and never executes', async t => {
  const f = await setup(t); await f.handle(f.event());
  const file = path.join(f.root, 'receipts', identityDigest('qq', 'fixture-app', 'explicit-user', 'message-1') + '.json');
  const receipt = JSON.parse(await fs.readFile(file)); receipt.authorized = false; await fs.writeFile(file, JSON.stringify(receipt));
  await assert.rejects(f.handle(f.event()), /REMOTE_RECEIPT_INVALID/); assert.equal(f.counts.length, 1);
});
test('discovery/passive/active share the one Phase 3 token cache and fixed HTTP endpoints', async () => {
  const calls = []; const client = createQqClient({ appId: 'fixture-app', clientSecret: 'fixture-secret' }, { fetchImpl: async (url, input) => {
    calls.push([url, input]); return { status: 200, json: async () => url.endsWith('getAppAccessToken') ? { access_token: 'fixture-token', expires_in: 7200 } : url.endsWith('/gateway') ? { url: 'wss://api.bot.qq.com/websocket/' } : { id: 'response', timestamp: '2026-09-30T00:00:00Z' } };
  } });
  assert.equal(await client.getGateway(), 'wss://api.bot.qq.com/websocket/'); assert.equal(await client.getAccessToken(), 'fixture-token');
  assert.equal((await client.sendPassiveReply({ userId: 'explicit-user', messageId: 'message-id', content: 'result' })).accepted, true);
  await client.sendNotification('user', 'target', { msg_type: 0, content: 'notification' });
  assert.equal(calls.filter(([url]) => url.endsWith('getAppAccessToken')).length, 1); assert.equal(calls[1][1].method, 'GET');
  assert.deepEqual(JSON.parse(calls[2][1].body), { msg_type: 0, content: 'result', msg_id: 'message-id', msg_seq: 1 }); assert.deepEqual(JSON.parse(calls[3][1].body), { msg_type: 0, content: 'notification' });
  const before = calls.length; await client.sendPassiveReply({ userId: 'user', content: 'missing id' }); assert.equal(calls.length, before);
});
test('gateway discovery rejects credentials/URL override and never connects off official origin', async () => {
  for (const url of ['wss://evil.test/websocket/', 'ws://api.bot.qq.com/websocket/', 'wss://api.bot.qq.com/websocket/?token=secret']) {
    const client = createQqClient({ appId: 'fixture', clientSecret: 'fixture' }, { fetchImpl: async endpoint => ({ status: 200, json: async () => endpoint.endsWith('getAppAccessToken') ? { access_token: 'token', expires_in: 7200 } : { url } }) });
    await assert.rejects(client.getGateway(), /QQ_GATEWAY_URL_INVALID/);
  }
});
