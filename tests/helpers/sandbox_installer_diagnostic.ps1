# Read-only diagnosis of the one failed guest fixture; never installs or changes services.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'POWERSHELL_7_REQUIRED' }
if ($env:USERNAME -ine 'WDAGUtilityAccount' -or $env:USERPROFILE -ine 'C:\Users\WDAGUtilityAccount' -or $PSScriptRoot -ine 'C:\PaperEchoLab\Input') { throw 'SANDBOX_IDENTITY_REQUIRED' }
$computer = Get-CimInstance Win32_ComputerSystem
if ($computer.Manufacturer -ine 'Microsoft Corporation' -or $computer.Model -ine 'Virtual Machine' -or (Get-Service CExecSvc).Status -ne 'Running') { throw 'SANDBOX_IDENTITY_REQUIRED' }
$work = 'C:\PaperEchoLab\Workspace'
$processes = @(Get-CimInstance Win32_Process -Filter "Name='msiexec.exe' OR Name='consent.exe'" | ForEach-Object {
    @{ name = $_.Name; pid = $_.ProcessId; parent = $_.ParentProcessId; session = $_.SessionId;
       commandClass = $(if ($_.Name -ieq 'consent.exe') { 'consent' } elseif ($_.CommandLine -match '(?i)(?:^|\s)/V(?:\s|$)') { 'service' } elseif ($_.CommandLine -match '(?i)(?:^|\s)/i(?:\s|$)') { 'install-client' } else { 'other' }) }
})
$service = Get-CimInstance Win32_Service -Filter "Name='msiserver'"
$logs = @()
foreach ($file in @(Get-ChildItem -LiteralPath $work -Filter '*.out.msi' -File | Select-Object -First 6)) {
    if ($file.Length -gt 262144 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $lines = @(Get-Content -LiteralPath $file.FullName -TotalCount 60) + @(Get-Content -LiteralPath $file.FullName -Tail 12)
    $tail = [string]::Join("`n", $lines)
    $messages = @()
    $timings = @()
    foreach ($line in $lines) {
        if ($line -match '^MSI \([cs]\).*?\[(\d{2}:\d{2}:\d{2}:\d{3})\]: (.+)$') {
            $at = $Matches[1]; $native = $Matches[2]
            $phase = if ($native -match 'SOFTWARE RESTRICTION POLICY: Verifying package') { 'VERIFY_PACKAGE' }
                elseif ($native -match 'SOFTWARE RESTRICTION POLICY:.*not digitally signed') { 'UNSIGNED_PACKAGE' }
                elseif ($native -match 'SOFTWARE RESTRICTION POLICY:.*has a digital signature') { 'SIGNED_PACKAGE' }
                elseif ($native -match 'SOFTWARE RESTRICTION POLICY:.*permitted to run') { 'POLICY_PERMITTED' }
                elseif ($native -match 'Grabbed execution mutex') { 'EXECUTION_MUTEX' }
                elseif ($native -match 'SRSetRestorePoint skipped') { 'RESTORE_POINT_SKIPPED' }
                else { 'ENGINE' }
            $timings += @{ at=$at; phase=$phase }
        }
        if ($line -notmatch '^MSI \([cs]\).*?: (.+)$') { continue }
        $message = $Matches[1]
        if ($message -match '(?i)PROPERTY CHANGE|Command ?Line|USERNAME|USERPROFILE|UserSID|Property\(') { continue }
        $message = $message.Replace($env:USERPROFILE, '<GUEST_PROFILE>')
        $message = [regex]::Replace($message, '(?:[A-Za-z]:\\|\\\\)[^\r\n]*', '<PATH>')
        $message = [regex]::Replace($message, '\{[A-Fa-f0-9-]{36}\}|S-1-[0-9-]+', '<ID>')
        $message = [regex]::Replace($message, 'https?://\S+|[\w.+-]+@[\w.-]+', '<ADDRESS>')
        $messages += $message.Substring(0, [Math]::Min(220, $message.Length))
    }
    $logs += @{ bytes = $file.Length;
        errorCodes = @([regex]::Matches($tail, 'Error\s+(\d{3,5})') | ForEach-Object { [int]$_.Groups[1].Value } | Select-Object -Unique -First 8);
        actions = @([regex]::Matches($tail, 'Action (?:start|ended) [0-9:]+: ([A-Za-z0-9_]+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique -Last 8);
        returns = @([regex]::Matches($tail, 'Return value (\d+)') | ForEach-Object { [int]$_.Groups[1].Value } | Select-Object -Last 6);
        engineMessages = @($messages | Select-Object -First 60); timings=$timings }
}
$events = @()
try { $events = @(Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='MsiInstaller';StartTime=(Get-Date).AddMinutes(-30)} -MaxEvents 8 -ErrorAction Stop | ForEach-Object { @{ id=$_.Id;level=$_.Level } }) } catch {}
$policyState = 'UNKNOWN'
try { $value = Get-ItemPropertyValue -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name 'VerifiedAndReputablePolicyState'; if ($value -in @(0,1,2)) { $policyState = [string]$value } } catch {}
$report = @{schemaVersion=1;stage='SANDBOX_INSTALLER_DIAGNOSTIC';guestIdentityVerified=$true;readOnly=$true;processes=$processes;securityPolicyState=$policyState;
    installerService=@{state=$service.State;startMode=$service.StartMode;pid=$service.ProcessId};logs=$logs;events=$events}
$file = 'C:\PaperEchoLab\Output\installer-diagnostic-timing.json'
$stream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $bytes=[Text.Encoding]::UTF8.GetBytes(($report|ConvertTo-Json -Depth 8 -Compress));$stream.Write($bytes,0,$bytes.Length) } finally { $stream.Dispose() }
