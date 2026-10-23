param([Parameter(Mandatory)][string]$Directory,[Parameter(Mandatory)][string]$Step,[string]$Action)
$ErrorActionPreference='Stop'
$root=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../runs'))
$dir=[IO.Path]::GetFullPath($Directory)
if(-not $dir.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'SIGNAL_WORKSPACE_REQUIRED'}
for($item=Get-Item -LiteralPath $dir;$item;$item=$item.Parent){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'SIGNAL_LINK_REJECTED'}}
if($Step -cnotmatch '^(negative|full)-(login-screen|password-field|desktop)$'){throw 'SIGNAL_STEP_INVALID'}
$progress=Get-Content -LiteralPath (Join-Path $dir 'installer-progress.json') -Raw|ConvertFrom-Json
if($progress.phase -cne $Step -or $progress.status -cne 'STARTED' -or $progress.runId -cnotmatch '^[a-f0-9-]{36}$'){throw 'UI_PHASE_CHANGED'}
$signal=@{schemaVersion=1;runId=$progress.runId;step=$Step}
if($Step.EndsWith('-login-screen')){if($Action -cnotin @('dismiss-lockscreen','password-ready')){throw 'SIGNAL_ACTION_REQUIRED'};$signal.action=$Action}
elseif($Action){throw 'SIGNAL_ACTION_INVALID'}
$file=Join-Path $dir ($Step+'.json');$temp=Join-Path $dir ([guid]::NewGuid().ToString()+'.tmp');$created=$false
try{
 $stream=[IO.File]::Open($temp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);$created=$true
 try{$bytes=[Text.Encoding]::UTF8.GetBytes(($signal|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 # The ready name becomes visible only after the exclusive writer has closed.
 [IO.File]::Move($temp,$file)
}finally{if($created -and (Test-Path -LiteralPath $temp)){Remove-Item -LiteralPath $temp}}
