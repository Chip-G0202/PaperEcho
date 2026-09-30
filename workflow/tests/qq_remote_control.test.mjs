import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { startControlCenter } from '../tools/web/server.mjs';
import { migrateApplicationConfig } from '../tools/lib/application_config_migration.mjs';
import { validateRunnerConfigObject } from '../tools/runner/config_loader.mjs';

const base = fileURLToPath(new URL('./.qq-remote-test-tmp/', import.meta.url));
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
async function fixture(t, { version = '22.4.0', enabled = false } = {}) {
  await fs.mkdir(base, { recursive: true }); const root = await fs.mkdtemp(path.join(base, 'control-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config', 'paperecho.config.json');
  const value = { schemaVersion: 6, mode: 'desktop', common: { email: { enabled: false }, notifications: { channels: { qq: { enabled: false, appId: 'fixture-app', targetType: 'user', targetId: 'outbound-recipient', remoteInteraction: { enabled, authorizedUser: 'explicit-user' } } } } } };
  await write(configPath, value);
  const reviewRoot = path.join(root, 'review_results', '文献评价'); const researchRoot = path.join(root, 'review_results');
  const sockets = []; const sent = []; const timers = new Map(); let timerId = 0; let gatewayCalls = 0;
  class Socket { constructor() { this.readyState = 1; this.events = {}; this.sent = []; sockets.push(this); } addEventListener(name, fn) { this.events[name] = fn; } send(text) { this.sent.push(JSON.parse(text)); } close() { this.readyState = 3; this.events.close?.({ code: 1000 }); } message(frame) { this.events.message({ data: JSON.stringify(frame) }); } }
  const client = { getGateway: async () => { gatewayCalls++; return 'wss://api.bot.qq.com/websocket/'; }, getAccessToken: async () => 'fixture-token', invalidateToken: () => {}, sendPassiveReply: async data => { sent.push(data); return { accepted: true }; } };
  const context = { mode: 'desktop', env: { QQ_BOT_APP_SECRET: 'fixture-secret' }, configPath, reviewRoot, researchRoot, runRoot: path.join(reviewRoot, 'runs') };
  const services = createControlServices({ root, context, env: { QQ_BOT_APP_SECRET: 'fixture-secret' }, qqTransport: async () => ({ accepted: true }), remoteOptions: { runtime: { nodeVersion: version, WebSocketCtor: Socket, timers: { setTimeout: (fn, delay) => { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout: id => timers.delete(id) } }, getClient: async () => client } });
  const running = await startControlCenter({ root, port: 0, services, context });
  t.after(async () => { await services.remote.stop(); running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); });
  await services.remote.reconciliation;
  const session = await fetch(running.url + '/api/session'); const sessionData = await session.json();
  const headers = { Cookie: session.headers.get('set-cookie').split(';')[0], Origin: running.url, 'X-CSRF-Token': sessionData.token, 'Content-Type': 'application/json' };
  const get = route => fetch(running.url + route, { headers }).then(async response => ({ status: response.status, data: await response.json() }));
  const post = (route, data, overrides = {}) => fetch(running.url + route, { method: 'POST', headers: { ...headers, ...overrides }, body: JSON.stringify(data) }).then(async response => ({ status: response.status, data: await response.json() }));
  return { root, reviewRoot, researchRoot, configPath, value, services, sockets, sent, timers, running, get, post, gatewayCalls: () => gatewayCalls };
}
test('v5→v6 centralized migration keeps outbound/preferences/secret refs, default disabled with no implicit administrator', async t => {
  const f = await fixture(t); const old = structuredClone(f.value); old.schemaVersion = 5; delete old.common.notifications.channels.qq.remoteInteraction; old.common.notifications.radar = { enabled: false }; old.common.notifications.weekly = { enabled: true }; old.common.email = { enabled: true, recipient: 'fixture@example.test', smtp: { passwordEnv: 'CUSTOM_PASSWORD' } };
  await write(f.configPath, old); await write(path.join(f.root, '.env'), 'deliberately unreadable legacy env');
  await assert.rejects(migrateApplicationConfig({ root: f.root, atomicOptions: { validateTemporary: async () => { throw new Error('injected migration failure'); } } })); assert.deepEqual(JSON.parse(await fs.readFile(f.configPath)), old);
  assert.equal((await migrateApplicationConfig({ root: f.root })).schemaVersion, 6); const next = JSON.parse(await fs.readFile(f.configPath));
  assert.deepEqual(next.common.notifications.channels.qq, { ...old.common.notifications.channels.qq, remoteInteraction: { enabled: false } }); assert.deepEqual(next.common.email, old.common.email); assert.deepEqual(next.common.notifications.radar, old.common.notifications.radar); assert.deepEqual(next.common.notifications.weekly, old.common.notifications.weekly);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath + '.v5-backup')), old); assert.equal((await migrateApplicationConfig({ root: f.root })).migrated, false);
});
test('remote schema fields are strict, explicit identity only, no token/URL/allowlist auto-learning', () => {
  for (const remoteInteraction of [{ token: 'x' }, { enabled: 'yes' }, { authorizedUser: 'QQ nickname' }, { authorizedUser: 'https://host' }, { authorizedUser: [] }, { firstUserIsAdmin: true }, []]) assert.throws(() => validateRunnerConfigObject({ schemaVersion: 6, common: { notifications: { channels: { qq: { remoteInteraction } } } } }));
  assert.throws(() => validateRunnerConfigObject({ schemaVersion: 5, common: { notifications: { channels: { qq: { remoteInteraction: { enabled: false } } } } } }));
});
test('Settings/API masks authorized identity and retains loopback/session/Origin/CSRF fences', async t => {
  const f = await fixture(t); const settings = await f.get('/api/settings'); const author = settings.data.find(entry => entry.id === 'qq.remote.authorizedUser'); assert.equal(author.value, null); assert.equal(author.configured, true); assert.ok(!JSON.stringify(settings.data).includes('explicit-user'));
  const remote = await f.get('/api/qq-remote'); assert.equal(remote.status, 200); assert.equal(remote.data.connection, 'not_running'); assert.equal(remote.data.enabled, false); assert.ok(!JSON.stringify(remote.data).includes('fixture-secret')); assert.ok(!JSON.stringify(remote.data).includes('explicit-user'));
  assert.equal((await fetch(f.running.url + '/api/qq-remote')).status, 403);
  assert.equal((await f.post('/api/settings', { id: 'qq.remote.enabled', value: true }, { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await f.post('/api/settings', { id: 'qq.remote.enabled', value: true }, { 'X-CSRF-Token': 'bad' })).status, 403);
  assert.equal((await f.post('/api/qq-remote', { action: '/status' })).status, 404); assert.equal(f.gatewayCalls(), 0);
});
test('Node 18 can save authorization/enable flag but listener cannot start; QQ outbound Test remains usable', async t => {
  const f = await fixture(t, { version: '18.20.8' });
  assert.equal((await f.post('/api/settings', { id: 'qq.remote.enabled', value: true })).status, 200); await f.services.remote.reconciliation;
  const remote = (await f.get('/api/qq-remote')).data; assert.equal(remote.enabled, true); assert.equal(remote.runtimeSupported, false); assert.equal(remote.connection, 'error'); assert.equal(remote.error, 'QQ_REMOTE_RUNTIME_UNSUPPORTED'); assert.equal(f.gatewayCalls(), 0); assert.equal(f.sockets.length + f.timers.size, 0);
  const channel = (await f.get('/api/notifications')).data.channels.find(entry => entry.id === 'qq'); assert.equal(channel.readiness, 'configured'); assert.equal(channel.testAvailable, true);
  assert.equal((await f.post('/api/notifications/test', { channel: 'qq', requestId: 'node18-outbound' })).data.status, 'success');
});
test('real read owners serve latest/radar/weekly/status without changing any business/config/feedback state', async t => {
  const f = await fixture(t); const weekly = path.join(f.researchRoot, 'pipeline', 'weekly'); const radar = path.join(f.researchRoot, 'pipeline', 'radar');
  const manifest = (id, time, artifacts) => ({ schemaVersion: 1, runId: id, pipelineMode: 'desktop', status: 'completed', startedAt: time, artifacts });
  const inputs = new Map([
    [path.join(f.reviewRoot, 'runs', 'weekly', 'run_group.json'), manifest('weekly', '2026-09-29T00:00:00Z', [{ kind: 'pipeline', rootKey: 'research', path: 'pipeline/weekly' }, { kind: 'weekly_export' }])],
    [path.join(weekly, 'run_report.json'), { steps: { med_weekly_synthesis: { completed: true } } }],
    [path.join(weekly, 'desktop_daily_review_source.json'), { triaged: [{ title: 'Existing paper', doi: '10.1234/fixture', grade: 'A' }] }],
    [path.join(weekly, 'zotero_writeback_summary.json'), { writeback_items: [{ title: 'Existing paper', doi: '10.1234/fixture', grade: 'A', itemKey: 'FIXTURE' }] }],
    [path.join(f.reviewRoot, 'runs', 'radar', 'run_group.json'), manifest('radar', '2026-09-30T00:00:00Z', [{ kind: 'pipeline', rootKey: 'research', path: 'pipeline/radar' }])],
    [path.join(radar, 'run_report.json'), { profile: 'radar' }], [path.join(radar, 'radar_audit.json'), { profile: 'radar', candidateCount: 8, urgentCount: 2, zoteroWriteCount: 0, xlsxWriteCount: 0 }],
  ]);
  for (const [file, data] of inputs) await write(file, data);
  const before = new Map(await Promise.all([...inputs.keys(), f.configPath].map(async file => [file, await fs.readFile(file, 'utf8')])));
  const calls = []; for (const method of ['status', 'latestLiteratureSummary', 'radarSummary', 'weeklySummary']) { const original = f.services.review[method].bind(f.services.review); f.services.review[method] = async () => { calls.push(method); return original(); }; }
  for (const owner of ['feedback', 'config', 'rules']) for (const method of ['submit', 'update', 'updateMany', 'decideWithReceipt']) if (typeof f.services[owner][method] === 'function') f.services[owner][method] = () => { throw new Error('business mutation forbidden'); };
  assert.equal((await f.services.remote.actions.execute('latest')).data.total, 1); assert.equal((await f.services.remote.actions.execute('weekly')).data.items[0].title, 'Existing paper'); assert.equal((await f.services.remote.actions.execute('radar')).data.urgentCount, 2); assert.equal((await f.services.remote.actions.execute('status')).lastRadar, '2026-09-30T00:00:00Z');
  assert.deepEqual(calls, ['latestLiteratureSummary', 'weeklySummary', 'radarSummary', 'status']);
  for (const [file, text] of before) assert.equal(await fs.readFile(file, 'utf8'), text);
  assert.equal((await fs.readdir(f.reviewRoot)).includes('control_feedback.json'), false);
});
test('Control Center startup/enable/Ready/replay/disconnect/close own the listener, no autonomous daemon', async t => {
  const f = await fixture(t, { enabled: true }); assert.equal(f.sockets.length, 1); assert.equal((await f.get('/api/qq-remote')).data.connection, 'connecting');
  const socket = f.sockets[0]; socket.message({ op: 10, d: { heartbeat_interval: 45000 } }); for (let i = 0; i < 10; i++) await Promise.resolve();
  socket.message({ op: 0, s: 1, t: 'READY', d: { session_id: 'fixture-session' } }); await f.services.remote.gateway.queue;
  assert.equal((await f.get('/api/qq-remote')).data.connection, 'online');
  const event = { op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { id: 'fixture-message', author: { user_openid: 'explicit-user' }, content: '/help' } };
  let executed = 0; const execute = f.services.remote.actions.execute.bind(f.services.remote.actions); f.services.remote.actions.execute = action => { executed++; return execute(action); };
  socket.message(event); await f.services.remote.gateway.queue; socket.message({ ...event, s: 3 }); await f.services.remote.gateway.queue; assert.equal(f.sent.length, 1); assert.equal(executed, 1);
  socket.events.close({ code: 4009 }); const [retryId, retry] = [...f.timers].find(([, timer]) => timer.delay === 1000); f.timers.delete(retryId); retry.fn(); for (let i = 0; i < 12; i++) await Promise.resolve();
  const resumed = f.sockets[1]; resumed.message({ op: 10, d: { heartbeat_interval: 45000 } }); for (let i = 0; i < 10; i++) await Promise.resolve(); assert.equal(resumed.sent[0].op, 6); assert.equal(resumed.sent[0].d.seq, 3);
  resumed.message({ ...event, s: 4 }); await f.services.remote.gateway.queue; resumed.message({ op: 0, s: 5, t: 'RESUMED', d: '' }); await f.services.remote.gateway.queue; assert.equal(f.sent.length, 1); assert.equal(executed, 1);
  assert.equal((await f.post('/api/settings', { id: 'qq.remote.enabled', value: false })).status, 200); await f.services.remote.reconciliation; assert.equal(resumed.readyState, 3); assert.equal((await f.get('/api/qq-remote')).data.connection, 'not_running');
  await f.services.remote.stop(); assert.equal(f.timers.size, 0);
});
