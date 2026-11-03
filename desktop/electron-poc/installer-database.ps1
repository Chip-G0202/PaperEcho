param([Parameter(Mandatory)][string]$Specification)
# Database authoring only; never call InstallProduct or msiexec on the build host.
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'POWERSHELL_7_REQUIRED' }
$spec = Get-Content -LiteralPath $Specification -Raw | ConvertFrom-Json -AsHashtable
if (Test-Path -LiteralPath $spec.msi) { throw 'INSTALLER_OUTPUT_EXISTS' }
$installer = New-Object -ComObject WindowsInstaller.Installer
$database = $installer.OpenDatabase($spec.msi, 3)
foreach ($name in $spec.tables.Keys) {
    $table = $spec.tables[$name]
    # MSI SQL identifiers such as Registry.Key must be quoted separately from types.
    $columns = [regex]::Replace($table.columns, '(^|, )([A-Za-z_][A-Za-z_0-9]*) ', '$1`$2` ')
    $keys = @($table.key.Split(',') | ForEach-Object { '`' + $_.Trim() + '`' }) -join ', '
    $view = $database.OpenView(('CREATE TABLE `{0}` ({1} PRIMARY KEY {2})' -f $name, $columns, $keys))
    $view.Execute(); $view.Close()
    [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null
    $view = $null
    foreach ($row in $table.rows) {
        # MSI INSERT requires a column list; literals cannot escape apostrophes.
        # Unset Record fields represent NULL, without unsupported SQL literals.
        $fields = @([regex]::Matches($table.columns, '(?:^|, )([A-Za-z_][A-Za-z_0-9]*) ') | ForEach-Object { '`' + $_.Groups[1].Value + '`' })
        if ($row.Count -ne $fields.Count) { throw 'INSTALLER_RECORD_FIELD_COUNT' }
        $markers = @($fields | ForEach-Object { '?' }) -join ', '
        $record = $installer.CreateRecord($fields.Count)
        for ($i = 0; $i -lt $row.Count; $i++) {
            if ($null -eq $row[$i]) { continue }
            if ($row[$i] -is [string]) { $record.StringData($i + 1) = $row[$i] }
            else { $record.IntegerData($i + 1) = [int]$row[$i] }
        }
        $method = 'OpenView'
        try {
            $view = $database.OpenView(('INSERT INTO `{0}` ({1}) VALUES ({2})' -f $name, ($fields -join ', '), $markers))
            $method = 'Execute'; $view.Execute($record)
        } catch {
            $extended = $installer.LastErrorRecord()
            $code = if ($extended) { $extended.IntegerData(1) } else { 0 }
            throw "INSTALLER_SQL_FAILED table=$name operation=INSERT method=$method code=$code"
        } finally {
            if ($view) {
                $view.Close()
                [Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null
                $view = $null
            }
            [Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) | Out-Null
        }
    }
}
$view = $database.OpenView('INSERT INTO `_Streams` (`Name`, `Data`) VALUES (?, ?)')
$record = $installer.CreateRecord(2)
$record.StringData(1) = 'payload.cab'; $record.SetStream(2, $spec.payload)
$view.Execute($record); $view.Close()
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($record) | Out-Null
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($view) | Out-Null
$summary = $database.SummaryInformation(8)
$summary.Property(2) = 'PaperEcho TEST ONLY'
$summary.Property(3) = 'Unsigned current-user Windows installer'
$summary.Property(4) = 'PaperEcho contributors'
$summary.Property(7) = 'x64;1033'
$summary.Property(9) = $spec.packageCode
$summary.Property(14) = 500
# Compressed files and no elevated privileges required (per-user only).
$summary.Property(15) = 10
$summary.Persist(); $database.Commit()
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($summary) | Out-Null
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($database) | Out-Null
[Runtime.InteropServices.Marshal]::FinalReleaseComObject($installer) | Out-Null
