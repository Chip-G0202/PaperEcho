param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][string]$Step,[string]$Action,
 [ValidateSet('CancelBeforeInstall','Install')][string]$Scenario,[string]$RunId,[string]$HyperVContextSha256)
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core'){throw 'PS7_REQUIRED'}
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../runs'))
$dir=[IO.Path]::GetFullPath($Directory)
if($Step.StartsWith('msi-') -and $dir -ieq ('C:\PaperEchoLab\Output\'+$RunId)){
 if($RunId -cnotmatch '^[a-f0-9-]{36}$' -or -not $Scenario -or $HyperVContextSha256 -cnotmatch '^[a-fA-F0-9]{64}$'){throw 'SIGNAL_GUEST_BINDING_REQUIRED'}
 & (Join-Path $PSScriptRoot 'installer-test.ps1') -IdentityOnly -FullUiScenario $Scenario -HyperVContextSha256 $HyperVContextSha256
} elseif(-not $dir.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'SIGNAL_WORKSPACE_REQUIRED'}
for($item=Get-Item -LiteralPath $dir;$item;$item=$item.Parent){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SIGNAL_LINK_REJECTED'}}
function Read-SignalJson([string]$file){
 $item=Get-Item -LiteralPath $file
 if($item.Length -gt 4096 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType){throw 'SIGNAL_FILE_UNSAFE'}
 return Get-Content -LiteralPath $file -Raw|ConvertFrom-Json
}
$fullUi=$Step.StartsWith('msi-')
if(-not $fullUi -and $Step -cnotmatch '^(negative|full)-(login-screen|password-field|desktop)$'){throw 'SIGNAL_STEP_INVALID'}
$publicationLock=$null
try {
if($fullUi){
 $initialBinding=Read-SignalJson (Join-Path $dir 'binding.json')
 $lockFile=Join-Path $dir 'ui-evidence.lock'
 if(Test-Path -LiteralPath $lockFile){$item=Get-Item -LiteralPath $lockFile;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType){throw 'SIGNAL_FILE_UNSAFE'}}
 $lockDeadline=if($initialBinding.signalDeadlineTick){[long]$initialBinding.signalDeadlineTick}else{[Environment]::TickCount64+5000}
 while(-not $publicationLock){
  if([Environment]::TickCount64 -ge $lockDeadline){throw 'SIGNAL_DEADLINE_EXCEEDED'}
  try{$publicationLock=[IO.File]::Open($lockFile,'OpenOrCreate','ReadWrite','None')}catch [IO.IOException]{if(($_.Exception.HResult -band 65535) -notin @(32,33)){throw};Start-Sleep -Milliseconds 10}
 }
}
$progress=Read-SignalJson (Join-Path $dir 'installer-progress.json')
if($progress.phase -cne $Step -or $progress.status -cne 'STARTED' -or $progress.runId -cnotmatch '^[a-f0-9-]{36}$'){throw 'UI_PHASE_CHANGED'}
$signal=@{schemaVersion=1;runId=$progress.runId;step=$Step}
if($fullUi){
 $steps=if($Scenario -ceq 'CancelBeforeInstall'){@('msi-welcome','msi-ready','msi-cancel','msi-user-exit')}elseif($Scenario -ceq 'Install'){@('msi-welcome','msi-ready','msi-install','msi-progress','msi-exit')}else{throw 'SIGNAL_SCENARIO_REQUIRED'}
 $index=[Array]::IndexOf($steps,$Step);$binding=Read-SignalJson (Join-Path $dir 'binding.json')
 if($index -lt 0 -or $progress.stepIndex -ne $index -or $RunId -cne $progress.runId -or $Scenario -cne $progress.scenario -or (Split-Path $dir -Leaf) -cne $RunId -or $progress.msiSha256 -cnotmatch '^[a-fA-F0-9]{64}$' -or $progress.contextSha256 -cnotmatch '^[a-fA-F0-9]{64}$'){throw 'SIGNAL_SCENARIO_INVALID'}
 foreach($record in @($binding,$progress)){if($record.runId -cne $RunId -or $record.scenario -cne $Scenario -or $record.msiSha256 -cne $progress.msiSha256 -or $record.contextSha256 -cne $progress.contextSha256){throw 'SIGNAL_BINDING_CHANGED'}}
 if($HyperVContextSha256 -and $HyperVContextSha256 -cne $progress.contextSha256){throw 'SIGNAL_BINDING_CHANGED'}
 for($i=0;$i -lt $index;$i++){
  $prior=Read-SignalJson (Join-Path $dir ($steps[$i]+'.json'))
  $priorAction=if($steps[$i] -ceq 'msi-cancel'){'clicked-cancel'}elseif($steps[$i] -ceq 'msi-install'){'clicked-install'}else{'observed'}
  if($prior.runId -cne $RunId -or $prior.scenario -cne $Scenario -or $prior.step -cne $steps[$i] -or $prior.stepIndex -ne $i -or $prior.action -cne $priorAction -or $prior.msiSha256 -cne $progress.msiSha256 -or $prior.contextSha256 -cne $progress.contextSha256){throw 'SIGNAL_ORDER_INVALID'}
 }
 $expected=if($Step -ceq 'msi-cancel'){'clicked-cancel'}elseif($Step -ceq 'msi-install'){'clicked-install'}else{'observed'}
 if($Action -cne $expected){throw 'SIGNAL_ACTION_INVALID'}
 if($binding.signalDeadlineTick -and ($progress.signalDeadlineTick -ne $binding.signalDeadlineTick -or [Environment]::TickCount64 -ge $binding.signalDeadlineTick)){throw 'SIGNAL_DEADLINE_EXCEEDED'}
 $signal.scenario=$Scenario;$signal.stepIndex=$index;$signal.msiSha256=$progress.msiSha256;$signal.contextSha256=$progress.contextSha256;$signal.action=$Action
} elseif($Scenario -or $RunId -or $HyperVContextSha256){throw 'SIGNAL_SCENARIO_INVALID'}
elseif($Step.EndsWith('-login-screen')){if($Action -cnotin @('dismiss-lockscreen','password-ready')){throw 'SIGNAL_ACTION_REQUIRED'};$signal.action=$Action}
elseif($Action){throw 'SIGNAL_ACTION_INVALID'}
$file=Join-Path $dir ($Step+'.json');$temp=Join-Path $dir ([guid]::NewGuid().ToString()+'.tmp');$created=$false
try{
 if($fullUi -and $binding.signalDeadlineTick){$signal.publishedTick=[Environment]::TickCount64}
 $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$created=$true
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($signal|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 # The ready name becomes visible only after the exclusive writer has closed.
 if($fullUi -and $binding.signalDeadlineTick -and [Environment]::TickCount64 -ge $binding.signalDeadlineTick){throw 'SIGNAL_DEADLINE_EXCEEDED'}
 [IO.File]::Move($temp,$file)
}finally{if($created -and (Test-Path -LiteralPath $temp)){Remove-Item -LiteralPath $temp}}

}finally{if($publicationLock){$publicationLock.Dispose()}}
