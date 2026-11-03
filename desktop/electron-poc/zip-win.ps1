param([Parameter(Mandatory)][string]$Plan, [Parameter(Mandatory)][string]$Destination)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') { throw 'ZIP_PS7_REQUIRED' }
function Assert-Entry([string]$Name) {
    if (-not $Name -or $Name.Length -gt 512 -or $Name -match '[\\:\x00-\x1f<>"|?*]' -or
        @($Name.Split('/') | Where-Object { -not $_ -or $_ -in '.', '..' -or $_ -match '[. ]$' }).Count) { throw 'ZIP_ENTRY_INVALID' }
}
$planData = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
Assert-Entry $planData.prefix
if ($planData.prefix.Contains('/') -or $planData.files.Count -gt 20001) { throw 'ZIP_ENTRY_INVALID' }
$root = [IO.Path]::GetFullPath($planData.root)
$expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($file in $planData.files) {
    Assert-Entry $file.path
    if ($file.sha256 -notmatch '^[a-f0-9]{64}$' -or $file.size -lt 0) { throw 'ZIP_ENTRY_INVALID' }
    $expected.Add(($planData.prefix + '/' + $file.path), $file)
}
$owned = $false
try {
    $stream = [IO.File]::Open($Destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $owned = $true
    try {
        $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
        try {
            foreach ($entry in $expected.GetEnumerator()) {
                $source = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.Value.path))
                if (-not $source.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'ZIP_ENTRY_INVALID' }
                $item = Get-Item -LiteralPath $source -Force
                if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'ZIP_SOURCE_UNSAFE' }
                [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $source, $entry.Key, [IO.Compression.CompressionLevel]::Optimal)
            }
        } finally { $archive.Dispose() }
    } finally { $stream.Dispose() }
    $archive = [IO.Compression.ZipFile]::OpenRead($Destination)
    try {
        if ($archive.Entries.Count -ne $expected.Count) { throw 'ZIP_CONTENT_MISMATCH' }
        foreach ($entry in $archive.Entries) {
            Assert-Entry $entry.FullName
            $file = $expected[$entry.FullName]
            if (-not $file -or $entry.Length -ne $file.size) { throw 'ZIP_CONTENT_MISMATCH' }
            $inputStream = $entry.Open(); $hash = [Security.Cryptography.SHA256]::Create()
            try { $actual = [Convert]::ToHexString($hash.ComputeHash($inputStream)).ToLowerInvariant() }
            finally { $inputStream.Dispose(); $hash.Dispose() }
            if ($actual -ne $file.sha256) { throw 'ZIP_HASH_MISMATCH' }
        }
    } finally { $archive.Dispose() }
} catch {
    if ($owned) { [IO.File]::Delete($Destination) }
    throw
}
