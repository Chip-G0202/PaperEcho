$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') { throw 'PS7_REQUIRED' }
. (Join-Path $PSScriptRoot 'windows_zip_smoke.ps1')
$base = Join-Path $PSScriptRoot '../runs'
$root = Join-Path $base ('zip-hosted-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
function Assert-Fails([scriptblock]$Operation, [string]$Code) {
    try { & $Operation; throw 'EXPECTED_FAILURE_MISSING' } catch { if (-not $_.Exception.Message.Contains($Code)) { throw } }
}
function New-TestArchive([string]$Name, [string[]]$Entries, [switch]$Link) {
    $file = Join-Path $root ($Name + '.zip')
    $archive = [IO.Compression.ZipFile]::Open($file, [IO.Compression.ZipArchiveMode]::Create)
    try { foreach ($name in $Entries) {
        $entry = $archive.CreateEntry($name)
        if ($Link) { $entry.ExternalAttributes = -1610612736 }
        $writer = [IO.StreamWriter]::new($entry.Open()); try { $writer.Write('dummy') } finally { $writer.Dispose() }
    } } finally { $archive.Dispose() }
    return $file
}
$prefix = 'PaperEcho-2.6.0-win32-x64-TEST-ONLY'
$valid = New-TestArchive 'valid' @("$prefix/regular.txt")
Expand-TestZip $valid (Join-Path $root 'extract') $prefix
if ((Get-Content -LiteralPath (Join-Path $root "extract/$prefix/regular.txt")) -ne 'dummy') { throw 'EXTRACT_FAILED' }
Assert-Fails { Expand-TestZip $valid (Join-Path $root 'extract') $prefix } 'ZIP_TARGET_NOT_FRESH'
$index = 0
foreach ($entries in @(@("$prefix/../escape"), @('C:/escape'), @("$prefix/a\escape"), @("$prefix/A", "$prefix/a"), @('other/file'))) {
    $file = New-TestArchive ('unsafe-' + $index) $entries
    Assert-Fails { Expand-TestZip $file (Join-Path $root ('unsafe-target-' + $index)) $prefix } 'ZIP_'
    if (Test-Path -LiteralPath (Join-Path $root ('unsafe-target-' + $index))) { throw 'UNSAFE_EXTRACTION_STARTED' }
    $index++
}
$link = New-TestArchive 'link' @("$prefix/link") -Link
Assert-Fails { Expand-TestZip $link (Join-Path $root 'link-target') $prefix } 'ZIP_ENTRY_UNSAFE'
Write-Output 'PASS native extraction, traversal, aliases, links and no overwrite'
$app = Join-Path $root 'manifest-app'; $null = New-Item -ItemType Directory -Path $app
$payload = Join-Path $app 'resource.dat'; 'dummy' | Set-Content -LiteralPath $payload
$commit = 'a' * 40
$manifest = @{ schemaVersion = 1; gitCommit = $commit; dirty = $false; platform = 'win32'; arch = 'x64'; artifactId = 'test';
    files = @(@{ path = 'resource.dat'; size = (Get-Item $payload).Length; sha256 = (Get-FileHash $payload).Hash.ToLowerInvariant() }) }
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $app 'release-manifest.json')
$summary = [pscustomobject]@{ gitCommit = $commit; artifactId = 'test'; fileCount = 2; manifestSha256 = (Get-FileHash (Join-Path $app 'release-manifest.json')).Hash.ToLowerInvariant() }
$null = Assert-TestManifest $app $summary $commit
Assert-Fails { Assert-TestManifest $app $summary ('b' * 40) } 'ZIP_MANIFEST_MISMATCH'
'tamper' | Add-Content -LiteralPath $payload
Assert-Fails { Assert-TestManifest $app $summary $commit } 'ZIP_FILE_SIZE_MISMATCH'
Assert-Fails { Assert-ZipHash $valid ('0' * 64) } 'ZIP_HASH_MISMATCH'
Write-Output 'PASS commit, manifest, ZIP hash and complete file inventory'
$probe = Join-Path $root 'probe.ps1'
'if ($PSVersionTable.PSEdition -ne "Core") { throw "PS7_REQUIRED" }; @{path=$env:PATH;credential=$env:GITHUB_TOKEN;args=$args.Count}|ConvertTo-Json -Compress' | Set-Content -LiteralPath $probe
$environment = @{ SystemRoot = $env:SystemRoot; WINDIR = $env:WINDIR; PATH = ''; TEMP = $root; TMP = $root }
$result = Invoke-ZipChild (Get-Process -Id $PID).Path @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $probe, '--check') $environment $root | ConvertFrom-Json
# PS7 prepends only its own directory during startup; no inherited tool directories are allowed.
$ownRuntimePath = (Split-Path (Get-Process -Id $PID).Path) + [IO.Path]::PathSeparator
if (($result.path -and $result.path -cne $ownRuntimePath) -or $result.credential -or $result.args -ne 1) { throw 'CHILD_ENVIRONMENT_INVALID' }
'exit 9' | Set-Content -LiteralPath $probe
Assert-Fails { Invoke-ZipChild (Get-Process -Id $PID).Path @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', $probe) $environment $root } 'ZIP_CHILD_FAILED exit=9'
Write-Output 'PASS real isolated child process, argv and failure propagation'
$workflow = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../../.github/workflows/windows-zip-smoke-manual.yml') -Raw
if ([regex]::Matches($workflow, 'runs-on: windows-2025').Count -ne 2 -or $workflow -notmatch 'workflow_dispatch:' -or
    $workflow -notmatch 'needs: build' -or $workflow -notmatch 'timeout-minutes: 30' -or $workflow -notmatch 'timeout-minutes: 15' -or
    $workflow -notmatch 'contents: read' -or [regex]::Matches($workflow, 'persist-credentials: false').Count -ne 2 -or
    $workflow -match 'secrets\.|self-hosted|windows-.*-large|always\(|continue-on-error|schedule:|pull_request:|push:|npm test|release create') { throw 'WORKFLOW_BOUNDARY_INVALID' }
$consumer = ($workflow -split '  independent-smoke:')[1]
if ($consumer -match 'npm |setup-node|package:win|package:zip' -or $consumer -notmatch 'Mode Smoke' -or $consumer -notmatch 'EXPECTED_ZIP_SHA') { throw 'WORKFLOW_CONSUMER_INVALID' }
Write-Output 'PASS manual-only two-runner workflow and no consumer dependency installation'
