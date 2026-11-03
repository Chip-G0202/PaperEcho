import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRuntimePaths, prepareRuntimePaths, assertRuntimeDataPath } from '../../workflow/tools/lib/runtime_config.mjs';
import { buildMacIconEntry } from '../../desktop/browser-workbench/build-icon-entry.mjs';

// All generated data stays in the workspace. No user configuration or API calls.
const runs = path.resolve('tests/runs/browser-quiet');
await fs.mkdir(runs, { recursive: true });
test('Mac entry bundles launch scripts and releases the GUI launch process', async () => {
  const root = await fs.mkdtemp(path.join(runs, 'bundle-test-'));
  const result = await buildMacIconEntry(path.join(root, 'Mac'));
  for (const name of ['PaperEcho 浏览器工作台.app', '停止 PaperEcho 浏览器工作台.app']) {
    const app = path.join(result.output, name);
    const script = await fs.readFile(path.join(app, 'Contents/MacOS/open-workbench'), 'utf8');
    assert.match(script, /Resources\/workbench/);
    assert.match(script, /2>&1 &!\nexit 0/);
    assert.doesNotMatch(script, /Terminal|exec \/bin\/zsh/);
    assert.equal(script.includes(' --stop </dev/null'), name.startsWith('停止'));
    for (const file of ['start.mjs', 'quiet-workbench.mjs', 'Start-Workbench-Quiet.command']) {
      assert.ok((await fs.stat(path.join(app, 'Contents/Resources/workbench', file))).size > 0);
    }
    assert.ok((await fs.stat(path.join(app, 'Contents/Resources/paperecho.icns'))).size > 0);
  }
});

test('stop refuses a service without a launcher ownership record', { skip: process.platform !== 'darwin' ? 'macOS integration only' : false }, async () => {
  const root = await fs.mkdtemp(path.join(runs, 'foreign-test-'));
  const application = path.join(root, 'application');
  await fs.mkdir(application);
  // Real resource files: production deliberately rejects linked ancestors.
  for (const name of ['lib/runtime_config.mjs', 'lib/date_label_support.mjs', 'lib/credential_registry.mjs', 'recovery/restore_transaction_status.mjs', 'lib/restore_filesystem.mjs']) {
    const destination = path.join(application, 'core/workflow/tools', name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.resolve('workflow/tools', name), destination);
  }
  const env = { ...process.env, PAPERECHO_SKIP_DOTENV: '1', PAPERECHO_LAYOUT: 'installed', PAPERECHO_APPLICATION_ROOT: application, PAPERECHO_RESOURCE_ROOT: path.join(application, 'core'), PAPERECHO_DATA_ROOT: path.join(root, 'data'), PAPERECHO_CACHE_ROOT: path.join(root, 'cache') };
  await fs.mkdir(path.join(env.PAPERECHO_DATA_ROOT, 'config'), { recursive: true });
  await fs.writeFile(path.join(env.PAPERECHO_DATA_ROOT, 'input.json'), '[]');
  await fs.writeFile(path.join(env.PAPERECHO_DATA_ROOT, 'config/paperecho.config.json'), JSON.stringify({ schemaVersion: 6, mode: 'local', profile: 'standard', common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false }, radar: { enabled: false } }, local: { input: '../input.json', outputRoot: '../review_results/local' }, weekly: { enabled: false, intervalDays: 7 }, scheduler: { schemaVersion: 1, enabled: false, time: '15:00', timezone: 'Asia/Shanghai' } }));
  const paths = resolveRuntimePaths({ env });
  prepareRuntimePaths(paths);
  assert.equal(assertRuntimeDataPath(paths, path.join(env.PAPERECHO_DATA_ROOT, 'result.json')), path.join(env.PAPERECHO_DATA_ROOT, 'result.json'));
  // Keep an outside marker; the test never deletes any fixture files.
  const outside = path.join(root, 'outside'); await fs.mkdir(outside);
  const sentinel = path.join(outside, 'untouched.txt'); await fs.writeFile(sentinel, 'unchanged');
  assert.throws(() => assertRuntimeDataPath(paths, sentinel), /RUNTIME_DATA_PATH_OUTSIDE_ROOT/);
  assert.throws(() => resolveRuntimePaths({ env: { ...env, PAPERECHO_DATA_ROOT: path.join(application, 'data') } }), /RUNTIME_INSTALLED_BOUNDARY/);
  const linkedResource = path.join(application, 'linked-core');
  await fs.symlink(path.join(application, 'core'), linkedResource, 'dir');
  assert.throws(() => prepareRuntimePaths({ ...paths, resourceRoot: linkedResource }), /RUNTIME_PATH_LINK_UNSAFE/);
  const linkedData = path.join(env.PAPERECHO_DATA_ROOT, 'linked-outside');
  await fs.symlink(outside, linkedData, 'dir');
  assert.throws(() => assertRuntimeDataPath(paths, path.join(linkedData, 'untouched.txt')), /RUNTIME_PATH_LINK_UNSAFE/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'unchanged');
  const previous = { ...process.env };
  Object.assign(process.env, env);
  let service;
  try {
    const { startBrowserWorkbench } = await import('../../desktop/browser-workbench/start.mjs');
    const { runQuiet } = await import('../../desktop/browser-workbench/quiet-workbench.mjs');
    service = await startBrowserWorkbench({ env });
    assert.equal(service.owned, true);
    let reused = false;
    await runQuiet({ env, openBrowser: async () => {}, onReady: state => { reused = state.reused; } });
    assert.equal(reused, true);
    await assert.rejects(runQuiet({ env, stop: true }), /WORKBENCH_NOT_OWNED/);
    const ready = await fetch(service.url + '/api/ready');
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).ready, true);
    assert.equal(service.server.listening, true);
  } finally {
    await service?.close();
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  }
});
