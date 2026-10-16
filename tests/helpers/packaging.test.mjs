import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceAllowed } from '../../desktop/electron-poc/package-win.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPackagedModulePath } from './packaged_probe.mjs';
test('packaging sources exclude credentials, local state and build inputs', () => {
  for (const file of ['.env', 'config/paperecho.config.json', 'README.md', 'review_results/runtime_state.json', 'tests/runs/log.json', 'desktop/electron-poc/package-lock.json']) assert.equal(sourceAllowed(file), false, file);
  for (const file of ['workflow/tools/runner/main.mjs', 'workflow/tools/web/static/app.js', 'skills/paperecho-local/scripts/run.mjs', 'config/paperecho.config.example.json']) assert.equal(sourceAllowed(file), true, file);
});

test('module boundary handles trailing separators and rejects external realpaths', async t => {
  const base = path.resolve('tests/runs/phase2b'); await fs.mkdir(base, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(base, 'module-boundary-'));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const core = path.join(fixture, '程序 空间/resources/core');
  await fs.mkdir(core, { recursive: true });
  const module = path.join(core, 'dummy.mjs'); await fs.writeFile(module, 'export default 1');
  for (const root of [core, core + path.sep, path.join(core, '.')]) assert.equal(await assertPackagedModulePath(root, module), 'dummy.mjs');
  for (const label of ['Dev', 'Production', '用户数据', 'core-other']) {
    const outside = path.join(fixture, label); await fs.mkdir(outside);
    const file = path.join(outside, 'dummy.mjs'); await fs.writeFile(file, 'export default 2');
    await assert.rejects(assertPackagedModulePath(core, file), /MODULE_OUTSIDE_PACKAGED_RESOURCES/);
  }
  const link = path.join(core, 'linked');
  await fs.symlink(path.join(fixture, 'Dev'), link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(assertPackagedModulePath(core, path.join(link, 'dummy.mjs')), /MODULE_OUTSIDE_PACKAGED_RESOURCES/);
});
