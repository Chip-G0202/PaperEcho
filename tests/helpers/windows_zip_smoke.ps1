param([ValidateSet('Prepare', 'Smoke')][string]$Mode, [string]$ArtifactRoot, [string]$ZipReport, [string]$ExpectedCommit, [string]$ExpectedZipSha)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') { throw 'PS7_REQUIRED' }

function Assert-ZipName([string]$Name) {
    if (-not $Name -or $Name.Length -gt 512 -or $Name -match '[\\:\x00-\x1f<>"|?*]' -or
        @($Name.Split('/') | Where-Object { -not $_ -or $_ -in '.', '..' -or $_ -match '[. ]$' }).Count) { throw 'ZIP_PATH_UNSAFE' }
}
function Assert-ZipHash([string]$File, [string]$Hash) {
    if ($Hash -notmatch '^[a-f0-9]{64}$' -or (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Hash) { throw 'ZIP_HASH_MISMATCH' }
}
function Expand-TestZip([string]$Zip, [string]$Target, [string]$Prefix) {
    Assert-ZipName $Prefix
    if ($Prefix.Contains('/') -or (Test-Path -LiteralPath $Target)) { throw 'ZIP_TARGET_NOT_FRESH' }
    $archive = [IO.Compression.ZipFile]::OpenRead($Zip)
    try {
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); [long]$total = 0
        if ($archive.Entries.Count -gt 20001) { throw 'ZIP_SIZE_LIMIT' }
        foreach ($entry in $archive.Entries) {
            Assert-ZipName $entry.FullName
            if (-not $entry.FullName.StartsWith($Prefix + '/', [StringComparison]::Ordinal) -or -not $seen.Add($entry.FullName) -or
                (($entry.ExternalAttributes -shr 16) -band 0xf000) -eq 0xa000 -or ($entry.ExternalAttributes -band 0x400)) { throw 'ZIP_ENTRY_UNSAFE' }
            $total += $entry.Length
            if ($total -gt 2GB) { throw 'ZIP_SIZE_LIMIT' }
        }
    } finally { $archive.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Zip, $Target) # Fresh target only; no overwrite.
}
function Assert-TestManifest([string]$Root, $Summary, [string]$Commit) {
    if ((Get-Item -LiteralPath (Join-Path $Root 'release-manifest.json')).Length -gt 8MB) { throw 'ZIP_MANIFEST_TOO_LARGE' }
    Assert-ZipHash (Join-Path $Root 'release-manifest.json') $Summary.manifestSha256
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'release-manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.gitCommit -cne $Commit -or $Summary.gitCommit -cne $Commit -or $manifest.dirty -ne $false -or
        $manifest.platform -ne 'win32' -or $manifest.arch -ne 'x64' -or $manifest.schemaVersion -ne 1 -or $manifest.artifactId -cne $Summary.artifactId -or
        $manifest.files.Count + 1 -ne $Summary.fileCount) { throw 'ZIP_MANIFEST_MISMATCH' }
    $files = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force)
    if ($files.Count -ne $Summary.fileCount -or @(Get-ChildItem -LiteralPath $Root -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count) { throw 'ZIP_INVENTORY_MISMATCH' }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($entry in $manifest.files) {
        Assert-ZipName $entry.path
        if (-not $seen.Add($entry.path) -or $entry.path -eq 'release-manifest.json') { throw 'ZIP_MANIFEST_MISMATCH' }
        $file = Join-Path $Root $entry.path
        if ((Get-Item -LiteralPath $file).Length -ne $entry.size) { throw 'ZIP_FILE_SIZE_MISMATCH' }
        Assert-ZipHash $file $entry.sha256
    }
    return $manifest
}
function Invoke-ZipChild([string]$Executable, [string[]]$Argv, [hashtable]$Environment, [string]$WorkingDirectory) {
    $start = [Diagnostics.ProcessStartInfo]::new($Executable)
    $start.UseShellExecute = $false; $start.WorkingDirectory = $WorkingDirectory
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true; $start.Environment.Clear()
    foreach ($key in $Environment.Keys) { $start.Environment[$key] = $Environment[$key] }
    foreach ($arg in $Argv) { $start.ArgumentList.Add($arg) }
    $process = [Diagnostics.Process]::Start($start)
    try {
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(60000)) { $process.Kill($true); throw 'ZIP_CHILD_TIMEOUT' }
        $output = $stdout.GetAwaiter().GetResult(); $errorText = $stderr.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw "ZIP_CHILD_FAILED exit=$($process.ExitCode) $((($errorText + $output) -split '\r?\n' | Where-Object { $_ } | Select-Object -First 1))" }
        return $output
    } finally { $process.Dispose() }
}
if ($MyInvocation.InvocationName -eq '.') { return } # Direct tests load only the bounded helpers.
if ($ExpectedCommit -notmatch '^[a-f0-9]{40}$') { throw 'ZIP_COMMIT_REQUIRED' }
if ($Mode -eq 'Prepare') {
    $report = Get-Content -LiteralPath $ZipReport -Raw | ConvertFrom-Json
    if ($report.gitCommit -cne $ExpectedCommit -or $report.testOnly -ne $true -or $report.evidence -ne 'OBSERVED' -or $report.release -ne 'BLOCKED') { throw 'ZIP_BUILD_REPORT_INVALID' }
    Assert-ZipHash $report.zip $report.sha256
    $build = Get-Content -LiteralPath 'tests/runs/phase2b/latest-build.json' -Raw | ConvertFrom-Json
    $manifestFile = Join-Path $build.output 'release-manifest.json'
    $summary = [ordered]@{ gitCommit = $ExpectedCommit; filename = [IO.Path]::GetFileName($report.zip); sha256 = $report.sha256; sizeBytes = $report.sizeBytes;
        fileCount = $report.fileCount; artifactId = $report.artifactId; manifestSha256 = (Get-FileHash -LiteralPath $manifestFile).Hash.ToLowerInvariant(); testOnly = $true; buildMachine = $env:COMPUTERNAME }
    $null = Assert-TestManifest $build.output ([pscustomobject]$summary) $ExpectedCommit
    if (Test-Path -LiteralPath $ArtifactRoot) { throw 'ZIP_ARTIFACT_NOT_FRESH' }
    $null = New-Item -ItemType Directory -Path $ArtifactRoot
    Copy-Item -LiteralPath $report.zip -Destination (Join-Path $ArtifactRoot $summary.filename)
    $summary | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $ArtifactRoot 'summary.json') -Encoding utf8
    "zip-sha=$($report.sha256)" | Add-Content -LiteralPath $env:GITHUB_OUTPUT
    return
}
if ($Mode -ne 'Smoke' -or -not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') { throw 'ZIP_HOSTED_WINDOWS_REQUIRED' }
$summary = Get-Content -LiteralPath (Join-Path $ArtifactRoot 'summary.json') -Raw | ConvertFrom-Json
if ($summary.testOnly -ne $true -or $summary.sha256 -cne $ExpectedZipSha -or $summary.filename -notmatch '^PaperEcho-[0-9.]+-win32-x64-TEST-ONLY\.zip$') { throw 'ZIP_SUMMARY_INVALID' }
$zip = Join-Path $ArtifactRoot $summary.filename
Assert-ZipHash $zip $ExpectedZipSha
if ((Get-Item -LiteralPath $zip).Length -ne $summary.sizeBytes) { throw 'ZIP_SIZE_MISMATCH' }
foreach ($old in @((Join-Path $env:LOCALAPPDATA 'PaperEcho'), (Join-Path $env:APPDATA 'PaperEcho'))) {
    if (Test-Path -LiteralPath $old) { throw 'ZIP_EXISTING_PROFILE' }
}
if (@(Get-Process -Name PaperEcho -ErrorAction SilentlyContinue).Count -or @(Get-ScheduledTask | Where-Object { $_.TaskName -like '*PaperEcho*' }).Count) { throw 'ZIP_EXISTING_ACTIVITY' }
$lab = Join-Path $env:RUNNER_TEMP ('pe-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$prefix = [IO.Path]::GetFileNameWithoutExtension($summary.filename)
Expand-TestZip $zip $lab $prefix
$app = Join-Path $lab $prefix
$manifest = Assert-TestManifest $app $summary $ExpectedCommit
foreach ($required in @('PaperEcho.exe', 'resources/app.asar', 'resources/powershell/pwsh.exe', 'resources/powershell/pwsh.dll', 'resources/powershell/System.Management.Automation.dll', 'resources/core/desktop/electron-poc/headless.mjs')) {
    if (-not (Test-Path -LiteralPath (Join-Path $app $required) -PathType Leaf)) { throw 'ZIP_RUNTIME_MISSING' }
}
$data = Join-Path $lab '合成 数据'; $syntheticHome = Join-Path $lab 'home'; $temp = Join-Path $lab 'temp'
foreach ($dir in @((Join-Path $data 'config'), $syntheticHome, $temp, (Join-Path $syntheticHome 'local'), (Join-Path $syntheticHome 'roaming'))) { $null = New-Item -ItemType Directory -Path $dir -Force }
$config = Join-Path $data 'config/paperecho.config.json'; $inputFile = Join-Path $data 'input.json'
'{"schemaVersion":2,"mode":"local","common":{"projectRoot":"..","llm":{"enabled":false,"mode":"disabled"},"email":{"enabled":false}},"local":{"input":"../input.json","outputRoot":"../output"}}' | Set-Content -LiteralPath $config -Encoding utf8
'[]' | Set-Content -LiteralPath $inputFile -Encoding utf8
$configHash = (Get-FileHash -LiteralPath $config).Hash.ToLowerInvariant(); $inputHash = (Get-FileHash -LiteralPath $inputFile).Hash.ToLowerInvariant()
$childEnv = @{ SystemRoot = $env:SystemRoot; WINDIR = $env:WINDIR; COMSPEC = $env:COMSPEC; PATH = ''; USERPROFILE = $syntheticHome; HOME = $syntheticHome;
    LOCALAPPDATA = (Join-Path $syntheticHome 'local'); APPDATA = (Join-Path $syntheticHome 'roaming'); TEMP = $temp; TMP = $temp;
    PAPERECHO_SKIP_DOTENV = '1'; PAPERECHO_LAYOUT = 'installed'; PAPERECHO_DATA_ROOT = $data }
$probe = Join-Path $lab 'runtime-probe.ps1'
'if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne "Core") { throw "PS7_REQUIRED" }; @{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition}|ConvertTo-Json -Compress' | Set-Content -LiteralPath $probe -Encoding utf8
$ps = Invoke-ZipChild (Join-Path $app 'resources/powershell/pwsh.exe') @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $probe) $childEnv $lab | ConvertFrom-Json
if ($ps.version -ne $manifest.runtime.powershell.version -or $ps.edition -ne 'Core') { throw 'ZIP_PS7_MISMATCH' }
$output = Invoke-ZipChild (Join-Path $app 'PaperEcho.exe') @('--headless', '--check', '--mode', 'local') $childEnv $lab
$preflight = @($output -split '\r?\n' | Where-Object { $_.StartsWith('{') } | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.type -eq 'preflight' })
if ($preflight.Count -ne 1 -or $preflight[0].canRun -ne $true -or $preflight[0].mode -ne 'local' -or $preflight[0].requiredMissing.Count -ne 0 -or
    -not @($preflight[0].readiness | Where-Object { $_.name -eq 'production_entry' -and $_.status -eq 'ready' }).Count) { throw 'ZIP_PREFLIGHT_FAILED' }
Assert-ZipHash $config $configHash; Assert-ZipHash $inputFile $inputHash
if (Test-Path -LiteralPath (Join-Path $data 'output')) { throw 'ZIP_UNEXPECTED_BUSINESS_OUTPUT' }
@{ status = 'Windows ZIP independent hosted-runner Headless smoke PASS'; gitCommit = $ExpectedCommit; zipSha256 = $ExpectedZipSha; files = $summary.fileCount;
    buildMachine = $summary.buildMachine; smokeMachine = $env:COMPUTERNAME; bundledPowerShell = $ps.version; childPathEmpty = $true;
    gui = 'NOT_TESTED'; cleanMachine = 'PENDING'; smartScreen = 'NOT_TESTED'; release = 'BLOCKED'; limitation = 'Hosted runners contain preinstalled developer tools; only child environment is isolated.' } | ConvertTo-Json -Compress
