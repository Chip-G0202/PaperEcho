import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { credentialAclFailure, secureCredentialFile, windowsCredentialAclScript } from '../tools/lib/credential_file_security.mjs';
import { bindPackagedPowerShell } from '../../desktop/electron-poc/runtime.mjs';

test('ACL errors distinguish unavailable runtime, verified unsafe ACL and unverifiable execution', () => {
  for (const code of ['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC']) assert.equal(credentialAclFailure({ code }), 'CREDENTIAL_ACL_RUNTIME_UNAVAILABLE');
  assert.equal(credentialAclFailure({ code: 1, stderr: 'CREDENTIAL_ACL_UNSAFE' }), 'CREDENTIAL_ACL_UNSAFE');
  for (const error of [{ signal: 'SIGTERM', killed: true }, { code: 1, stderr: 'private error' }, {}, { code: 1, stderr: 'CREDENTIAL_ACL_UNSAFE\nextra' }]) assert.equal(credentialAclFailure(error), 'CREDENTIAL_ACL_CHECK_FAILED');
});

test('GUI and Headless shared bootstrap binds only the packaged executable, without PATH or global overrides', async t => {
  const base = path.resolve('tests/runs/acl-runtime'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '程序 空间-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const core = path.join(root, 'resources/core'); await fs.mkdir(core, { recursive: true });
  const env = { PATH: '', PWSH_PATH: 'external-untrusted.exe' };
  assert.throws(() => bindPackagedPowerShell({ core, env, platform: 'win32' }), /RUNTIME_UNAVAILABLE/);
  assert.equal(env.PWSH_PATH, 'external-untrusted.exe');
  const shipped = path.join(root, 'resources/powershell/pwsh.exe'); await fs.mkdir(path.dirname(shipped)); await fs.writeFile(shipped, 'fixture-not-executed');
  assert.equal(bindPackagedPowerShell({ core, env, platform: 'win32' }), shipped);
  assert.equal(env.PWSH_PATH, shipped); assert.equal(env.PATH, '');
  const linked = path.join(root, 'external-runtime');
  await fs.rename(path.dirname(shipped), linked);
  await fs.symlink(linked, path.dirname(shipped), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => bindPackagedPowerShell({ core, env, platform: 'win32' }), /RUNTIME_UNAVAILABLE/);
});

test('missing runtime preserves original bytes; native ACL policy rejects inheritance, broad Allow and unsupported owner', async t => {
  if (process.platform !== 'win32') return; // Native DACL assertions apply only on Windows.
  const base = path.resolve('tests/runs/acl-runtime'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'acl-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'location.json.synthetic.tmp'); await fs.writeFile(file, 'synthetic-not-secret');
  const previous = process.env.PWSH_PATH;
  try {
    process.env.PWSH_PATH = path.join(root, 'missing-pwsh.exe');
    await assert.rejects(secureCredentialFile(file), /RUNTIME_UNAVAILABLE/);
  } finally { if (previous === undefined) delete process.env.PWSH_PATH; else process.env.PWSH_PATH = previous; }
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic-not-secret');
  await assert.rejects(secureCredentialFile(file, { checkOnly: true }), /ACL_UNSAFE/);
  await secureCredentialFile(file); await secureCredentialFile(file, { checkOnly: true });
  const pwsh = process.env.PWSH_PATH || 'pwsh.exe';
  const run = script => execFileSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, env: { ...process.env, PAPERECHO_CREDENTIAL_FILE: file, PAPERECHO_CREDENTIAL_ACL_SOURCE: '', PAPERECHO_CREDENTIAL_ACL_ACTION: 'check' }, stdio: 'pipe' });
  // Synthetic wrong-owner metadata exercises the real predicate without needing privileged ownership changes.
  const wrongOwner = windowsCredentialAclScript.replace('$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])', "$owner = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')");
  assert.throws(() => run(wrongOwner), error => error.status === 1 && error.stderr.toString() === 'CREDENTIAL_ACL_UNSAFE');
  const safeSddl = run("[Console]::Out.Write((Get-Acl -LiteralPath $env:PAPERECHO_CREDENTIAL_FILE).Sddl)").toString();
  // DACL-only grant: no Owner/SACL setter or privilege beyond the file owner's WRITE_DAC.
  assert.equal(run("$ErrorActionPreference='Stop'; $p=$env:PAPERECHO_CREDENTIAL_FILE; $before=Get-Acl -LiteralPath $p; & (Join-Path $env:SystemRoot 'System32/icacls.exe') $p '/grant' '*S-1-1-0:(R)' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'FIXTURE_DACL_GRANT_FAILED' }; $a=Get-Acl -LiteralPath $p; $rules=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-1-0' -and $_.AccessControlType -eq 'Allow' -and -not $_.IsInherited -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Read) -eq [Security.AccessControl.FileSystemRights]::Read }); if ($rules.Count -ne 1 -or $a.Owner -ne $before.Owner -or -not $a.AreAccessRulesProtected) { throw 'FIXTURE_DACL_NOT_ESTABLISHED' }; [Console]::Out.Write('ACE_ESTABLISHED')").toString(), 'ACE_ESTABLISHED');
  const unsafeSddl = run("[Console]::Out.Write((Get-Acl -LiteralPath $env:PAPERECHO_CREDENTIAL_FILE).Sddl)").toString();
  await assert.rejects(secureCredentialFile(file, { checkOnly: true }), { message: 'CREDENTIAL_ACL_UNSAFE' });
  assert.equal(run("[Console]::Out.Write((Get-Acl -LiteralPath $env:PAPERECHO_CREDENTIAL_FILE).Sddl)").toString(), unsafeSddl, 'inspection must not change DACL');
  await assert.rejects(fs.access(path.join(root, 'location.json')), { code: 'ENOENT' });
  // Remove only the fixture's verified explicit ACE; this negative test does not ask the product to repair unsafe ACLs.
  run("& (Join-Path $env:SystemRoot 'System32/icacls.exe') $env:PAPERECHO_CREDENTIAL_FILE '/remove:g' '*S-1-1-0' | Out-Null; if ($LASTEXITCODE -ne 0) { throw 'FIXTURE_DACL_RESTORE_FAILED' }");
  assert.equal(run("[Console]::Out.Write((Get-Acl -LiteralPath $env:PAPERECHO_CREDENTIAL_FILE).Sddl)").toString(), safeSddl);
  await secureCredentialFile(file, { checkOnly: true });
  assert.equal(await fs.readFile(file, 'utf8'), 'synthetic-not-secret');
});
