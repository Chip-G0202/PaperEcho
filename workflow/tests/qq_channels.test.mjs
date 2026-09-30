import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { migrateApplicationConfig } from '../tools/lib/application_config_migration.mjs';
import { validateRunnerConfigObject } from '../tools/runner/config_loader.mjs';
import { readNotificationReceipt, testNotificationReceiptPathFor } from '../tools/stage5/email_receipt.mjs';
import { startControlCenter } from '../tools/web/server.mjs';
import { runPreflight } from '../tools/runner/preflight.mjs';
import { runStage5Notification } from '../tools/stage5/main.mjs';

const base = fileURLToPath(new URL('../../tests/runs/qq-channels/', import.meta.url));
async function fixture(t, options = {}) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config/paperecho.config.json');
  const qq = { enabled: true, appId: 'fixture-app', targetType: 'user', targetId: 'fixture-openid', ...options.qq };
  const value = { schemaVersion: 5, mode: 'desktop', common: { email: { enabled: false }, notifications: { channels: { qq }, radar: { enabled: false }, weekly: { enabled: true } } } };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(value));
  if (options.secret !== false) await fs.writeFile(path.join(root, '.env'), 'QQ_BOT_APP_SECRET="fixture-secret"\n');
  const messages = [];
  const services = createControlServices({ root, env: {}, qqTransport: options.transport || (async message => { messages.push(message); return { accepted: true }; }) });
  return { root, value, configPath, services, messages, read: async () => JSON.parse(await fs.readFile(configPath, 'utf8')) };
}
const qqChannel = async f => (await f.services.notifications.settings()).channels.find(entry => entry.id === 'qq');

test('v4 to v5 migration preserves preferences/email, initializes disabled QQ, is atomic/idempotent', async t => {
  const f = await fixture(t);
  const old = { ...f.value, schemaVersion: 4 };
  delete old.common.notifications.channels;
  old.common.email = { enabled: false, recipient: 'fixture@example.test', smtp: { passwordEnv: 'CUSTOM_PASSWORD' } };
  await fs.writeFile(f.configPath, JSON.stringify(old));
  await fs.writeFile(path.join(f.root, '.env'), 'invalid legacy env must never be read');
  await assert.rejects(migrateApplicationConfig({ root: f.root, atomicOptions: { validateTemporary: async () => { throw new Error('injected failure'); } } }));
  assert.deepEqual(await f.read(), old);
  const result = await migrateApplicationConfig({ root: f.root });
  assert.equal(result.schemaVersion, 6);
  const after = await f.read();
  assert.deepEqual(after.common.email, old.common.email);
  for (const event of ['radar', 'weekly']) assert.deepEqual(after.common.notifications[event], old.common.notifications[event]);
  assert.deepEqual(after.common.notifications.channels, Object.fromEntries(['qq','wechat','feishu','wecom'].map(id => [id, { enabled: false }])));
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath + '.v4-backup', 'utf8')), old);
  assert.equal((await migrateApplicationConfig({ root: f.root })).migrated, false);
  assert.deepEqual(await f.read(), after);
});

test('QQ schema rejects provider URL, secrets and unsupported channel fields', () => {
  for (const field of ['apiBase', 'clientSecret', 'access_token', 'retry', 'botId']) assert.throws(() => validateRunnerConfigObject({ schemaVersion: 5, common: { notifications: { channels: { qq: { [field]: 'fixture' } } } } }));
  assert.throws(() => validateRunnerConfigObject({ schemaVersion: 4, common: { notifications: { channels: { qq: { enabled: true } } } } }));
});

for (const [qq, secret, state] of [[{ enabled: false }, true, 'configured'], [{ targetId: '' }, true, 'incomplete'], [{ targetId: 'bad\nvalue' }, true, 'invalid'], [{}, false, 'incomplete']]) test(`QQ readiness ${state}, enabled ${qq.enabled !== false}`, async t => {
  const f = await fixture(t, { qq, secret });
  const result = await qqChannel(f);
  assert.equal(result.enabled, qq.enabled !== false);
  assert.equal(result.readiness, state);
  assert.equal(result.testAvailable, state === 'configured');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(f.messages.length, 0);
});

test('disabled QQ explicit Test is generic, independently deduped and does not enable business preferences', async t => {
  const f = await fixture(t, { qq: { enabled: false } });
  const before = await f.read();
  const input = { channel: 'qq', requestId: 'same-test' };
  assert.equal((await f.services.notifications.test(input)).status, 'success');
  assert.equal((await f.services.notifications.test(input)).status, 'success');
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0].content, /QQ 通知测试/);
  assert.equal(f.messages[0].html, undefined);
  assert.deepEqual(await f.read(), before);
  const { receiptRoot } = await f.services.notifications.configuration();
  const receipt = await readNotificationReceipt(testNotificationReceiptPathFor(receiptRoot, input.requestId, 'qq'));
  assert.equal(receipt.channel, 'qq');
  assert.equal(receipt.status, 'accepted');
  assert.equal(JSON.stringify(receipt).includes('fixture-secret'), false);
  const settings = await f.services.notifications.settings();
  assert.equal(settings.channels.find(value => value.id === 'qq').lastDelivery.status, 'success');
  assert.equal(settings.channels.find(value => value.id === 'email').lastDelivery.status, 'none');
});

