import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { trustedFirstRunFrame, selectFirstRunDirectory } from '../../desktop/electron-poc/shell.mjs';
import * as owner from '../../workflow/tools/lib/startup_location.mjs';
import { resolveRuntimePaths, prepareRuntimePaths } from '../../workflow/tools/lib/runtime_config.mjs';
import vm from 'node:vm';

async function fixture(t) {
  const base = path.resolve('tests/runs/first-run-directory'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '选择 空间-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationRoot = path.join(root, 'program'), target = path.join(root, '中文 数据');
  await fs.mkdir(applicationRoot); await fs.mkdir(target);
  const env = { LOCALAPPDATA: path.join(root, 'profile') };
  const paths = prepareRuntimePaths(resolveRuntimePaths({ applicationRoot, env: { ...env, PAPERECHO_LAYOUT: 'installed', PAPERECHO_WORKSPACE_ID: 'default' } }));
  let restarts = 0, dialogs = 0;
  const options = { paths, env, owner, choose: async () => { dialogs++; return { canceled: false, filePaths: [target] }; }, confirm: async () => true, restart: async () => { restarts++; } };
  return { ...options, target, run: overrides => selectFirstRunDirectory({ ...options, ...overrides }), count: () => ({ restarts, dialogs }), record: owner.startupLocationFile(env) };
}
test('native bridge accepts only the actual main frame at its authenticated setup document', () => {
  const frame = { url: 'http://127.0.0.1:8765/#setup' }, contents = { mainFrame: frame };
  assert.equal(trustedFirstRunFrame({ sender: contents, senderFrame: frame }, contents, 'http://127.0.0.1:8765'), true);
  for (const url of ['http://elsewhere/#setup', 'http://127.0.0.1:8765/?x=1#setup', 'http://127.0.0.1:8765/#settings']) {
    frame.url = url; assert.equal(trustedFirstRunFrame({ sender: contents, senderFrame: frame }, contents, 'http://127.0.0.1:8765'), false);
  }
  frame.url = 'http://127.0.0.1:8765/#setup';
  assert.equal(trustedFirstRunFrame({ sender: contents, senderFrame: { ...frame } }, contents, 'http://127.0.0.1:8765'), false);
});
test('native picker cancel and confirmation cancel never save or restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.run({ choose: async () => ({ canceled: true, filePaths: [] }) })).status, 'cancelled');
  assert.equal((await f.run({ confirm: async () => false })).status, 'cancelled');
  await assert.rejects(fs.access(f.record)); assert.equal(f.count().restarts, 0);
  assert.deepEqual(await fs.readdir(f.target), []);
});
test('only persisted Phase A selection permits restart; cold resolution uses the selected directory', async t => {
  const f = await fixture(t);
  const result = await f.run({ restart: async () => {
    const env = await owner.resolveStartupEnvironment({ applicationRoot: f.paths.applicationRoot, env: f.env });
    assert.equal(env.PAPERECHO_DATA_ROOT, f.target);
  } });
  assert.equal(result.status, 'restarting'); assert.notEqual(result.status, 'ready');
  const fresh = await owner.resolveStartupEnvironment({ applicationRoot: f.paths.applicationRoot, env: f.env });
  const active = prepareRuntimePaths(resolveRuntimePaths({ applicationRoot: f.paths.applicationRoot, env: { ...fresh, PAPERECHO_LAYOUT: 'installed' } }));
  assert.equal(active.userDataRoot, f.target); await fs.writeFile(active.configPath, '{}');
  await assert.rejects(fs.access(f.paths.configPath));
});
test('existing business state and explicit Portable never reach the native picker', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.paths.userDataRoot, '.env'), 'DUMMY=preserved');
  await assert.rejects(f.run(), /STARTUP_DATA_PRESENT/);
  await assert.rejects(f.run({ env: { ...f.env, PAPERECHO_LAYOUT: 'portable' } }), /STARTUP_SELECTION_UNAVAILABLE/);
  assert.deepEqual(f.count(), { restarts: 0, dialogs: 0 });
  assert.equal(await fs.readFile(path.join(f.paths.userDataRoot, '.env'), 'utf8'), 'DUMMY=preserved');
});
test('nonempty and invalid selected targets retain data and never restart', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.target, 'research'), 'preserved');
  for (const target of [f.target, 'relative', f.paths.applicationRoot]) {
    await assert.rejects(f.run({ choose: async () => ({ canceled: false, filePaths: [target] }) }));
  }
  assert.equal(f.count().restarts, 0); await assert.rejects(fs.access(f.record));
  assert.equal(await fs.readFile(path.join(f.target, 'research'), 'utf8'), 'preserved');
});
test('save permission failure never restarts or activates a partial record', async t => {
  const f = await fixture(t);
  const failingOwner = { ...owner, saveFirstRunLocation: options => owner.saveFirstRunLocation({ ...options, atomicOptions: { renameImpl: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }, renameAttempts: 1 } }) };
  await assert.rejects(f.run({ owner: failingOwner }), /denied/);
  assert.equal(f.count().restarts, 0); await assert.rejects(fs.access(f.record));
  assert.deepEqual(await fs.readdir(f.target), []);
});
test('restart failure reports restart-required, retains record and old root, and never reports Ready', async t => {
  const f = await fixture(t);
  const before = await fs.readdir(f.paths.userDataRoot);
  const result = await f.run({ restart: async () => { throw new Error('cannot restart'); } });
  assert.deepEqual(result, { status: 'restart-required', error: 'STARTUP_RESTART_REQUIRED' });
  assert.deepEqual(await fs.readdir(f.paths.userDataRoot), before);
  assert.equal(JSON.parse(await fs.readFile(f.record, 'utf8')).dataRoot, f.target);
});
test('preload exposes no caller-chosen paths, generic IPC or Node API and packaged integrity covers it', async () => {
  const preload = await fs.readFile('desktop/electron-poc/preload.cjs', 'utf8');
  assert.match(preload, /status: \(\) => ipcRenderer.invoke\('first-run-directory', 'status'\)/);
  assert.match(preload, /choose: \(\) => ipcRenderer.invoke\('first-run-directory', 'choose'\)/);
  assert.equal(preload.includes('node:fs'), false);
  for (const file of ['package-win.mjs', 'release.mjs', 'package-policy.mjs']) assert.match(await fs.readFile(path.join('desktop/electron-poc', file), 'utf8'), /preload.cjs/);
});
test('Wizard blocks competing edits while selecting, restores cancel/error state and never unlocks after save', async () => {
  const script = await fs.readFile('workflow/tools/web/static/app.js', 'utf8');
  const start = script.indexOf("const choose = button('选择数据目录…'");
  const handler = script.slice(start, script.indexOf('section.append(choose, notice);', start)) + '\nchoose;';
  for (const result of [{ status: 'cancelled' }, { error: 'STARTUP_TARGET_NOT_EMPTY' }, { status: 'restarting' }, { status: 'restart-required' }]) {
    let finish; const next = { disabled: false }, protectedButton = { disabled: true }, notice = {};
    const controls = [next, protectedButton];
    const choose = vm.runInNewContext(handler, { document: { querySelectorAll: () => controls }, notice,
      window: { paperEchoFirstRun: { choose: () => new Promise(resolve => { finish = resolve; }) } },
      button: (_name, run) => ({ run, disabled: false }), section: {}, el: () => ({}) });
    controls.push(choose);
    const operation = choose.run();
    assert.equal(next.disabled, true); assert.equal(choose.disabled, true);
    finish(result); await operation;
    assert.equal(next.disabled, ['restarting', 'restart-required'].includes(result.status));
    assert.equal(protectedButton.disabled, true);
    assert.equal(String(notice.textContent).includes('Ready'), false);
  }
});
