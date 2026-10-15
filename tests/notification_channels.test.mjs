import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createControlServices } from '../workflow/tools/lib/control_application_services.mjs';
import { secureCredentialFile } from '../workflow/tools/lib/credential_file_security.mjs';
import { migrateApplicationConfig } from '../workflow/tools/lib/application_config_migration.mjs';
import { validateRunnerConfigObject, resolveRunnerConfiguration } from '../workflow/tools/runner/config_loader.mjs';
import { parseRunnerArgs } from '../workflow/tools/runner/args.mjs';
import { buildExecutionPlan } from '../workflow/tools/runner/preflight.mjs';
import { emailDeliveryPolicy, channelDeliveryPolicy } from '../workflow/tools/notification/policy.mjs';
import { runStage5Notification, resolveStage5Request } from '../workflow/tools/stage5/main.mjs';
import { sendRadarAggregateNotification } from '../workflow/tools/stage5/radar_notification.mjs';
import { createNotificationReceipt, writeNotificationReceipt, receiptPathFor, notificationReceiptPathFor } from '../workflow/tools/stage5/email_receipt.mjs';
import { startControlCenter } from '../workflow/tools/web/server.mjs';

const base = fileURLToPath(new URL('./runs/notification-channels/', import.meta.url));
const smtp = { host: 'smtp.example.test', user: 'sender@example.test', port: 465, secure: true, passwordEnv: 'SMTP_PASS' };
const fakeSecret = 'fixture-smtp-password';
async function fixture(t, { enabled = true, complete = true, env = {}, transport = async () => ({ accepted: true }), email = {}, schemaVersion = 4 } = {}) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config/paperecho.config.json');
  const value = { schemaVersion, mode: 'desktop', common: { radar: { enabled: true }, email: { enabled, ...(complete ? { recipient: 'reader@example.test', smtp: { ...smtp } } : {}), ...email }, notifications: schemaVersion === 4 ? { radar: { enabled: true }, weekly: { enabled: true } } : {} } };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(value));
  if (complete) await fs.writeFile(path.join(root, '.env'), `SMTP_PASS="${fakeSecret}"\n`);
  const services = createControlServices({ root, env, notificationTransport: transport });
  return { root, configPath, value, services, read: async () => JSON.parse(await fs.readFile(configPath, 'utf8')) };
}
const channel = async (f) => (await f.services.notifications.settings()).channels[0];

test('v3 to v5 migration preserves Email/other configuration and never reads legacy inputs', async (t) => {
  const f = await fixture(t, { enabled: false, schemaVersion: 3 });
  await fs.writeFile(path.join(f.root, '.env'), 'BROKEN legacy input must not be read');
  assert.equal((await migrateApplicationConfig({ root: f.root })).schemaVersion, 6);
  const after = await f.read();
  assert.deepEqual(after.common.email, f.value.common.email);
  assert.deepEqual(after.common.notifications, { radar: { enabled: true }, weekly: { enabled: true }, channels: Object.fromEntries(['qq','wechat','feishu','wecom'].map(id => [id, { enabled: false }])) });
  assert.deepEqual(JSON.parse(await fs.readFile(`${f.configPath}.v3-backup`, 'utf8')), f.value);
  assert.equal((await migrateApplicationConfig({ root: f.root })).migrated, false);
  assert.deepEqual(await f.read(), after);
});
test('v4 preferences reject arbitrary channel fields and policy values', () => {
  for (const preference of [{ enabled: 'true' }, { enabled: true, policy: 'digest' }, { enabled: true, channels: ['qq'] }]) {
    assert.throws(() => validateRunnerConfigObject({ schemaVersion: 4, common: { notifications: { radar: preference } } }));
  }
  assert.throws(() => validateRunnerConfigObject({ schemaVersion: 3, common: { notifications: { radar: { enabled: true } } } }));
});
for (const enabled of [false, true]) test(`Email ${enabled ? 'enabled' : 'disabled'} retains independent configuration readiness`, async (t) => {
  const f = await fixture(t, { enabled });
  const result = await channel(f);
  assert.equal(result.id, 'email'); assert.equal(result.displayName, '邮箱'); assert.equal(result.availability, 'available');
  assert.equal(result.enabled, enabled); assert.equal(result.readiness, 'configured'); assert.equal(result.testAvailable, true);
  assert.equal(result.lastDelivery.status, 'none'); assert.equal(JSON.stringify(result).includes(fakeSecret), false);
});
test('enabled incomplete and invalid have explicit states without sending', async (t) => {
  let calls = 0;
  const incomplete = await fixture(t, { complete: false, transport: async () => { calls++; } });
  assert.equal((await channel(incomplete)).readiness, 'incomplete');
  assert.equal((await incomplete.services.notifications.test({ channel: 'email', requestId: 'incomplete' })).error, 'configuration_incomplete');
  const invalid = await fixture(t, { email: { smtp: { ...smtp, host: 'https://invalid.example/password' } }, transport: async () => { calls++; } });
  assert.equal((await channel(invalid)).readiness, 'invalid');
  assert.equal((await invalid.services.notifications.test({ channel: 'email', requestId: 'invalid' })).error, 'configuration_invalid');
  assert.equal(calls, 0);
});

