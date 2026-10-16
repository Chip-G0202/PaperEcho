import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { DoctorService } from '../tools/lib/control_doctor_service.mjs';
import { main } from '../tools/runner/main.mjs';
import { inspectWorkflowLease, createOperationLedger } from '../tools/recovery/operation_ledger.mjs';
import { startControlCenter } from '../tools/web/server.mjs';
import { readBoundedJson } from '../tools/lib/atomic_json.mjs';
import { createNotificationReceipt } from '../tools/stage5/email_receipt.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); }
async function snapshot(root) {
  const result = {};
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const stat = await fs.stat(file);
      result[path.relative(root, file)] = [stat.mode, stat.mtimeMs, entry.isDirectory() ? null : createHash('sha256').update(await fs.readFile(file)).digest('hex')];
      if (entry.isDirectory()) await visit(file);
    }
  }
  await visit(root); return result;
}
async function fixture(t, layout = 'installed') {
  const base = path.join(repo, 'tests/runs/doctor'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '健康 检查-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'); const data = layout === 'portable' ? path.join(app, 'data') : layout === 'dev' ? app : path.join(root, 'data');
  for (const file of ['config/paperecho.config.example.json', 'workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html']) {
    await fs.mkdir(path.dirname(path.join(app, file)), { recursive: true }); await fs.copyFile(path.join(repo, file), path.join(app, file));
  }
  await write(path.join(data, 'input.json'), []);
  await write(path.join(data, 'config/paperecho.config.json'), { schemaVersion: 2, mode: 'local', common: { llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } });
  const env = { PAPERECHO_LAYOUT: layout, PAPERECHO_APPLICATION_ROOT: app, ...(layout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: data }), PAPERECHO_SKIP_DOTENV: '1', PATH: '' };
  const context = await resolveApplicationRuntimeContext({ cwd: app, env }); await fs.mkdir(context.cacheRoot, { recursive: true });
  const services = createControlServices({ root: app, context, env });
  return { root, app, data, env, context, services };
}
const check = (report, id) => report.checks.find(x => x.checkId === id);
function diagnostic(f, overrides = {}) { return new DoctorService({ ...f.services, context: f.context, env: f.env,
  secrets: { health: async () => ({ filePresent: false, aclRuntime: true, credentials: [] }) }, ...overrides }); }
