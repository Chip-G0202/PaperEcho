# Test-only near trigger and cleanup. No host execution or production task names.
$ErrorActionPreference='Stop'
try {
  if ($PSVersionTable.PSVersion.Major -lt 7 -or $env:USERNAME -ine 'WDAGUtilityAccount' -or $env:USERPROFILE -ine 'C:\Users\WDAGUtilityAccount' -or $PSScriptRoot -ine 'C:\PaperEchoLab\Input') { throw 'SCHEDULER_SANDBOX_REQUIRED' }
  $computer=Get-CimInstance Win32_ComputerSystem
  if ($computer.Manufacturer -ine 'Microsoft Corporation' -or $computer.Model -ine 'Virtual Machine' -or (Get-Service CExecSvc).Status -ne 'Running') { throw 'SCHEDULER_SANDBOX_REQUIRED' }
  [Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
  $r=[Console]::In.ReadToEnd() | ConvertFrom-Json
  if ($r.taskId -notmatch '^PaperEcho-[a-f0-9]{24}$' -or $r.operation -notin @('near-trigger','stop-owned','inventory','observe','describe','watch-run')) { throw 'SCHEDULER_FIXTURE_ARGUMENT_INVALID' }
  $name='PaperEcho-Sandbox-Test-'+$r.taskId.Substring(10)
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $service=New-Object -ComObject Schedule.Service; $service.Connect()
  $folder=$service.GetFolder('\PaperEcho')
  if ($r.operation -eq 'inventory') {
    $count=@($folder.GetTasks(1) | Where-Object { $_.Name -eq $name }).Count
    $all=@(Get-CimInstance Win32_Process -Filter "Name='PaperEcho.exe'")
    $controller=@($all | Where-Object {$_.ProcessId -eq $r.controllerPid -and $_.CommandLine -like '*C:\PaperEchoLab\Input\scheduler-guest.mjs*'})
    if ($controller.Count -ne 1) { throw 'SCHEDULER_CONTROLLER_IDENTITY_INVALID' }
    $processes=@($all | Where-Object {$_.ProcessId -ne $r.controllerPid})
    [Console]::Out.Write((@{status='PASS';ownedTasks=$count;ownedProcesses=$processes.Count;processIds=@($processes.ProcessId);guestIdentityVerified=$true}|ConvertTo-Json -Compress)); exit 0
  }
  $task=$folder.GetTask($name)
  $user=$task.Definition.Principal.UserId
  $actualSid=if ($user -match '^S-1-') { $user } else { ([Security.Principal.NTAccount]::new($user)).Translate([Security.Principal.SecurityIdentifier]).Value }
  if ($actualSid -ne $sid -or $task.Definition.Principal.LogonType -ne 3 -or $task.Definition.Principal.RunLevel -ne 0 -or $task.Definition.RegistrationInfo.Description -cne ('PaperEcho scheduler v1 '+$r.taskId)) { throw 'SCHEDULER_TASK_OWNERSHIP_MISMATCH' }
  if ($r.operation -eq 'describe') {
    $a=$task.Definition.Actions.Item(1);$base='C:\PaperEchoLab\Scheduler Workspace\程序 & (空格)'
    $expected=Join-Path $base 'PaperEcho.exe'
    if($task.Definition.Actions.Count -ne 1 -or $a.Path -cne $expected -or $a.WorkingDirectory -cne $base -or -not [IO.File]::Exists($a.Path)){throw 'SCHEDULER_ACTION_PATH_INVALID'}
    $hash={param($v)[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($v))).ToLowerInvariant()}
    [Console]::Out.Write((@{status='PASS';guestIdentityVerified=$true;taskName=$name;actionPathMatches=$true;localExecutableExists=$true;workingDirectoryMatches=$true;argumentsSha256=(&$hash $a.Arguments);executableSha256=(Get-FileHash -LiteralPath $a.Path -Algorithm SHA256).Hash.ToLowerInvariant();xmlSha256=(&$hash $task.Xml);currentUser=$true;leastPrivilege=$true}|ConvertTo-Json -Compress));exit 0
  }
  if ($r.operation -eq 'watch-run') {
    if($r.evidenceId -notmatch '^[a-f0-9-]{36}$'){throw 'SCHEDULER_OBSERVER_ID_INVALID'}
    $start='start-'+$r.evidenceId;$stop='stop-'+$r.evidenceId;$starts=@{};$stops=@{};$result=$null
    try {
      Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStartTrace WHERE ProcessName='PaperEcho.exe'" -SourceIdentifier $start | Out-Null
      Register-CimIndicationEvent -Namespace root/cimv2 -Query "SELECT * FROM Win32_ProcessStopTrace WHERE ProcessName='PaperEcho.exe'" -SourceIdentifier $stop | Out-Null
      $ready=Join-Path 'C:\PaperEchoLab\Output' ('observer-'+$r.evidenceId+'.json')
      [IO.File]::WriteAllText(($ready+'.pending'),(@{evidenceId=$r.evidenceId;status='ready'}|ConvertTo-Json -Compress));[IO.File]::Move(($ready+'.pending'),$ready)
      $end=[DateTime]::UtcNow.AddSeconds(60)
      while([DateTime]::UtcNow -lt $end){
        foreach($identifier in @($start,$stop)){
          foreach($item in @(Get-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue)){
            $e=$item.SourceEventArgs.NewEvent;$id=[int]$e.ProcessID
            if($id -ne $r.controllerPid){
              $at=[DateTime]::FromFileTimeUtc([long]$e.TIME_CREATED).ToString('o')
              if($identifier -eq $start){
                $who=[Security.Principal.SecurityIdentifier]::new([byte[]]$e.Sid,0).Value
                $starts[$id]=@{pid=$id;parentPid=[int]$e.ParentProcessID;startedAt=$at;currentUser=($who -eq $sid)}
              }else{$stops[$id]=@{exitCode=[long]$e.ExitStatus;exitedAt=$at}}
              if($starts.Count -gt 16 -or $stops.Count -gt 16){throw 'SCHEDULER_OBSERVER_LIMIT'}
            }
            Remove-Event -EventIdentifier $item.EventIdentifier
          }
        }
        if($starts.Count -ge 2 -and @($starts.Keys|Where-Object{-not $stops.ContainsKey($_)}).Count -eq 0){
          $processes=@($starts.Keys|ForEach-Object{$entry=$starts[$_];$entry.exitCode=$stops[$_].exitCode;$entry.exitedAt=$stops[$_].exitedAt;$entry})
          $result=@{status='PASS';guestIdentityVerified=$true;evidenceId=$r.evidenceId;processes=$processes};break
        }
        Wait-Event -Timeout 1 | Out-Null
      }
      if(-not $result){throw 'SCHEDULER_PROCESS_EVIDENCE_TIMEOUT'}
    }finally{foreach($identifier in @($start,$stop)){Unregister-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue;Get-Event -SourceIdentifier $identifier -ErrorAction SilentlyContinue|Remove-Event -ErrorAction SilentlyContinue}}
    [Console]::Out.Write(($result|ConvertTo-Json -Depth 5 -Compress));exit 0
  }
  if ($r.operation -eq 'observe') {
    $all=@(Get-CimInstance Win32_Process -Filter "Name='PaperEcho.exe'" | Where-Object {$_.ProcessId -ne $r.controllerPid})
    $processes=@($all | ForEach-Object {
      $owner=Invoke-CimMethod -InputObject $_ -MethodName GetOwner
      @{pid=$_.ProcessId;parentPid=$_.ParentProcessId;startedAt=$_.CreationDate.ToUniversalTime().ToString('o');currentUser=($owner.User -ieq 'WDAGUtilityAccount');packaged=($_.ExecutablePath -ieq 'C:\PaperEchoLab\Scheduler Workspace\程序 & (空格)\PaperEcho.exe');headless=($_.CommandLine -like '*--headless*')}
    })
    $instances=@($task.GetInstances(0) | ForEach-Object {@{state=[int]$_.State;enginePid=[int]$_.EnginePID}})
    [Console]::Out.Write((@{status='PASS';guestIdentityVerified=$true;processes=$processes;instances=$instances}|ConvertTo-Json -Depth 5 -Compress)); exit 0
  }
  if ($r.operation -eq 'near-trigger') {
    $at=[DateTimeOffset]$r.at
    $delta=($at-[DateTimeOffset]::UtcNow).TotalSeconds
    $timing=@{remainingSeconds=[Math]::Round($delta,2);legacyParsedSeconds=[Math]::Round((([DateTimeOffset]::Parse($r.at))-[DateTimeOffset]::UtcNow).TotalSeconds,2);localOffsetMinutes=[DateTimeOffset]::Now.Offset.TotalMinutes}
    if ($delta -lt 10 -or $delta -gt 60 -or $task.GetInstances(0).Count -gt 0) { throw 'SCHEDULER_FIXTURE_TRIGGER_INVALID' }
    $d=$task.Definition; $d.Triggers.Clear()
    $trigger=$d.Triggers.Create(1); $trigger.StartBoundary=$at.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'"); $trigger.Enabled=$true
    $null=$folder.RegisterTaskDefinition($name,$d,4,$sid,$null,3,$null)
  } else { $task.Stop(0) }
  [Console]::Out.Write((@{status='PASS';guestIdentityVerified=$true;timing=$timing}|ConvertTo-Json -Compress))
} catch {
  $code=if ($_.Exception.Message -match '^SCHEDULER_[A-Z_]+$') {$_.Exception.Message} else {'SCHEDULER_FIXTURE_OPERATION_FAILED'}
  [Console]::Out.Write((@{status='FAIL';code=$code;hresult=$_.Exception.GetBaseException().HResult;line=$_.InvocationInfo.ScriptLineNumber}|ConvertTo-Json -Compress)); exit 1
}
