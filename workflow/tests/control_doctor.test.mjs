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
import { RuntimeLog } from '../tools/lib/runtime_logging.mjs';
import { WindowsTaskScheduler } from '../tools/lib/windows_task_scheduler.mjs';
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
async function fixture(t, layout = 'installed', mode = 'local') {
  const base = path.join(repo, 'tests/runs/doctor'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '健康 检查-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'); const data = layout === 'portable' ? path.join(app, 'data') : layout === 'dev' ? app : path.join(root, 'data');
  for (const file of ['config/paperecho.config.example.json', 'workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html']) {
    await fs.mkdir(path.dirname(path.join(app, file)), { recursive: true }); await fs.copyFile(path.join(repo, file), path.join(app, file));
  }
  await write(path.join(data, 'input.json'), []);
  await write(path.join(data, 'config/paperecho.config.json'), { schemaVersion: 2, mode, common: { llm: { enabled: false, mode: 'disabled' }, email: { enabled: false } }, local: { input: '../input.json', outputRoot: '../local' } });
  const env = { PAPERECHO_LAYOUT: layout, PAPERECHO_APPLICATION_ROOT: app, ...(layout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: data }), PAPERECHO_SKIP_DOTENV: '1', PATH: '' };
  const context = await resolveApplicationRuntimeContext({ cwd: app, env }); await fs.mkdir(context.cacheRoot, { recursive: true });
  const services = createControlServices({ root: app, context, env });
  assert.equal((await new RuntimeLog({ applicationRoot: app, env }).write('RUNNER_STARTED')).ok, true);
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
  await write(path.join(directory, 'run_group.json'), { schemaVersion: 1, runId: 'dummy', pipelineMode: 'local', startedAt: '2026-10-16T00:00:00Z', status: 'incomplete' });
  const artifact = path.join(directory, 'input_artifact.json'); await write(artifact, []);
  const hash = createHash('sha256').update(await fs.readFile(artifact)).digest('hex');
  const ledger = createOperationLedger({ runId: 'dummy', mode: 'local', profile: 'standard', configHash: 'a'.repeat(64), inputHash: hash, artifactPath: artifact, stages: ['stage1', 'state_persist', 'stage4_exports'] });
  ledger.artifact.hash = hash;
  ledger.status = 'incomplete'; for (const stage of Object.values(ledger.stages)) stage.status = 'verified';
  await write(path.join(directory, 'operation_ledger.json'), ledger);
  const before = await snapshot(f.root); const report = await diagnostic(f).status();
  assert.equal(check(report, 'workflow.ledger').status, 'PASS'); assert.equal(check(report, 'workflow.recovery').status, 'WARN');
  assert.match(check(report, 'workflow.recovery').summary, /业务阶段已成功/); assert.deepEqual(await snapshot(f.root), before);
  const receiptFile = path.join(directory, 'stage5/email_receipt.json');
  ledger.operations.push({ type: 'notification', inputVersion: 1, idempotencyKey: 'c'.repeat(64), status: 'failed', target: { receiptPath: receiptFile } });
  await write(path.join(directory, 'operation_ledger.json'), ledger);
  const receipt = createNotificationReceipt({ notificationType: 'run_summary', runId: 'dummy', businessSubject: 'dummy-private-title', eventEpoch: 'dummy', recipient: 'dummy@example.invalid', ledgerOperationId: 'c'.repeat(64), payload: { subject: 'dummy', text: 'dummy-private-content' } });
  for (const [status, expected] of [['failed', 'WARN'], ['unknown', 'UNKNOWN'], ['accepted', 'PASS']]) {
    await write(receiptFile, { ...receipt, status }); const stable = await snapshot(f.root); const result = await diagnostic(f).status();
    assert.equal(check(result, 'workflow.receipts').status, expected); assert.equal(result.canRun, false);
    assert.equal(check(result, 'workflow.startup').status, 'FAIL', 'unfinished recovery blocks launch even after receipt acceptance');
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
  const f = await schedulerFixture(t); const other = await fixture(t); await fs.rm(path.join(other.data, 'config/paperecho.config.json'));
  const execute = WindowsTaskScheduler.prototype.execute;
  t.mock.method(WindowsTaskScheduler.prototype, 'execute', function (operation, spec) {
    assert.equal(operation, 'query');
    return execute.call(new WindowsTaskScheduler({ transport: async () => schedulerResponse() }), operation, spec);
  });
  const before = await snapshot(f.root); const ui = await f.services.doctor.status(); let output = '';
  assert.equal(check(ui, 'scheduler.os').status, 'PASS');
  const code = await main(['--doctor'], { env: f.env, cwd: f.app, stdout: { write: text => output += text } });
  assert.deepEqual(JSON.parse(output), ui); assert.equal(code, ui.status === 'FAIL' ? 2 : ui.status === 'UNKNOWN' ? 3 : 0);
  assert.equal(check(await diagnostic(other).status(), 'configuration').status, 'FAIL'); assert.equal(check(ui, 'configuration').status, 'PASS');
  let server, unauthenticated;
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidate = await startControlCenter({ root: f.app, context: f.context, services: f.services, port: 0 });
    try { unauthenticated = await fetch(candidate.url + '/api/doctor'); server = candidate; break; }
    catch (error) {
      candidate.server.closeAllConnections(); await new Promise(resolve => candidate.server.close(resolve));
      if (error.cause?.message !== 'bad port' || attempt === 2) throw error;
      t.diagnostic('DOCTOR_FIXTURE_FETCH_BLOCKED_PORT=' + new URL(candidate.url).port);
    }
  }
  t.after(() => { server.server.closeAllConnections(); return new Promise(resolve => server.server.close(resolve)); });
  assert.equal(unauthenticated.status, 403);
  const session = await fetch(server.url + '/api/session'); const cookie = session.headers.get('set-cookie').split(';')[0];
  const response = await fetch(server.url + '/api/doctor', { headers: { cookie } }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), ui);
  assert.deepEqual(await snapshot(f.root), before);
  output = ''; assert.equal(await main(['--doctor', '--run'], { env: f.env, cwd: f.app, stdout: { write: text => output += text } }), 2);
});