test('healthy PASS, optional WARN, no system Node requirement and zero writes across layouts', async t => {
  for (const layout of ['installed', 'portable', 'dev']) {
    const f = await fixture(t, layout); const before = await snapshot(f.root);
    const healthy = await diagnostic(f, { preflight: async () => ({ canRun: true, requiredMissing: [], optionalMissing: [], featureMissing: [] }) }).status();
    assert.equal(healthy.status, 'PASS'); assert.equal(healthy.canRun, true); assert.equal(check(healthy, 'runtime.node').status, 'PASS');
    const optional = await diagnostic(f).status(); assert.equal(optional.status, 'WARN'); assert.equal(optional.canRun, true);
    assert.equal(check(optional, 'preflight.optional').status, 'WARN');
    assert.deepEqual(await snapshot(f.root), before);
  }
});
test('missing/invalid/schema config fails without initialization, fresh Doctor creates no directories', async t => {
  const f = await fixture(t); const file = path.join(f.data, 'config/paperecho.config.json');
  for (const value of [null, { schemaVersion: 999 }, { schemaVersion: 2, mode: null }]) {
    if (value === null) await fs.rm(file); else await write(file, value);
    const before = await snapshot(f.root); const report = await diagnostic(f).status();
    assert.equal(check(report, 'configuration').status, 'FAIL'); assert.equal(report.canRun, false); assert.deepEqual(await snapshot(f.root), before);
  }
  const fresh = path.join(f.root, 'never-created'); const before = await snapshot(f.root); let output = '';
  assert.equal(await main(['--doctor'], { cwd: f.app, env: { ...f.env, PAPERECHO_DATA_ROOT: fresh }, stdout: { write: text => output += text } }), 2);
  assert.equal(JSON.parse(output).status, 'FAIL'); assert.deepEqual(await snapshot(f.root), before);
});
test('root access errors fail; individual owner faults remain UNKNOWN without private exception text', async t => {
  const f = await fixture(t);
  const report = await diagnostic(f, { fsApi: { stat: async () => { throw new Error('dummy-private-data'); } }, review: { health: async () => { throw new Error('dummy-private-data'); } } }).status();
  assert.equal(check(report, 'runtime.data').status, 'FAIL'); assert.equal(check(report, 'workflow').status, 'UNKNOWN');
  assert.ok(!JSON.stringify(report).includes('dummy-private-data'));
});
test('external credentials stay read-only, metadata does not echo secret, ACL failure blocks', async t => {
  const f = await fixture(t); const env = { ...f.env, TITLE_TRANSLATION_API_KEY: 'dummy-external-only' };
  const actual = createControlServices({ root: f.app, context: { ...f.context, env: { ...f.context.env, TITLE_TRANSLATION_API_KEY: env.TITLE_TRANSLATION_API_KEY } }, env });
  const health = await actual.secrets.health(); const external = health.credentials.find(x => x.id === 'TITLE_TRANSLATION_API_KEY');
  assert.equal(external.storageClass, 'external-managed'); assert.equal(external.writable, false);
  assert.ok(!JSON.stringify(health).includes('dummy-external-only'));
  await assert.rejects(actual.secrets.replace('TITLE_TRANSLATION_API_KEY', 'dummy-replacement'), /EXTERNALLY_MANAGED/);
  const report = await diagnostic(f, { secrets: { health: async () => { throw new Error('dummy-secret'); } } }).status();
  assert.equal(check(report, 'secrets').status, 'FAIL'); assert.ok(!JSON.stringify(report).includes('dummy-secret'));
  const unavailable = await diagnostic(f, { secrets: { health: async () => { throw Object.assign(new Error(), { code: 'CREDENTIAL_ACL_RUNTIME_UNAVAILABLE' }); } } }).status();
  assert.equal(check(unavailable, 'secrets').status, 'UNKNOWN'); assert.equal(unavailable.canRun, null);
});
test('lease evidence distinguishes live, stale, remote and uncertain without mtime heuristics', async t => {
  const f = await fixture(t); const file = path.join(f.context.runRoot, '.workflow.lease.json');
  const lease = { schemaVersion: 1, runId: 'dummy', ownerId: 'dummy', hostname: os.hostname(), pid: process.pid, expiresAt: '2000-01-01T00:00:00Z' };
  assert.equal(inspectWorkflowLease(lease), 'running');
  assert.equal(inspectWorkflowLease(lease, { processAlive: () => false }), 'stale');
  assert.equal(inspectWorkflowLease({ ...lease, hostname: 'remote-dummy' }), 'unknown');
  assert.equal(inspectWorkflowLease({ ...lease, expiresAt: 'invalid' }), 'unknown');
  await write(file, lease); assert.equal(check(await diagnostic(f).status(), 'workflow.claim').status, 'PASS');
  await write(file, { ...lease, hostname: 'remote-dummy' }); assert.equal(check(await diagnostic(f).status(), 'workflow.claim').status, 'UNKNOWN');
});
test('ledger recovery, unknown notification and business completion remain separate and read-only', async t => {
  const f = await fixture(t); const directory = path.join(f.context.runRoot, 'dummy');
  await write(path.join(directory, 'run_group.json'), { schemaVersion: 1, runId: 'dummy', startedAt: '2026-10-16T00:00:00Z', status: 'incomplete' });
  const ledger = createOperationLedger({ runId: 'dummy', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: directory, stages: ['stage1', 'state_persist', 'stage4_exports'] });
  ledger.status = 'incomplete'; for (const stage of Object.values(ledger.stages)) stage.status = 'verified';
  await write(path.join(directory, 'operation_ledger.json'), ledger);
  const before = await snapshot(f.root); const report = await diagnostic(f).status();
  assert.equal(check(report, 'workflow.ledger').status, 'PASS'); assert.equal(check(report, 'workflow.recovery').status, 'WARN');
  assert.match(check(report, 'workflow.recovery').summary, /业务阶段已成功/); assert.deepEqual(await snapshot(f.root), before);
  const receiptFile = path.join(directory, 'stage5/email_receipt.json');
  ledger.operations.push({ type: 'notification', inputVersion: 1, idempotencyKey: 'c'.repeat(64), status: 'failed', target: { receiptPath: receiptFile } });
  await write(path.join(directory, 'operation_ledger.json'), ledger);
  const receipt = createNotificationReceipt({ notificationType: 'run_summary', runId: 'dummy', businessSubject: 'dummy-private-title', eventEpoch: 'dummy', recipient: 'dummy@example.invalid', payload: { subject: 'dummy', text: 'dummy-private-content' } });
  for (const [status, expected] of [['failed', 'WARN'], ['unknown', 'UNKNOWN'], ['accepted', 'PASS']]) {
    await write(receiptFile, { ...receipt, status }); const stable = await snapshot(f.root); const result = await diagnostic(f).status();
    assert.equal(check(result, 'workflow.receipts').status, expected); assert.equal(result.canRun, true);
    assert.match(check(result, 'workflow.recovery').summary, /业务阶段已成功/);
    assert.doesNotMatch(JSON.stringify(result), /dummy-private-title|dummy-private-content|dummy@example/); assert.deepEqual(await snapshot(f.root), stable);
  }
  await write(path.join(directory, 'operation_ledger.json'), { ...ledger, schemaVersion: 999 });
  assert.equal(check(await diagnostic(f).status(), 'workflow').status, 'UNKNOWN');
});
test('research pending/prepared/unknown/recoverable/consumed summaries never expose text or replay models', async t => {
  const f = await fixture(t); const research = f.services.research;
  await research.submit({ text: 'dummy-private-research-content', requestId: 'one' });
  let report = await diagnostic(f).status(); assert.equal(check(report, 'research.pending').status, 'PASS'); assert.match(check(report, 'research.pending').summary, /1 项/);
  const event = JSON.parse(await fs.readFile(research.eventPath('one'))); event.batchRunId = 'dummy'; event.status = 'prepared';
  await write(research.eventPath('one'), event);
  for (const [status, key, expected] of [['preparing', 'unknown', 'UNKNOWN'], ['prepared', 'prepared', 'PASS'], ['failed', 'recoverable', 'WARN'], ['published', 'recoverable', 'WARN']]) {
    await write(research.batchPath('dummy'), { status }); const before = await snapshot(f.root); report = await diagnostic(f).status();
    assert.equal(check(report, `research.${key}`).status, expected); assert.match(check(report, `research.${key}`).summary, /1 项/);
    assert.ok(!JSON.stringify(report).includes('dummy-private-research-content')); assert.deepEqual(await snapshot(f.root), before);
  }
  await write(research.eventPath('one'), { ...event, status: 'consumed' });
  assert.match(check(await diagnostic(f).status(), 'research.processed').summary, /1 项/);
});
test('bounded history, unreadable and unsafe linked files never become PASS', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.context.runRoot, { recursive: true });
  for (let n = 0; n < 101; n++) await fs.writeFile(path.join(f.context.runRoot, `limit-${n}`), '');
  assert.equal(check(await diagnostic(f).status(), 'workflow').status, 'UNKNOWN');
  const outside = path.join(f.root, 'outside'); await write(path.join(outside, 'private.json'), { dummy: true });
  const linked = path.join(f.data, 'linked'); await fs.symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readBoundedJson(f.data, path.join(linked, 'private.json')), /UNSAFE/);
});
test('CLI and authenticated UI share status, exit semantics, workspace isolation and zero writes', async t => {
  const f = await fixture(t); const other = await fixture(t); await fs.rm(path.join(other.data, 'config/paperecho.config.json'));
  const before = await snapshot(f.root); const ui = await f.services.doctor.status(); let output = '';
  const code = await main(['--doctor'], { env: f.env, cwd: f.app, stdout: { write: text => output += text } });
  assert.deepEqual(JSON.parse(output), ui); assert.equal(code, ui.status === 'FAIL' ? 2 : ui.status === 'UNKNOWN' ? 3 : 0);
  assert.equal(check(await diagnostic(other).status(), 'configuration').status, 'FAIL'); assert.equal(check(ui, 'configuration').status, 'PASS');
  const server = await startControlCenter({ root: f.app, context: f.context, services: f.services, port: 0 }); t.after(() => new Promise(resolve => server.server.close(resolve)));
  assert.equal((await fetch(server.url + '/api/doctor')).status, 403);
  const session = await fetch(server.url + '/api/session'); const cookie = session.headers.get('set-cookie').split(';')[0];
  const response = await fetch(server.url + '/api/doctor', { headers: { cookie } }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), ui);
  assert.deepEqual(await snapshot(f.root), before);
  output = ''; assert.equal(await main(['--doctor', '--run'], { env: f.env, cwd: f.app, stdout: { write: text => output += text } }), 2);
});
