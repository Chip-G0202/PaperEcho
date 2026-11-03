param([switch]$NegativeOnly, [switch]$IdentityOnly, [string]$HyperVContextSha256,
    [ValidateSet('CancelBeforeInstall','Install')][string]$FullUiScenario, [switch]$ProfileIsolated)
# Guest only. Fixed paths, immutable input, no commands or code from the output mapping.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'POWERSHELL_7_REQUIRED' }
if ($FullUiScenario -and ($NegativeOnly -or $HyperVContextSha256 -cnotmatch '^[a-fA-F0-9]{64}$')) { throw 'FULL_UI_HYPERV_CONTEXT_REQUIRED' }
$inputRoot = 'C:\PaperEchoLab\Input'; $outputRoot = 'C:\PaperEchoLab\Output'
if ($ProfileIsolated) {
    if (-not $FullUiScenario -or $NegativeOnly -or $HyperVContextSha256 -cnotmatch '^[a-fA-F0-9]{64}$') { throw 'PROFILE_FULL_UI_CONTEXT_REQUIRED' }
    $profileRunId = Split-Path (Split-Path $PSScriptRoot -Parent) -Leaf
    if ($profileRunId -cnotmatch '^[a-f0-9-]{36}$') { throw 'PROFILE_RUN_PATH_REQUIRED' }
    $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
    if (-not $localAppData -or [IO.Path]::GetFullPath($env:LOCALAPPDATA) -ine [IO.Path]::GetFullPath($localAppData)) { throw 'PROFILE_ROOT_UNVERIFIED' }
    $profileRoot = Join-Path $localAppData 'PaperEchoFullUiTests'
    $inputRoot = Join-Path $profileRoot ($profileRunId+'\Input')
    $outputRoot = Join-Path $profileRoot 'Output'
}
$work = 'C:\PaperEchoLab\Workspace'; $steps = [Collections.Generic.List[object]]::new()
$stage = 'identity'; $ownedPids = [Collections.Generic.List[int]]::new(); $identityVerified = $false
$runTrace = [Collections.Generic.List[object]]::new()
$reportStage = 'SANDBOX_INSTALLER'
function Get-FullUiProfileIdentity {
    try {
        $who=[Security.Principal.WindowsIdentity]::GetCurrent()
        $account=Get-LocalUser -SID $who.User -ErrorAction Stop
        $vmId=Get-ItemPropertyValue -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Virtual Machine\Guest\Parameters' -Name VirtualMachineId -ErrorAction Stop
        return @{sid=$who.User.Value;vmId=$vmId;localStandard=($account.PrincipalSource.ToString() -ceq 'Local' -and -not ($who.Groups.Value -contains 'S-1-5-32-544'));localAppData=[Environment]::GetFolderPath('LocalApplicationData')}
    } catch { throw 'PROFILE_IDENTITY_UNVERIFIED' }
}
function Assert-FullUiProfileAuthorization($context, [string]$runId) {
    if ($context.testScope -cne 'PROFILE_ISOLATED_TEST_ONLY' -or $context.runId -cne $runId -or
        $context.profileBaselineVerified -ne $true -or $context.personalProfilesExcluded -ne $true -or
        $context.profileSyntheticData -ne $true -or $context.noSnapshotAuthorized -ne $true -or
        $context.noAutomaticRecovery -ne $true -or $context.checkpointId -or
        $context.checkpointRestoreVerified -isnot [bool] -or $context.checkpointRestoreVerified) { throw 'PROFILE_AUTHORIZATION_REQUIRED' }
    $identity=Get-FullUiProfileIdentity
    if (-not $identity.localStandard -or $identity.sid -cne $context.userSid) { throw 'LOCAL_STANDARD_PROFILE_REQUIRED' }
    if ($identity.vmId -notmatch '^[{]?[a-fA-F0-9-]{36}[}]?$' -or [guid]$identity.vmId -ne [guid]$context.vmId) { throw 'PROFILE_VM_ID_UNVERIFIED' }
    if (-not $identity.localAppData) { throw 'PROFILE_ROOT_UNVERIFIED' }
    $root=Join-Path $identity.localAppData 'PaperEchoFullUiTests'
    if ($inputRoot -ine (Join-Path $root ($runId+'\Input')) -or $outputRoot -ine (Join-Path $root 'Output')) { throw 'PROFILE_ROOT_UNVERIFIED' }
    foreach ($dir in @($inputRoot,$outputRoot)) {
        for ($item=Get-Item -LiteralPath $dir; $item; $item=$item.Parent) {
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.LinkType) { throw 'PROFILE_DIRECTORY_LINK_REJECTED' }
        }
        $acl=Get-Acl -LiteralPath $dir -ErrorAction Stop
        $trusted=@($identity.sid,'S-1-5-18','S-1-5-32-544')
        if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $trusted) { throw 'PROFILE_DIRECTORY_OWNER_UNVERIFIED' }
        $rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
        if (-not $rules.Count) { throw 'PROFILE_DIRECTORY_ACL_UNVERIFIED' }
        foreach ($rule in $rules) {
            if ($rule.AccessControlType.ToString() -ceq 'Allow' -and ([int]$rule.FileSystemRights -band (2 -bor 4 -bor 16 -bor 64 -bor 256 -bor 65536 -bor 262144 -bor 524288)) -ne 0 -and $rule.IdentityReference.Value -notin ($trusted+@('S-1-3-0'))) { throw 'PROFILE_DIRECTORY_SHARED_WRITE_REJECTED' }
        }
    }
}
function Assert-InstallerGuest {
    if ($PSScriptRoot -ine $inputRoot) { throw 'INSTALLER_GUEST_PATH_REQUIRED' }
    $computer = Get-CimInstance Win32_ComputerSystem
    if ($computer.Manufacturer -ine 'Microsoft Corporation' -or $computer.Model -ine 'Virtual Machine') { throw 'INSTALLER_VM_IDENTITY_REQUIRED' }
    if ($HyperVContextSha256) {
        if ($HyperVContextSha256 -cnotmatch '^[A-Fa-f0-9]{64}$') { throw 'HYPERV_CONTEXT_INVALID' }
        $file = Join-Path $inputRoot 'guest-context.json'
        $info = Get-Item -LiteralPath $file
        if ($info.Length -gt 8192 -or ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $HyperVContextSha256) { throw 'HYPERV_CONTEXT_INVALID' }
        $context = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
        $manifestFile = Join-Path $inputRoot 'test-manifest.json'
        if ($context.schemaVersion -ne 1 -or $context.kind -cne 'HYPERV_INSTALLER' -or $context.vmId -notmatch '^[a-f0-9-]{36}$' -or (-not $ProfileIsolated -and $context.checkpointId -notmatch '^[a-f0-9-]{36}$') -or (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash -ine $context.manifestSha256) { throw 'HYPERV_CONTEXT_INVALID' }
        $handoff = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
        if ($handoff.testOnly -ne $true -or $context.runId -cne $handoff.runId -or $context.msiSha256 -ine $handoff.msiSha256) { throw 'HYPERV_HANDOFF_INVALID' }
        if ([guid](Get-CimInstance Win32_ComputerSystemProduct).UUID -ne [guid]$context.biosGuid -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $context.userSid) { throw 'HYPERV_GUEST_IDENTITY_REQUIRED' }
        if (([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'UNELEVATED_INSTALLER_TEST_REQUIRED' }
        if ($FullUiScenario) {
            if ($context.fullUiAuthorized -ne $true -or $context.fullUiScenario -cne $FullUiScenario -or $context.networkIsolated -ne $true -or $handoff.runId -cnotmatch '^[a-f0-9-]{36}$') { throw 'FULL_UI_AUTHORIZATION_REQUIRED' }
            if ($ProfileIsolated) {
                Assert-FullUiProfileAuthorization $context $profileRunId
            } elseif ($context.syntheticData -ne $true -or $context.checkpointRestoreVerified -ne $true -or $context.testScope -eq 'PROFILE_ISOLATED_TEST_ONLY') { throw 'FULL_UI_AUTHORIZATION_REQUIRED' }
            $script:fullUiContext = $context; $script:fullUiManifest = $handoff
        }
        $script:reportStage = 'HYPERV_INSTALLER'
        $script:work = Join-Path $outputRoot 'Workspace'
        $env:PAPERECHO_TEST_HYPERV_CONTEXT_SHA256 = $HyperVContextSha256
    } elseif ($env:USERNAME -ine 'WDAGUtilityAccount' -or $env:USERPROFILE -ine 'C:\Users\WDAGUtilityAccount' -or (Get-Service CExecSvc).Status -ne 'Running') { throw 'SANDBOX_IDENTITY_REQUIRED' }
    if (-not (Test-Path -LiteralPath $inputRoot -PathType Container) -or -not (Test-Path -LiteralPath $outputRoot -PathType Container)) { throw 'SANDBOX_MAPPING_REQUIRED' }
    foreach ($dir in @($inputRoot, $outputRoot)) { if (((Get-Item -LiteralPath $dir).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'GUEST_DIRECTORY_LINK_REJECTED' } }
}
# A host-safe identity probe: this branch can never reach any install command.
if ($IdentityOnly) { Assert-InstallerGuest; return }
function Require([bool]$condition, [string]$code) { if (-not $condition) { throw $code } }
function Require-Exited([int]$processId) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process) { Require ($process.WaitForExit(5000)) 'CHILD_PROCESS_REMAINS' }
}
function Read-MsiTrace([string]$file) {
    if (-not $file -or -not (Test-Path -LiteralPath $file)) { return @{ bytes = 0; actions = @(); phases = @(); errorCodes = @(); scopeRejected = $false } }
    $tail = [string]::Join("`n", @(Get-Content -LiteralPath $file -Tail 120))
    $phases = @()
    foreach ($pair in @(@('CLIENT','MSI (c)'),@('SERVER','MSI (s)'),@('WINVERIFYTRUST','WinVerifyTrust'),@('APPCOMPAT','APPCOMPAT'),@('ELEVATION','MSI_LUA'),@('SERVER_SWITCH','Switching to server'))) {
        if ($tail.Contains($pair[1])) { $phases += $pair[0] }
    }
    return @{ bytes = (Get-Item -LiteralPath $file).Length; phases = $phases;
        actions = @([regex]::Matches($tail, '(?:Doing action: |Action start [0-9:]+: )([A-Za-z0-9_]+)') | ForEach-Object { $_.Groups[1].Value } | Select-Object -Unique -Last 8);
        errorCodes = @([regex]::Matches($tail, '(?:Error|error)\s+(\d{3,5})') | ForEach-Object { [int]$_.Groups[1].Value } | Select-Object -Unique -First 8);
        scopeRejected = $tail.Contains('PaperEcho supports current-user installation only.') }
}
function Run([string]$file, [string]$arguments, [int]$timeoutSeconds = 120) {
    Assert-InstallerGuest
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $out = Join-Path $work ([guid]::NewGuid().ToString('N') + '.out')
    $err = Join-Path $work ([guid]::NewGuid().ToString('N') + '.err')
    $msiLog = $null
    if ([IO.Path]::GetFileName($file) -ieq 'msiexec.exe') { $msiLog = $out + '.msi'; $arguments += ' /l*vx! "' + $msiLog + '"' }
    $process = Start-Process -FilePath $file -ArgumentList $arguments -WorkingDirectory $work -RedirectStandardOutput $out -RedirectStandardError $err -PassThru -WindowStyle Hidden
    $ownedPids.Add($process.Id)
    $trace = @{ kind = $(if ($msiLog) { 'msiexec' } else { 'application' }); pid = $process.Id; quiet = $arguments.Contains('/qn'); noRestart = $arguments.Contains('/norestart'); machineRequested = $arguments.Contains('ALLUSERS=1'); source = 'guest-local' }
    $runTrace.Add($trace)
    if (-not $process.WaitForExit([Math]::Max(1, $timeoutSeconds * 1000 - [int]$watch.ElapsedMilliseconds))) {
        $trace.elapsedMs = $watch.ElapsedMilliseconds; $trace.timedOut = $true
        $trace.hasExited = $process.HasExited
        $trace.processes = @(Get-CimInstance Win32_Process -Filter "Name='msiexec.exe' OR Name='consent.exe'" | Select-Object -First 12 | ForEach-Object {
            @{ pid = $_.ProcessId; parent = $_.ParentProcessId; session = $_.SessionId; kind = $(if ($_.Name -ieq 'consent.exe') { 'consent' } elseif ($_.ProcessId -eq $process.Id) { 'owned-client' } elseif ($_.CommandLine -match '(?i)(?:^|\s)/V(?:\s|$)') { 'service' } else { 'other-msiexec' }) }
        })
        $waits = @{}
        try { foreach ($thread in $process.Threads) { $reason = $thread.ThreadState.ToString(); if ($reason -eq 'Wait') { $reason += ':' + $thread.WaitReason.ToString() }; if (-not $waits.ContainsKey($reason)) { $waits[$reason] = 0 }; $waits[$reason]++ } } catch { $waits = @{ unavailable = $true } }
        $trace.threadStates = $waits
        $script:installerServiceAtTimeout = (Get-Service msiserver).Status.ToString()
        $trace.msi = Read-MsiTrace $msiLog
        $process.Kill($true); $process.WaitForExit()
        if ($msiLog -and (Test-Path -LiteralPath $msiLog)) {
            $tail = [string]::Join("`n", @(Get-Content -LiteralPath $msiLog -Tail 100))
            $actions = @([regex]::Matches($tail, '(?:Doing action: |Action start [0-9:]+: )([A-Za-z0-9_]+)') | ForEach-Object { $_.Groups[1].Value })
            $script:lastMsiAction = if ($actions.Count) { $actions[-1] } else { 'NONE_RECORDED' }
        }
        throw 'GUEST_CHILD_TIMEOUT'
    }
    $process.WaitForExit()
    $trace.elapsedMs = $watch.ElapsedMilliseconds; $trace.exitCode = $process.ExitCode
    $trace.msi = Read-MsiTrace $msiLog
    $script:lastMsiScopeRejected = $trace.msi.scopeRejected
    $script:lastChildExit = $process.ExitCode
    $script:lastChildCodes = @([regex]::Matches([IO.File]::ReadAllText($err), 'ERR_[A-Z_]+|0x[0-9A-Fa-f]{8}|PAPERECHO_[A-Z_]+') | ForEach-Object Value | Select-Object -Unique -First 6)
    $script:lastMsiCodes = @()
    if ($msiLog -and (Test-Path -LiteralPath $msiLog)) { $script:lastMsiCodes = @([regex]::Matches([IO.File]::ReadAllText($msiLog), 'Error\s+(\d{3,5})') | ForEach-Object { [int]$_.Groups[1].Value } | Select-Object -Unique -First 6) }
    return @{ code = $process.ExitCode; text = (Get-Content -LiteralPath $out -Raw) }
}
function Data-Snapshot {
    $result = Run $exe ('"' + $inputRoot + '\installer-check.mjs" snapshot')
    Require ($result.code -eq 0) 'DATA_SNAPSHOT_FAILED'
    $snapshot = $result.text | ConvertFrom-Json
    Require ($snapshot.secretAclVerified -eq $true) 'SECRET_ACL_NOT_VERIFIED'
    return $snapshot.digest
}
function Assert-FullUiPath([string]$path) {
    $item = Get-Item -LiteralPath $path
    while ($item) {
        Require (-not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not $item.LinkType) 'FULL_UI_LINK_REJECTED'
        $item = if ($item.PSIsContainer) { $item.Parent } else { $item.Directory }
    }
}
function Assert-FullUiDesktop {
    Require ([Environment]::UserInteractive -and (Get-Process -Id $PID).SessionId -gt 0) 'INTERACTIVE_DESKTOP_REQUIRED'
    if (-not ('PaperEchoInstallerDesktop' -as [type])) {
        Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class PaperEchoInstallerDesktop { [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint a); [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h); [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetUserObjectInformation(IntPtr h, int n, StringBuilder b, uint l, out uint needed); [DllImport("wtsapi32.dll", CharSet=CharSet.Unicode)] private static extern bool WTSQuerySessionInformation(IntPtr s, int id, int c, out IntPtr b, out uint n); [DllImport("wtsapi32.dll")] private static extern void WTSFreeMemory(IntPtr b); public static bool IsActiveSession(int id) { IntPtr b; uint n; if(!WTSQuerySessionInformation(IntPtr.Zero,id,8,out b,out n)) return false; try { return n>=4 && Marshal.ReadInt32(b)==0; } finally { WTSFreeMemory(b); } } }'
    }
    # Only query this process's session: WTSConnectState=8, WTSActive=0.
    Require ([PaperEchoInstallerDesktop]::IsActiveSession((Get-Process -Id $PID).SessionId)) 'ACTIVE_USER_SESSION_REQUIRED'
    $desktop = [PaperEchoInstallerDesktop]::OpenInputDesktop(0, $false, 1)
    Require ($desktop -ne [IntPtr]::Zero) 'INTERACTIVE_DESKTOP_REQUIRED'
    try {
        $name = [Text.StringBuilder]::new(256); [uint32]$needed = 0
        Require ([PaperEchoInstallerDesktop]::GetUserObjectInformation($desktop, 2, $name, 512, [ref]$needed) -and $name.ToString() -ceq 'Default') 'VISIBLE_DEFAULT_DESKTOP_REQUIRED'
    } finally { $null = [PaperEchoInstallerDesktop]::CloseDesktop($desktop) }
}
function Write-FullUiJson([string]$path, $value, [switch]$Replace) {
    Assert-FullUiPath (Split-Path -Parent $path)
    if (Test-Path -LiteralPath $path) { Assert-FullUiPath $path; Require ($Replace.IsPresent) 'FULL_UI_REPORT_EXISTS' }
    $temporary = Join-Path (Split-Path -Parent $path) ([guid]::NewGuid().ToString()+'.tmp')
    $stream = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
    try { $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 10 -Compress)); $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temporary, $path, $Replace.IsPresent)
}
function Get-FullUiSnapshot([string]$root) {
    if (-not (Test-Path -LiteralPath $root)) { return 'ABSENT' }
    Assert-FullUiPath $root
    $files = [Collections.Generic.List[string]]::new(); $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            Assert-FullUiPath $item.FullName
            if ($item.PSIsContainer) { $pending.Push($item.FullName) } else {
                Require ($files.Count -lt 10000) 'SYNTHETIC_DATA_LIMIT'
                $files.Add($item.FullName.Substring($root.Length)+'|'+(Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash+'|'+(Get-Acl -LiteralPath $item.FullName).Sddl)
            }
        }
    }
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes(($files.ToArray() | Sort-Object) -join "`n")))
}
function Read-FullUiPackage([string]$msi) {
    $engine = New-Object -ComObject WindowsInstaller.Installer; $db = $engine.OpenDatabase($msi, 0); $identity = @{}
    try {
        foreach ($property in @('ProductName','ProductCode','ProductVersion','UpgradeCode')) {
            $view = $db.OpenView(('SELECT `Value` FROM `Property` WHERE `Property` = ''{0}''' -f $property)); $view.Execute()
            try { $identity[$property] = $view.Fetch().StringData(1) } finally { $view.Close() }
        }
        $identity.PackageCode = $db.SummaryInformation(0).Property(9)
        return $identity
    } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($db) | Out-Null; [Runtime.InteropServices.Marshal]::FinalReleaseComObject($engine) | Out-Null }
}
function Get-FullUiProductState([string]$product) {
    $engine = New-Object -ComObject WindowsInstaller.Installer
    try { return $engine.ProductState($product) } finally { [Runtime.InteropServices.Marshal]::FinalReleaseComObject($engine) | Out-Null }
}
function Enter-FullUiEvidenceLock([string]$directory, [long]$deadline) {
    $path = Join-Path $directory 'ui-evidence.lock'
    Assert-FullUiPath $directory
    if (Test-Path -LiteralPath $path) { Assert-FullUiPath $path }
    do {
        try { return [IO.File]::Open($path, 'OpenOrCreate', 'ReadWrite', 'None') }
        catch [IO.IOException] {
            if (($_.Exception.HResult -band 65535) -notin @(32,33)) { throw }
            $remaining=$deadline-[Environment]::TickCount64
            if ($remaining -le 0) { throw 'FULL_UI_TIMEOUT' }
            Start-Sleep -Milliseconds ([int][Math]::Min(10,$remaining))
        }
    } while ([Environment]::TickCount64 -lt $deadline)
    throw 'FULL_UI_TIMEOUT'
}
function Get-FullUiExitEvidence($process, [long]$deadline) {
    $evidence = @{status='EXIT_CODE_UNVERIFIED';exitCode=$null}
    try {
        $remaining = $deadline-[Environment]::TickCount64
        if ($remaining -lt 0) { $remaining=0 } elseif ($remaining -gt 120000) { $remaining=120000 }
        if ($process.HasExited -or $process.WaitForExit([int]$remaining)) {
            $evidence.status='EXIT_CODE_VERIFIED'; $evidence.exitCode=$process.ExitCode
        }
    } catch { $evidence.error='ORIGINAL_PROCESS_EXIT_UNAVAILABLE' }
    return $evidence
}
function Get-FullUiContextRows([string]$product, [string]$sid) {
    if (-not ('PaperEchoMsiContext' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public sealed class PaperEchoMsiContextRow {
 public uint Code, Context;
 public bool ProductMatches, SidMatches;
}
public static class PaperEchoMsiContext {
 [DllImport("msi.dll",EntryPoint="MsiEnumProductsExW",CharSet=CharSet.Unicode,ExactSpelling=true)]
 private static extern uint Enum(string product,string sid,uint context,uint index,[Out] StringBuilder code,out uint actual,[Out] StringBuilder owner,ref uint size);
 public static PaperEchoMsiContextRow[] Query(string product,string sid) {
  var rows=new List<PaperEchoMsiContextRow>();
  foreach(uint mask in new uint[]{1,2,4}) {
   for(uint i=0;i<4;i++) {
    uint actual,size=256;var code=new StringBuilder(39);var owner=new StringBuilder(256);
    // Keep the machine NULL inside C#: PowerShell converts null string arguments to empty strings.
    uint rc=Enum(product,mask==4?null:sid,mask,i,code,out actual,owner,ref size);
    rows.Add(new PaperEchoMsiContextRow{Code=rc,Context=actual,ProductMatches=String.Equals(product,code.ToString(),StringComparison.OrdinalIgnoreCase),SidMatches=String.Equals(sid,owner.ToString(),StringComparison.Ordinal)});
    if(rc==259) break;
    if(rc!=0 || i==3) return rows.ToArray();
   }
  }
  return rows.ToArray();
 }
}
'@
    }
    return [PaperEchoMsiContext]::Query($product,$sid)
}
function Get-FullUiInstallScope([string]$product) {
    try {
        Require ($product -cmatch '^\{[A-F0-9-]{36}\}$') 'PRODUCT_ID_INVALID'
        $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $rows=@(Get-FullUiContextRows $product $sid)
        Require ($rows.Count -ge 3 -and @($rows|Where-Object Code -EQ 259).Count -eq 3) 'CONTEXT_QUERY_INCOMPLETE'
        Require (@($rows|Where-Object { $_.Code -notin @(0,259) }).Count -eq 0) 'CONTEXT_QUERY_FAILED'
        $installed=@($rows|Where-Object Code -EQ 0)
        foreach ($row in $installed) { Require ($row.ProductMatches -and ($row.Context -eq 4 -or ($row.Context -in @(1,2) -and $row.SidMatches))) 'CONTEXT_IDENTITY_MISMATCH' }
        if (-not $installed.Count) { return 'UNREGISTERED' }
        if ($installed.Count -ne 1) { return 'INSTALL_SCOPE_UNVERIFIED' }
        if ($installed[0].Context -eq 4) { return 'INSTALL_SCOPE_MACHINE' }
        return 'INSTALL_SCOPE_USER'
    } catch { return 'INSTALL_SCOPE_UNVERIFIED' }
}
function Assert-FullUiProfileFreshInstall([string]$product) {
    $scope=Get-FullUiInstallScope $product
    Require ($scope -cne 'INSTALL_SCOPE_UNVERIFIED') 'PROFILE_INSTALL_SCOPE_UNVERIFIED'
    Require ($scope -ceq 'UNREGISTERED') 'PROFILE_FRESH_CONTEXT_REQUIRED'
    $paths=@((Join-Path $env:LOCALAPPDATA 'PaperEcho'),
        (Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'PaperEcho'),
        (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'PaperEcho'),
        (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) 'PaperEcho'),
        'HKLM:\SOFTWARE\PaperEcho',
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Installer\InProgress',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Installer\InProgress')
    foreach ($path in $paths) { Require (-not (Test-Path -LiteralPath $path -ErrorAction Stop)) 'PROFILE_SHARED_OR_RECOVERY_STATE_PRESENT' }
    Require (@(Get-NetAdapter -ErrorAction Stop|Where-Object Status -EQ 'Up').Count -eq 0) 'PROFILE_NETWORK_NOT_ISOLATED'
}

