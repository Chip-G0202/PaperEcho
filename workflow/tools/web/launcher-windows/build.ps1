# Developer build only; no PowerShell process is used by PaperEcho.exe.
#Requires -Version 7.0
$ErrorActionPreference = 'Stop'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../../..'))
$compiler = @(
    (Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET/Framework/v4.0.30319/csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (!$compiler) { throw 'Existing .NET Framework C# compiler required. Nothing was installed.' }
$temporary = Join-Path $PSScriptRoot ('PaperEcho-' + [Guid]::NewGuid().ToString('N') + '.exe')
$icon = Join-Path $repoRoot 'workflow/tools/branding/PaperEcho.ico'
if (!(Test-Path -LiteralPath $icon)) { throw 'PaperEcho.ico is missing. Run node workflow/tools/branding/build-desktop-icons.mjs first.' }
try {
    & $compiler /nologo /target:winexe /platform:anycpu /optimize+ /debug- /reference:System.Windows.Forms.dll "/win32icon:$icon" "/out:$temporary" (Join-Path $PSScriptRoot 'PaperEchoLauncher.cs')
    if ($LASTEXITCODE -ne 0) { throw 'PaperEcho launcher compilation failed.' }
    Move-Item -LiteralPath $temporary -Destination (Join-Path $repoRoot 'PaperEcho.exe') -Force
} finally {
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
