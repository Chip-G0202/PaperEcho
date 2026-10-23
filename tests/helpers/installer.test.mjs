import test from 'node:test';
import assert from 'node:assert/strict';
import { installerTables } from '../../desktop/electron-poc/installer-win.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const product = '{7395EC5E-338E-4E71-92A2-579BD64EE6E4}';
const files = [{ path: 'PaperEcho.exe', size: 10 }, { path: 'resources/core/空 格/module.mjs', size: 20 }];
test('Hyper-V UI signals close the writer before publishing and reject stale or duplicate observations', async t => {
  const pwsh = process.env.PWSH_PATH; assert.ok(pwsh && path.isAbsolute(pwsh), 'APPROVED_PWSH_7_REQUIRED');
  const base = path.resolve('tests/runs/phase3a'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'signal-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const script = `$ErrorActionPreference='Stop';$root=$env:TEST_SIGNAL_ROOT;$file=Join-Path $root 'locked.json';$h=[IO.File]::Open($file,'CreateNew','Write','None');$denied=$false;try{try{$null=Get-Content -LiteralPath $file -Raw -ErrorAction Stop}catch{$denied=($_.Exception.HResult -eq -2147024864)}}finally{$h.Dispose()};if(-not $denied){throw 'SHARING_FIXTURE_INVALID'};$run=[guid]::NewGuid().ToString();@{runId=$run;phase='negative-login-screen';status='STARTED'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $root 'installer-progress.json');$helper=$env:TEST_SIGNAL_HELPER;& $helper -Directory $root -Step negative-login-screen -Action dismiss-lockscreen;$signal=Get-Content -LiteralPath (Join-Path $root 'negative-login-screen.json') -Raw|ConvertFrom-Json;if($signal.runId -cne $run -or $signal.action -cne 'dismiss-lockscreen' -or @(Get-ChildItem $root -Filter '*.tmp').Count){throw 'ATOMIC_SIGNAL_INVALID'};foreach($step in @('negative-login-screen','full-desktop','../escape')){$rejected=$false;try{& $helper -Directory $root -Step $step -Action dismiss-lockscreen}catch{$rejected=$true};if(-not $rejected){throw 'UNTRUSTED_SIGNAL_ACCEPTED'}};'ATOMIC_SIGNAL_PASS'`;
  const output = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000, env: { ...process.env, TEST_SIGNAL_ROOT: root, TEST_SIGNAL_HELPER: path.resolve('tests/helpers/hyperv_ui_signal.ps1') } });
  assert.equal(output.trim(), 'ATOMIC_SIGNAL_PASS');
});