async function schedulerFixture(t, layout = 'installed') {
  const f = await fixture(t, layout, 'desktop');
  const file = path.join(f.data, 'config/paperecho.config.json');
  f.value = { ...JSON.parse(await fs.readFile(file)), schemaVersion: 6, profile: 'standard',
    scheduler: { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' } };
  await write(file, f.value); return f;
}
const schedulerResponse = (extra = {}) => ({ schemaVersion: 1, status: 'PASS', exists: true, currentUser: true,
  leastPrivilege: true, interactiveToken: true, enabled: true, definitionMatches: true, ...extra });

test('OS scheduler diagnostics query only the canonical task, remain advisory and preserve business checks (mock OS)', async t => {
  const cases = [
    ['enabled', true, {}, 'PASS'], ['missing', true, { exists: false }, 'WARN'],
    ['disabled in OS', true, { enabled: false }, 'WARN'], ['definition mismatch', true, { definitionMatches: false }, 'WARN'],
    ['disabled and absent', false, { exists: false }, 'PASS'], ['disabled and installed', false, { enabled: false }, 'PASS'],
    ['unexpectedly enabled', false, {}, 'WARN'], ['wrong user', true, { currentUser: false }, 'UNKNOWN'],
    ['elevated task', true, { leastPrivilege: false }, 'UNKNOWN'], ['wrong logon type', true, { interactiveToken: false }, 'UNKNOWN'],
    ['malformed response', true, null, 'UNKNOWN'], ['unconfirmed definition', true, { definitionMatches: undefined }, 'UNKNOWN'],
    ['unconfirmed enabled', true, { enabled: undefined }, 'UNKNOWN'],
  ];
  for (const layout of ['installed', 'portable']) {
    const f = await schedulerFixture(t, layout);
    for (const [name, enabled, extra, expected] of cases) await t.test(`${layout}: ${name}`, async () => {
      await write(path.join(f.data, 'config/paperecho.config.json'), { ...f.value, scheduler: { ...f.value.scheduler, enabled } });
      const before = await snapshot(f.root); let queries = 0, preflights = 0;
      const report = await diagnostic(f, { platform: 'win32',
        preflight: async () => { assert.equal(++preflights, 1, 'no recursive preflight'); return { canRun: true, requiredMissing: [], optionalMissing: [], featureMissing: [] }; },
        schedulerTransport: async request => {
          queries++; assert.equal(request.operation, 'query'); assert.equal(request.definition, undefined);
          assert.equal(request.sandboxOnly, false); assert.equal(request.triggerEnabled, enabled);
          assert.ok(request.arguments.includes('--scheduled-daily')); assert.ok(request.arguments.includes(f.data));
          return extra === null ? null : schedulerResponse({ ...extra, xml: 'dummy-private-secret', path: f.root });
        } }).status();
      const result = check(report, 'scheduler.os');
      assert.equal(queries, 1); assert.equal(preflights, 1); assert.equal(result.status, expected);
      assert.equal(result.blocking, false); assert.equal(report.canRun, true);
      assert.equal(check(report, 'workflow.scheduleClaim').status, 'PASS');
      assert.doesNotMatch(JSON.stringify(result), /dummy-private-secret|<Task|--scheduled-daily/); assert.ok(!JSON.stringify(result).includes(f.root));
      if (!enabled && extra?.exists === false) assert.match(result.summary, /未注册/);
      if (expected !== 'PASS') assert.ok(result.actionableHint);
      assert.deepEqual(await snapshot(f.root), before);
    });
  }
});

test('OS scheduler query failures are UNKNOWN without private exception details or business blocking (mock OS)', async t => {
  const f = await schedulerFixture(t);
  for (const code of ['EACCES', 'SCHEDULER_OS_OPERATION_FAILED', 'ETIMEDOUT']) {
    const before = await snapshot(f.root);
    const report = await diagnostic(f, { platform: 'win32', schedulerTransport: async request => {
      assert.equal(request.operation, 'query'); throw Object.assign(new Error(`dummy-private-token ${f.root}`), { code });
    } }).status();
    const result = check(report, 'scheduler.os'); assert.equal(result.status, 'UNKNOWN'); assert.equal(result.blocking, false);
    assert.ok(!JSON.stringify(result).includes(f.root)); assert.doesNotMatch(JSON.stringify(result), /dummy-private|EACCES|ETIMEDOUT/);
    assert.deepEqual(await snapshot(f.root), before);
  }
});

test('OS scheduler inapplicable, missing and invalid configuration never queries OS or invents registration (mock OS)', async t => {
  const f = await schedulerFixture(t), local = await fixture(t), dev = await schedulerFixture(t, 'dev');
  let forbiddenCalls = 0;
  const poison = async () => { forbiddenCalls++; assert.fail('OS query forbidden'); };
  const preflight = await diagnostic(f, { platform: 'win32', schedulerTransport: poison }).status({ queryOsScheduler: false });
  assert.equal(check(preflight, 'scheduler.os').status, 'UNKNOWN'); assert.equal(check(preflight, 'configuration').status, 'PASS');
  assert.equal(check(preflight, 'workflow.scheduleClaim').status, 'PASS');
  for (const [value, options, expected] of [[local, {}, 'PASS'], [dev, {}, 'PASS'], [f, { platform: 'darwin' }, 'UNKNOWN'],
    [f, { platform: 'linux' }, 'UNKNOWN']]) {
    const result = check(await diagnostic(value, { platform: 'win32', schedulerTransport: poison, ...options }).status(), 'scheduler.os');
    assert.equal(result.status, expected); assert.equal(result.blocking, false); assert.match(result.summary, /未查询/);
  }
  for (const value of [null, { ...f.value, schemaVersion: 999 }, { ...f.value, mode: null },
    { ...f.value, scheduler: undefined }, { ...f.value, scheduler: { ...f.value.scheduler, enabled: 'true' } }]) {
    const file = path.join(f.data, 'config/paperecho.config.json');
    if (value === null) await fs.rm(file); else await write(file, value);
    const before = await snapshot(f.root);
    assert.equal(check(await diagnostic(f, { platform: 'win32', schedulerTransport: poison }).status(), 'scheduler.os').status, 'UNKNOWN');
    assert.deepEqual(await snapshot(f.root), before);
  }
  assert.equal(forbiddenCalls, 0);
});

test('scheduler preflight excludes only the OS advisory query and retains native timeout ownership', async () => {
  const source = await fs.readFile(path.join(repo, 'workflow/tools/lib/control_doctor_service.mjs'), 'utf8');
  assert.doesNotMatch(source, /inspectOsSchedule|manageOsSchedule/);
  assert.equal((source.match(/\.execute\(/g) || []).length, 1); assert.match(source, /\.execute\('query', spec\)/);
  const adapter = await fs.readFile(path.join(repo, 'workflow/tools/lib/windows_task_scheduler.mjs'), 'utf8');
  assert.match(adapter, /timeout: 30000/); assert.match(source, /}, false, 35000\)/);
  const preflight = await fs.readFile(path.join(repo, 'workflow/tools/lib/os_scheduler.mjs'), 'utf8');
  assert.match(preflight, /doctor\.status\(\{ queryOsScheduler: false }\)/);
});

async function rssRun(f, items, { runId = 'rss-new', startedAt = '2026-10-26T00:00:00Z', artifactPath = 'pipeline/rss-new', complete = true } = {}) {
  await write(path.join(f.context.runRoot, runId, 'run_group.json'), { schemaVersion: 1, runId, startedAt, status: 'completed', pipelineMode: 'desktop', artifacts: [{ kind: 'pipeline', rootKey: 'research', path: artifactPath }] });
  const file = path.join(f.context.researchRoot, artifactPath, 'retrieval_audit.json');
  await write(file, { schemaVersion: 1, complete, candidateCounts: { rss: items.length }, candidates: { rss: items } });
  return file;
}
const rssItem = extra => ({ source_channel: 'rss', source_platform: 'rss', title: 'dummy-private-paper', abstract: 'dummy-private-topic', feed_url: 'https://private.example/feed?token=dummy-secret', ...extra });

test('RSS Doctor counts canonical venues, current declared fallback, labels and unknown without guessing provenance or leaking content', async t => {
  const f = await fixture(t, 'installed', 'desktop');
  await write(path.join(f.data, 'config/rss_sources.json'), { sources: [{ url: 'https://single.example/feed', publicationTitle: 'Synthetic Journal', enabled: true }] });
  await rssRun(f, [rssItem({ publicationTitle: 'Trusted Canonical Journal' }), rssItem({ feed_url: 'https://single.example/feed' }), rssItem({ feed_title: 'Private Multi Journal Roundup' }), rssItem({}), rssItem({ journal: 'Legacy Journal' })]);
  const before = await snapshot(f.root), result = check(await diagnostic(f).status(), 'rss.venue');
  assert.equal(result.status, 'WARN'); assert.equal(result.blocking, false);
  for (const text of ['5/5', '非全部历史', 'publicationTitle 1', '其它 venue 1', 'fallback 1', 'feed title 1', 'unknown 1']) assert.ok(result.summary.includes(text), text);
  assert.match(result.actionableHint, /配置匹配不证明历史 fallback/); assert.match(result.actionableHint, /综合来源.*unknown/);
  for (const text of ['private.example', 'single.example', 'dummy-secret', 'dummy-private', 'Private Multi', 'Trusted Canonical', f.root]) assert.ok(!JSON.stringify(result).includes(text));
  assert.deepEqual(await snapshot(f.root), before);
});

test('RSS Doctor bounds the latest registered run and sample denominator; never substitutes older evidence or follows escaped artifacts', async t => {
  const f = await fixture(t, 'installed', 'desktop');
  await rssRun(f, [rssItem({ publicationTitle: 'Old Journal' })], { runId: 'rss-old', startedAt: '2026-10-25T00:00:00Z', artifactPath: 'pipeline/rss-old' });
  const file = await rssRun(f, Array.from({ length: 501 }, () => rssItem({ publicationTitle: 'New Journal' })));
  let before = await snapshot(f.root), result = check(await diagnostic(f).status(), 'rss.venue');
  assert.equal(result.status, 'WARN'); assert.ok(result.summary.includes('500/501')); assert.match(result.summary, /publicationTitle 500/);
  assert.deepEqual(await snapshot(f.root), before);
  await fs.rm(file); before = await snapshot(f.root);
  assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'UNKNOWN'); assert.deepEqual(await snapshot(f.root), before);
  await write(path.join(f.context.runRoot, 'rss-new/run_group.json'), { schemaVersion: 1, runId: 'rss-new', startedAt: '2026-10-26T00:00:00Z', artifacts: [{ kind: 'pipeline', rootKey: 'research', path: '../outside' }] });
  before = await snapshot(f.root); assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'UNKNOWN'); assert.deepEqual(await snapshot(f.root), before);
});

test('RSS Doctor missing, empty, malformed, incomplete, oversized and excessive registration evidence is never a coverage PASS', async t => {
  const f = await fixture(t, 'installed', 'desktop');
  assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'UNKNOWN');
  const file = await rssRun(f, []); assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'UNKNOWN');
  await fs.writeFile(file, '{dummy-private-invalid'); assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'UNKNOWN');
  await rssRun(f, [rssItem({ publicationTitle: 'Journal' })], { complete: false }); assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'WARN');
  await fs.writeFile(file, ' '.repeat(1048577)); assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'UNKNOWN');
  await rssRun(f, [rssItem({ publicationTitle: 'Journal' })]); assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'PASS');
  for (let i = 0; i < 101; i++) await fs.mkdir(path.join(f.context.runRoot, 'extra-' + i));
  const before = await snapshot(f.root); assert.equal(check(await diagnostic(f).status(), 'rss.venue').status, 'UNKNOWN'); assert.deepEqual(await snapshot(f.root), before);
});
