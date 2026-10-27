import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import JSZip from 'jszip';
import { createReleaseManifest } from '../../desktop/electron-poc/release.mjs';
import { packageZip } from '../../desktop/electron-poc/package-zip.mjs';

const commit = 'a'.repeat(40), inspect = async () => ({ arch: 'x64', signature: 'NOT_SIGNED', fuses: 'MOCK', asar: 'MOCK' });
async function fixture(t) {
  const base = path.resolve('tests/runs/zip-tests'); await fs.mkdir(base, { recursive: true });
  const parent = await fs.mkdtemp(path.join(base, '包 空间-')), root = path.join(parent, 'application');
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const sources = ['desktop/electron-poc/headless.mjs', 'workflow/tools/lib/runtime_config.mjs', 'workflow/tools/runner/main.mjs'];
  const files = { 'PaperEcho.exe': 'dummy executable', 'PaperEcho-headless.cmd': 'dummy launcher', 'resources/app.asar': 'dummy ASAR',
    version: '44.7.2', 'resources/core/package.json': JSON.stringify({ name: 'paperecho-core', version: '2.6.0', type: 'module', dependencies: { dummy: '1.0.0' } }),
    'resources/core/node_modules/dummy/package.json': '{"name":"dummy","version":"1.0.0"}', 'resources/core/node_modules/dummy/native.node': 'native dummy bytes' };
  for (const source of sources) files['resources/core/' + source] = 'export const dummy = true;';
  for (const [file, value] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), value); }
  const manifest = await createReleaseManifest({ root, parent, sources, modules: ['node_modules/dummy'], gitCommit: commit, dirty: false, builtAt: '2026-10-27T00:00:00.000Z', inspect });
  await fs.writeFile(path.join(root, 'release-manifest.json'), JSON.stringify(manifest));
  return { root, parent, manifest, package: () => packageZip({ root, parent, expectedCommit: commit, inspect, outputParent: path.join(parent, 'output') }) };
}
test('ZIP preserves every manifest resource and native dependency with exact bytes and hashes', async t => {
  const f = await fixture(t), result = await f.package();
  const bytes = await fs.readFile(result.zip), zip = await JSZip.loadAsync(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.sha256);
  assert.equal(result.evidence, 'MOCK'); assert.equal(result.release, 'BLOCKED');
  const prefix = 'PaperEcho-2.6.0-win32-x64/';
  assert.deepEqual(Object.keys(zip.files).sort(), [...f.manifest.files.map(x => prefix + x.path), prefix + 'release-manifest.json'].sort());
  for (const entry of Object.values(zip.files)) assert.deepEqual(await entry.async('nodebuffer'), await fs.readFile(path.join(f.root, entry.name.slice(prefix.length))));
  assert.ok(zip.file(prefix + 'resources/core/node_modules/dummy/native.node'));
  assert.equal((await fs.readFile(result.zip + '.sha256', 'utf8')).startsWith(result.sha256), true);
});
test('ZIP refuses private or modified payload before creating an output', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, '.env'), 'DUMMY=private');
  await assert.rejects(f.package(), /RELEASE_PRIVATE_CONTENT/);
  await fs.unlink(path.join(f.root, '.env'));
  await fs.appendFile(path.join(f.root, 'resources/app.asar'), 'tamper');
  await assert.rejects(f.package(), /RELEASE_MANIFEST_MISMATCH/);
  await assert.rejects(fs.access(path.join(f.parent, 'output')));
});
test('native ZIP writer rejects traversal and aliases, and never overwrites an existing file', async t => {
  const f = await fixture(t), plan = path.join(f.parent, 'plan.json'), destination = path.join(f.parent, 'protected.zip');
  await fs.writeFile(destination, 'protected');
  for (const names of [['../escape'], ['C:/escape'], ['/escape'], ['a\\escape'], ['A', 'a'], ['PaperEcho.exe']]) {
    await fs.writeFile(plan, JSON.stringify({ root: f.root, prefix: 'PaperEcho', files: names.map(name => ({ path: name, size: 0, sha256: '0'.repeat(64) })) }));
    assert.throws(() => execFileSync(process.env.PWSH_PATH || 'pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.resolve('desktop/electron-poc/zip-win.ps1'), '-Plan', plan, '-Destination', destination], { windowsHide: true, stdio: 'pipe' }));
    assert.equal(await fs.readFile(destination, 'utf8'), 'protected');
  }
});
