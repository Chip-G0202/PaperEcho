$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') { throw 'PowerShell 7 Core required' }
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'Start-Workbench.cmd') -PathType Leaf)) { throw 'Place these icon files beside the existing Start-Workbench.cmd first.' }
$source = Join-Path $PSScriptRoot 'paperecho.ico'
$hash = (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant()
$directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'PaperEcho\launcher-icons'
if (Test-Path -LiteralPath $directory) {
    if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Icon directory must not be a link.' }
} else { [IO.Directory]::CreateDirectory($directory) | Out-Null }
$destination = Join-Path $directory ('paperecho-' + $hash.Substring(0, 12) + '.ico')
if (Test-Path -LiteralPath $destination) {
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Existing icon does not match; no file was replaced.' }
} else { [IO.File]::Copy($source, $destination, $false) }
Write-Host 'PaperEcho icon is ready. Open the PaperEcho browser-workbench shortcut in this folder.'
