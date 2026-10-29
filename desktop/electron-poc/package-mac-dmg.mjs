// TEST-ONLY ad-hoc build with native validation. No Developer ID, notarization or release.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { packager } from '@electron/packager';
import { flipFuses, getCurrentFuseWire, FuseV1Options as F, FuseState } from '@electron/fuses';
import { appVersion, sourceAllowed, fuseConfig } from './package-policy.mjs';
import { nativeSmoke } from './mac-native-smoke.mjs';

// Reuse Packager's locked signer, including its inside-out nested-code ordering.
const packagerRequire = createRequire(createRequire(import.meta.url).resolve('@electron/packager'));
const { sign } = await import(pathToFileURL(packagerRequire.resolve('@electron/osx-sign')).href);

const repo = fileURLToPath(new URL('../../', import.meta.url));
const name = 'PaperEcho';
// No project-specific Mac ID is configured; retain Packager 20's existing default.
export const macBundleId = 'com.electron.paperecho';
export const macSourceAllowed = file => sourceAllowed(file) && !file.startsWith('tests/');
// Sign the complete final bundle below, instead of fuses' recursive --deep signer.
export const macFuseConfig = Object.freeze({ ...fuseConfig, resetAdHocDarwinSignature: false });
export const macSigningStatus = Object.freeze({ runtimeSignatureAfterFuseChanges: 'AD_HOC_TEST_ONLY',
  developerIdSigning: 'DEVELOPER_ID_NOT_PERFORMED', notarization: 'NOTARIZATION_NOT_PERFORMED' });