test('installer diagnostic reader accepts empty stderr and retains only bounded error codes', async t => {
  const pwsh = process.env.PWSH_PATH; assert.ok(pwsh && path.isAbsolute(pwsh), 'APPROVED_PWSH_7_REQUIRED');
  const base = path.resolve('tests/runs/phase3a'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'diagnostic-reader-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = String.raw`
$ErrorActionPreference='Stop'
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:PAPERECHO_TEST_READER_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'HELPER_PARSE_FAILED'}
$nodes=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -ceq '$script:lastChildCodes'},$true))
if($nodes.Count -ne 1){throw 'EXACT_READER_REQUIRED'}
$reader=[scriptblock]::Create('param($err) '+$nodes[0].Right.Extent.Text)
$file=Join-Path $env:PAPERECHO_TEST_READER_ROOT 'dummy-stderr.txt'
foreach($case in @(@('',0),@('dummy free text',0),@('ERR_DUMMY 0xC0000001 PAPERECHO_DUMMY',3))){
 [IO.File]::WriteAllText($file,$case[0])
 $codes=@(& $reader $file)
 if($codes.Count -ne $case[1]){throw 'READER_RESULT_INVALID'}
}
[IO.File]::WriteAllText($file,((1..10|ForEach-Object{'ERR_DUMMY_'+([char](64+$_))})-join ' '))
if(@(& $reader $file).Count -ne 6){throw 'READER_LIMIT_INVALID'}
[Console]::Out.Write('DIAGNOSTIC_READER_PASS')`;
  const output = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000, encoding: 'utf8',
    env: { ...process.env, PAPERECHO_TEST_READER_SOURCE: path.resolve('tests/helpers/sandbox_installer.ps1'), PAPERECHO_TEST_READER_ROOT: root } });
  assert.equal(output, 'DIAGNOSTIC_READER_PASS');
});
test('installer identity-only probe rejects the host before reaching any MSI operation', () => {
  const pwsh = process.env.PWSH_PATH; assert.ok(pwsh && path.isAbsolute(pwsh), 'APPROVED_PWSH_7_REQUIRED');
  for (const extra of [[], ['-HyperVContextSha256', '0'.repeat(64)]]) {
    assert.throws(() => execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.resolve('tests/helpers/sandbox_installer.ps1'), '-IdentityOnly', ...extra],
      { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status !== 0 && error.stderr.includes('INSTALLER_GUEST_PATH_REQUIRED'));
  }
});
test('native installer is per-user, data-free and uses standard transactional actions', () => {
  const t = installerTables(files, product);
  assert.equal(t.Property.rows.some(([key]) => key === 'ALLUSERS'), false);
  assert.equal(t.LaunchCondition.rows.some(([value]) => value === 'NOT ALLUSERS'), true);
  assert.equal(t.Property.rows.some(([key, value]) => key === 'ProductName' && value.includes('TEST ONLY')), true);
  assert.equal(t.Directory.rows.some(row => row[2] === '空 格'), true);
  assert.equal(t.File.rows.length, files.length); assert.equal(t.Component.rows.length, files.length);
  assert.equal(t.Component.rows.every(row => row[3] === 260 && row[5].startsWith('R')), true);
  assert.equal(t.Registry.rows.every(row => row[1] === 1 && row[2].startsWith('Software\\PaperEcho\\Installer\\')), true);
  assert.equal(t.RemoveFile.rows.every(row => row[2] === null && row[3] === 'MenuDir' && row[4] === 2), true);
  assert.equal(t.InstallExecuteSequence.rows.at(-1)[0], 'InstallFinalize');
  assert.equal(Object.hasOwn(t, 'CustomAction'), false); assert.equal(Object.hasOwn(t, 'ServiceInstall'), false);
});
test('private files, duplicate casefolded names and path injection fail closed', () => {
  for (const name of ['../PaperEcho.exe', '/PaperEcho.exe', 'C:/PaperEcho.exe', 'x\\y', 'x"y', 'a/../b', 'a\nb', '.env', 'config/paperecho.config.json', 'x.log', 'x.pebackup']) {
    assert.throws(() => installerTables([...files, { path: name, size: 1 }], product), /INSTALLER_INPUT_INVALID/);
  }
  assert.throws(() => installerTables([...files, { path: 'paperecho.exe', size: 1 }], product), /INSTALLER_INPUT_INVALID/);
  assert.throws(() => installerTables([{ path: 'x', size: 1 }], product), /INSTALLER_EXE_REQUIRED/);
});

test('native MSI database roundtrips Unicode, apostrophes and NULL fields', async t => {
  assert.equal(process.platform, 'win32', 'WINDOWS_NATIVE_SQL_GATE');
  const pwsh = process.env.PWSH_PATH; assert.ok(pwsh && path.isAbsolute(pwsh), 'APPROVED_PWSH_7_REQUIRED');
  const base = path.resolve('tests/runs/phase3a'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'native-sql-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // Only the database/stream contract is under test; this is never an installable fixture.
  const payload = path.join(root, 'dummy-stream'); await fs.writeFile(payload, 'dummy SQL stream');
  const tables = installerTables([{ path: 'PaperEcho.exe', size: 1 }, { path: "resources/空 格's.mjs", size: 2 }], product);
  const spec = path.join(root, 'database.json');
  await fs.writeFile(spec, JSON.stringify({ tables, msi: path.join(root, 'fixture.msi'), payload, packageCode: product }));
  const result = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.resolve('tests/helpers/installer_sql.ps1'), '-Specification', spec], { timeout: 30000, encoding: 'utf8' });
  assert.match(result, /NATIVE_MSI_SQL_ROUNDTRIP_PASS/);
});
