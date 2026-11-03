import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { SupportBundleService, SUPPORT_LIMITS } from '../tools/lib/control_support_bundle_service.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { RuntimeLog } from '../tools/lib/runtime_logging.mjs';
import { CONTROL_SECRET_NAMES } from '../tools/lib/credential_registry.mjs';
import { resolveRuntimePaths, resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { startControlCenter } from '../tools/web/server.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const privateText = 'DummyUser_隐私 机密研究标题及反馈 https://example.invalid/?token=private Authorization: private Cookie: private';
async function fixture(t, layout = 'installed') {
  const base = path.join(repo, 'tests/runs/support'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '诊断 安全-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'); await fs.mkdir(app);
  const tokens = Object.fromEntries(CONTROL_SECRET_NAMES.map((name, i) => [name, `dummy-support-${i}-credential-private-value`]));
  const env = { PAPERECHO_LAYOUT: layout, PAPERECHO_APPLICATION_ROOT: app, ...(layout === 'installed' ? { PAPERECHO_DATA_ROOT: path.join(root, 'data') } : {}), PAPERECHO_SKIP_DOTENV: '1', ...tokens };
  const paths = resolveRuntimePaths({ env }); await fs.mkdir(path.join(paths.userDataRoot, 'config'), { recursive: true });
  await fs.writeFile(path.join(paths.userDataRoot, 'input.json'), '[]');
  await fs.writeFile(paths.configPath, JSON.stringify({ schemaVersion: 2, mode: 'local', common: { llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } }));
  const context = await resolveApplicationRuntimeContext({ cwd: app, env, readOnly: true });
  const services = createControlServices({ root: app, env, context });
  const log = new RuntimeLog({ env }); assert.equal((await log.write('RUNNER_STARTED')).ok, true);
  const report = { status: 'UNKNOWN', summary: privateText, checks: [{ checkId: 'secrets', status: 'PASS', severity: 'blocking', summary: privateText }, { checkId: 'runtime.node', status: 'UNKNOWN', severity: 'advisory', actionableHint: privateText }] };
  const make = options => new SupportBundleService({ doctor: { status: async () => report }, secrets: services.secrets, context, env, ...options });
  return { root, app, paths, env, tokens, context, services, log, report, make };
}
async function snapshot(root) {
  const values = {};
  async function visit(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name); const stat = await fs.lstat(file);
    values[path.relative(root, file)] = [stat.mode, stat.mtimeMs, e.isDirectory() ? null : createHash('sha256').update(await fs.readFile(file)).digest('hex')];
    if (e.isDirectory()) await visit(file);
  } }
  await visit(root); return values;
}
async function unpack(bytes) {
  assert.ok(bytes.length <= SUPPORT_LIMITS.zipBytes);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  assert.deepEqual(Object.keys(zip.files).sort(), ['doctor-summary.json', 'log-events-summary.json', 'manifest.json', 'runtime-summary.json']);
  const files = new Map(); let total = 0;
  for (const [name, file] of Object.entries(zip.files)) {
    assert.equal(file.dir, false); assert.equal(file.unsafeOriginalName, name); assert.ok(!/[\\/]/.test(name));
    const value = await file.async('nodebuffer'); total += value.length; assert.ok(value.length <= SUPPORT_LIMITS.fileBytes); files.set(name, value);
  }
  assert.ok(total <= SUPPORT_LIMITS.totalBytes);
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.integrity.authenticity, 'unsigned'); assert.equal(manifest.integrity.manifestSelfHash, false);
  assert.equal(manifest.files.length, 3);
  for (const item of manifest.files) { assert.equal(files.get(item.name).length, item.size); assert.equal(createHash('sha256').update(files.get(item.name)).digest('hex'), item.sha256); }
  return { files, manifest, text: [...files.values()].join('\n'), doctor: JSON.parse(files.get('doctor-summary.json')), runtime: JSON.parse(files.get('runtime-summary.json')), events: JSON.parse(files.get('log-events-summary.json')) };
}