test('Settings preserves SMTP transport defaults when optional port/TLS are absent', async (t) => {
  for (const port of [undefined, 465, 587]) {
    const f = await fixture(t, { email: { smtp: { host: smtp.host, user: smtp.user, ...(port ? { port } : {}) } } });
    const settings = await f.services.config.list();
    assert.equal(settings.find((entry) => entry.id === 'smtp.port').value, port ?? 465);
    const secure = settings.find((entry) => entry.id === 'smtp.secure').value;
    assert.equal(secure, (port ?? 465) === 465);
    await f.services.config.update('smtp.secure', secure);
    assert.equal((await f.read()).common.email.smtp.secure, (port ?? 465) === 465);
  }
});
test('canonical Settings save migrates v3 and legacy Email alias without dual writes', async (t) => {
  const f = await fixture(t, { schemaVersion: 3 });
  const legacy = path.join(f.root, 'config/title_translation.config.json');
  await fs.writeFile(legacy, '{"model":"legacy-unchanged"}');
  await f.services.config.updateMany([{ id: 'weekly.email', value: false }, { id: 'notification.radar', value: false }, { id: 'notification.weekly', value: true }, { id: 'smtp.host', value: 'mail.example.test' }]);
  const result = await f.read();
  assert.equal(result.schemaVersion, 4); assert.equal(result.common.email.enabled, false);
  assert.equal(result.common.notifications.radar.enabled, false); assert.equal(result.common.notifications.weekly.enabled, true);
  assert.equal(result.common.email.smtp.host, 'mail.example.test'); assert.equal(result.weekly?.email, undefined);
  assert.equal(await fs.readFile(legacy, 'utf8'), '{"model":"legacy-unchanged"}');
  assert.equal((await f.services.config.list()).some((entry) => entry.id === 'weekly.email'), false);
  await assert.rejects(f.services.config.updateMany([{ id: 'weekly.email', value: true }, { id: 'email.enabled', value: false }]), /BATCH_INVALID/);
});
test('invalid/unknown Settings are rejected atomically, preserving saved configuration', async (t) => {
  const f = await fixture(t); const before = await fs.readFile(f.configPath, 'utf8');
  for (const [id, value] of [['smtp.host', 'smtp://bad'], ['smtp.host', 'bad host'], ['smtp.port', 0], ['smtp.port', 65536], ['email.recipient', 'bad'], ['smtp.from', 'bad'], ['email.secret', fakeSecret]]) {
    await assert.rejects(f.services.config.updateMany([{ id: 'email.enabled', value: false }, { id, value }]));
    assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
  }
  await assert.rejects(f.services.config.updateMany([{ id: 'smtp.host', value: 'valid.example', password: fakeSecret }]));
});
test('SMTP Replace/Clear uses SecretService and immediately changes channel readiness', async (t) => {
  const f = await fixture(t);
  // Existing dummy credentials need an explicit ACL, independent of host groups.
  await secureCredentialFile(path.join(f.root, '.env'));
  await f.services.secrets.replace('SMTP_PASS', 'new-fixture-secret');
  assert.equal((await channel(f)).credential.configured, true);
  assert.equal(JSON.stringify(await channel(f)).includes('new-fixture-secret'), false);
  await f.services.secrets.clear('SMTP_PASS');
  assert.equal((await channel(f)).readiness, 'incomplete');
  assert.equal((await f.read()).common.email.enabled, true);
  assert.equal((await fs.readFile(f.configPath, 'utf8')).includes('new-fixture-secret'), false);
});
test('external SMTP override and custom secret reference stay read-only and never returned', async (t) => {
  for (const custom of [false, true]) {
    const secret = 'injected-fixture-secret';
    const f = await fixture(t, { env: custom ? { CUSTOM_SMTP_SECRET: secret } : { SMTP_PASS: secret }, email: custom ? { recipient: 'reader@example.test', smtp: { ...smtp, passwordEnv: 'CUSTOM_SMTP_SECRET' } } : {} });
    const result = await channel(f);
    assert.equal(result.readiness, 'configured'); assert.equal(result.credential.writable, false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    if (!custom) await assert.rejects(f.services.secrets.clear('SMTP_PASS'), /EXTERNALLY_MANAGED/);
    assert.equal((await f.services.notifications.test({ channel: 'email', requestId: 'override' })).status, 'success');
  }
});
for (const enabled of [true, false]) test(`explicit test succeeds with configured Email ${enabled ? 'enabled' : 'disabled'} and touches no business state`, async (t) => {
  let calls = 0; let message;
  const f = await fixture(t, { enabled, transport: async (input) => { calls++; message = input; return { accepted: true }; } });
  const marker = path.join(f.root, 'review_results/runtime_state.json'); await fs.mkdir(path.dirname(marker), { recursive: true }); await fs.writeFile(marker, '{"unchanged":true}');
  const before = await fs.readFile(f.configPath, 'utf8');
  assert.equal((await f.services.notifications.test({ channel: 'email', requestId: 'same-test' })).status, 'success');
  assert.equal((await f.services.notifications.test({ channel: 'email', requestId: 'same-test' })).status, 'success');
  assert.equal(calls, 1); assert.equal(message.subject, 'PaperEcho 通知测试'); assert.match(message.html, /PaperEcho/); assert.match(message.text, /通知测试成功/);
  assert.deepEqual(message.attachments, []); assert.equal(message.to, 'reader@example.test'); assert.equal(JSON.stringify(message).includes(fakeSecret), false);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before); assert.equal(await fs.readFile(marker, 'utf8'), '{"unchanged":true}');
  assert.equal(await fs.stat(f.services.review.runRoot).then(() => true).catch(() => false), false);
  assert.equal((await channel(f)).lastDelivery.kind, 'test');
});
for (const [code, error, status] of [['EAUTH', 'authentication_failed', 'failed'], ['ECONNRESET', 'connection_failed', 'pending']]) test(`test ${code} shows a safe category and preserves delivery semantics`, async (t) => {
  let calls = 0;
  const f = await fixture(t, { transport: async () => { calls++; throw Object.assign(new Error(`raw ${fakeSecret} smtp response`), { code }); } });
  const result = await f.services.notifications.test({ channel: 'email', requestId: 'failure' });
  assert.equal(result.error, error); assert.equal(result.status, status); assert.equal(JSON.stringify(result).includes(fakeSecret), false);
  assert.equal((await channel(f)).lastDelivery.status, status);
  if (code === 'ECONNRESET') { await f.services.notifications.test({ channel: 'email', requestId: 'failure' }); assert.equal(calls, 1); }
});
test('duplicate/in-flight test requests are bounded and do not enqueue another send', async (t) => {
  let release; let started; let calls = 0;
  const began = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { transport: async () => { calls++; started(); await new Promise((resolve) => { release = resolve; }); return { accepted: true }; } });
  const first = f.services.notifications.test({ channel: 'email', requestId: 'first' });
  await began;
  assert.equal((await f.services.notifications.test({ channel: 'email', requestId: 'second' })).status, 'busy');
  assert.equal((await channel(f)).lastDelivery.status, 'pending');
  release(); assert.equal((await first).status, 'success'); assert.equal(calls, 1);
});
test('latest status reads formal Weekly, Radar and shared receipts, never raw replay content', async (t) => {
  const f = await fixture(t); const settings = await f.services.notifications.configuration();
  const root = path.join(f.services.review.runRoot, 'weekly-status');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'run_group.json'), JSON.stringify({ schemaVersion: 1, runId: 'weekly-status', startedAt: '2026-09-30T00:00:00Z', artifacts: [] }));
  for (const [type, status, date] of [['run_summary', 'accepted', '2026-09-30T01:00:00Z'], ['radar_business', 'failed', '2026-09-30T02:00:00Z'], ['source_health', 'pending', '2026-09-30T03:00:00Z']]) {
    const receipt = createNotificationReceipt({ notificationType: type, runId: 'weekly-status', businessSubject: 'status', eventEpoch: type, payload: {}, recipient: 'reader@example.test', clock: () => new Date(date) }); receipt.status = status; receipt.recoveryData = { private: 'do-not-return' };
    const file = type === 'run_summary' ? receiptPathFor(root) : notificationReceiptPathFor(type === 'radar_business' ? root : settings.receiptRoot, receipt.receiptId);
    await writeNotificationReceipt(file, receipt);
    const result = (await channel(f)).lastDelivery; assert.equal(result.kind, 'business'); assert.equal(result.status, status === 'accepted' ? 'success' : status); assert.equal(result.at, new Date(date).toISOString());
    assert.equal(JSON.stringify(result).includes('do-not-return'), false);
  }
});
for (const profile of ['standard', 'radar']) test(`${profile} preference and disabled channel suppress requests before preflight/delivery`, async (t) => {
  const f = await fixture(t);
  await f.services.config.update(profile === 'radar' ? 'notification.radar' : 'notification.weekly', false);
  const resolved = await resolveRunnerConfiguration(parseRunnerArgs(['--check', '--config', f.configPath, '--profile', profile]), { cwd: f.root, env: { PAPERFLOW_REPORT_TO: 'legacy@example.test' } });
  const event = profile === 'radar' ? 'radar' : 'weekly';
  assert.equal(emailDeliveryPolicy(event, { env: resolved.env }).required, false);
  assert.equal(resolveStage5Request(['--email', 'reader@example.test'], resolved.env, event).recipient, '');
  assert.equal(buildExecutionPlan(resolved.options, { env: resolved.env }).emailRequested, false);
  await f.services.config.update('email.enabled', false);
  assert.equal(emailDeliveryPolicy(event, { config: await f.read() }).reason, 'channel_disabled');
  const env = { PAPERECHO_EMAIL_ENABLED: 'false' };
  const poison = async () => { throw new Error('transport must not run'); };
  assert.equal((await runStage5Notification({ recipient: 'reader@example.test', config: { env }, transport: poison })).reason, 'channel_disabled');
  assert.equal((await sendRadarAggregateNotification({ recipient: 'reader@example.test', urgentItems: [{ grade: 'A' }], env, transport: poison })).reason, 'channel_disabled');
});

