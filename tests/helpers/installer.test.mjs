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
test('Full UI is explicit, Hyper-V authorized, interactive and never uses silent cleanup or forced termination', async () => {
  const source = await fs.readFile('tests/helpers/sandbox_installer.ps1', 'utf8');
  const full = source.slice(source.indexOf('function Invoke-FullUiScenario'), source.indexOf('if ($FullUiScenario) { Invoke-FullUiScenario; return }'));
  assert.match(source, /ValidateSet\('CancelBeforeInstall','Install'\)/);
  for (const guard of ['FULL_UI_HYPERV_CONTEXT_REQUIRED', 'fullUiAuthorized', 'checkpointRestoreVerified', 'networkIsolated', 'syntheticData', 'UNELEVATED_INSTALLER_TEST_REQUIRED', 'HYPERV_GUEST_IDENTITY_REQUIRED', 'HANDOFF_HASH_INVALID', 'FULL_UI_MSI_HASH_INVALID', 'FULL_UI_RUN_ALREADY_EXISTS']) assert.ok(source.includes(guard));
  assert.match(full, /Assert-InstallerGuest; Assert-FullUiDesktop/);
  assert.match(full, /\/qf \/norestart \/l\*vx!/); assert.match(full, /-WindowStyle Normal/);
  assert.doesNotMatch(full, /-WindowStyle Hidden|\/qn|\/qb|ALLUSERS=1|\.Kill\(|Stop-Process|Restore-VM|Run \$|\/x /);
  for (const proof of ['UserInteractive', 'SessionId -gt 0', 'OpenInputDesktop', 'IsActiveSession', 'FULL_UI_PREVIOUS_RUN_UNRESOLVED']) assert.ok(source.includes(proof));
  for (const extra of [[], ['-HyperVContextSha256', '0'.repeat(64)]]) {
    assert.throws(() => execFileSync(process.env.PWSH_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.resolve('tests/helpers/sandbox_installer.ps1'), '-FullUiScenario', 'Install', ...extra],
      { timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), error => error.status !== 0 && /FULL_UI_HYPERV_CONTEXT_REQUIRED|INSTALLER_GUEST_PATH_REQUIRED/.test(error.stderr));
  }
});

test('Full UI signals bind scenario, run, hashes and ordered manual actions without replay', async t => {
  const base = path.resolve('tests/runs/phase3a'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'full-ui-signals-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = String.raw`
$ErrorActionPreference='Stop'
foreach($scenario in @('CancelBeforeInstall','Install')){
 $run=[guid]::NewGuid().ToString();$directory=Join-Path $env:TEST_ROOT $run;$null=New-Item -ItemType Directory -Path $directory
 $binding=@{schemaVersion=1;runId=$run;scenario=$scenario;msiSha256=('a'*64);contextSha256=('b'*64)}
 $binding|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory 'binding.json')
 $steps=if($scenario -ceq 'Install'){@('msi-welcome','msi-ready','msi-install','msi-progress','msi-exit')}else{@('msi-welcome','msi-ready','msi-cancel','msi-user-exit')}
 for($i=0;$i -lt $steps.Count;$i++){
  $phase=$steps[$i];$action=if($phase -ceq 'msi-install'){'clicked-install'}elseif($phase -ceq 'msi-cancel'){'clicked-cancel'}else{'observed'}
  $progress=$binding+@{phase=$phase;status='STARTED';stepIndex=$i};$progress|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory 'installer-progress.json')
  foreach($bad in @(@{Scenario=$scenario;RunId=$run;Action='wrong'},@{Scenario=$scenario;RunId=[guid]::NewGuid().ToString();Action=$action},@{Scenario=$(if($scenario -ceq 'Install'){'CancelBeforeInstall'}else{'Install'});RunId=$run;Action=$action})){
   $denied=$false;try{& $env:TEST_SIGNAL_HELPER -Directory $directory -Step $phase @bad}catch{$denied=$true};if(-not $denied){throw 'BAD_SIGNAL_ACCEPTED'}
  }
  if($i -eq 0){
   $progress.msiSha256='c'*64;$progress|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory 'installer-progress.json')
   $denied=$false;try{& $env:TEST_SIGNAL_HELPER -Directory $directory -Step $phase -Scenario $scenario -RunId $run -Action observed}catch{$denied=$true};if(-not $denied){throw 'HASH_CHANGE_ACCEPTED'}
   $progress.msiSha256=$binding.msiSha256
   $progress.phase=$steps[1];$progress.stepIndex=1;$progress|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory 'installer-progress.json')
   $denied=$false;try{& $env:TEST_SIGNAL_HELPER -Directory $directory -Step $steps[1] -Scenario $scenario -RunId $run -Action observed}catch{$denied=$true};if(-not $denied){throw 'OUT_OF_ORDER_ACCEPTED'}
   $progress.phase=$phase;$progress.stepIndex=$i;$progress|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory 'installer-progress.json')
  }
  & $env:TEST_SIGNAL_HELPER -Directory $directory -Step $phase -Scenario $scenario -RunId $run -Action $action
  $signal=Get-Content -LiteralPath (Join-Path $directory ($phase+'.json')) -Raw|ConvertFrom-Json
  if($signal.stepIndex -ne $i -or $signal.scenario -cne $scenario -or $signal.action -cne $action){throw 'SIGNAL_CONTENT_INVALID'}
  $denied=$false;try{& $env:TEST_SIGNAL_HELPER -Directory $directory -Step $phase -Scenario $scenario -RunId $run -Action $action}catch{$denied=$true};if(-not $denied){throw 'REPLAY_ACCEPTED'}
 }
 $progress.status='INSTALL_PASS';$progress|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $directory 'installer-progress.json')
 $denied=$false;try{& $env:TEST_SIGNAL_HELPER -Directory $directory -Step $phase -Scenario $scenario -RunId $run -Action $action}catch{$denied=$true};if(-not $denied){throw 'FINISHED_RUN_ACCEPTED'}
 if(@(Get-ChildItem -LiteralPath $directory -Filter '*.tmp').Count){throw 'ATOMIC_TEMP_REMAINS'}
}
[Console]::Out.Write('FULL_UI_SIGNALS_PASS')`;
  const output = execFileSync(process.env.PWSH_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, TEST_ROOT: root, TEST_SIGNAL_HELPER: path.resolve('tests/helpers/hyperv_ui_signal.ps1') } });
  assert.equal(output, 'FULL_UI_SIGNALS_PASS');
});

test('Full UI safe substitutes distinguish cancellation, installation and running timeout without real MSI execution', async t => {
  const base = path.resolve('tests/runs/phase3a'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'full-ui-mock-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const command = String.raw`
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile($env:TEST_INSTALLER_SOURCE,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PARSE_FAILED'}
foreach($fn in $ast.EndBlock.Statements|Where-Object {$_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -in @('Require','Assert-FullUiPath','Write-FullUiJson','Get-FullUiSnapshot','Get-FullUiOutcome','Wait-FullUiObservation','Invoke-FullUiScenario')}){Invoke-Expression $fn.Extent.Text}
foreach($case in @(@('CancelBeforeInstall',1602,-1,$false,$false,'USER_CANCELLED'),@('CancelBeforeInstall',0,5,$true,$true,'FAIL'),@('CancelBeforeInstall',1602,-1,$true,$false,'FAIL'),@('Install',0,5,$true,$true,'INSTALL_PASS'),@('Install',1603,5,$true,$false,'FAIL'),@('Install',0,-1,$true,$true,'FAIL'))){$arguments=@($case[0..4]);if((Get-FullUiOutcome @arguments) -cne $case[5]){throw 'OUTCOME_INVALID'}}
$waiter=(Get-Item -LiteralPath 'Function:\Wait-FullUiObservation').ScriptBlock
$desktopFn=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Assert-FullUiDesktop'},$true)[0]
$compile=$desktopFn.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -ceq 'Add-Type'},$true)[0]
& ([scriptblock]::Create($compile.Extent.Text))
function Assert-InstallerGuest {$script:identityCalls++}
function Assert-FullUiDesktop {$script:desktopCalls++}
function Get-CimInstance {return @()}
function Test-Path {param([string]$LiteralPath) if($LiteralPath -match '^HK[CL]'){return $false};Microsoft.PowerShell.Management\Test-Path -LiteralPath $LiteralPath}
function Read-FullUiPackage {return @{ProductName='PaperEcho TEST ONLY';ProductVersion='2.6.0';ProductCode='{11111111-1111-4111-8111-111111111111}';PackageCode='{22222222-2222-4222-8222-222222222222}';UpgradeCode='{7395EC5E-338E-4E71-92A2-579BD64EE6E4}'}}
function Get-FullUiProductState {if($script:stateReads++ -eq 0){return -1};if($FullUiScenario -ceq 'Install'){return 5};return -1}
function Wait-FullUiObservation {param($process,$directory,$binding,$steps,$index,$watch) return @{step=$steps[$index];source='OFFLINE_MOCK_ONLY'}}
function Start-Process {
 param($FilePath,$ArgumentList,$WorkingDirectory,[switch]$PassThru,$WindowStyle)
 if($script:identityCalls -lt 2 -or $script:desktopCalls -lt 2 -or $WindowStyle -cne 'Normal' -or $ArgumentList -notmatch '/qf /norestart /l\*vx!' -or $ArgumentList -match '/qn|/qb|/x |ALLUSERS' -or [IO.Path]::GetFileName($FilePath) -ine 'msiexec.exe'){throw 'UNSAFE_START'}
 $script:starts++
 $lines=@('Action start 10:00:00: Welcome.')
 if($FullUiScenario -ceq 'Install'){
  $null=New-Item -ItemType Directory -Path (Join-Path $env:LOCALAPPDATA 'Programs\PaperEcho') -Force
  [IO.File]::WriteAllText((Join-Path $env:LOCALAPPDATA 'Programs\PaperEcho\PaperEcho.exe'),'DUMMY_PAYLOAD')
  $lines+=@('Action start 10:00:00: Progress.','Action start 10:00:00: InstallInitialize.','Action ended 10:00:00: InstallFinalize. Return value 1.','Action start 10:00:00: Exit.')
 }
 $lines|Set-Content -LiteralPath (Join-Path (Split-Path -Parent $WorkingDirectory) 'msi-verbose.log')
 $p=[pscustomobject]@{Id=4242;HasExited=$false;ExitCode=$(if($FullUiScenario -ceq 'Install'){0}else{1602})}
 $p|Add-Member ScriptMethod WaitForExit {param($budget) if($script:timeout){return $false};$this.HasExited=$true;return $true}
 $p|Add-Member ScriptMethod Kill {$script:kills++;throw 'KILL_FORBIDDEN'}
 return $p
}
$HyperVContextSha256='b'*64;$script:kills=0;$script:starts=0
foreach($case in @('CancelBeforeInstall','Install','Timeout')){
 $script:timeout=$case -ceq 'Timeout';$FullUiScenario=if($script:timeout){'CancelBeforeInstall'}else{$case}
 $run=[guid]::NewGuid().ToString();$inputRoot=Join-Path $env:TEST_ROOT ('input-'+$run);$outputRoot=Join-Path $env:TEST_ROOT ('output-'+$run)
 $env:LOCALAPPDATA=Join-Path $env:TEST_ROOT ('profile-'+$run)
 $null=New-Item -ItemType Directory -Path $inputRoot,$outputRoot
 $source=Join-Path $inputRoot 'PaperEcho-TEST-ONLY.msi';[IO.File]::WriteAllText($source,'DUMMY_NOT_AN_MSI')
 $payload=Join-Path $inputRoot 'dummy-payload';[IO.File]::WriteAllText($payload,'DUMMY_PAYLOAD')
 $hash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
 $script:fullUiManifest=@{runId=$run;msiSha256=$hash;productCode='{11111111-1111-4111-8111-111111111111}';files=@(@{path='PaperEcho-TEST-ONLY.msi';sha256=$hash});payload=@(@{path='PaperEcho.exe';sha256=(Get-FileHash -LiteralPath $payload -Algorithm SHA256).Hash})}
 $script:fullUiContext=@{};$script:stateReads=0;$script:identityCalls=0;$script:desktopCalls=0
 $caught=$false;try{Invoke-FullUiScenario}catch{if(-not $script:timeout -or $_.Exception.Message -cne 'FULL_UI_INSPECTION_REQUIRED'){throw};$caught=$true}
 $directory=Join-Path $outputRoot $run;$report=Get-Content -LiteralPath (Join-Path $directory 'full-ui-result.json') -Raw|ConvertFrom-Json
 $expected=if($script:timeout){'UNKNOWN'}elseif($case -ceq 'Install'){'INSTALL_PASS'}else{'USER_CANCELLED'}
 if($report.status -cne $expected -or $report.automaticCleanupPerformed -ne $false -or $report.runId -cne $run -or $script:kills -ne 0){throw 'MOCK_REPORT_INVALID'}
 if($script:timeout -and (-not $caught -or $report.processState -cne 'RUNNING' -or $report.code -cne 'FULL_UI_TIMEOUT')){throw 'TIMEOUT_LOST'}
 if(-not $script:timeout){$denied=$false;try{Invoke-FullUiScenario}catch{$denied=$true};if(-not $denied){throw 'RUN_REUSE_ACCEPTED'}}
 if($script:timeout){
  $script:fullUiManifest.runId=[guid]::NewGuid().ToString();$denied=$false
  try{Invoke-FullUiScenario}catch{if($_.Exception.Message -cne 'FULL_UI_PREVIOUS_RUN_UNRESOLVED'){throw};$denied=$true}
  if(-not $denied){throw 'UNRESOLVED_RUN_BYPASSED'}
 }
}
$binding=@{runId=$run;scenario='CancelBeforeInstall';msiSha256=('a'*64);contextSha256=('b'*64)}
$denied=$false;try{& $waiter ([pscustomobject]@{HasExited=$false}) $directory $binding @('msi-welcome') 0 ([pscustomobject]@{Elapsed=[timespan]::FromSeconds(1201)})}catch{if($_.Exception.Message -cne 'FULL_UI_TIMEOUT'){throw};$denied=$true}
if(-not $denied -or $script:starts -ne 3 -or $script:kills -ne 0){throw 'WAIT_SIDE_EFFECT'}
[Console]::Out.Write('FULL_UI_OFFLINE_MOCK_PASS')`;
  const output = execFileSync(process.env.PWSH_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 20000, windowsHide: true,
    env: { ...process.env, TEST_ROOT: root, TEST_INSTALLER_SOURCE: path.resolve('tests/helpers/sandbox_installer.ps1') } });
  assert.equal(output, 'FULL_UI_OFFLINE_MOCK_PASS');
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
