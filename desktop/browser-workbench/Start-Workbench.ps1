param([string]$UserDataRoot)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') { throw 'PowerShell 7 Core required' }
$entry = Join-Path $PSScriptRoot 'start.mjs'
if ($UserDataRoot) { & node $entry --user-data-root $UserDataRoot } else { & node $entry }
exit $LASTEXITCODE