test('notification API keeps session/Host/Origin/CSRF guards and never returns secrets', async (t) => {
  const f = await fixture(t, { transport: async () => { throw Object.assign(new Error(fakeSecret), { code: 'EAUTH' }); } });
  const running = await startControlCenter({ root: f.root, services: f.services, port: 0 });
  t.after(async () => { running.server.closeAllConnections(); await new Promise((resolve) => running.server.close(resolve)); });
  const url = new URL(running.url);
  const request = (route, { data, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method: data ? 'POST' : 'GET', headers }, (res) => { let text = ''; res.on('data', (part) => text += part); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, value: JSON.parse(text) })); }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
  assert.equal((await request('/api/notifications')).status, 403);
  const session = await request('/api/session');
  const auth = { cookie: session.headers['set-cookie'][0].split(';')[0], origin: running.url, 'x-csrf-token': session.value.token, 'content-type': 'application/json' };
  const data = { channel: 'email', requestId: 'http-test' };
  for (const headers of [{ ...auth, origin: 'https://evil.example' }, { ...auth, host: 'evil.example' }, { ...auth, 'x-csrf-token': '' }, { ...auth, cookie: '' }]) assert.equal((await request('/api/notifications/test', { data, headers })).status, 403);
  assert.equal((await request('/api/notifications/test', { data: { ...data, recipient: 'arbitrary@example.test' }, headers: auth })).status, 400);
  assert.equal((await request('/api/notifications/test', { data, headers: auth })).value.error, 'authentication_failed');
  for (const route of ['/api/notifications', '/api/settings', '/api/credentials']) { const result = await request(route, { headers: auth }); assert.equal(result.status, 200); assert.equal(result.text.includes(fakeSecret), false); assert.equal(result.headers['access-control-allow-origin'], undefined); }
});
test('v6 global channel selection and event switches reach the shared Runner policy without dual writes', async t => {
  const f = await fixture(t, { schemaVersion: 6 });
  await f.services.config.updateMany([{ id: 'email.enabled', value: true }, { id: 'qq.enabled', value: true }, { id: 'notification.radar', value: true }, { id: 'notification.weekly', value: false }]);
  const config = await f.read();
  assert.deepEqual(config.common.notifications.radar, { enabled: true });
  assert.deepEqual(config.common.notifications.weekly, { enabled: false });
  assert.equal(emailDeliveryPolicy('radar', { config }).required, true);
  assert.equal(channelDeliveryPolicy('qq', 'radar', { config }).required, true);
  assert.equal(emailDeliveryPolicy('weekly', { config }).required, false);
  const options = parseRunnerArgs(['--check', '--mode', 'desktop', '--profile', 'standard', '--config', f.configPath]);
  const resolved = await resolveRunnerConfiguration(options, { cwd: f.root, env: { PAPERECHO_NOTIFY_RADAR_CHANNELS: '[]' } });
  assert.equal(resolved.env.PAPERECHO_NOTIFY_RADAR_CHANNELS, undefined);
  for (const id of ['email', 'qq', 'wechat', 'feishu', 'wecom']) {
    assert.equal(channelDeliveryPolicy(id, 'radar', { env: resolved.env }).required, ['email', 'qq'].includes(id));
    assert.equal(channelDeliveryPolicy(id, 'weekly', { env: resolved.env }).required, false);
  }
  assert.equal(emailDeliveryPolicy('failure', { env: resolved.env }).required, true);
  for (const channels of [['unknown'], ['qq', 'qq'], 'qq', [null]]) assert.throws(() => validateRunnerConfigObject({ schemaVersion: 6, common: { notifications: { radar: { channels } } } }));
  assert.equal((await f.services.config.list()).some(entry => /notification\.(radar|weekly)\.channels/.test(entry.id)), false);
  const saved = await f.read(); await assert.rejects(f.services.config.update('notification.radar.channels', ['qq']), /SETTING_UNKNOWN/); assert.deepEqual(await f.read(), saved);
});

