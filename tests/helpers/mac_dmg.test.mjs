import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { macOptions, macFuseConfig, macSourceAllowed, macBundleId, buildTestDmg } from '../../desktop/electron-poc/package-mac-dmg.mjs';
import { appVersion, fuseConfig } from '../../desktop/electron-poc/package-policy.mjs';
import { nativeSmoke } from '../../desktop/electron-poc/mac-native-smoke.mjs';

test('Mac TEST-ONLY package reuses version, resources and fuses, single architecture, without implicit signing', () => {
  const options = macOptions('/synthetic/build', { fixture: 'checksum' }, '44.7.2');
  assert.equal(options.platform, 'darwin'); assert.equal(options.arch, 'arm64');
  assert.equal(options.name, 'PaperEcho'); assert.equal(options.appVersion, appVersion); assert.equal(options.buildVersion, appVersion);
  assert.equal(macBundleId, 'com.electron.paperecho'); assert.equal(options.asar, true);
  assert.equal(options.osxSign, undefined); assert.equal(options.osxNotarize, undefined); assert.equal(options.asarIntegrityDigest, false);
  assert.deepEqual(options.extraResource, [path.join('/synthetic/build', 'core')]); assert.equal(options.download.checksums.fixture, 'checksum');
  assert.deepEqual(macFuseConfig, { ...fuseConfig, resetAdHocDarwinSignature: false }); assert.equal(fuseConfig.resetAdHocDarwinSignature, undefined);
});
test('Mac source policy excludes secrets, user state, build inputs and packaged test probes', () => {
  for (const file of ['.env', 'config/paperecho.config.json', 'tests/runs/data.json', 'tests/helpers/packaged_probe.mjs', 'README.md', '.github/workflows/mac-dmg-manual.yml']) assert.equal(macSourceAllowed(file), false, file);
  for (const file of ['workflow/tools/lib/macos_launchagent.mjs', 'workflow/tools/web/static/app.js', 'desktop/electron-poc/headless.mjs', 'config/paperecho.config.example.json']) assert.equal(macSourceAllowed(file), true, file);
});
test('Mac build fails before any build or system command on an unsupported host', async () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') await assert.rejects(buildTestDmg(), /MACOS_ARM64_BUILD_REQUIRED/);
});
test('manual workflow uses an existing build command and uploads only after successful native verification', async () => {
  const pkg = JSON.parse(await fs.readFile(new URL('../../desktop/electron-poc/package.json', import.meta.url)));
  assert.equal(pkg.scripts['package:dmg:mac'], 'node package-mac-dmg.mjs');
  const workflow = await fs.readFile(new URL('../../.github/workflows/mac-dmg-manual.yml', import.meta.url), 'utf8');
  assert.match(workflow, /npm run package:dmg:mac --prefix desktop\/electron-poc/);
  assert.doesNotMatch(workflow, /secrets\.|self-hosted|macos-.*-large|always\(|continue-on-error|schedule:|pull_request:|push:|^\s*cache:|npm test|release create/m);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /retention-days: 3/); assert.match(workflow, /persist-credentials: false/);
});

