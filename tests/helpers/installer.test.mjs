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
test('installer failure catch preserves diagnostics without cleanup; successful uninstall flow remains', () => {
  const pwsh = process.env.PWSH_PATH; assert.ok(pwsh && path.isAbsolute(pwsh), 'APPROVED_PWSH_7_REQUIRED');
  const command = String.raw`
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core'){throw 'PS7_REQUIRED'}
$errors=$null;$tokens=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'HELPER_PARSE_FAILED'}
$main=@($ast.EndBlock.Statements | Where-Object {$_ -is [Management.Automation.Language.TryStatementAst]})
if($main.Count -ne 1 -or $main[0].CatchClauses.Count -ne 1){throw 'EXACT_FAILURE_CATCH_REQUIRED'}
$body=$main[0].CatchClauses[0].Body
if(@($body.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst]},$true)).Count){throw 'FAILURE_CATCH_COMMAND_FORBIDDEN'}
$identityVerified=$true;$product='{F195CE9A-D022-5105-AF9C-5CB52C0636ED}'
$manifest=@{runId='synthetic-failure'};$reportStage='HYPERV_INSTALLER';$stage='install'
$steps=[Collections.Generic.List[object]]::new();$steps.Add(@{step='prior-step'})
$runTrace=[Collections.Generic.List[object]]::new();$runTrace.Add(@{kind='msiexec';pid=123;timedOut=$false})
$script:lastChildExit=1603;$script:lastChildCodes=@('ERR_DUMMY');$script:lastMsiCodes=@(1402)
$script:lastMsiAction='InstallFiles';$script:installerServiceAtTimeout='Running'
$script:cleanupCalls=0
function Run { $script:cleanupCalls++; throw 'MSI_EXECUTION_FORBIDDEN' }
# Exercise only the parsed catch, never the Guest entry or any real installer.
$invoke=[scriptblock]::Create('try { throw "DUMMY_INSTALL_FAILED" } catch '+$body.Extent.Text+'; $report')
$report=& $invoke
if($script:cleanupCalls -ne 0){throw 'FAILURE_CLEANUP_ATTEMPTED'}
if($report.status -cne 'FAIL' -or $report.code -cne 'DUMMY_INSTALL_FAILED' -or $report.failedStep -cne 'install' -or $report.cleanupExit -cne 'NOT_ATTEMPTED_EVIDENCE_PRESERVED'){throw 'FAILURE_REPORT_CHANGED'}
if($report.childExit -ne 1603 -or $report.childCodes[0] -cne 'ERR_DUMMY' -or $report.msiCodes[0] -ne 1402 -or $report.lastMsiAction -cne 'InstallFiles' -or $report.installerServiceAtTimeout -cne 'Running' -or $report.trace.Count -ne 1 -or $report.steps.Count -ne 1 -or -not $report.line -or -not $report.hresult){throw 'DIAGNOSTICS_LOST'}
if(@([regex]::Matches($main[0].Body.Extent.Text,'Run \$msiexec \(''/x ')).Count -ne 2){throw 'SUCCESS_UNINSTALL_FLOW_CHANGED'}
[Console]::Out.Write('FAILURE_EVIDENCE_PRESERVED')`;
  const output = execFileSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: 15000, encoding: 'utf8', windowsHide: true, env: { ...process.env, TEST_INSTALLER_SOURCE: path.resolve('tests/helpers/sandbox_installer.ps1') },
  });
  assert.equal(output, 'FAILURE_EVIDENCE_PRESERVED');
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

