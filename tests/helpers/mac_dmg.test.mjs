import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { macOptions, macFuseConfig, macSourceAllowed, macBundleId, buildTestDmg } from '../../desktop/electron-poc/package-mac-dmg.mjs';
import { appVersion, fuseConfig } from '../../desktop/electron-poc/package-policy.mjs';

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