for (const [daily, weekly, radarEnabled, weeklyEnabled, expected] of [
  [['email', 'qq'], ['email'], true, true, ['email', 'qq']],
  [[], ['qq'], true, true, ['qq']],
  [['wechat'], ['feishu', 'wecom'], false, true, ['wechat', 'feishu', 'wecom']],
  [['qq'], [], true, false, ['qq']],
  [[], [], false, false, []],
  [undefined, ['qq'], false, true, ['email', 'qq', 'wechat', 'feishu', 'wecom']],
]) test(`legacy event lists migrate atomically to global selection ${JSON.stringify([daily, weekly, radarEnabled, weeklyEnabled])}`, async t => {
  const f = await fixture(t, { schemaVersion: 6 });
  f.value.common.notifications = { radar: { enabled: radarEnabled, ...(daily ? { channels: daily } : {}) }, weekly: { enabled: weeklyEnabled, channels: weekly }, channels: Object.fromEntries(['qq', 'wechat', 'feishu', 'wecom'].map(id => [id, { enabled: true }])) };
  await fs.writeFile(f.configPath, JSON.stringify(f.value));
  // Read-only compatibility and persisted migration use exactly the same projection.
  const before = await fs.readFile(f.configPath, 'utf8');
  const listed = await f.services.config.list();
  assert.deepEqual(listed.filter(entry => /^(email|qq|wechat|feishu|wecom)\.enabled$/.test(entry.id) && entry.value).map(entry => entry.id.split('.')[0]), expected);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
  assert.equal((await migrateApplicationConfig({ root: f.root })).migrated, true);
  const after = await f.read();
  assert.equal(after.schemaVersion, 6);
  assert.deepEqual(after.common.notifications.radar, { enabled: radarEnabled });
  assert.deepEqual(after.common.notifications.weekly, { enabled: weeklyEnabled });
  assert.deepEqual(['email', 'qq', 'wechat', 'feishu', 'wecom'].filter(id => id === 'email' ? after.common.email.enabled : after.common.notifications.channels[id].enabled), expected);
  assert.deepEqual(after.common.email.smtp, f.value.common.email.smtp);
  assert.deepEqual(JSON.parse(await fs.readFile(`${f.configPath}.v6-backup`, 'utf8')), f.value);
  const migrated = await fs.readFile(f.configPath, 'utf8');
  assert.equal((await migrateApplicationConfig({ root: f.root })).migrated, false);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), migrated);
  await f.services.config.update('notification.radar', !radarEnabled);
  assert.equal((await f.read()).common.notifications.radar.channels, undefined);
});

