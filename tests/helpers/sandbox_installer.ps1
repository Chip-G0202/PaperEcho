param([switch]$NegativeOnly, [switch]$IdentityOnly, [string]$HyperVContextSha256)
# Guest only. Fixed paths, immutable input, no commands or code from the output mapping.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'POWERSHELL_7_REQUIRED' }
$inputRoot = 'C:\PaperEchoLab\Input'; $outputRoot = 'C:\PaperEchoLab\Output'
$work = 'C:\PaperEchoLab\Workspace'; $steps = [Collections.Generic.List[object]]::new()
$stage = 'identity'; $ownedPids = [Collections.Generic.List[int]]::new(); $identityVerified = $false
$runTrace = [Collections.Generic.List[object]]::new()
$reportStage = 'SANDBOX_INSTALLER'
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
        if ($context.schemaVersion -ne 1 -or $context.kind -cne 'HYPERV_INSTALLER' -or $context.vmId -notmatch '^[a-f0-9-]{36}$' -or $context.checkpointId -notmatch '^[a-f0-9-]{36}$' -or (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash -ine $context.manifestSha256) { throw 'HYPERV_CONTEXT_INVALID' }
        $handoff = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
        if ($handoff.testOnly -ne $true -or $context.runId -cne $handoff.runId -or $context.msiSha256 -ine $handoff.msiSha256) { throw 'HYPERV_HANDOFF_INVALID' }
        if ([guid](Get-CimInstance Win32_ComputerSystemProduct).UUID -ne [guid]$context.biosGuid -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $context.userSid) { throw 'HYPERV_GUEST_IDENTITY_REQUIRED' }
        if (([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'UNELEVATED_INSTALLER_TEST_REQUIRED' }
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