test('native full-install UI has valid keys, control references, focus cycles and engine progress bindings', () => {
  const t = installerTables(files, product);
  const dialogs = new Map(t.Dialog.rows.map(row => [row[0], row]));
  const controls = new Map(t.Control.rows.map(row => [`${row[0]}/${row[1]}`, row]));
  assert.deepEqual([...dialogs.keys()], ['Welcome', 'Ready', 'Progress', 'CancelConfirm', 'Exit', 'UserExit', 'FatalError', 'ErrorDlg']);
  for (const table of Object.values(t)) {
    const columns = table.columns.split(', ').map(column => column.split(' ')[0]);
    const keys = table.key.split(',').map(key => columns.indexOf(key.trim()));
    const seen = new Set();
    for (const row of table.rows) {
      assert.equal(row.length, columns.length);
      const key = JSON.stringify(keys.map(index => row[index])); assert.ok(!seen.has(key)); seen.add(key);
    }
  }
  for (const [name, row] of dialogs) for (const control of row.slice(7).filter(Boolean)) assert.ok(controls.has(`${name}/${control}`));
  for (const [name, control, , x, y, width, height, , , , next] of t.Control.rows) {
    assert.ok(dialogs.has(name)); assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
    if (next) assert.ok(controls.has(`${name}/${next}`));
    if (controls.get(`${name}/${control}`)[2] === 'PushButton' && name !== 'ErrorDlg') {
      const visited = new Set(); let cursor = control;
      do { assert.ok(!visited.has(cursor)); visited.add(cursor); cursor = controls.get(`${name}/${cursor}`)[10]; } while (cursor !== control);
    }
  }
  for (const [name, control, event, argument] of t.ControlEvent.rows) {
    assert.equal(controls.get(`${name}/${control}`)?.[2], 'PushButton');
    if (['NewDialog', 'SpawnDialog'].includes(event)) assert.ok(dialogs.has(argument));
    assert.ok(['NewDialog', 'SpawnDialog', 'EndDialog'].includes(event));
  }
  for (const [name, control] of t.EventMapping.rows) assert.ok(controls.has(`${name}/${control}`));
  assert.deepEqual(t.EventMapping.rows, [['Progress', 'Bar', 'SetProgress', 'Progress'], ['Progress', 'Status', 'ActionText', 'Text']]);
  assert.equal(dialogs.get('Progress')[5] & 2, 0);
  const progress = t.Control.rows.filter(row => row[0] === 'Progress').sort((a, b) => a[4] - b[4]);
  for (let i = 1; i < progress.length; i++) assert.ok(progress[i - 1][4] + progress[i - 1][6] <= progress[i][4]);
  assert.ok(t.ActionText.rows.every(row => row.every(value => !String(value || '').includes('['))));
  assert.ok(t.Control.rows.filter(row => row[0] === 'Progress').every(row => !/INSTALLROOT|LocalAppData|CommandLine|Secret|API_KEY/.test(row[9] || '')));
});

test('native UI confirmation, cancellation and mutually exclusive exits cannot bypass original security or execute actions', () => {
  const t = installerTables(files, product);
  const ui = new Map(t.InstallUISequence.rows.map(row => [row[0], row]));
  for (const name of ['Welcome', 'Progress', 'Exit', 'UserExit', 'FatalError']) assert.equal(ui.get(name)[1], 'UILevel = 5 AND NOT Installed');
  assert.ok(ui.get('LaunchConditions')[2] < ui.get('Welcome')[2]);
  assert.ok(ui.get('Welcome')[2] < ui.get('Progress')[2] && ui.get('Progress')[2] < ui.get('ExecuteAction')[2]);
  assert.deepEqual(t.InstallUISequence.rows.filter(row => row[2] < 0).map(row => [row[0], row[2]]), [['Exit', -1], ['UserExit', -2], ['FatalError', -3]]);
  const hasEvent = (dialog, control, event, argument) => t.ControlEvent.rows.some(row => JSON.stringify(row) === JSON.stringify([dialog, control, event, argument, '1', 1]));
  assert.ok(hasEvent('Welcome', 'Next', 'NewDialog', 'Ready'));
  assert.ok(hasEvent('Ready', 'Back', 'NewDialog', 'Welcome'));
  assert.ok(hasEvent('Ready', 'Install', 'EndDialog', 'Return'));
  for (const name of ['Welcome', 'Ready', 'Progress']) assert.ok(hasEvent(name, 'Cancel', 'SpawnDialog', 'CancelConfirm'));
  assert.ok(hasEvent('CancelConfirm', 'Yes', 'EndDialog', 'Exit'));
  assert.ok(hasEvent('CancelConfirm', 'No', 'EndDialog', 'Return'));
  assert.equal(t.Property.rows.find(row => row[0] === 'ErrorDialog')[1], 'ErrorDlg');
  const error = t.Dialog.rows.find(row => row[0] === 'ErrorDlg'); assert.ok(error[5] & 65536); assert.equal(error[7], 'ErrorText');
  for (const response of ['Abort', 'Cancel', 'Ignore', 'No', 'Ok', 'Retry', 'Yes']) {
    assert.ok(hasEvent('ErrorDlg', response, 'EndDialog', 'Error' + response));
    assert.equal(t.Control.rows.find(row => row[0] === 'ErrorDlg' && row[1] === response)[10], null);
  }
  assert.ok(!Object.hasOwn(t, 'CustomAction'));
  assert.deepEqual(t.InstallExecuteSequence.rows.map(row => row[0]), ['AppSearch', 'FindRelatedProducts', 'LaunchConditions', 'CostInitialize', 'FileCost', 'CostFinalize', 'InstallValidate', 'InstallInitialize', 'ProcessComponents', 'UnpublishFeatures', 'RemoveRegistryValues', 'RemoveShortcuts', 'RemoveFiles', 'RemoveFolders', 'InstallFiles', 'CreateShortcuts', 'WriteRegistryValues', 'RegisterUser', 'RegisterProduct', 'PublishFeatures', 'PublishProduct', 'InstallFinalize']);
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