function Wait-FullUiObservation($process, [string]$directory, $binding, $steps, [int]$index, $watch, [int]$budget = 1080) {
    $phase = $steps[$index]
    $deadline = if ($binding.signalDeadlineTick) { [long]$binding.signalDeadlineTick } else { [Environment]::TickCount64+[long][Math]::Max(0,($budget-$watch.Elapsed.TotalSeconds)*1000) }
    $lock = Enter-FullUiEvidenceLock $directory $deadline
    try {
        Require ($watch.Elapsed.TotalSeconds -lt $budget -and [Environment]::TickCount64 -lt $deadline) 'FULL_UI_TIMEOUT'
        Write-FullUiJson (Join-Path $directory 'installer-progress.json') ($binding + @{phase=$phase;status='STARTED';stepIndex=$index}) -Replace
    } finally { $lock.Dispose() }
    $file = Join-Path $directory ($phase+'.json')
    while ($watch.Elapsed.TotalSeconds -lt $budget -and [Environment]::TickCount64 -lt $deadline) {
        $lock = Enter-FullUiEvidenceLock $directory $deadline
        try {
            if (Test-Path -LiteralPath $file) {
                Assert-FullUiPath $file; Require ((Get-Item -LiteralPath $file).Length -le 4096) 'FULL_UI_SIGNAL_INVALID'
                $signal = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
                $action = if ($phase -ceq 'msi-cancel') {'clicked-cancel'} elseif ($phase -ceq 'msi-install') {'clicked-install'} else {'observed'}
                Require ($signal.runId -ceq $binding.runId -and $signal.scenario -ceq $binding.scenario -and $signal.msiSha256 -ceq $binding.msiSha256 -and $signal.contextSha256 -ceq $binding.contextSha256 -and $signal.step -ceq $phase -and $signal.stepIndex -eq $index -and $signal.action -ceq $action) 'FULL_UI_SIGNAL_INVALID'
                # Publication AND acceptance must finish before the cutoff; equality is late.
                Require ([Environment]::TickCount64 -lt $deadline -and $watch.Elapsed.TotalSeconds -lt $budget) 'FULL_UI_TIMEOUT'
                if ($binding.signalDeadlineTick) { Require ($signal.publishedTick -ge $binding.startedTick -and $signal.publishedTick -lt $deadline) 'FULL_UI_SIGNAL_INVALID' }
                return @{step=$phase;action=$action;source='manual-observation'}
            }
        } finally { $lock.Dispose() }
        Require (-not $process.HasExited) 'FULL_UI_OBSERVATION_INCOMPLETE'
        $remaining=$deadline-[Environment]::TickCount64
        if ($remaining -gt 0) { Start-Sleep -Milliseconds ([int][Math]::Min(250,$remaining)) }
    }
    throw 'FULL_UI_TIMEOUT'
}

