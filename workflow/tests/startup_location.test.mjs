import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRuntimePaths, prepareRuntimePaths } from '../tools/lib/runtime_config.mjs';
import { resolveStartupEnvironment, saveFirstRunLocation, startupLocationFile, assertFirstRunBlank } from '../tools/lib/startup_location.mjs';
import { RuntimeLog } from '../tools/lib/runtime_logging.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

async function fixture(t) {
  const base = path.resolve('tests/runs/startup-location'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '首次 空间-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationRoot = path.join(root, 'program'), target = path.join(root, '选定 数据');
  await fs.mkdir(applicationRoot); await fs.mkdir(target);
  const env = { LOCALAPPDATA: path.join(root, 'profile'), PAPERECHO_SKIP_DOTENV: '1' };
  const currentPaths = resolveRuntimePaths({ applicationRoot, env: { ...env, PAPERECHO_LAYOUT: 'installed', PAPERECHO_WORKSPACE_ID: 'default' } });
  prepareRuntimePaths(currentPaths);
  const options = { applicationRoot, env, currentPaths, target };
  return { ...options, save: more => saveFirstRunLocation({ ...options, ...more }), load: more => resolveStartupEnvironment({ applicationRoot, env, ...more }) };
}
test('missing record preserves Installed default; explicit layout, workspace and root override the shared record', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.load(), f.env);
  await f.save();
  for (const override of [{ PAPERECHO_LAYOUT: 'portable' }, { PAPERECHO_LAYOUT: 'installed' }, { PAPERECHO_WORKSPACE_ID: 'other' }, { PAPERECHO_DATA_ROOT: f.currentPaths.userDataRoot }]) {
    const env = { ...f.env, ...override }; assert.deepEqual(await f.load({ env }), env);
  }
  const gui = await f.load(), headless = await f.load();
  assert.deepEqual(gui, headless); assert.equal(gui.PAPERECHO_DATA_ROOT, f.target);
  const module = pathToFileURL(path.resolve('workflow/tools/lib/startup_location.mjs')).href;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `import {resolveStartupEnvironment} from ${JSON.stringify(module)};console.log(JSON.stringify(await resolveStartupEnvironment(${JSON.stringify({ applicationRoot: f.applicationRoot, env: f.env })})));`], { env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, PWSH_PATH: process.env.PWSH_PATH }, windowsHide: true });
  assert.deepEqual(JSON.parse(stdout), gui); // Cold process, no inherited selected root.
  const paths = resolveRuntimePaths({ applicationRoot: f.applicationRoot, env: { ...gui, PAPERECHO_LAYOUT: 'installed' } });
  assert.equal(paths.userDataRoot, f.target); assert.equal(paths.layout, 'installed');
  assert.deepEqual(await fs.readdir(f.target), []); // Saving is not initialization or migration.
  await assert.rejects(f.save(), /STARTUP_LOCATION_EXISTS/);
});
test('GUI-only startup logs and empty config are distinguishable from real or unknown data', async t => {
  const f = await fixture(t);
  const log = new RuntimeLog({ applicationRoot: f.applicationRoot, env: { ...f.env, PAPERECHO_LAYOUT: 'installed', PAPERECHO_WORKSPACE_ID: 'default' }, warning: code => assert.fail(code) });
  await log.write('GUI_STARTED', { subsystem: 'gui' }); await log.write('GUI_READY', { subsystem: 'gui' });
  await assertFirstRunBlank(f.currentPaths);
  const bytes = await fs.readFile(path.join(f.currentPaths.logsRoot, 'runtime.jsonl'));
  for (const name of ['.env', 'config/paperecho.config.json', 'unknown-user-file']) {
    const file = path.join(f.currentPaths.userDataRoot, name); await fs.writeFile(file, 'preserved');
    await assert.rejects(f.save(), /STARTUP_DATA_PRESENT|INSPECTION_LIMIT/);
    assert.equal(await fs.readFile(file, 'utf8'), 'preserved'); await fs.unlink(file);
  }
  await f.save(); assert.deepEqual(await fs.readFile(path.join(f.currentPaths.logsRoot, 'runtime.jsonl')), bytes);
});
test('nonempty, linked, program and overlapping targets refuse without changing existing contents', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.target, 'user'), 'preserved');
  await assert.rejects(f.save(), /STARTUP_TARGET_NOT_EMPTY/);
  assert.equal(await fs.readFile(path.join(f.target, 'user'), 'utf8'), 'preserved');
  for (const target of [f.applicationRoot, f.currentPaths.userDataRoot, path.dirname(f.currentPaths.userDataRoot), 'relative']) await assert.rejects(f.save({ target }));
  const linked = path.join(path.dirname(f.target), 'alias'); await fs.symlink(f.target, linked, 'junction');
  await assert.rejects(f.save({ target: linked }), /RUNTIME_PATH_LINK_UNSAFE/);
  await assert.rejects(fs.access(startupLocationFile(f.env)));
});
test('failed atomic save leaves no active record, target contents or partial files', async t => {
  const f = await fixture(t);
  await assert.rejects(f.save({ atomicOptions: { renameImpl: async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); } } }), /full/);
  assert.deepEqual(await f.load(), f.env); assert.deepEqual(await fs.readdir(f.target), []);
  assert.deepEqual(await fs.readdir(path.dirname(startupLocationFile(f.env))), []);
});
test('damaged, unsafe and missing-target records fail closed instead of selecting another workspace', async t => {
  const f = await fixture(t); await f.save(); const file = startupLocationFile(f.env);
  const original = await fs.readFile(file);
  await fs.writeFile(file, '{'); await assert.rejects(f.load(), /STARTUP_RECORD_INVALID/);
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, dataRoot: f.applicationRoot }));
  await assert.rejects(f.load(), /RUNTIME_INSTALLED_BOUNDARY/);
  await fs.writeFile(file, original); await fs.rmdir(f.target); await assert.rejects(f.load(), /ENOENT|STARTUP_TARGET_MISSING/);
  await secureCredentialFile(file, { checkOnly: true });
});
test('native GUI and Headless enter the same bootstrap before initializing log or service owners', async () => {
  const gui = await fs.readFile('desktop/electron-poc/main.mjs', 'utf8');
  const cli = await fs.readFile('desktop/electron-poc/headless.mjs', 'utf8');
  const runtime = await fs.readFile('desktop/electron-poc/runtime.mjs', 'utf8');
  assert.ok(gui.indexOf('await preparePackagedStartup()') < gui.indexOf("runtimeLog = new RuntimeLog"));
  assert.ok(cli.indexOf('await preparePackagedStartup(') < cli.indexOf("new RuntimeLog("));
  assert.ok(runtime.indexOf('await resolveStartupEnvironment(') < runtime.indexOf('return preparePackagedRuntime(options)'));
});
