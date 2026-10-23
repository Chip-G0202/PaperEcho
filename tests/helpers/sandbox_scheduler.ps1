# Guest-only launcher. Host executes no Task Scheduler mutation.
$ErrorActionPreference='Stop'
$inputRoot='C:\PaperEchoLab\Input'; $outputRoot='C:\PaperEchoLab\Output'; $work='C:\PaperEchoLab\Scheduler Workspace'
$identity=$false; $pidOwned=$null; $handoff=$null
function Publish($name,$value) {
  $pending=Join-Path $outputRoot ($name+'.pending')
  [IO.File]::WriteAllText($pending,($value|ConvertTo-Json -Depth 5 -Compress))
  [IO.File]::Move($pending,(Join-Path $outputRoot $name),$true)
}
try {
  if ($PSVersionTable.PSVersion.Major -lt 7 -or $env:USERNAME -ine 'WDAGUtilityAccount' -or $env:USERPROFILE -ine 'C:\Users\WDAGUtilityAccount' -or $PSScriptRoot -ine $inputRoot) { throw 'SCHEDULER_SANDBOX_REQUIRED' }
  $computer=Get-CimInstance Win32_ComputerSystem
  if ($computer.Manufacturer -ine 'Microsoft Corporation' -or $computer.Model -ine 'Virtual Machine' -or (Get-Service CExecSvc).Status -ne 'Running') { throw 'SCHEDULER_SANDBOX_REQUIRED' }
  $identity=$true
  if ((Get-Service Schedule).Status -ne 'Running') { throw 'SCHEDULER_SERVICE_NOT_RUNNING' }
  if (Test-Path -LiteralPath $work) { throw 'SCHEDULER_FRESH_GUEST_REQUIRED' }
  if (@(Get-ChildItem -LiteralPath $outputRoot -Force | Where-Object {$_.Name -ne 'session-ready.json'}).Count) { throw 'SCHEDULER_FRESH_OUTPUT_REQUIRED' }
  $handoff=Get-Content -LiteralPath (Join-Path $inputRoot 'handoff.json') -Raw | ConvertFrom-Json
  if ($handoff.schemaVersion -ne 1 -or $handoff.runId -notmatch '^[a-f0-9-]{36}$' -or $handoff.files.Count -gt 20000) { throw 'SCHEDULER_HANDOFF_INVALID' }
  Publish 'progress.json' @{schemaVersion=1;runId=$handoff.runId;status='started';phase='input-verification';guestIdentityVerified=$identity}
  $total=0
  foreach ($file in $handoff.files) {
    if ($file.name -match '(^|/)\.\.?(/|$)|[\\:\x00-\x1f]' -or $file.name.StartsWith('/') -or $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'SCHEDULER_INPUT_PATH_INVALID' }
    $full=[IO.Path]::GetFullPath((Join-Path $inputRoot $file.name))
    if (-not $full.StartsWith($inputRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'SCHEDULER_INPUT_PATH_INVALID' }
    $stat=Get-Item -LiteralPath $full
    if ($stat.PSIsContainer -or ($stat.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $stat.Length -ne $file.size -or (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ine $file.sha256) { throw 'SCHEDULER_INPUT_HASH_MISMATCH' }
    $total+=$stat.Length
    if ($total -gt 2147483648) { throw 'SCHEDULER_INPUT_LIMIT' }
  }
  New-Item -ItemType Directory -Path $work | Out-Null
  $app=Join-Path $work '程序 & (空格)'
  Copy-Item -LiteralPath (Join-Path $inputRoot 'Runtime') -Destination $app -Recurse
  foreach ($file in $handoff.files | Where-Object {$_.name.StartsWith('Runtime/')}) {
    $full=Join-Path $app $file.name.Substring(8)
    if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ine $file.sha256) { throw 'SCHEDULER_LOCAL_RUNTIME_HASH_MISMATCH' }
  }
  Publish 'progress.json' @{schemaVersion=1;runId=$handoff.runId;status='started';phase='guest-tests';guestIdentityVerified=$identity}
  $env:PATH=''; $env:PAPERECHO_SKIP_DOTENV='1'; $env:ELECTRON_RUN_AS_NODE='1'
  $env:PWSH_PATH=Join-Path $inputRoot 'tools\pwsh\pwsh.exe'
  $env:TEMP=Join-Path $work 'tmp'; $env:TMP=$env:TEMP
  New-Item -ItemType Directory -Path $env:TEMP | Out-Null
  $exe=Join-Path $app 'PaperEcho.exe'
  $child=Start-Process -FilePath $exe -ArgumentList '"C:\PaperEchoLab\Input\scheduler-guest.mjs"' -WorkingDirectory $work -PassThru -WindowStyle Hidden
  $pidOwned=$child.Id
  if (-not $child.WaitForExit(600000)) { $child.Kill($true); $child.WaitForExit(); throw 'SCHEDULER_GUEST_TIMEOUT' }
  $child.WaitForExit()
  Publish 'launcher-result.json' @{schemaVersion=1;status=$(if($child.ExitCode -eq 0){'completed'}else{'failed'});guestIdentityVerified=$identity;inputHashesVerified=$true;localCopyVerified=$true;exitCode=$child.ExitCode;childExited=$child.HasExited;runId=$handoff.runId}
} catch {
  $code=if ($_.Exception.Message -match '^SCHEDULER_[A-Z_]+$') {$_.Exception.Message} else {'SCHEDULER_GUEST_LAUNCH_FAILED'}
  Publish 'launcher-result.json' @{schemaVersion=1;runId=$handoff.runId;guestIdentityVerified=$identity;status='failed';code=$code;line=$_.InvocationInfo.ScriptLineNumber;hresult=$_.Exception.GetBaseException().HResult}
}


Publish 'completed.json' @{schemaVersion=1;runId=$handoff.runId;status=$(if($child -and $child.HasExited -and $child.ExitCode -eq 0){'completed'}else{'failed'});guestIdentityVerified=$identity}