export async function finalizeMacBundle(bundle, stage, electronVersion, { flip = flipFuses, signApp = sign, smoke = nativeSmoke } = {}) {
  await flip(bundle, macFuseConfig);
  await signApp({ app: bundle, platform: 'darwin', version: electronVersion, identity: '-', identityValidation: false,
    preAutoEntitlements: false, preEmbedProvisioningProfile: false, strictVerify: true,
    // Ad-hoc test identity only: no certificate discovery, provisioning or timestamp service.
    optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' }) });
  return smoke(bundle, stage, { electronVersion });
}
export function macOptions(stage, checksums, electronVersion) {
  return { dir: path.join(stage, 'shell'), name, appVersion, buildVersion: appVersion, electronVersion,
    platform: 'darwin', arch: 'arm64', asar: true, prune: false,
    // Preserve the existing digest policy; the complete bundle is signed after fuses.
    asarIntegrityDigest: false,
    extraResource: [path.join(stage, 'core')], out: path.join(stage, 'output'), tmpdir: path.join(stage, 'tmp'),
    download: { cacheRoot: path.join(stage, 'electron-download'), checksums } };
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', timeout: 300000, shell: false, ...options }).trim();
async function bundleInventory(bundle) {
  const root = await fs.realpath(bundle), entries = {};
  async function visit(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
      assert.ok(!/(^|\/)(?:\.env(?:\.[^/]*)?|paperecho\.config\.json|\.git|review_results|tests\/runs)(\/|$)|\.(?:log|pebackup|pfx|p12|pem|key)$/i.test(relative), 'PRIVATE_OR_BUILD_FILE_IN_APP');
      const actual = await fs.realpath(file);
      assert.ok(actual === root || actual.startsWith(root + path.sep), 'EXTERNAL_APP_LINK');
      if (entry.isSymbolicLink()) entries[relative] = { link: await fs.readlink(file) };
      else if (entry.isDirectory()) await visit(file);
      else {
        const stat = await fs.lstat(file); assert.ok(stat.isFile()); assert.equal(stat.nlink, 1);
        entries[relative] = { size: stat.size, sha256: sha256(await fs.readFile(file)) };
      }
    }
  }
  await visit(root);
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}
function appMetadata(bundle) {
  const plist = path.join(bundle, 'Contents/Info.plist');
  const value = key => run('/usr/libexec/PlistBuddy', ['-c', 'Print :' + key, plist]);
  assert.equal(value('CFBundleIdentifier'), macBundleId);
  assert.equal(value('CFBundleExecutable'), name);
  assert.equal(value('CFBundleShortVersionString'), appVersion); assert.equal(value('CFBundleVersion'), appVersion);
  assert.equal(run('/usr/bin/lipo', ['-archs', path.join(bundle, 'Contents/MacOS', name)]), 'arm64');
  return { version: appVersion, bundleId: macBundleId, architecture: 'arm64' };
}
export async function buildTestDmg() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('MACOS_ARM64_BUILD_REQUIRED');
  const gitCommit = run('git', ['rev-parse', 'HEAD'], { cwd: repo });
  if (process.env.GITHUB_SHA) assert.equal(gitCommit, process.env.GITHUB_SHA);
  assert.equal(run('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json', 'workflow/tools', 'config', 'skills', 'desktop/electron-poc', '.github/workflows/mac-dmg-manual.yml'], { cwd: repo }), '', 'COMMITTED_BUILD_INPUTS_REQUIRED');
  const base = path.join(repo, 'tests/runs/mac-dmg'); await fs.mkdir(base, { recursive: true });
  const stage = await fs.mkdtemp(path.join(base, 'build-'));
  const shell = path.join(stage, 'shell'), core = path.join(stage, 'core'); await fs.mkdir(shell); await fs.mkdir(core);
  const tracked = run('git', ['ls-files', '-z', 'workflow/tools', 'skills', 'config', 'desktop/electron-poc'], { cwd: repo }).split('\0').filter(Boolean);
  const sources = tracked.filter(macSourceAllowed);
  for (const source of sources) {
    const file = path.join(repo, source), stat = await fs.lstat(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'UNSAFE_SOURCE_FILE');
    assert.equal(await fs.realpath(file), file);
    const target = path.join(core, source); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(file, target);
  }
  const metadata = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(core, 'package.json'), JSON.stringify({ name: 'paperecho-core', version: appVersion, private: true, type: 'module', dependencies: metadata.dependencies }));
  // Reuse the Windows packager's installed-production-tree selection, not dev tools.
  const installed = run(process.execPath, [process.env.npm_execpath, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: repo }).split(/\r?\n/).slice(1);
  const modules = installed.filter(file => !installed.some(parent => parent !== file && file.startsWith(parent + path.sep)));
  assert.ok(modules.length > 0, 'PRODUCTION_DEPENDENCIES_REQUIRED');
  for (const directory of modules) {
    assert.ok(directory.startsWith(path.join(repo, 'node_modules') + path.sep)); assert.equal(await fs.realpath(directory), directory);
    await fs.cp(directory, path.join(core, path.relative(repo, directory)), { recursive: true, dereference: false });
  }
  for (const file of ['main.mjs', 'shell.mjs', 'preload.cjs']) await fs.copyFile(path.join(repo, 'desktop/electron-poc', file), path.join(shell, file));
  await fs.writeFile(path.join(shell, 'package.json'), JSON.stringify({ name: 'paperecho', productName: name, author: 'PaperEcho contributors', version: appVersion, private: true, type: 'module', main: 'main.mjs' }));
  const electron = JSON.parse(await fs.readFile(new URL('./node_modules/electron/package.json', import.meta.url), 'utf8'));
  const declared = JSON.parse(await fs.readFile(new URL('./package.json', import.meta.url), 'utf8')).devDependencies.electron;
  assert.equal(electron.version, declared);
  const checksums = JSON.parse(await fs.readFile(new URL('./node_modules/electron/checksums.json', import.meta.url), 'utf8'));
  const outputs = await packager(macOptions(stage, checksums, electron.version)); assert.equal(outputs.length, 1);
  const bundle = path.join(outputs[0], name + '.app');
  const smoke = await finalizeMacBundle(bundle, stage, electron.version);
  const wire = await getCurrentFuseWire(bundle);
  for (const key of Object.values(F).filter(x => typeof x === 'number')) assert.equal(wire[key], fuseConfig[key] ? FuseState.ENABLE : FuseState.DISABLE);
  for (const required of ['Contents/Resources/app.asar', 'Contents/Resources/core/package.json', 'Contents/Resources/core/workflow/tools/runner/main.mjs', 'Contents/Resources/core/desktop/electron-poc/headless.mjs']) await fs.access(path.join(bundle, required));
  const info = appMetadata(bundle);
  const before = await bundleInventory(bundle);
  const disk = path.join(stage, 'disk'); await fs.mkdir(disk);
  await fs.rename(bundle, path.join(disk, name + '.app')); await fs.symlink('/Applications', path.join(disk, 'Applications'));
  const artifact = path.join(base, 'artifact'); await fs.mkdir(artifact); // Refuse stale output or a second build.
  const filename = `${name}-${appVersion}-darwin-arm64-TEST-ONLY.dmg`, dmg = path.join(artifact, filename);
  run('/usr/bin/hdiutil', ['create', '-volname', 'PaperEcho TEST ONLY', '-srcfolder', disk, '-format', 'UDZO', '-fs', 'HFS+', dmg]);
  run('/usr/bin/hdiutil', ['verify', dmg]);
  const mount = path.join(stage, 'verify-mount'); await fs.mkdir(mount);
  run('/usr/bin/hdiutil', ['attach', dmg, '-readonly', '-nobrowse', '-mountpoint', mount]);
  try {
    const mounted = path.join(mount, name + '.app'); assert.ok((await fs.lstat(mounted)).isDirectory());
    assert.ok((await fs.lstat(path.join(mount, 'Applications'))).isSymbolicLink());
    assert.equal(await fs.readlink(path.join(mount, 'Applications')), '/Applications');
    assert.deepEqual(appMetadata(mounted), info); assert.deepEqual(await bundleInventory(mounted), before);
  } finally { run('/usr/bin/hdiutil', ['detach', mount]); }
  const bytes = await fs.readFile(dmg);
  const validation = { testOnly: true, gitCommit, ...info, filename, bytes: bytes.length, sha256: sha256(bytes), files: Object.keys(before).length,
    sourceFiles: sources.length, electron: electron.version, dmgVerified: true, readonlyMountVerified: true, unmounted: true,
    ...macSigningStatus, signatureValidity: 'VERIFIED', nativeSmoke: smoke, guiAndGatekeeper: 'NOT_TESTED', releaseReady: false };
  await fs.writeFile(path.join(artifact, 'validation.json'), JSON.stringify(validation, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(validation)); return validation;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildTestDmg();
