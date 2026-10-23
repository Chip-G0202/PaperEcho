// Guest-only checks executed by the installed embedded runtime, never system Node.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
assert.equal(process.platform, 'win32');
if (process.env.PAPERECHO_TEST_HYPERV_CONTEXT_SHA256) {
  const pinned = process.env.PAPERECHO_TEST_HYPERV_CONTEXT_SHA256;
  assert.match(pinned, /^[a-f0-9]{64}$/i);
  const file = 'C:\\PaperEchoLab\\Input\\guest-context.json', s = await fs.lstat(file);
  assert.ok(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 8192);
  const bytes = await fs.readFile(file), context = JSON.parse(bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), pinned.toLowerCase());
  assert.equal(context.schemaVersion, 1); assert.equal(context.kind, 'HYPERV_INSTALLER');
  const manifestBytes = await fs.readFile('C:\\PaperEchoLab\\Input\\test-manifest.json');
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), context.manifestSha256.toLowerCase());
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.testOnly, true); assert.equal(manifest.runId, context.runId); assert.equal(manifest.msiSha256, context.msiSha256);
  assert.equal(process.env.PWSH_PATH.toLowerCase(), 'c:\\paperecholab\\input\\tools\\pwsh\\pwsh.exe');
  const identity = JSON.parse(execFileSync(process.env.PWSH_PATH, ['-NoProfile', '-NonInteractive', '-Command',
    '$s=Get-CimInstance Win32_ComputerSystem;$w=[Security.Principal.WindowsIdentity]::GetCurrent();@{manufacturer=$s.Manufacturer;model=$s.Model;uuid=(Get-CimInstance Win32_ComputerSystemProduct).UUID;sid=$w.User.Value;elevated=([Security.Principal.WindowsPrincipal]::new($w)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}|ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 15000, windowsHide: true }));
  assert.equal(identity.manufacturer, 'Microsoft Corporation'); assert.equal(identity.model, 'Virtual Machine');
  assert.equal(identity.uuid.toLowerCase(), context.biosGuid.toLowerCase()); assert.equal(identity.sid, context.userSid);
  assert.equal(identity.elevated, false);
} else {
  assert.equal(process.env.USERNAME.toLowerCase(), 'wdagutilityaccount');
  assert.equal(process.env.USERPROFILE.toLowerCase(), 'c:\\users\\wdagutilityaccount');
}
assert.equal(process.versions.electron, '44.7.2');
assert.equal(process.env.PATH, '');
assert.equal(path.resolve(process.argv[1]).toLowerCase(), 'c:\\paperecholab\\input\\installer-check.mjs');
const app = path.dirname(process.execPath), core = path.join(app, 'resources/core');
assert.equal(app.toLowerCase(), path.join(process.env.LOCALAPPDATA, 'Programs/PaperEcho').toLowerCase());
const { preparePackagedRuntime } = await import(pathToFileURL(path.join(core, 'desktop/electron-poc/runtime.mjs')).href);
const paths = preparePackagedRuntime({ readOnly: true });
assert.equal(paths.layout, 'installed');
assert.equal(paths.userDataRoot, path.join(process.env.LOCALAPPDATA, 'PaperEcho/workspaces/default'));
assert.equal(paths.applicationRoot, app);
assert.equal(paths.cacheRoot, path.join(process.env.LOCALAPPDATA, 'PaperEcho/cache/default'));
const mode = process.argv[2];
if (mode === 'snapshot') {
  const secret = path.join(paths.userDataRoot, '.env'), secretStat = await fs.lstat(secret);
  assert.ok(secretStat.isFile() && !secretStat.isSymbolicLink() && secretStat.nlink === 1);
  const { secureCredentialFile } = await import(pathToFileURL(path.join(core, 'workflow/tools/lib/credential_file_security.mjs')).href);
  await secureCredentialFile(secret, { checkOnly: true });
  const entries = [];
  async function visit(dir) {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name), s = await fs.lstat(file);
      assert.equal(s.isSymbolicLink(), false);
      if (s.isDirectory()) await visit(file);
      else { assert.equal(s.isFile(), true); assert.equal(s.nlink, 1); assert.ok(entries.length < 3000);
        entries.push([path.relative(paths.userDataRoot, file), createHash('sha256').update(await fs.readFile(file)).digest('hex')]); }
    }
  }
  await visit(paths.userDataRoot);
  console.log(JSON.stringify({ digest: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), fileCount: entries.length, secretAclVerified: true }));
} else {
  assert.equal(mode, 'paths');
  console.log(JSON.stringify({ installed: true, embeddedRuntime: true, rootsSeparated: true, defaultWorkspace: true }));
}