function Get-FullUiOutcome([string]$scenario, [int]$exitCode, [int]$productState, [bool]$transactionStarted, [bool]$transactionFinished) {
    if ($scenario -ceq 'CancelBeforeInstall' -and $exitCode -eq 1602 -and $productState -eq -1 -and -not $transactionStarted) { return 'USER_CANCELLED' }
    if ($scenario -ceq 'Install' -and $exitCode -eq 0 -and $productState -eq 5 -and $transactionStarted -and $transactionFinished) { return 'INSTALL_PASS' }
    return 'FAIL'
}
function Invoke-FullUiScenario {
    Assert-InstallerGuest; Assert-FullUiDesktop
    $manifest = $script:fullUiManifest; $context = $script:fullUiContext
    foreach ($dir in @($inputRoot,$outputRoot)) { Assert-FullUiPath $dir }
    foreach ($prior in Get-ChildItem -LiteralPath $outputRoot -Directory | Where-Object Name -CMatch '^[a-f0-9-]{36}$') {
        Assert-FullUiPath $prior.FullName
        $result = Join-Path $prior.FullName 'full-ui-result.json'
        Require (Test-Path -LiteralPath $result) 'FULL_UI_PREVIOUS_RUN_UNRESOLVED'
        Assert-FullUiPath $result; Require ((Get-Item -LiteralPath $result).Length -le 16384) 'FULL_UI_PREVIOUS_RUN_UNRESOLVED'
        $previous = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
        Require ($previous.runId -ceq $prior.Name -and $previous.status -cin @('USER_CANCELLED','INSTALL_PASS')) 'FULL_UI_PREVIOUS_RUN_UNRESOLVED'
    }
    Require (@(Get-CimInstance Win32_Process -Filter "Name='msiexec.exe' OR Name='PaperEcho.exe'").Count -eq 0) 'ACTIVE_INSTALL_OR_APPLICATION'
    $app = Join-Path $env:LOCALAPPDATA 'Programs\PaperEcho'; $data = Join-Path $env:LOCALAPPDATA 'PaperEcho\workspaces\default'
    Require (-not (Test-Path -LiteralPath $app) -and -not (Test-Path -LiteralPath $data)) 'FRESH_INSTALL_REQUIRED'
    foreach ($entry in $manifest.files) {
        Require ($entry.path -notmatch '(^|[\\/])\.\.($|[\\/])|[:\x00-\x1f]' -and -not [IO.Path]::IsPathRooted($entry.path)) 'HANDOFF_PATH_INVALID'
        $file = Join-Path $inputRoot $entry.path; Assert-FullUiPath $file
        Require ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ieq $entry.sha256) 'HANDOFF_HASH_INVALID'
    }
    $source = Join-Path $inputRoot 'PaperEcho-TEST-ONLY.msi'; Assert-FullUiPath $source
    Require ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ieq $manifest.msiSha256) 'FULL_UI_MSI_HASH_INVALID'
    $identity = Read-FullUiPackage $source
    Require ($identity.ProductName -ceq 'PaperEcho TEST ONLY' -and $identity.ProductCode -ceq $manifest.productCode -and $identity.ProductCode -cmatch '^\{[A-F0-9-]{36}\}$' -and $identity.PackageCode -cmatch '^\{[A-F0-9-]{36}\}$' -and $identity.UpgradeCode -ceq '{7395EC5E-338E-4E71-92A2-579BD64EE6E4}' -and $identity.ProductVersion -ceq '2.6.0') 'FULL_UI_MSI_IDENTITY_INVALID'
    $beforeState = Get-FullUiProductState $identity.ProductCode; Require ($beforeState -eq -1) 'FRESH_PRODUCT_REQUIRED'
    if ($ProfileIsolated) { Assert-FullUiProfileFreshInstall $identity.ProductCode }
    Require (@($manifest.payload).Count -gt 0) 'PAYLOAD_MANIFEST_REQUIRED'
    foreach ($entry in $manifest.payload) { Require ($entry.path -notmatch '(^|[\\/])\.\.($|[\\/])|[:\x00-\x1f]' -and -not [IO.Path]::IsPathRooted($entry.path)) 'PAYLOAD_PATH_INVALID' }
    $directory = Join-Path $outputRoot $manifest.runId
    Require (-not (Test-Path -LiteralPath $directory)) 'FULL_UI_RUN_ALREADY_EXISTS'
    $null = New-Item -ItemType Directory -Path $directory; Assert-FullUiPath $directory
    $work = Join-Path $directory 'Workspace'; $null = New-Item -ItemType Directory -Path $work
    $msi = Join-Path $work 'PaperEcho-TEST-ONLY.msi'; Copy-Item -LiteralPath $source -Destination $msi
    Require ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ieq $manifest.msiSha256) 'LOCAL_MSI_HASH_INVALID'
    $binding = @{schemaVersion=1;runId=$manifest.runId;scenario=$FullUiScenario;msiSha256=$manifest.msiSha256;contextSha256=$HyperVContextSha256}
    if ($ProfileIsolated) { $binding.userSid=$context.userSid; $binding.vmId=$context.vmId }
    # 18 minutes for manual evidence; reserve at most 2 minutes for the original process.
    $binding.startedTick=[Environment]::TickCount64
    $binding.signalDeadlineTick=$binding.startedTick+1080000
    $binding.totalDeadlineTick=$binding.startedTick+1200000
    $binding.signalDeadlineUtc=[DateTime]::UtcNow.AddMinutes(18).ToString('o')
    Write-FullUiJson (Join-Path $directory 'binding.json') $binding
    $beforeData = Get-FullUiSnapshot $data; $log = Join-Path $directory 'msi-verbose.log'; $process = $null
    $report = $binding + @{status='UNKNOWN';productStateBefore=$beforeState;automaticCleanupPerformed=$false;log='msi-verbose.log';observationEvidence='MANUAL_SIGNALS_REQUIRE_VISUAL_REVIEW';observations=@();testScope=$(if($ProfileIsolated){'PROFILE_ISOLATED_TEST_ONLY'}else{'SYNTHETIC_GUEST'});checkpointRestoreVerified=($context.checkpointRestoreVerified -eq $true);machineCleanClaim=$false}
    $reportFrozen=$false; $handleAcquired=$false; $exitDeadline=$null
    try {
        Assert-InstallerGuest; Assert-FullUiDesktop
        # Manual GUI interaction only. Never call the silent Run(): it has a different timeout policy.
        $process = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\msiexec.exe') -ArgumentList ('/i "'+$msi+'" /qf /norestart /l*vx! "'+$log+'"') -WorkingDirectory $work -PassThru -WindowStyle Normal
        $report.pid = $process.Id; $watch = [Diagnostics.Stopwatch]::StartNew()
        $null=$process.Handle; $handleAcquired=$true
        $report.processStartedUtc=$process.StartTime.ToUniversalTime().ToString('o')
        $phases = if ($FullUiScenario -ceq 'CancelBeforeInstall') { @('msi-welcome','msi-ready','msi-cancel','msi-user-exit') } else { @('msi-welcome','msi-ready','msi-install','msi-progress','msi-exit') }
        for ($i = 0; $i -lt $phases.Count; $i++) { $report.observations += Wait-FullUiObservation $process $directory $binding $phases $i $watch }
        $exitDeadline=[Math]::Min($binding.totalDeadlineTick,([Environment]::TickCount64+120000))
        $exitEvidence=Get-FullUiExitEvidence $process $exitDeadline
        Require ($exitEvidence.status -ceq 'EXIT_CODE_VERIFIED') 'FULL_UI_TIMEOUT'
        $report.exitCode = $exitEvidence.exitCode; $report.exitCodeEvidence='ORIGINAL_PROCESS_HANDLE'; $report.productStateAfter = Get-FullUiProductState $identity.ProductCode
        Assert-FullUiPath $log
        $started = $false; $finished = $false; $welcome = $false; $progress = $false; $exit = $false
        foreach ($line in [IO.File]::ReadLines($log)) {
            if ($line -match '^Action start [^:]+:[^:]+:[^:]+: InstallInitialize\.') {$started=$true}
            if ($line -match '^Action ended .+: InstallFinalize\. Return value 1\.') {$finished=$true}
            if ($line -match '^Action start .+: Welcome\.') {$welcome=$true}
            if ($line -match '^Action start .+: Progress\.') {$progress=$true}
            if ($line -match '^Action start .+: Exit\.') {$exit=$true}
        }
        Require ($welcome) 'FULL_UI_LOG_EVIDENCE_MISSING'
        $report.status = Get-FullUiOutcome $FullUiScenario $report.exitCode $report.productStateAfter $started $finished
        Require ($report.status -ne 'FAIL') 'FULL_UI_RESULT_MISMATCH'
        Require ((Get-FullUiSnapshot $data) -ceq $beforeData) 'FULL_UI_DATA_CHANGED'
        Require ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ieq $manifest.msiSha256) 'FULL_UI_INPUT_CHANGED'
        $report.installScope=Get-FullUiInstallScope $identity.ProductCode
        Require ($report.installScope -cne 'INSTALL_SCOPE_UNVERIFIED') 'INSTALL_SCOPE_UNVERIFIED'
        $expectedScope=if($FullUiScenario -ceq 'Install'){'INSTALL_SCOPE_USER'}else{'UNREGISTERED'}
        Require ($report.installScope -ceq $expectedScope) 'INSTALL_SCOPE_MISMATCH'
        if ($FullUiScenario -ceq 'Install') {
            Require ($progress -and $exit) 'FULL_UI_LOG_EVIDENCE_MISSING'
            foreach ($entry in $manifest.payload) { $file = Join-Path $app $entry.path; Assert-FullUiPath $file; Require ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ieq $entry.sha256) 'INSTALLED_PAYLOAD_HASH_INVALID' }
        } else { Require (-not (Test-Path -LiteralPath $app) -and -not (Test-Path -LiteralPath ('HKCU:\Software\PaperEcho\Installer\Packages\'+$identity.ProductCode)) -and -not (Test-Path -LiteralPath ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$identity.ProductCode))) 'CANCEL_LEFT_PRODUCT_REGISTRATION' }
        Require (@(Get-CimInstance Win32_Process -Filter "Name='PaperEcho.exe'").Count -eq 0) 'APPLICATION_AUTOSTARTED'
        $report.dataUnchanged = $true; $report.payloadVerified = $FullUiScenario -ceq 'Install'
    } catch {
        $report.status = 'FAIL'; $report.code = if ($_.Exception.Message -cmatch '^[A-Z][A-Z0-9_]+$') { $_.Exception.Message } else { 'FULL_UI_CHECK_FAILED' }
        if ($process -and -not $process.HasExited) { $report.status='UNKNOWN';$report.processState='RUNNING';$report.manualInspectionRequired=$true }
        # Freeze failure before collecting supplementary exit evidence. Never upgrade this result.
        Write-FullUiJson (Join-Path $directory 'full-ui-result.json') $report; $reportFrozen=$true
        $supplement=@{status='EXIT_CODE_UNVERIFIED';exitCode=$null}
        if ($handleAcquired) {
            if ($null -eq $exitDeadline) { $exitDeadline=[Math]::Min($binding.totalDeadlineTick,([Environment]::TickCount64+120000)) }
            $supplement=Get-FullUiExitEvidence $process $exitDeadline
        }
        Write-FullUiJson (Join-Path $directory 'exit-evidence.json') ($binding+@{originalStatus=$report.status;originalCode=$report.code;evidence=$supplement;guiAcceptance='UNCONFIRMED'})
    } finally { if ($process) { $process.Dispose() } }
    $lock=Enter-FullUiEvidenceLock $directory $binding.totalDeadlineTick
    try { Write-FullUiJson (Join-Path $directory 'installer-progress.json') ($binding + @{status=$report.status;phase='finished'}) -Replace } finally { $lock.Dispose() }
    if (-not $reportFrozen) { Write-FullUiJson (Join-Path $directory 'full-ui-result.json') $report }
    if ($report.status -notin @('USER_CANCELLED','INSTALL_PASS')) { throw 'FULL_UI_INSPECTION_REQUIRED' }
}
if ($FullUiScenario) { Invoke-FullUiScenario; return }
try {
    Assert-InstallerGuest; $identityVerified = $true
    Require (-not (Test-Path -LiteralPath $work)) 'FRESH_GUEST_WORKSPACE_REQUIRED'
    Require (@(Get-ChildItem -LiteralPath $outputRoot -Force).Count -eq 0) 'FRESH_OUTPUT_REQUIRED'
    $manifest = Get-Content -LiteralPath (Join-Path $inputRoot 'test-manifest.json') -Raw | ConvertFrom-Json
    Require ($manifest.schemaVersion -eq 1 -and $manifest.testOnly -eq $true -and $manifest.runId -match '^[a-f0-9-]{36}$') 'HANDOFF_INVALID'
    foreach ($entry in $manifest.files) {
        Require ($entry.path -notmatch '(^|[\\/])\.\.($|[\\/])|[:\x00-\x1f]' -and -not [IO.Path]::IsPathRooted($entry.path)) 'HANDOFF_PATH_INVALID'
        $file = Join-Path $inputRoot $entry.path
        Require (((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) 'HANDOFF_LINK_INVALID'
        Require ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ieq $entry.sha256) 'HANDOFF_HASH_INVALID'
    }
    New-Item -ItemType Directory -Path $work | Out-Null
    $app = Join-Path $env:LOCALAPPDATA 'Programs\PaperEcho'
    $data = Join-Path $env:LOCALAPPDATA 'PaperEcho\workspaces\default'
    Require (-not (Test-Path -LiteralPath $app) -and -not (Test-Path -LiteralPath $data)) 'FRESH_INSTALL_REQUIRED'
    # Stage immutable, verified input on the guest's own filesystem before MSI runs.
    $msi = Join-Path $work 'PaperEcho-TEST-ONLY.msi'
    Copy-Item -LiteralPath (Join-Path $inputRoot 'PaperEcho-TEST-ONLY.msi') -Destination $msi
    Require ((Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash -ieq $manifest.msiSha256) 'LOCAL_MSI_HASH_INVALID'
    $msiexec = Join-Path $env:SystemRoot 'System32\msiexec.exe'
    $product = $manifest.productCode
    Require ($product -match '^\{[A-F0-9-]{36}\}$') 'PRODUCT_ID_INVALID'
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $stage = 'reject-machine-scope'
    $failed = Run $msiexec ('/i "' + $msi + '" /qn /norestart ALLUSERS=1')
    Require ($failed.code -eq 1603 -and $script:lastMsiScopeRejected) 'MACHINE_SCOPE_CONSTRAINT_NOT_PROVEN'
    Require (-not (Test-Path -LiteralPath $app) -and $installer.ProductState($product) -eq -1) 'FAILED_INSTALL_NOT_CLEAN'
    Require (-not (Test-Path -LiteralPath ('HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$product)) -and -not (Test-Path -LiteralPath ('HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\'+$product))) 'MACHINE_REGISTRATION_REMAINS'
    $steps.Add(@{ step = $stage; rejected = $true; exitCode = $failed.code; clean = $true; scopeConstraintSeen = $true; noMachineRegistration = $true; localSourceHashVerified = $true })
    if (-not $NegativeOnly) {
    $stage = 'install'
    $installed = Run $msiexec ('/i "' + $msi + '" /qn /norestart')
    Require ($installed.code -eq 0 -and $installer.ProductState($product) -eq 5) 'INSTALL_FAILED'
    $exe = Join-Path $app 'PaperEcho.exe'; $core = Join-Path $app 'resources\core'; $headless = Join-Path $core 'desktop\electron-poc\headless.mjs'
    Require ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -eq '2.6.0') 'INSTALLED_VERSION_INVALID'
    foreach ($entry in $manifest.payload) {
        Require ((Get-FileHash -LiteralPath (Join-Path $app $entry.path) -Algorithm SHA256).Hash -ieq $entry.sha256) 'INSTALLED_PAYLOAD_HASH_INVALID'
    }
    $steps.Add(@{ step = $stage; installed = $true; payloadFiles = $manifest.payload.Count; perUser = $true; version = '2.6.0' })
    $env:PATH = ''; $env:PWSH_PATH = Join-Path $inputRoot 'tools\pwsh\pwsh.exe'
    $env:PAPERECHO_LAYOUT = 'installed'; $env:PAPERECHO_SKIP_DOTENV = '1'; $env:ELECTRON_RUN_AS_NODE = '1'
    $stage = 'runtime-roots'
    $paths = Run $exe ('"' + $inputRoot + '\installer-check.mjs" paths')
    Require ($paths.code -eq 0 -and ($paths.text | ConvertFrom-Json).rootsSeparated) 'INSTALLED_ROOTS_FAILED'
    $steps.Add(@{ step = $stage; defaultWorkspace = $true; embeddedRuntime = $true; emptyPath = $true })
    New-Item -ItemType Directory -Path $data -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $data '.packaged-smoke-fixture') -Value 'dummy-only' -NoNewline
    Set-Content -LiteralPath (Join-Path $data '.first-run-smoke.json') -Value '{"width":1366,"height":768}' -NoNewline
    Set-Content -LiteralPath (Join-Path $data 'input.json') -Value '[]' -NoNewline
    $stage = 'first-run-gui'
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    $env:TITLE_TRANSLATION_API_KEY = 'dummy-external-wizard'
    $gui = Run $exe '--force-device-scale-factor=1 --smoke'
    Require ($gui.code -eq 0) 'INSTALLED_WIZARD_FAILED'
    $guiReport = Get-Content -LiteralPath (Join-Path $data 'smoke\smoke-report.json') -Raw | ConvertFrom-Json
    Require ($guiReport.wizard.ready -and $guiReport.wizard.secretsWriteOnly -and $guiReport.wizard.externalReadOnly -and $guiReport.ownedServerClosed) 'WIZARD_REPORT_INVALID'
    Require ($guiReport.consoleErrors.Count -eq 0 -and $guiReport.runtimeErrors.Count -eq 0) 'GUI_ERRORS'
    foreach ($process in $guiReport.processes) { Require-Exited $process.pid }
    Remove-Item Env:TITLE_TRANSLATION_API_KEY
    $env:ELECTRON_RUN_AS_NODE = '1'
    $steps.Add(@{ step = $stage; actualBrowserWindow = $true; wizard = $true; writeOnlyDummySecret = $true; width = 1366; height = 768 })
    $stage = 'headless-and-doctor'
    $check = Run $exe ('"' + $headless + '" --check'); Require ($check.code -eq 0) 'INSTALLED_HEADLESS_FAILED'
    $beforeDoctor = Data-Snapshot
    $doctor = Run $exe ('"' + $headless + '" --doctor'); Require ($doctor.code -eq 0) 'INSTALLED_DOCTOR_FAILED'
    Require ((Data-Snapshot) -eq $beforeDoctor) 'DOCTOR_CHANGED_DATA'
    $steps.Add(@{ step = $stage; check = $true; doctorReadOnly = $true; secretAclVerified = $true })
    $stage = 'uninstall'
    $before = Data-Snapshot
    $removed = Run $msiexec ('/x ' + $product + ' /qn /norestart')
    Require ($removed.code -eq 0 -and $installer.ProductState($product) -eq -1 -and -not (Test-Path -LiteralPath $exe)) 'UNINSTALL_FAILED'
    Require (Test-Path -LiteralPath (Join-Path $data '.env')) 'SECRET_REMOVED'
    # The embedded binary is gone; hash preserved data with PowerShell's local hashing.
    function Preserved-Hashes { return @(Get-ChildItem -LiteralPath $data -Recurse -File | Sort-Object FullName | ForEach-Object { [pscustomobject]@{ name = $_.FullName.Substring($data.Length); hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } }) }
    $preserved = Preserved-Hashes
    $steps.Add(@{ step = $stage; applicationRemoved = $true; secretPreserved = $true })
    $stage = 'reinstall'
    $again = Run $msiexec ('/i "' + $msi + '" /qn /norestart'); Require ($again.code -eq 0) 'REINSTALL_FAILED'
    Require ((Data-Snapshot) -eq $before) 'UNINSTALL_OR_REINSTALL_CHANGED_DATA'
    $steps.Add(@{ step = $stage; dataBytePreserved = $true })
    Remove-Item -LiteralPath (Join-Path $data '.first-run-smoke.json')
    Set-Content -LiteralPath (Join-Path $data '.startup-cold-smoke-fixture') -Value 'dummy-only' -NoNewline
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    $cold = Run $exe '--force-device-scale-factor=1 --smoke'; Require ($cold.code -eq 0) 'REINSTALL_CONFIGURED_GUI_FAILED'
    $coldReport = Get-Content -LiteralPath (Join-Path $data 'smoke\smoke-report.json') -Raw | ConvertFrom-Json
    Require ($coldReport.checks -contains 'configured clean GUI cold startup') 'REINSTALL_DID_NOT_RECOGNIZE_CONFIG'
    $stage = 'final-uninstall'
    $beforeFinal = Preserved-Hashes
    $final = Run $msiexec ('/x ' + $product + ' /qn /norestart')
    Require ($final.code -eq 0 -and -not (Test-Path -LiteralPath $exe) -and $installer.ProductState($product) -eq -1) 'FINAL_UNINSTALL_FAILED'
    Require ((ConvertTo-Json -InputObject (Preserved-Hashes) -Compress) -eq (ConvertTo-Json -InputObject $beforeFinal -Compress)) 'FINAL_UNINSTALL_CHANGED_DATA'
    foreach ($pidValue in $ownedPids) { Require-Exited $pidValue }
    foreach ($process in $coldReport.processes) { Require-Exited $process.pid }
    $steps.Add(@{ step = $stage; userDataPreserved = $true; noApplicationProcesses = $true })
    $report = @{ schemaVersion = 1; runId = $manifest.runId; stage = $reportStage; status = 'PASS'; guestIdentityVerified = $true; testOnly = $true; msiSha256 = $manifest.msiSha256; steps = $steps.ToArray() }
    } else {
        foreach ($pidValue in $ownedPids) { Require-Exited $pidValue }
        $report = @{ schemaVersion = 1; runId = $manifest.runId; stage = ($reportStage + '_NEGATIVE'); status = 'PASS'; probeOnly = $true; guestIdentityVerified = $true; msiSha256 = $manifest.msiSha256; steps = $steps.ToArray() }
    }
    $report.trace = $runTrace.ToArray()
} catch {
    $code = $_.Exception.Message
    if ($code -notmatch '^[A-Z][A-Z0-9_]+$') { $code = 'GUEST_TEST_EXCEPTION' }
    $report = @{ schemaVersion = 1; runId = $manifest.runId; stage = $reportStage; status = 'FAIL'; guestIdentityVerified = $identityVerified; failedStep = $stage; code = $code; line = $_.InvocationInfo.ScriptLineNumber; hresult = $_.Exception.HResult; childExit = $script:lastChildExit; childCodes = $script:lastChildCodes; msiCodes = $script:lastMsiCodes; lastMsiAction = $script:lastMsiAction; installerServiceAtTimeout = $script:installerServiceAtTimeout; steps = $steps.ToArray(); trace = $runTrace.ToArray() }
    # Preserve the failure state for diagnosis; cleanup requires a separate authorized operation.
    $report.cleanupExit = 'NOT_ATTEMPTED_EVIDENCE_PRESERVED'
}
if ($identityVerified) {
    $file = Join-Path $outputRoot 'installer-result.json'
    $json = $report | ConvertTo-Json -Depth 10 -Compress
    $temp = Join-Path $outputRoot ([guid]::NewGuid().ToString('N') + '.tmp')
    $stream = [IO.File]::Open($temp, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $bytes = [Text.Encoding]::UTF8.GetBytes($json); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    [IO.File]::Move($temp, $file)
}
