import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

test('local PS7 probe verifies the actual engine and rejects the wrong machine', () => {
  const runId = randomUUID();
  function run(expected) {
    const script = `$ErrorActionPreference='Stop'; $bios=${expected}; & $env:TEST_PROBE -RunId '${runId}' -ExpectedBiosGuid $bios`;
    return spawnSync(process.env.PWSH_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, TEST_PROBE: path.resolve('tests/helpers/powershell7_probe.ps1') }, encoding: 'utf8', timeout: 15000,
    });
  }
  const good = run('(Get-CimInstance Win32_ComputerSystemProduct).UUID');
  assert.equal(good.status, 0, good.error?.code || 'PS7_PROBE_FAILED');
  const result = JSON.parse(good.stdout.trim());
  assert.equal(result.runId, runId);
  assert.equal(result.status, 'PASS');
  assert.ok(Number(result.version.split('.')[0]) >= 7);
  assert.equal(result.edition, 'Core');
  assert.equal(path.win32.basename(result.exe).toLowerCase(), 'pwsh.exe');
  assert.equal(result.compatSessions, 0);
  assert.equal(result.identityVerified, true);
  assert.equal(result.probeSha256, createHash('sha256').update(readFileSync('tests/helpers/powershell7_probe.ps1')).digest('hex'));
  const bad = run(`'${randomUUID()}'`);
  assert.equal(bad.status, 1);
  assert.deepEqual(JSON.parse(bad.stdout.trim()), { schemaVersion: 1, runId, status: 'FAIL', errorCode: 'PROBE_IDENTITY_MISMATCH' });
});

test('5.1 is rejected by entry requirements and the version guard without starting 5.1', () => {
  const script = String.raw`
$ErrorActionPreference='Stop'
$ast=[Management.Automation.Language.Parser]::ParseFile($env:TEST_PROBE,[ref]$null,[ref]$null)
if($ast.ScriptRequirements.RequiredPSVersion -lt [version]'7.0' -or 'Core' -notin $ast.ScriptRequirements.RequiredPSEditions){throw 'PS7_REQUIREMENTS_MISSING'}
$guard=$ast.Find({param($n)$n -is [Management.Automation.Language.IfStatementAst] -and $n.Extent.Text.StartsWith('if($PSVersionTable.PSVersion.Major -lt 7')},$true)
$testVersion=@{PSVersion=[version]'5.1';PSEdition='Desktop'}
$rejected=$false;try{& ([scriptblock]::Create($guard.Extent.Text.Replace('$PSVersionTable','$testVersion')))}catch{$rejected=$_.Exception.Message -ceq 'POWERSHELL_7_CORE_REQUIRED'}
if(-not $rejected){throw 'WRONG_ENGINE_NOT_REJECTED'}
'PS7_GUARD_PASS'
`;
  const result = spawnSync(process.env.PWSH_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    env: { ...process.env, TEST_PROBE: path.resolve('tests/helpers/powershell7_probe.ps1') }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.status, 0, result.error?.code || 'PS7_GUARD_FAILED');
  assert.equal(result.stdout.trim(), 'PS7_GUARD_PASS');
});
