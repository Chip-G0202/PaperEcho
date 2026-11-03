#Requires -Version 7.0
#Requires -PSEdition Core
param([Parameter(Mandatory)][guid]$RunId,[Parameter(Mandatory)][guid]$ExpectedBiosGuid)
# Read-only local probe. No remote endpoint, profile, credential or system-setting changes.
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
try{
 if($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -cne 'Core'){throw 'POWERSHELL_7_CORE_REQUIRED'}
 $exe=(Get-Process -Id $PID).Path
 if([IO.Path]::GetFileName($exe) -ine 'pwsh.exe'){throw 'PWSH_PROCESS_REQUIRED'}
 if([guid](Get-CimInstance Win32_ComputerSystemProduct).UUID -ne $ExpectedBiosGuid){throw 'PROBE_IDENTITY_MISMATCH'}
 $compat=@(Get-PSSession|Where-Object Name -Like '*WinPSCompat*').Count
 if($compat){throw 'COMPAT_SESSION_FORBIDDEN'}
 @{schemaVersion=1;runId=[string]$RunId;status='PASS';version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;exe=$exe;identityVerified=$true;compatSessions=$compat;probeSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()}|ConvertTo-Json -Compress
}catch{
 $code=if($_.Exception.Message -cmatch '^[A-Z][A-Z0-9_]+$'){$_.Exception.Message}else{'PS7_LOCAL_PROBE_FAILED'}
 @{schemaVersion=1;runId=[string]$RunId;status='FAIL';errorCode=$code}|ConvertTo-Json -Compress
 exit 1
}