test('legacy migration retains disabled global channels and failed atomic writes retain original bytes', async t => {
  const f = await fixture(t, { schemaVersion: 6, enabled: false });
  f.value.common.notifications = { radar: { channels: ['email', 'qq'] }, weekly: { channels: ['email'] }, channels: { qq: { enabled: false } } };
  await fs.writeFile(f.configPath, JSON.stringify(f.value));
  const before = await fs.readFile(f.configPath, 'utf8');
  await assert.rejects(migrateApplicationConfig({ root: f.root, atomicOptions: { validateTemporary: () => { throw new Error('fixture atomic failure'); } } }), /fixture atomic failure/);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
  await migrateApplicationConfig({ root: f.root });
  const config = await f.read();
  assert.equal(config.common.email.enabled, false); assert.equal(config.common.notifications.channels.qq.enabled, false);
  assert.deepEqual(config.common.notifications.radar, { enabled: true }); assert.deepEqual(config.common.notifications.weekly, { enabled: true });
});

test('explicit Test does not select channels or enable either event', async t => {
  let calls = 0;
  const f = await fixture(t, { enabled: false, schemaVersion: 6, transport: async () => { calls++; return { accepted: true }; } });
  await f.services.config.updateMany([{ id: 'notification.radar', value: false }, { id: 'notification.weekly', value: false }]);
  const before = await fs.readFile(f.configPath, 'utf8');
  assert.equal((await f.services.notifications.test({ channel: 'email', requestId: 'both-events-disabled' })).status, 'success');
  assert.equal(calls, 1); assert.equal(await fs.readFile(f.configPath, 'utf8'), before);
});

test('globally selected QQ with missing credentials retains transport fail-closed behavior', async t => {
  const f = await fixture(t, { enabled: false, schemaVersion: 6 });
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; assert.fail('incomplete provider must not contact QQ'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const env = { PAPERECHO_CONFIG_SCHEMA_VERSION: '6', PAPERECHO_EMAIL_ENABLED: 'false', PAPERECHO_QQ_CHANNEL: JSON.stringify({ enabled: true, appId: 'fixture', targetType: 'user', targetId: 'fixture-target' }) };
  const result = await runStage5Notification({ runSummary: { runId: 'missing-credential', outputRoot: f.root, artifacts: [], counts: { created: 1 } }, config: { env, runStateRoot: f.root } });
  assert.equal(result.channels.qq.status, 'failed'); assert.equal(result.channels.qq.reason, 'qq_configuration_invalid');
  assert.equal(result.businessStatus, 'success'); assert.equal(result.notificationStatus, 'incomplete'); assert.equal(calls, 0);
});
