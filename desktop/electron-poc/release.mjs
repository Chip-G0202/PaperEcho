// Offline build verification only. No signing, installer, OS-task or publishing API.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { getCurrentFuseWire, FuseState } from '@electron/fuses';
import { appVersion, sourceAllowed, fuseConfig } from './package-policy.mjs';
import { powershell } from './powershell-runtime.mjs';

export const limits = Object.freeze({ files: 20000, totalBytes: 2 * 1024 ** 3, manifestBytes: 8 * 1024 ** 2 });
const fail = code => { throw new Error(code); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => JSON.stringify(value);
const required = ['PaperEcho.exe', 'PaperEcho-headless.cmd', 'resources/app.asar', 'version',
  'resources/core/package.json', 'resources/core/desktop/electron-poc/headless.mjs',
  'resources/core/workflow/tools/lib/runtime_config.mjs', 'resources/core/workflow/tools/runner/main.mjs'];
const native = new Set(['PaperEcho.exe', 'PaperEcho-headless.cmd', 'chrome_100_percent.pak', 'chrome_200_percent.pak',
  'd3dcompiler_47.dll', 'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'LICENSE', 'LICENSES.chromium.html',
  'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll']);
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.length > 512 || /[\\:\u0000-\u001f]/.test(name)
    || name.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))) fail('RELEASE_ENTRY_INVALID');
  return name;
}
async function safeRoot(root, parent) {
  if (!path.isAbsolute(root) || !path.isAbsolute(parent)) fail('RELEASE_BOUNDARY');
  const rel = path.relative(parent, root);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) fail('RELEASE_BOUNDARY');
  // Reject linked ancestors, including a junction above the artifact parent.
  for (let dir = path.resolve(root); ; dir = path.dirname(dir)) {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('RELEASE_BOUNDARY');
    if (dir === path.dirname(dir)) break;
  }
  return path.resolve(root);
}
async function boundedJSON(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limits.manifestBytes) fail('RELEASE_METADATA_INVALID');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function fingerprint(file) {
  const handle = await fs.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limits.totalBytes) fail('RELEASE_FILE_UNSAFE');
    const digest = createHash('sha256');
    for await (const bytes of handle.createReadStream({ autoClose: false })) digest.update(bytes);
    const after = await handle.stat(), named = await fs.lstat(file);
    if (named.isSymbolicLink() || after.ino !== named.ino || after.dev !== named.dev || after.nlink !== 1
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail('RELEASE_FILE_CHANGED');
    return { size: after.size, sha256: digest.digest('hex') };
  } finally { await handle.close(); }
}
function validLists(sources, modules) {
  if (!Array.isArray(sources) || !sources.length || sources.length > limits.files
    || !Array.isArray(modules) || modules.length > 1000) fail('RELEASE_SOURCE_LIST_INVALID');
  const cleanSources = sources.map(relativeName), cleanModules = modules.map(relativeName);
  if (new Set(cleanSources).size !== sources.length || cleanSources.some(file => !sourceAllowed(file))
    || new Set(cleanModules).size !== modules.length || cleanModules.some(file => !/^node_modules\/(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(file))) fail('RELEASE_SOURCE_LIST_INVALID');
  return { sources: cleanSources, modules: cleanModules };
}
async function inventory(root, sources, modules) {
  const sourceSet = new Set(sources), files = []; let total = 0, count = 0;
  async function walk(dir, prefix = '') {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      if (++count > limits.files * 2) fail('RELEASE_SIZE_LIMIT');
      const name = relativeName(prefix + item.name), file = path.join(dir, item.name), stat = await fs.lstat(file);
      if (stat.isSymbolicLink()) fail('RELEASE_LINK_REJECTED');
      if (/(^|\/)\.env($|\.)|(^|\/)(?:\.npmrc|\.pypirc|paperecho\.config\.json|.*\.(?:pfx|p12|pem|key|log|pebackup|zip))$/i.test(name)) fail('RELEASE_PRIVATE_CONTENT');
      if (item.isDirectory() && stat.isDirectory()) {
        const core = name.startsWith('resources/core/') ? name.slice('resources/core/'.length) : '';
        if (!['locales', 'resources', 'resources/core', 'resources/powershell'].includes(name) && !name.startsWith('resources/powershell/')
          && !sources.some(s => s.startsWith(core + '/'))
          && !modules.some(m => m === core || m.startsWith(core + '/') || core.startsWith(m + '/'))) fail('RELEASE_UNEXPECTED_FILE');
        await walk(file, name + '/'); continue;
      }
      if (!stat.isFile() || stat.nlink !== 1) fail('RELEASE_LINK_REJECTED');
      if (name === 'release-manifest.json') continue;
      let allowed = native.has(name) || /^locales\/[a-zA-Z0-9_-]+\.pak$/.test(name) || name === 'resources/app.asar' || name.startsWith('resources/powershell/');
      if (name.startsWith('resources/core/')) {
        const core = name.slice('resources/core/'.length);
        allowed = core === 'package.json' || sourceSet.has(core) || modules.some(m => core.startsWith(m + '/'));
      }
      if (!allowed) fail('RELEASE_UNEXPECTED_FILE');
      if (files.length >= limits.files || total + stat.size > limits.totalBytes) fail('RELEASE_SIZE_LIMIT');
      const value = await fingerprint(file); total += value.size;
      if (files.length >= limits.files || total > limits.totalBytes) fail('RELEASE_SIZE_LIMIT');
      files.push({ path: name, ...value });
    }
  }
  await walk(root);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (required.some(name => !files.some(f => f.path === name))) fail('RELEASE_RESOURCE_MISSING');
  for (const name of sources) if (!files.some(f => f.path === 'resources/core/' + name)) fail('RELEASE_RESOURCE_MISSING');
  for (const name of modules) if (!files.some(f => f.path === 'resources/core/' + name + '/package.json')) fail('RELEASE_DEPENDENCY_MISSING');
  return files;
}
export function peIdentity(bytes) {
  if (bytes.length < 256 || bytes.readUInt16LE(0) !== 0x5a4d) fail('RELEASE_PE_INVALID');
  const offset = bytes.readUInt32LE(0x3c);
  if (offset + 176 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550
    || bytes.readUInt16LE(offset + 4) !== 0x8664 || bytes.readUInt16LE(offset + 24) !== 0x20b
    || bytes.readUInt16LE(offset + 20) < 152 || bytes.readUInt32LE(offset + 24 + 108) < 5) fail('RELEASE_ARCH_MISMATCH');
  const certificateOffset = bytes.readUInt32LE(offset + 24 + 112 + 32), certificateBytes = bytes.readUInt32LE(offset + 24 + 112 + 36);
  if ((certificateOffset === 0) !== (certificateBytes === 0) || certificateOffset + certificateBytes > bytes.length) fail('RELEASE_PE_INVALID');
  return { arch: 'x64', signature: certificateBytes ? 'UNVERIFIED' : 'NOT_SIGNED' };
}
export async function inspectElectron(root) {
  for (const name of ['pwsh.exe', 'pwsh.dll', 'System.Management.Automation.dll', 'LICENSE.txt', 'ThirdPartyNotices.txt']) await fingerprint(path.join(root, 'resources/powershell', name));
  const exe = path.join(root, 'PaperEcho.exe'), bytes = await fs.readFile(exe);
  const identity = peIdentity(bytes), wire = await getCurrentFuseWire(exe);
  verifyFuseWire(wire);
  const require = createRequire(import.meta.url);
  const { NtExecutable, NtExecutableResource, Resource } = await import(pathToFileURL(require.resolve('resedit')).href);
  const { getRawHeader, extractFile, listPackage } = await import(pathToFileURL(require.resolve('@electron/asar')).href);
  const asar = path.join(root, 'resources/app.asar');
  const entries = NtExecutableResource.from(NtExecutable.from(bytes)).entries;
  const versions = Resource.VersionInfo.fromEntries(entries).flatMap(info => info.getAllLanguagesForStringValues().map(lang => info.getStringValues(lang)));
  if (!versions.length || versions.some(v => v.ProductVersion !== appVersion || v.FileVersion !== appVersion || v.ProductName !== 'PaperEcho')) fail('RELEASE_VERSION_MISMATCH');
  const integrity = entries.find(e => e.type === 'INTEGRITY' && e.id === 'ELECTRONASAR');
  if (!integrity || JSON.parse(Buffer.from(integrity.bin).toString('utf8'))[0]?.value !== hash(getRawHeader(asar).headerString)) fail('RELEASE_ASAR_INTEGRITY');
  const asarFiles = listPackage(asar).map(f => f.replaceAll('\\', '/').replace(/^\//, '')).sort();
  if (canonical(asarFiles) !== canonical(['main.mjs', 'package.json', 'preload.cjs', 'shell.mjs'])) fail('RELEASE_ASAR_CONTENT');
  const shell = JSON.parse(extractFile(asar, 'package.json'));
  if (shell.version !== appVersion || shell.main !== 'main.mjs') fail('RELEASE_VERSION_MISMATCH');
  for (const file of ['main.mjs', 'shell.mjs', 'preload.cjs']) if (hash(extractFile(asar, file)) !== (await fingerprint(path.join(root, 'resources/core/desktop/electron-poc', file))).sha256) fail('RELEASE_SHELL_MISMATCH');
  return { ...identity, fuses: 'VERIFIED', asar: 'VERIFIED' };
}
export function verifyFuseWire(wire) {
  for (const key of Object.keys(fuseConfig).filter(k => /^\d+$/.test(k))) {
    if (wire[key] !== (fuseConfig[key] ? FuseState.ENABLE : FuseState.DISABLE)) fail('RELEASE_FUSE_MISMATCH');
  }
}
async function metadata(root, sources, modules, gitCommit, dirty, builtAt) {
  validLists(sources, modules);
  if (!/^[a-f0-9]{40}$/.test(gitCommit) || typeof dirty !== 'boolean' || !/^\d{4}-\d\d-\d\dT.*Z$/.test(builtAt) || !Number.isFinite(Date.parse(builtAt))) fail('RELEASE_METADATA_INVALID');
  const pkg = await boundedJSON(path.join(root, 'resources/core/package.json'));
  if (pkg.version !== appVersion || pkg.name !== 'paperecho-core' || pkg.type !== 'module') fail('RELEASE_VERSION_MISMATCH');
  if ((await fs.readFile(path.join(root, 'version'), 'utf8')).trim() !== '44.7.2') fail('RELEASE_ELECTRON_MISMATCH');
  for (const dep of Object.keys(pkg.dependencies || {})) if (!modules.includes('node_modules/' + dep)) fail('RELEASE_DEPENDENCY_MISSING');
  const tool = async name => (await boundedJSON(fileURLToPath(new URL(`./node_modules/${name}/package.json`, import.meta.url)))).version;
  return { schemaVersion: 1, product: 'PaperEcho', appVersion, gitCommit, dirty, builtAt, platform: 'win32', arch: 'x64', buildMode: 'unpacked',
    electronVersion: await tool('electron'), packagerVersion: await tool('@electron/packager'), fusesVersion: await tool('@electron/fuses'),
    packageVersion: (await boundedJSON(fileURLToPath(new URL('./package.json', import.meta.url)))).version,
    entrypoints: { gui: 'resources/app.asar', headless: 'resources/core/desktop/electron-poc/headless.mjs' },
    runtime: { owner: 'resources/core/workflow/tools/lib/runtime_config.mjs', layouts: ['installed', 'portable'],
      installed: 'OS_USER_DATA', portable: 'APPLICATION_DATA_SUBDIRECTORY', cache: 'RUNTIME_ROOT_OWNER',
      powershell: { ...powershell, executable: 'resources/powershell/pwsh.exe' } },
    sources: [...sources].sort(), modules: [...modules].sort() };
}
export async function createReleaseManifest({ root, parent, sources, modules, gitCommit, dirty, builtAt, inspect = inspectElectron }) {
  await safeRoot(root, parent);
  const info = await metadata(root, sources, modules, gitCommit, dirty, builtAt);
  const files = await inventory(root, sources, modules);
  await inspect(root);
  const content = { ...info, files };
  return { ...content, artifactId: hash(canonical(content)) };
}
export async function verifyReleaseArtifact({ root, parent, expectedCommit, inspect = inspectElectron }) {
  await safeRoot(root, parent);
  const m = await boundedJSON(path.join(root, 'release-manifest.json'));
  const { sources, modules } = validLists(m.sources, m.modules);
  const info = await metadata(root, sources, modules, m.gitCommit, m.dirty, m.builtAt);
  if (expectedCommit && m.gitCommit !== expectedCommit) fail('RELEASE_COMMIT_MISMATCH');
  const files = await inventory(root, sources, modules), content = { ...info, files };
  // Exact projection: unknown metadata/entries cannot silently become trusted.
  if (canonical(m) !== canonical({ ...content, artifactId: hash(canonical(content)) })) fail('RELEASE_MANIFEST_MISMATCH');
  const binary = await inspect(root);
  return { artifactId: m.artifactId, appVersion: m.appVersion, gitCommit: m.gitCommit, dirty: m.dirty,
    fileCount: files.length, sizeBytes: files.reduce((n, f) => n + f.size, 0), evidence: inspect === inspectElectron ? 'OBSERVED' : 'MOCK', binary };
}
export function signingPreflight(artifact, configuration = {}, toolAvailable = false) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) fail('SIGNING_CONFIG_INVALID');
  const { certificate, timestampURL } = configuration;
  if (Object.keys(configuration).some(k => !['certificate', 'timestampURL'].includes(k))) fail('SIGNING_CONFIG_INVALID');
  if (certificate && (certificate.source !== 'windows-store' || !/^[a-fA-F0-9]{40}$/.test(certificate.thumbprint || '')
    || Object.keys(certificate).some(k => !['source', 'thumbprint'].includes(k)))) fail('SIGNING_CONFIG_INVALID');
  if (timestampURL) { let u; try { u = new URL(timestampURL); } catch { fail('SIGNING_CONFIG_INVALID'); }
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) fail('SIGNING_CONFIG_INVALID'); }
  const signature = artifact.binary.signature;
  return { status: signature === 'INVALID' ? 'FAILED' : 'BLOCKED', code: signature === 'INVALID' ? 'SIGNATURE_INVALID' : 'SIGNING_BLOCKED',
    signature, evidence: artifact.evidence, toolLocated: Boolean(toolAvailable), toolTrust: 'UNVERIFIED', certificateConfigured: Boolean(certificate),
    certificateTrust: 'UNVERIFIED', timestampConfigured: Boolean(timestampURL), authenticodeVerification: 'NOT_EXECUTED_REQUIRED_BEFORE_RELEASE',
    requirements: ['TRUSTED_SIGNTOOL', 'TRUSTED_CODE_SIGNING_CERTIFICATE', 'RFC3161_TIMESTAMP', 'AUTHENTICODE_VERIFY_ALL', 'INSTALLER_SEPARATE_SIGNATURE'],
    order: ['BUILD', 'FUSES', 'ASAR_INTEGRITY', 'SIGN_APPLICATION', 'VERIFY_APPLICATION', 'BUILD_INSTALLER', 'SIGN_INSTALLER', 'VERIFY_INSTALLER', 'FINAL_HASH_MANIFEST'],
    verification: ['signtool.exe', 'verify', '/pa', '/all', '/v', '<artifact>'] };
}
export function notarizationPreflight() {
  return { status: 'BLOCKED', code: 'MACOS_NOT_VALIDATED', evidence: 'STATIC_CONTRACT_ONLY',
    requirements: ['MACOS_HOST', 'DEVELOPER_ID_APPLICATION', 'HARDENED_RUNTIME', 'REVIEWED_ENTITLEMENTS', 'SIGN_NESTED_CODE_INSIDE_OUT',
      'NOTARY_ACCEPTED', 'STAPLED_TICKET', 'GATEKEEPER_ACCEPTED', 'X64_ARM64_NATIVE_TESTS'],
    commands: [ ['codesign', '--verify', '--deep', '--strict', '--verbose=2', '<app>'],
      ['xcrun', 'notarytool', 'submit', '<signed-archive>', '--keychain-profile', '<profile>', '--wait'],
      ['xcrun', 'stapler', 'staple', '<app>'], ['xcrun', 'stapler', 'validate', '<app>'],
      ['spctl', '--assess', '--type', 'execute', '--verbose=2', '<app>'] ],
    signingCommand: ['codesign', '--force', '--options', 'runtime', '--timestamp', '--entitlements', '<reviewed-entitlements.plist>', '--sign', '<Developer-ID-Application>', '<nested-code-or-app>'],
    entitlementReview: ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'],
    executed: false };
}
export function releaseGate(artifact, signing = signingPreflight(artifact)) {
  if (!['BLOCKED', 'FAILED'].includes(signing.status) || signing.evidence !== artifact.evidence) fail('RELEASE_EVIDENCE_INVALID');
  // No caller-supplied PASS flags can satisfy the unimplemented real-world gates.
  const gates = [
    { id: 'development', status: 'UNKNOWN', code: 'CURRENT_SOURCE_TEST_EVIDENCE_REQUIRED' },
    { id: 'offlinePackaging', status: artifact.evidence === 'OBSERVED' ? 'READY_FOR_TEST' : 'UNKNOWN', code: artifact.evidence === 'OBSERVED' ? 'HASH_FUSES_ASAR_VERIFIED' : 'MOCK_ONLY' },
    { id: 'releasePreflight', status: artifact.dirty ? 'BLOCKED' : 'READY_FOR_TEST', code: artifact.dirty ? 'UNCOMMITTED_BUILD_INPUTS' : 'OFFLINE_CHECKS_ONLY' },
    { id: 'windowsSigning', status: signing.status, code: signing.code },
    { id: 'installer', status: 'BLOCKED', code: 'PHASE_3A_ISOLATED_WINDOWS_REQUIRED' },
    { id: 'scheduler', status: 'BLOCKED', code: 'PHASE_5B_OS_VALIDATION_REQUIRED' },
    { id: 'upgradeRollback', status: 'BLOCKED', code: 'PHASE_6C_VERSION_REPLACEMENT_REQUIRED' },
    { id: 'macos', status: 'BLOCKED', code: 'MACOS_NOT_VALIDATED' },
    { id: 'publication', status: 'BLOCKED', code: 'REQUIRED_RELEASE_EVIDENCE_MISSING' } ];
  return { schemaVersion: 1, status: signing.status === 'FAILED' ? 'FAILED' : 'BLOCKED', releaseReady: false,
    artifact: { id: artifact.artifactId, version: artifact.appVersion, gitCommit: artifact.gitCommit, dirty: artifact.dirty,
      fileCount: artifact.fileCount, sizeBytes: artifact.sizeBytes, evidence: artifact.evidence },
    gates, signing, macos: notarizationPreflight(), integrityIsSignature: false,
    runAsNode: 'ENABLED_FOR_EMBEDDED_HEADLESS_ARBITRARY_NODE_EXECUTION_REMAINS',
    resourcesCore: 'HASHED_NOT_ASAR_AUTHENTICATED_PROTECT_PROGRAM_WRITE_ACCESS' };
}
export async function main(argv = process.argv.slice(2)) {
  const repo = fileURLToPath(new URL('../../', import.meta.url)), parent = path.join(repo, 'tests/runs/phase2b');
  await safeRoot(parent, repo);
  if (argv.length && (argv.length !== 2 || argv[0] !== '--artifact' || !path.isAbsolute(argv[1]))) fail('RELEASE_ARGUMENT_INVALID');
  const root = argv[1] || (await boundedJSON(path.join(parent, 'latest-build.json'))).output;
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const artifact = await verifyReleaseArtifact({ root, parent, expectedCommit });
  let toolAvailable = false;
  if (process.platform === 'win32' && process.env.SystemRoot) {
    try { toolAvailable = Boolean(execFileSync(path.join(process.env.SystemRoot, 'System32/where.exe'), ['signtool.exe'],
      { timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).length); } catch { /* Missing tool is an explicit BLOCKED prerequisite. */ }
  }
  const report = releaseGate(artifact, signingPreflight(artifact, {}, toolAvailable));
  console.log(JSON.stringify(report, null, 2));
  return report.status === 'FAILED' ? 2 : 3;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(/^RELEASE_[A-Z_]+$/.test(error.message) ? error.message : 'RELEASE_VERIFICATION_FAILED'); process.exitCode = 2; }
}