async function nativeFixture() {
  const base = new URL('../runs/', import.meta.url); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(new URL('mac-native-', base));
  const bundle = path.join(root, 'PaperEcho.app');
  await fs.mkdir(path.join(bundle, 'Contents/MacOS'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Contents/MacOS/PaperEcho'), '', { mode: 0o700 });
  await fs.mkdir(path.join(bundle, 'Contents/Resources/core'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Contents/Resources/core/package.json'), JSON.stringify({ dependencies: { jszip: '3.10.1' } }));
  return { root, bundle };
}
const validPreflight = { type: 'preflight', canRun: true, mode: 'local', requiredMissing: [], readiness: [{ name: 'production_entry', status: 'ready' }] };
function mockNative(calls, fail) {
  return (file, args, options) => {
    const step = file.endsWith('codesign') ? 'signature' : args[0] === '-e' ? 'runtime' : 'headless';
    calls.push({ step, file, args, options });
    if (fail?.step === step) return fail.result;
    return { status: 0, signal: null, stdout: step === 'signature' ? '' : JSON.stringify(step === 'runtime'
      ? { arch: 'arm64', electron: '44.7.2', node: '24.21.0', dependencies: ['jszip'] } : validPreflight), stderr: '' };
  };
}
test('native smoke verifies signature then bundled dependencies and the formal isolated read-only entry', async () => {
  const { root, bundle } = await nativeFixture(), calls = [];
  const report = await nativeSmoke(bundle, root, { platform: 'darwin', execute: mockNative(calls), electronVersion: '44.7.2' });
  assert.deepEqual(calls.map(value => value.step), ['signature', 'runtime', 'headless']);
  assert.deepEqual(calls[0].args, ['--verify', '--deep', '--strict', '--verbose=2', bundle]);
  assert.deepEqual(calls[2].args, ['--headless', '--check', '--mode', 'local']);
  assert.equal(calls[1].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(calls[2].options.env.ELECTRON_RUN_AS_NODE, undefined);
  for (const { file, options } of calls) {
    assert.equal(options.shell, false); assert.equal(options.timeout, 60000);
    assert.equal(options.env.PATH, ''); assert.equal(options.env.PAPERECHO_SKIP_DOTENV, '1');
    assert.equal(options.env.NODE_OPTIONS, undefined); assert.equal(options.env.GITHUB_TOKEN, undefined);
    assert.ok(options.cwd.startsWith(root + path.sep)); assert.ok(options.env.HOME.startsWith(options.cwd + path.sep));
    assert.ok(file.endsWith('codesign') || file === path.join(bundle, 'Contents/MacOS/PaperEcho'));
  }
  assert.equal(report.headless.preflight.productionExecuted, false);
  assert.equal(report.gui, 'NOT_TESTED'); assert.equal(report.gatekeeper, 'NOT_TESTED');
  const builder = await fs.readFile(new URL('../../desktop/electron-poc/package-mac-dmg.mjs', import.meta.url), 'utf8');
  assert.ok(builder.indexOf('await nativeSmoke(bundle') < builder.indexOf("['create', '-volname'"));
});
test('invalid codesign stops before launch, retaining the actual error and no signature repair', async () => {
  const { root, bundle } = await nativeFixture(), calls = [];
  await assert.rejects(nativeSmoke(bundle, root, { platform: 'darwin', execute: mockNative(calls,
    { step: 'signature', result: { status: 1, stderr: 'a sealed resource is missing or invalid' } }) }), /MACOS_SIGNATURE_FAILED/);
  assert.deepEqual(calls.map(value => value.step), ['signature']);
});
test('native headless spawn failure, signal, failed preflight and wrong runtime cannot pass', async () => {
  for (const [step, result] of [
    ['headless', { status: null, error: { code: 'ENOENT' } }],
    ['headless', { status: null, signal: 'SIGKILL' }],
    ['headless', { status: 2, stderr: 'PAPERECHO_HEADLESS_START_FAILED' }],
    ['headless', { status: 0, stdout: JSON.stringify({ ...validPreflight, canRun: false }) }],
    ['runtime', { status: 0, stdout: JSON.stringify({ arch: 'x64', electron: '44.7.2', node: '24.21.0', dependencies: ['jszip'] }) }],
  ]) {
    const { root, bundle } = await nativeFixture(), calls = [];
    await assert.rejects(nativeSmoke(bundle, root, { platform: 'darwin', execute: mockNative(calls, { step, result }) }));
    assert.equal(calls.at(-1).step, step);
  }
});
test('non-Mac smoke refuses execution before file access or commands', async () => {
  await assert.rejects(nativeSmoke('unused', 'unused', { platform: 'win32', execute: () => assert.fail('must not execute') }), /MACOS_NATIVE_SMOKE_REQUIRED/);
});