test('QQ credential Replace/Clear remains redacted and preserves channel config', async t => {
  const f = await fixture(t);
  const before = await f.read();
  await f.services.secrets.replace('QQ_BOT_APP_SECRET', 'replacement-fixture');
  assert.equal((await qqChannel(f)).credential.configured, true);
  assert.equal(JSON.stringify(await f.services.secrets.list()).includes('replacement-fixture'), false);
  assert.equal(f.services.secrets.redact('replacement-fixture'), '[REDACTED]');
  await f.services.secrets.clear('QQ_BOT_APP_SECRET');
  assert.equal((await qqChannel(f)).readiness, 'incomplete');
  assert.deepEqual(await f.read(), before);
});

test('QQ Test limited errors and unknown replay cannot leak or resend', async t => {
  let calls = 0;
  const f = await fixture(t, { transport: async () => { calls++; return { category: 'qq_network', raw: 'fixture-secret' }; } });
  const request = { channel: 'qq', requestId: 'unknown' };
  const result = await f.services.notifications.test(request);
  assert.equal(result.status, 'pending');
  assert.equal(result.error, 'connection_failed');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  await f.services.notifications.test(request);
  assert.equal(calls, 1);
});

test('QQ endpoint retains session/Origin/CSRF and rejects arbitrary provider URL', async t => {
  const f = await fixture(t);
  const server = await startControlCenter({ root: f.root, services: f.services, env: {}, port: 0 });
  t.after(async () => { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); });
  const home = await fetch(server.url + '/api/session');
  const cookie = home.headers.get('set-cookie').split(';')[0];
  const token = (await home.json()).token;
  const post = (input, headers = {}) => fetch(server.url + '/api/notifications/test', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) });
  const valid = { channel: 'qq', requestId: 'api-test' };
  assert.equal((await post(valid)).status, 403);
  const headers = { Cookie: cookie, Origin: new URL(server.url).origin, 'X-CSRF-Token': token };
  assert.equal((await post({ ...valid, apiUrl: 'https://example.com' }, headers)).status, 400);
  const result = await post(valid, headers);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).status, 'success');
  assert.equal(result.headers.get('access-control-allow-origin'), null);
});

test('v5 incomplete SMTP is isolated from QQ and business preflight', async t => {
  const f = await fixture(t);
  const entry = path.join(f.root, 'entry.mjs');
  await fs.writeFile(entry, 'export {};');
  const options = { mode: 'web', action: 'check', profile: 'standard', email: 'reader@example.test', llmMode: 'disabled', requireLlm: false, configPath: f.configPath, configSummary: { sectionsChecked: ['common', 'web'], secretStatus: {} }, configWarnings: [] };
  const report = await runPreflight(options, { env: { PAPERECHO_CONFIG_SCHEMA_VERSION: '5', ZOTERO_API_KEY: 'fake', ZOTERO_USER_ID: '123' },
    entries: { web: entry }, findExecutableImpl: () => entry, existsSync: value => value === entry, resolveLlmRuntimeImpl: () => ({ apiKeyConfigured: false }) });
  assert.equal(report.canRun, true);
  assert.equal(report.requiredMissing.some(item => /^SMTP/.test(item.name)), false);
  assert.equal(JSON.stringify(report).includes('fixture-secret'), false);
});

for (const invalid of ['qq', 'email']) test(`${invalid} invalid config cannot prevent the other delivery`, async t => {
  const f = await fixture(t);
  let email = 0; let qq = 0;
  const env = { PAPERECHO_CONFIG_SCHEMA_VERSION: '5', PAPERECHO_QQ_CHANNEL: JSON.stringify({ ...f.value.common.notifications.channels.qq, ...(invalid === 'qq' ? { targetType: 'guild' } : {}) }), QQ_BOT_APP_SECRET: 'fake' };
  const result = await runStage5Notification({ runSummary: { runId: 'fixture', finishedAt: '2026-09-30T12:00:00Z', outputRoot: f.root, artifacts: [], counts: { created: 1 } },
    recipient: invalid === 'email' ? 'invalid-address' : 'reader@example.test', transport: async () => { email++; return { accepted: true }; },
    config: { env, runStateRoot: f.root, ...(invalid === 'email' ? { qqTransport: async () => { qq++; return { accepted: true }; } } : {}) } });
  assert.equal(result.businessStatus, 'success');
  assert.equal(result.channels[invalid].status, 'failed');
  assert.equal(result.channels[invalid === 'qq' ? 'email' : 'qq'].status, invalid === 'qq' ? 'sent' : 'accepted');
  assert.equal(invalid === 'qq' ? email : qq, 1);
});