test('ZIP actually unpacks with exact manifest hashes, strict projections and no private content', async t => {
  const f = await fixture(t); f.report.checks.push({ checkId: privateText, status: 'PASS', value: f.tokens.SMTP_PASS });
  await fs.appendFile(path.join(f.paths.logsRoot, 'runtime.jsonl'), JSON.stringify({ code: 'RUNNER_FAILED', subsystem: 'runner', severity: privateText, summary: privateText, stack: privateText, token: f.tokens.SMTP_PASS }) + '\n');
  const before = await snapshot(f.paths.userDataRoot); const result = await unpack(await f.make().export());
  assert.deepEqual(await snapshot(f.paths.userDataRoot), before);
  assert.equal(result.doctor.status, 'UNKNOWN'); assert.equal(result.doctor.omittedChecks, 1);
  assert.deepEqual(Object.keys(result.doctor.checks[0]).sort(), ['checkId', 'severity', 'status']);
  assert.ok(result.events.events.some(event => event.code === 'RUNNER_FAILED' && event.severity === 'error'));
  for (const value of [privateText, 'DummyUser_', '机密研究', f.root, '.env', ...Object.values(f.tokens)]) assert.ok(!result.text.includes(value));
  for (const value of Object.values(f.tokens)) { assert.ok(!result.text.includes(value.slice(0, 8))); assert.ok(!result.text.includes(value.slice(-8))); }
  assert.doesNotMatch(result.text, /Authorization|Cookie|stdout|stderr|stack|eventId|runId/);
  assert.deepEqual(Object.keys(result.runtime).sort(), ['arch', 'layout', 'logging', 'mode', 'node', 'platform', 'product', 'schemaVersion']);
});

test('real Doctor composition exports read-only and unknown evidence is never promoted', async t => {
  const f = await fixture(t); const before = await snapshot(f.paths.userDataRoot);
  const result = await unpack(await f.services.supportBundle.export());
  assert.notEqual(result.doctor.status, 'PASS'); assert.deepEqual(await snapshot(f.paths.userDataRoot), before);
});

test('all layouts and different workspaces keep the selected owner and omit paths', async t => {
  for (const layout of ['dev', 'portable', 'installed']) {
    const f = await fixture(t, layout); const result = await unpack(await f.make().export());
    assert.equal(result.runtime.layout, layout); assert.ok(!result.text.includes(f.paths.userDataRoot));
  }
  const a = await fixture(t), b = await fixture(t); await b.log.write('GUI_STARTED', { subsystem: 'gui' });
  assert.ok(!(await unpack(await a.make().export())).events.events.some(event => event.code === 'GUI_STARTED'));
  await assert.rejects(a.make({ context: b.context }).export(), /SUPPORT_ROOT_UNSAFE/);
});

test('unknown fields, check statuses and event codes stay excluded or UNKNOWN', async t => {
  const f = await fixture(t); f.report.checks.push({ checkId: 'configuration', status: privateText, severity: privateText, code: privateText });
  await fs.appendFile(path.join(f.paths.logsRoot, 'runtime.jsonl'), JSON.stringify({ code: privateText, subsystem: 'gui' }) + '\n');
  const result = await unpack(await f.make().export());
  assert.equal(result.doctor.checks.at(-1).status, 'UNKNOWN'); assert.equal(result.events.omitted, 1); assert.ok(!result.text.includes(privateText));
});

test('unreadable logs, unfinished records and an active rotation are explicit omissions, never raw fallbacks', async t => {
  const f = await fixture(t); const file = path.join(f.paths.logsRoot, 'runtime.jsonl');
  await fs.rename(file, file + '.fixture');
  assert.equal((await unpack(await f.make().export())).events.status, 'omitted');
  await fs.writeFile(file, '{"code":'); assert.equal((await unpack(await f.make().export())).events.status, 'omitted');
  await fs.unlink(file); await fs.rename(file + '.fixture', file);
  const line = JSON.stringify({ code: 'RUNNER_STARTED', subsystem: 'runner', summary: privateText }) + '\n';
  await fs.writeFile(file, line.repeat(Math.floor(1048576 / Buffer.byteLength(line))));
  const [writes, result] = await Promise.all([Promise.all(Array.from({ length: 20 }, () => f.log.write('RUNNER_STARTED'))), f.make().export()]);
  assert.ok(writes.every(x => x.ok)); assert.ok(['available', 'omitted'].includes((await unpack(result)).events.status));
  assert.ok((await fs.stat(path.join(f.paths.logsRoot, 'runtime.previous.jsonl'))).size <= 1048576);
});

