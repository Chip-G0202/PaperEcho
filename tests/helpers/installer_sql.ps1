param([Parameter(Mandatory)][string]$Specification)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'POWERSHELL_7_REQUIRED' }
& (Join-Path $PSScriptRoot '../../desktop/electron-poc/installer-database.ps1') -Specification $Specification
$spec = Get-Content -LiteralPath $Specification -Raw | ConvertFrom-Json -AsHashtable
$installer = New-Object -ComObject WindowsInstaller.Installer
try { $database = $installer.OpenDatabase($spec.msi, 0) }
catch {
    $extended = $installer.LastErrorRecord()
    $fields = @()
    if ($null -ne $extended) { for ($i = 1; $i -le [Math]::Min($extended.FieldCount, 4); $i++) { $fields += $extended.StringData($i) } }
    [pscustomobject]@{ stage = 'sql-read-after-author'; exists = (Test-Path -LiteralPath $spec.msi); extended = $fields; hresult = $_.Exception.HResult } | ConvertTo-Json -Compress
    throw
}
try {
    $view = $database.OpenView('SELECT `FileName` FROM `File` WHERE `Version` IS NULL')
    $view.Execute(); $names = @()
    while ($row = $view.Fetch()) { $names += $row.StringData(1) }
    $view.Close()
    if ($names.Count -ne 2 -or $names -notcontains "空 格's.mjs") { throw 'MSI_SQL_ROUNDTRIP_FAILED' }
    if ($database.SummaryInformation(0).Property(7) -ne 'x64;1033') { throw 'MSI_X64_SUMMARY_FAILED' }
    'NATIVE_MSI_SQL_ROUNDTRIP_PASS'
} finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
}
