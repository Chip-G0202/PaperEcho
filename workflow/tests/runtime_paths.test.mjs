import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRuntimePaths, prepareRuntimePaths, assertRuntimeDataPath, buildRuntimeConfig, buildLocalRuntimeConfig, resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { resolveRunnerConfiguration } from '../tools/runner/config_loader.mjs';
import { parseRunnerArgs } from '../tools/runner/args.mjs';
import { buildExecutionPlan, runPreflight } from '../tools/runner/preflight.mjs';
import { loadDotEnv, resolveDotEnvPath } from '../tools/lib/env_file_bootstrap.mjs';
import { SecretService } from '../tools/lib/control_credentials_service.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { controlCenterInstance, resolveControlCenterStartup, startControlCenter } from '../tools/web/server.mjs';
import { requestLocal } from '../tools/web/launcher.mjs';
import { applicationConfigPath } from '../tools/lib/application_config.mjs';
import { OperationLedgerStore } from '../tools/recovery/operation_ledger.mjs';
import { canonicalQueryHash } from '../tools/stage1/source_state.mjs';
import { scheduleDayDecisionPath } from '../tools/lib/schedule_support.mjs';
import { receiptPathFor } from '../tools/stage5/email_receipt.mjs';
const base = fileURLToPath(new URL('../../tests/runs/runtime-paths/', import.meta.url));
const inside = (root, file) => { const r = path.relative(root, file); assert.ok(!r.startsWith('..') && !path.isAbsolute(r)); };
async function fixture(t, layout = 'portable') {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '目录 空格 '));
  t.after(async () => { inside(base, root); await fs.rm(root, { recursive: true, force: true, maxRetries: 2 }); });
  const app = path.join(root, '程序'); await fs.mkdir(app);
  await fs.writeFile(path.join(app, 'program.txt'), 'immutable program');
  const env = { PAPERECHO_LAYOUT: layout, PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_SKIP_DOTENV: '1', LOCALAPPDATA: path.join(root, 'Local AppData'), PAPERECHO_WORKSPACE_ID: 'research-a' };
  return { root, app, env, paths: resolveRuntimePaths({ env }) };
}
async function seed(f, mode = 'local') {
  prepareRuntimePaths(f.paths);
  const config = { schemaVersion: 2, mode, common: { projectRoot: '..', llm: { enabled: false }, email: { enabled: false } } };
  if (mode === 'local') {
    await fs.writeFile(path.join(f.paths.userDataRoot, 'input.json'), '[]');
    config.local = { input: '../input.json' };
  }
  const text = JSON.stringify(config, null, 2); await fs.writeFile(f.paths.configPath, text);
  return text;
}
test('Portable data and canonical relative config survive moving the complete directory', async t => {
  const f = await fixture(t); const before = await seed(f);
  const a = await resolveApplicationRuntimeContext({ cwd: f.app, env: f.env });
  inside(f.paths.userDataRoot, a.localRepository.root);
  const moved = path.join(f.root, '移动后的 程序'); inside(f.root, moved); inside(f.root, f.app);
  await fs.rename(f.app, moved);
  const env = { ...f.env, PAPERECHO_APPLICATION_ROOT: moved };
  const paths = resolveRuntimePaths({ env });
  const b = await resolveApplicationRuntimeContext({ cwd: f.root, env });
  inside(paths.userDataRoot, b.reviewRoot); inside(paths.userDataRoot, b.localRepository.root);
  assert.notEqual(b.userDataRoot, a.userDataRoot);
  assert.equal(await fs.readFile(paths.configPath, 'utf8'), before);
});
test('Installed roots use explicit workspace identity, isolate workspaces and never write the application directory', async t => {
  const f = await fixture(t, 'installed'); await seed(f);
  const before = await fs.readdir(f.app);
  const a = await resolveApplicationRuntimeContext({ cwd: f.app, env: f.env });
  const bPaths = resolveRuntimePaths({ env: { ...f.env, PAPERECHO_WORKSPACE_ID: 'research-b' } });
  assert.notEqual(a.userDataRoot, bPaths.userDataRoot);
  const other = resolveRuntimePaths({ env: { ...f.env, PAPERECHO_APPLICATION_ROOT: path.join(f.root, 'new-version') } });
  assert.equal(a.userDataRoot, other.userDataRoot);
  const startup = await resolveControlCenterStartup({ root: f.app, env: f.env });
  assert.equal(startup.env.PAPERECHO_DATA_ROOT, a.userDataRoot);
  assert.equal(controlCenterInstance(f.app, a), controlCenterInstance(other.applicationRoot, a));
  assert.deepEqual(await fs.readdir(f.app), before);
  assert.equal(await fs.readFile(path.join(f.app, 'program.txt'), 'utf8'), 'immutable program');
  // Deny writes to the program tree; data writes still use the real fixture filesystem.
  const denyProgramWrite = (file, operation) => {
    if (!path.relative(f.app, file).startsWith('..')) throw Object.assign(new Error('read-only program fixture'), { code: 'EACCES' });
    return operation();
  };
  prepareRuntimePaths(f.paths, { fsApi: { ...syncFs,
    mkdirSync: (file, options) => denyProgramWrite(file, () => syncFs.mkdirSync(file, options)),
    openSync: (file, flags, mode) => denyProgramWrite(file, () => syncFs.openSync(file, flags, mode)),
  } });
});
test('Dev retains legacy canonical config and .env without automatic rewriting', async t => {
  const f = await fixture(t, 'dev'); await fs.mkdir(path.dirname(f.paths.configPath));
  const original = '{"schemaVersion":2,"mode":"desktop","common":{"projectRoot":".."}}\n';
  await fs.writeFile(f.paths.configPath, original);
  await fs.writeFile(f.paths.secretPath, 'TITLE_TRANSLATION_API_KEY=dummy-development-only\n');
  const env = { ...f.env }; delete env.PAPERECHO_SKIP_DOTENV;
  loadDotEnv({ env, envPath: f.paths.secretPath });
  const context = await resolveApplicationRuntimeContext({ cwd: f.app, env });
  assert.equal(path.resolve(context.projectRoot), f.app);
  assert.equal(resolveDotEnvPath({ env }), f.paths.secretPath);
  assert.equal((await new SecretService({ root: f.app, env }).list()).find(x => x.id === 'TITLE_TRANSLATION_API_KEY').storageClass, 'local-managed');
  assert.equal(await fs.readFile(f.paths.configPath, 'utf8'), original);
});
test('bootstrap, canonical resolver and SecretService share only the selected User Data Root', async t => {
  const f = await fixture(t, 'installed'); await seed(f);
  await fs.writeFile(f.paths.secretPath, ''); await secureCredentialFile(f.paths.secretPath);
  const service = new SecretService({ root: f.app, env: f.env });
  assert.equal((await service.replace('TITLE_TRANSLATION_API_KEY', 'dummy-portable-only')).savedToFile, true);
  assert.equal(syncFs.existsSync(path.join(f.app, '.env')), false);
  const env = { ...f.env }; delete env.PAPERECHO_SKIP_DOTENV; loadDotEnv({ env });
  assert.equal(Boolean(env.TITLE_TRANSLATION_API_KEY), true);
  assert.equal(applicationConfigPath({ root: f.app, env }), f.paths.configPath);
  const external = new SecretService({ root: f.app, env: { ...f.env, TITLE_TRANSLATION_API_KEY: 'dummy-external-only' } });
  await assert.rejects(external.replace('TITLE_TRANSLATION_API_KEY', 'dummy-refused'), /CREDENTIAL_EXTERNALLY_MANAGED/);
});
test('runtime, preflight, claim, ledger, receipt and recovery keep the same data authority', async t => {
  const f = await fixture(t, 'installed'); await seed(f, 'desktop');
  const resolved = await resolveRunnerConfiguration(parseRunnerArgs(['--check', '--mode', 'desktop']), { cwd: f.app, env: f.env });
  const runtime = buildRuntimeConfig({ cwd: f.root, env: resolved.env, argv: [] });
  const plan = buildExecutionPlan(resolved.options, { env: resolved.env });
  const claim = scheduleDayDecisionPath(path.join(runtime.researchRoot, 'schedule_decisions'), '2026-10-15');
  const hash = canonicalQueryHash({ dummy: true });
  const store = await OperationLedgerStore.create({ runRoot: plan.runRoot, runId: 'path-fixture', mode: 'desktop', profile: 'standard', launcherId: 'desktop-fixed-launcher/runner', configHash: hash, inputHash: hash, stages: ['stage1'] });
  const reloaded = await OperationLedgerStore.load({ runRoot: plan.runRoot, runId: 'path-fixture' });
  assert.equal(store.filePath, reloaded.filePath);
  for (const file of [claim, store.filePath, receiptPathFor(path.join(plan.runRoot, 'path-fixture')), resolved.env.PAPERECHO_NOTIFICATION_HEALTH_ROOT, resolved.env.TEMP]) inside(f.paths.userDataRoot === path.dirname(f.paths.cacheRoot) ? f.paths.userDataRoot : f.root, file);
  inside(f.paths.userDataRoot, claim); inside(f.paths.userDataRoot, store.filePath);
  const context = await resolveApplicationRuntimeContext({ cwd: f.app, env: f.env });
  assert.equal(path.resolve(context.runRoot), plan.runRoot);
  const services = createControlServices({ root: f.app, env: f.env, context, llmClient: () => { throw new Error('EXTERNAL_CALL_FORBIDDEN'); } });
  assert.equal(services.config.root, f.paths.userDataRoot);
  assert.equal(services.review.runRoot, context.runRoot);
});
test('Local preflight works with a separate data root and changed invocation directory', async t => {
  const f = await fixture(t, 'installed'); await seed(f);
  const options = parseRunnerArgs(['--check', '--mode', 'local'], { cwd: f.paths.userDataRoot });
  const a = await resolveRunnerConfiguration(options, { cwd: f.root, env: f.env });
  const report = await runPreflight(a.options, { env: a.env });
  assert.equal(report.canRun, true);
  const r1 = buildRuntimeConfig({ cwd: f.app, env: a.env, argv: [] });
  const r2 = buildRuntimeConfig({ cwd: path.dirname(f.root), env: a.env, argv: [] });
  assert.equal(r1.reviewRoot, r2.reviewRoot);
  assert.equal(buildLocalRuntimeConfig({ cwd: f.root, env: a.env, argv: [] }).outputRoot, path.join(f.paths.userDataRoot, 'review_results', 'local').replaceAll('\\', '/'));
  const input = buildLocalRuntimeConfig({ cwd: f.root, env: a.env, argv: ['--input', 'input.json', '--feedback', 'feedback.jsonl'] });
  assert.equal(path.resolve(input.inputPath), path.join(f.paths.userDataRoot, 'input.json'));
  assert.equal(path.resolve(input.feedbackPath), path.join(f.paths.userDataRoot, 'feedback.jsonl'));
});
test('ambiguous legacy data, unsafe paths, links and read-only destinations fail closed', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.app, '.env'), '# legacy marker only');
  assert.throws(() => prepareRuntimePaths(f.paths), /RUNTIME_LEGACY_DATA_FOUND/);
  assert.equal(syncFs.existsSync(f.paths.userDataRoot), false);
  const selected = resolveRuntimePaths({ env: { ...f.env, PAPERECHO_DATA_ROOT: 'data' } }); prepareRuntimePaths(selected);
  assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_DATA_ROOT: '../outside' } }), /RUNTIME_PORTABLE_BOUNDARY/);
  assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: f.app } }), /RUNTIME_INSTALLED_BOUNDARY/);
  assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: f.root } }), /RUNTIME_INSTALLED_BOUNDARY/);
  assert.throws(() => assertRuntimeDataPath(selected, path.join(f.root, 'outside')), /RUNTIME_DATA_PATH_OUTSIDE_ROOT/);
  const junction = path.join(selected.userDataRoot, 'linked'); const outside = path.join(f.root, 'protected'); await fs.mkdir(outside);
  await fs.symlink(outside, junction, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertRuntimeDataPath(selected, path.join(junction, '.env')), /RUNTIME_PATH_LINK_UNSAFE/);
  const programAlias = path.join(f.root, 'program-alias');
  await fs.symlink(selected.userDataRoot, programAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const aliased = resolveRuntimePaths({ env: { ...f.env, PAPERECHO_LAYOUT: 'installed', PAPERECHO_APPLICATION_ROOT: programAlias, PAPERECHO_DATA_ROOT: selected.userDataRoot } });
  assert.throws(() => prepareRuntimePaths(aliased), /RUNTIME_PATH_LINK_UNSAFE/);
  const denied = { ...syncFs, openSync: () => { throw Object.assign(new Error('denied fixture'), { code: 'EACCES' }); } };
  assert.throws(() => prepareRuntimePaths(selected, { fsApi: denied }), /RUNTIME_DATA_UNWRITABLE/);
  assert.deepEqual(await fs.readdir(outside), []);
});
test('platform contracts and concurrent directory creation do not guess a root', async t => {
  const f = await fixture(t, 'installed');
  const p = resolveRuntimePaths({ platform: 'darwin', homeDir: '/Users/dummy', applicationRoot: '/Applications/PaperEcho.app/Contents/Resources/app.asar', env: { PAPERECHO_LAYOUT: 'installed', PAPERECHO_WORKSPACE_ID: 'lab' } });
  assert.equal(p.userDataRoot, '/Users/dummy/Library/Application Support/PaperEcho/lab');
  assert.equal(p.cacheRoot, '/Users/dummy/Library/Caches/PaperEcho/lab');
  assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_WORKSPACE_ID: '' } }), /RUNTIME_WORKSPACE_ID_REQUIRED/);
  assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_DATA_ROOT: 'relative' } }), /RUNTIME_DATA_ROOT_ABSOLUTE_REQUIRED/);
  if (process.platform === 'win32') {
    assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_APPLICATION_ROOT: '\\program' } }), /RUNTIME_APPLICATION_ROOT_ABSOLUTE_REQUIRED/);
    assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_DATA_ROOT: '\\data' } }), /RUNTIME_DATA_ROOT_ABSOLUTE_REQUIRED/);
    assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_LAYOUT: 'portable', PAPERECHO_DATA_ROOT: f.app.toUpperCase() } }), /RUNTIME_PORTABLE_BOUNDARY/);
    assert.throws(() => resolveRuntimePaths({ env: { ...f.env, PAPERECHO_DATA_ROOT: '\\\\?\\C:\\program\\data' } }), /RUNTIME_DATA_ROOT_ABSOLUTE_REQUIRED/);
  }
  const script = `import { resolveRuntimePaths, prepareRuntimePaths } from ${JSON.stringify(new URL('../tools/lib/runtime_config.mjs', import.meta.url).href)}; prepareRuntimePaths(resolveRuntimePaths({ env: JSON.parse(process.argv[1]) }));`;
  await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.env)], { windowsHide: true })));
  assert.equal((await fs.readdir(f.paths.tempRoot)).length, 0);
});
for (const layout of ['portable', 'installed']) test(`${layout} HTTP smoke uses only its selected data root and never starts external work`, async t => {
  const f = await fixture(t, layout); const original = await seed(f);
  const startup = await resolveControlCenterStartup({ root: f.app, env: f.env });
  let llmCalls = 0;
  const services = createControlServices({ root: f.app, env: startup.env, context: startup.context, llmClient: async () => { llmCalls++; throw new Error('EXTERNAL_CALL_FORBIDDEN'); } });
  const server = await startControlCenter({ ...startup, port: 0, services });
  try {
    const home = await fetch(server.url); assert.equal(home.status, 200); assert.ok((await home.text()).includes('PaperEcho'));
    assert.equal((await requestLocal(server.url + '/api/credentials')).status, 403);
    const session = await requestLocal(server.url + '/api/session');
    const headers = { Cookie: session.headers['set-cookie'][0].split(';')[0], Origin: server.url, 'X-CSRF-Token': session.json.token, 'Content-Type': 'application/json' };
    const settings = await fetch(server.url + '/api/settings', { headers });
    assert.equal(settings.status, 200); await settings.arrayBuffer();
    assert.equal((await requestLocal(server.url + '/api/research', { method: 'POST', headers, body: JSON.stringify({ text: 'fixture research direction', requestId: `fixture-${layout}` }) })).status, 200);
    assert.equal(llmCalls, 0);
    assert.ok(syncFs.existsSync(path.join(startup.context.reviewRoot, 'research_evaluations')));
    assert.equal(await fs.readFile(f.paths.configPath, 'utf8'), original);
    if (layout === 'installed') assert.deepEqual(await fs.readdir(f.app), ['program.txt']);
  } finally { server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve)); }
});