test('log sampling has a 200 event ceiling and preserves the original log bytes', async t => {
  const f = await fixture(t); const file = path.join(f.paths.logsRoot, 'runtime.jsonl');
  const line = JSON.stringify({ code: 'GUI_READY', severity: 'error', subsystem: 'gui', message: privateText }) + '\n';
  await fs.writeFile(file, line.repeat(250)); const before = await snapshot(f.paths.userDataRoot);
  const result = await unpack(await f.make().export()); assert.equal(result.events.sampled, 200); assert.equal(result.events.truncated, true);
  assert.deepEqual(result.events.events, [{ code: 'GUI_READY', severity: 'info', subsystem: 'gui', count: 200 }]);
  assert.deepEqual(await snapshot(f.paths.userDataRoot), before);
});

test('Secret check and final redaction failure refuse export without exposing the failure payload', async t => {
  const f = await fixture(t); f.report.checks[0].status = 'UNKNOWN';
  await assert.rejects(f.make().export(), /^Error: SUPPORT_SECRET_CHECK_FAILED$/);
  f.report.checks[0].status = 'PASS';
  await assert.rejects(f.make({ secrets: { redact: () => '[REDACTED]' } }).export(), /^Error: SUPPORT_SAFETY_FAILED$/);
  await assert.rejects(f.make({ secrets: { redact: () => { throw new Error(privateText); } } }).export(), /^Error: SUPPORT_EXPORT_FAILED$/);
});

test('file, total, ZIP, check and file-count limits fail closed and archive faults leave no copies', async t => {
  const f = await fixture(t); const before = await snapshot(f.root);
  for (const limits of [{ fileBytes: 8 }, { totalBytes: 16 }, { zipBytes: 16 }, { checks: 1 }, { files: 3 }]) await assert.rejects(f.make({ limits }).export(), /SUPPORT_LIMIT_EXCEEDED/);
  await assert.rejects(f.make({ archive: async () => { throw new Error(privateText); } }).export(), /^Error: SUPPORT_EXPORT_FAILED$/);
  assert.deepEqual(await snapshot(f.root), before);
});

test('root junction and linked logs fail safely without changing the external fixture', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'protected'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'private'), privateText);
  const linked = path.join(f.root, 'linked'); await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const before = await snapshot(outside);
  await assert.rejects(f.make({ env: { ...f.env, PAPERECHO_DATA_ROOT: linked }, context: { ...f.context, userDataRoot: linked } }).export(), /SUPPORT_EXPORT_FAILED/);
  await fs.rename(f.paths.logsRoot, f.paths.logsRoot + '-owned'); await fs.symlink(outside, f.paths.logsRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await unpack(await f.make().export())).events.status, 'omitted'); assert.deepEqual(await snapshot(outside), before);
});

test('concurrent export rejects immediately; cancellation and timeout keep the admission slot until readers settle', { timeout: 20000 }, async t => {
  const f = await fixture(t); let release; let observed;
  const service = f.make({ doctor: { status: ({ signal }) => { observed = signal; return new Promise(resolve => { release = () => resolve(f.report); }); } } });
  const controller = new AbortController(); const pending = service.export({ signal: controller.signal });
  while (!release) await new Promise(resolve => setTimeout(resolve, 2));
  await assert.rejects(service.export(), /SUPPORT_BUSY/); controller.abort(); await assert.rejects(pending, /SUPPORT_CANCELLED/); assert.equal(observed.aborted, true);
  await assert.rejects(service.export(), /SUPPORT_BUSY/); release();
  while (service.active) await new Promise(resolve => setTimeout(resolve, 2));
  service.doctor = { status: async () => f.report };
  await unpack(await service.export());
  let finish; const timeout = f.make({ limits: { milliseconds: 5 }, doctor: { status: () => new Promise(resolve => { finish = () => resolve(f.report); }) } });
  await assert.rejects(timeout.export(), /SUPPORT_TIMEOUT/);
  // Under suite load the deadline may expire during root inspection, before
  // Doctor starts. Only a genuinely pending reader must retain the busy slot.
  if (finish) { await assert.rejects(timeout.export(), /SUPPORT_BUSY/); finish(); }
  while (timeout.active) await new Promise(resolve => setTimeout(resolve, 2));
});

