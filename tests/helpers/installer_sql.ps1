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
    # Reopen and compare actual UI tables as well as all existing authoring rows; never execute the MSI.
    foreach ($name in $spec.tables.Keys) {
        $table = $spec.tables[$name]
        $columns = @([regex]::Matches($table.columns, '(?:^|, )([A-Za-z_][A-Za-z_0-9]*) ') | ForEach-Object { $_.Groups[1].Value })
        $query = 'SELECT ' + (($columns | ForEach-Object { '`' + $_ + '`' }) -join ', ') + ' FROM `' + $name + '`'
        $view = $database.OpenView($query); $view.Execute()
        $actual = @()
        while ($row = $view.Fetch()) {
            $values = @(for ($i = 1; $i -le $columns.Count; $i++) { $row.StringData($i) })
            $actual += ConvertTo-Json -InputObject $values -Compress
        }
        $view.Close()
        $expected = @($table.rows | ForEach-Object { ConvertTo-Json -InputObject @($_ | ForEach-Object { [string]$_ }) -Compress })
        if ((ConvertTo-Json -InputObject @($actual | Sort-Object) -Compress) -cne (ConvertTo-Json -InputObject @($expected | Sort-Object) -Compress)) { throw "MSI_TABLE_ROUNDTRIP_FAILED:$name" }
    }
    'NATIVE_MSI_SQL_ROUNDTRIP_PASS'
} finally {
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) | Out-Null
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
}
