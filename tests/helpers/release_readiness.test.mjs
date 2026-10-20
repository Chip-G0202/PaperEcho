// Build-tool tests live with existing packaging tests, outside workflow-only npm test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReleaseManifest, verifyReleaseArtifact, signingPreflight, notarizationPreflight, releaseGate,
  peIdentity, verifyFuseWire, limits } from '../../desktop/electron-poc/release.mjs';
import { fuseConfig, sourceAllowed } from '../../desktop/electron-poc/package-policy.mjs';
import { FuseState } from '../../desktop/electron-poc/node_modules/@electron/fuses/dist/index.js';

const commit = 'a'.repeat(40), inspect = async () => ({ arch: 'x64', signature: 'NOT_SIGNED', fuses: 'MOCK', asar: 'MOCK' });
async function fixture(t) {
  const parent = path.resolve('tests/runs/phase11'); await fs.mkdir(parent, { recursive: true });
  const owned = await fs.mkdtemp(path.join(parent, '发行 校验-')), root = path.join(owned, '程序 & 空间');
  t.after(() => fs.rm(owned, { recursive: true, force: true }));
  const sources = ['desktop/electron-poc/headless.mjs', 'workflow/tools/lib/runtime_config.mjs', 'workflow/tools/runner/main.mjs', 'config/paperecho.config.example.json'];
  const contents = { 'PaperEcho.exe': 'dummy executable', 'PaperEcho-headless.cmd': 'dummy launcher', 'resources/app.asar': 'dummy ASAR',
    version: '44.7.2', 'resources/core/package.json': JSON.stringify({ name: 'paperecho-core', version: '2.6.0', type: 'module', dependencies: {} }) };
  for (const source of sources) contents['resources/core/' + source] = 'export const dummy = true;';
  for (const [file, value] of Object.entries(contents)) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), value); }
  const input = { root, parent: owned, sources, modules: [], gitCommit: commit, dirty: false, builtAt: '2026-10-20T00:00:00.000Z', inspect };
  const manifest = await createReleaseManifest(input);
  const manifestFile = path.join(root, 'release-manifest.json');
  await fs.writeFile(manifestFile, JSON.stringify(manifest));
  const verify = extra => verifyReleaseArtifact({ root, parent: owned, expectedCommit: commit, inspect, ...extra });
  return { root, owned, input, manifest, manifestFile, verify };
}
test('manifest records actual file SHA256, version, commit, entries, tool versions and Runtime Root contract', async t => {
  const f = await fixture(t), result = await f.verify();
  assert.equal(result.appVersion, '2.6.0'); assert.equal(result.gitCommit, commit); assert.equal(result.evidence, 'MOCK');
  assert.equal(f.manifest.electronVersion, '44.7.2'); assert.equal(f.manifest.packagerVersion, '20.3.0'); assert.equal(f.manifest.fusesVersion, '2.1.3');
  assert.deepEqual(f.manifest.runtime.layouts, ['installed', 'portable']);
  assert.equal(f.manifest.runtime.owner, 'resources/core/workflow/tools/lib/runtime_config.mjs');
  for (const entry of f.manifest.files) {
    const bytes = await fs.readFile(path.join(f.root, entry.path));
    assert.equal(entry.size, bytes.length); assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(path.isAbsolute(entry.path), false); assert.equal(entry.path.includes('\\'), false);
  }
  assert.equal(f.manifest.files.some(e => e.path === 'release-manifest.json'), false);
});
test('missing resource and missing dependency fail closed', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.root, 'PaperEcho-headless.cmd'));
  await assert.rejects(f.verify(), /RELEASE_RESOURCE_MISSING/);
  const g = await fixture(t); await fs.writeFile(path.join(g.root, 'resources/core/package.json'), JSON.stringify({ name: 'paperecho-core', version: '2.6.0', type: 'module', dependencies: { dummy: '1.0.0' } }));
  await assert.rejects(g.verify(), /RELEASE_DEPENDENCY_MISSING/);
});
test('modified payload, forged hash and additional manifest fields are rejected', async t => {
  const f = await fixture(t); await fs.appendFile(path.join(f.root, 'resources/app.asar'), 'tamper');
  await assert.rejects(f.verify(), /RELEASE_MANIFEST_MISMATCH/);
  const g = await fixture(t); g.manifest.files[0].sha256 = '0'.repeat(64);
  await fs.writeFile(g.manifestFile, JSON.stringify(g.manifest)); await assert.rejects(g.verify(), /RELEASE_MANIFEST_MISMATCH/);
  const h = await fixture(t); await fs.writeFile(h.manifestFile, JSON.stringify({ ...h.manifest, signed: true }));
  await assert.rejects(h.verify(), /RELEASE_MANIFEST_MISMATCH/);
});
test('wrong application, Electron version or commit is refused', async t => {
  const f = await fixture(t); await fs.writeFile(path.join(f.root, 'resources/core/package.json'), JSON.stringify({ name: 'paperecho-core', version: '2.5.0', type: 'module' }));
  await assert.rejects(f.verify(), /RELEASE_VERSION_MISMATCH/);
  const g = await fixture(t); await fs.writeFile(path.join(g.root, 'version'), '0.0.0'); await assert.rejects(g.verify(), /RELEASE_ELECTRON_MISMATCH/);
  const h = await fixture(t); await assert.rejects(h.verify({ expectedCommit: 'b'.repeat(40) }), /RELEASE_COMMIT_MISMATCH/);
});
test('every required fuse including RunAsNode is exact; absent or inverted states are refused', () => {
  const wire = Object.fromEntries(Object.keys(fuseConfig).filter(k => /^\d+$/.test(k)).map(k => [k, fuseConfig[k] ? FuseState.ENABLE : FuseState.DISABLE]));
  verifyFuseWire(wire);
  for (const key of Object.keys(wire)) {
    assert.throws(() => verifyFuseWire({ ...wire, [key]: wire[key] === FuseState.ENABLE ? FuseState.DISABLE : FuseState.ENABLE }), /RELEASE_FUSE_MISMATCH/);
    const absent = { ...wire }; delete absent[key]; assert.throws(() => verifyFuseWire(absent), /RELEASE_FUSE_MISMATCH/);
  }
});
test('real PE header classification separates certificate presence from trusted Authenticode', () => {
  const pe = Buffer.alloc(512); pe.writeUInt16LE(0x5a4d); pe.writeUInt32LE(128, 0x3c); pe.writeUInt32LE(0x4550, 128);
  pe.writeUInt16LE(0x8664, 132); pe.writeUInt16LE(0x20b, 152);
  pe.writeUInt16LE(240, 148); pe.writeUInt32LE(16, 260);
  assert.deepEqual(peIdentity(pe), { arch: 'x64', signature: 'NOT_SIGNED' });
  pe.writeUInt32LE(400, 296); pe.writeUInt32LE(8, 300); assert.equal(peIdentity(pe).signature, 'UNVERIFIED');
  pe.writeUInt32LE(500, 300); assert.throws(() => peIdentity(pe), /RELEASE_PE_INVALID/);
  pe.writeUInt16LE(0x14c, 132); assert.throws(() => peIdentity(pe), /RELEASE_ARCH_MISMATCH/);
});
test('unsigned and MOCK-valid signatures never pass a real signing or release gate', async t => {
  const f = await fixture(t), artifact = await f.verify();
  const signing = signingPreflight(artifact); assert.equal(signing.code, 'SIGNING_BLOCKED'); assert.equal(signing.certificateConfigured, false);
  const report = releaseGate(artifact); assert.equal(report.releaseReady, false); assert.equal(report.status, 'BLOCKED');
  const fake = { ...artifact, binary: { ...artifact.binary, signature: 'VALID' } };
  const fakeReport = releaseGate(fake); assert.equal(fakeReport.releaseReady, false); assert.equal(fakeReport.signing.status, 'BLOCKED');
  assert.throws(() => releaseGate(fake, { status: 'RELEASE_READY', evidence: 'MOCK' }), /RELEASE_EVIDENCE_INVALID/);
  const invalid = { ...artifact, binary: { ...artifact.binary, signature: 'INVALID' } };
  assert.equal(releaseGate(invalid).status, 'FAILED');
});
test('certificate configuration forbids private keys/passwords, injected arguments and sensitive timestamp URLs', async t => {
  const f = await fixture(t), a = await f.verify();
  for (const invalid of [{ password: 'dummy-password' }, { certificate: { source: 'pfx', thumbprint: 'a'.repeat(40) } },
    { certificate: { source: 'windows-store', thumbprint: 'x; arbitrary' } }, { timestampURL: 'http://example.invalid' },
    { timestampURL: 'https://user:dummy@example.invalid' }, { timestampURL: 'https://example.invalid/?token=dummy' }]) assert.throws(() => signingPreflight(a, invalid), /SIGNING_CONFIG_INVALID/);
  const report = signingPreflight(a, { certificate: { source: 'windows-store', thumbprint: 'a'.repeat(40) }, timestampURL: 'https://example.invalid/timestamp' }, true);
  assert.equal(report.status, 'BLOCKED'); assert.equal(report.certificateTrust, 'UNVERIFIED'); assert.equal(JSON.stringify(report).includes('a'.repeat(40)), false);
});
test('Installer, Scheduler, release upgrade and macOS stay independently blocked', async t => {
  const f = await fixture(t), report = releaseGate(await f.verify());
  for (const id of ['installer', 'scheduler', 'upgradeRollback', 'macos', 'publication']) assert.equal(report.gates.find(g => g.id === id).status, 'BLOCKED');
  assert.equal(report.gates.length, 9); assert.equal(notarizationPreflight().executed, false);
  assert.ok(notarizationPreflight().requirements.includes('HARDENED_RUNTIME'));
  assert.ok(notarizationPreflight().commands.some(args => args[0] === 'spctl'));
  const signing = notarizationPreflight().signingCommand;
  for (const flag of ['runtime', '--timestamp', '--entitlements']) assert.ok(signing.includes(flag));
  assert.equal(signing.includes('--deep'), false); // Sign nested code explicitly, not with recursive signing shortcuts.
});
test('credentials, user state, raw logs, archives and newly invented config are excluded', async t => {
  for (const name of ['config/secrets.json', 'config/paperecho.config.json', '.env', 'review_results/body.json']) assert.equal(sourceAllowed(name), false);
  for (const name of ['.env', 'resources/core/.env', 'resources/core/.npmrc', 'resources/core/config/paperecho.config.json', 'backup.zip', 'private.pfx', 'private.pem', 'runtime.log']) {
    const f = await fixture(t), file = path.join(f.root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'dummy-secret-not-exported');
    await assert.rejects(f.verify(), /RELEASE_PRIVATE_CONTENT/);
  }
  for (const name of ['review_results/body.json', 'data', 'resources/core/research']) {
    const f = await fixture(t); await fs.mkdir(path.join(f.root, name), { recursive: true });
    await assert.rejects(f.verify(), /RELEASE_UNEXPECTED_FILE/);
  }
});
test('manifest entries reject traversal, drive paths, alternate streams and Windows aliases', async t => {
  for (const name of ['../outside.mjs', '/absolute', 'C:/dummy', 'config/x.json:stream', 'config/a./x', 'config/a /x', 'config\\x.json']) {
    const f = await fixture(t); await assert.rejects(createReleaseManifest({ ...f.input, sources: [name] }), /RELEASE_ENTRY_INVALID/);
  }
});
test('artifact boundary, symlink/junction and hardlink cannot borrow outside data', async t => {
  const f = await fixture(t); await assert.rejects(f.verify({ parent: f.root }), /RELEASE_BOUNDARY/);
  const outside = path.join(f.owned, 'external'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'dummy'), 'dummy');
  await fs.symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.verify(), /RELEASE_LINK_REJECTED/);
  const g = await fixture(t); await fs.link(path.join(g.root, 'PaperEcho.exe'), path.join(g.owned, 'external-link'));
  await assert.rejects(g.verify(), /RELEASE_LINK_REJECTED/);
  const h = await fixture(t); await fs.symlink(h.root, path.join(h.owned, 'artifact-link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(h.verify({ root: path.join(h.owned, 'artifact-link') }), /RELEASE_BOUNDARY/);
});
test('oversize metadata is rejected before parsing and never becomes diagnostic content', async t => {
  const f = await fixture(t); await fs.writeFile(f.manifestFile, Buffer.alloc(limits.manifestBytes + 1));
  await assert.rejects(f.verify(), /RELEASE_METADATA_INVALID/);
});
test('repeated preflight is read-only, reports no private paths/content, and has no OS action adapter', async t => {
  const f = await fixture(t), before = await fs.readFile(f.manifestFile), stat = await fs.stat(f.manifestFile);
  const reports = await Promise.all([f.verify(), f.verify()]);
  assert.deepEqual(reports[0], reports[1]); assert.deepEqual(await fs.readFile(f.manifestFile), before);
  assert.equal((await fs.stat(f.manifestFile)).mtimeMs, stat.mtimeMs);
  const report = JSON.stringify(releaseGate(reports[0]));
  for (const forbidden of [f.root, f.owned, 'dummy-secret', 'dummy executable']) assert.equal(report.includes(forbidden), false);
  assert.equal(releaseGate({ ...reports[0], evidence: 'OBSERVED', dirty: true }).gates.find(g => g.id === 'releasePreflight').status, 'BLOCKED');
  assert.equal(reports[0].evidence, 'MOCK'); // Synthetic PE/ASAR is never real packaged acceptance.
});