async function httpFixture(t) {
  const f = await fixture(t); let exports = 0;
  f.services.supportBundle = f.make(); const original = f.services.supportBundle.export.bind(f.services.supportBundle);
  f.services.supportBundle.export = options => { exports++; return original(options); };
  const running = await startControlCenter({ root: f.app, port: 0, services: f.services, context: f.context });
  t.after(async () => { running.server.closeAllConnections(); await new Promise(resolve => running.server.close(resolve)); });
  const request = (route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request(running.url + route, { method, headers }, res => { const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) })); });
    req.on('error', reject); req.end(body);
  });
  const session = await request('/api/session');
  const auth = { cookie: session.headers['set-cookie'][0].split(';')[0], origin: running.url, 'x-csrf-token': JSON.parse(session.bytes).token, 'content-type': 'application/json' };
  const post = (route, headers = {}, body = '{}') => request(route, { method: 'POST', headers: { ...auth, ...headers }, body });
  return { ...f, ...running, request, auth, post, exports: () => exports };
}

test('only explicit authenticated POST exports; Doctor GET and rejected requests have no export side effects', async t => {
  const f = await httpFixture(t); const before = await snapshot(f.paths.userDataRoot);
  assert.equal((await f.request('/api/doctor', { headers: f.auth })).status, 200);
  assert.equal((await f.request('/api/support-bundle', { headers: f.auth })).status, 405);
  assert.equal((await f.post('/api/support-bundle', { cookie: '' })).status, 403);
  assert.equal((await f.post('/api/support-bundle', { origin: 'https://example.invalid' })).status, 403);
  assert.equal((await f.post('/api/support-bundle', { 'x-csrf-token': '' })).status, 403);
  assert.equal((await f.post('/api/support-bundle', { host: 'untrusted.invalid' })).status, 403);
  assert.equal((await f.post('/api/support-bundle', { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await f.post('/api/support-bundle?path=private')).status, 400);
  assert.equal((await f.post('/api/support-bundle', {}, '{"path":"../private"}')).status, 400);
  assert.equal((await f.post('/api/%2e%2e/support-bundle')).status, 404);
  assert.equal((await f.post('/api/support-bundle', {}, JSON.stringify({ data: 'x'.repeat(65536) }))).status, 413);
  assert.equal(f.exports(), 0);
  const response = await f.post('/api/support-bundle'); assert.equal(response.status, 200); await unpack(response.bytes);
  assert.equal(response.headers['content-type'], 'application/zip'); assert.equal(response.headers['cache-control'], 'no-store'); assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="paperecho-support.zip"');
  assert.equal(f.exports(), 1); assert.deepEqual(await snapshot(f.paths.userDataRoot), before);
});

test('HTTP disconnect cancels generation without a temporary archive or a new queued task', { timeout: 20000 }, async t => {
  const f = await httpFixture(t); let release; let signal;
  f.services.supportBundle = f.make({ doctor: { status: options => { signal = options.signal; return new Promise(resolve => { release = () => resolve(f.report); }); } } });
  const before = await snapshot(f.root);
  const req = http.request(f.url + '/api/support-bundle', { method: 'POST', headers: f.auth }); req.on('error', () => {}); req.end('{}');
  while (!release) await new Promise(resolve => setTimeout(resolve, 2)); req.destroy();
  while (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(f.services.supportBundle.active, true); release();
  while (f.services.supportBundle.active) await new Promise(resolve => setTimeout(resolve, 2));
  assert.deepEqual(await snapshot(f.root), before);
});
