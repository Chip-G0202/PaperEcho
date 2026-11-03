param([switch]$Stop)
$ErrorActionPreference = 'Stop'
try {
    if ($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -ne 'Core') { throw 'PS7_REQUIRED' }
    if (-not $Stop) { & (Join-Path $PSScriptRoot 'Prepare-Workbench-Icon.ps1') | Out-Null }
    $candidates = @()
    if ($env:PAPERECHO_DESKTOP_APP) {
        $candidates += $env:PAPERECHO_DESKTOP_APP
        $candidates += (Join-Path $env:PAPERECHO_DESKTOP_APP 'PaperEcho.exe')
    }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\PaperEcho\PaperEcho.exe') }
    $runtime = $candidates | Where-Object { (Test-Path -LiteralPath $_ -PathType Leaf) -and $_.EndsWith('PaperEcho.exe', [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $_) 'resources\core\desktop\electron-poc\headless.mjs') -PathType Leaf) } | Select-Object -First 1
    $embedded = [bool]$runtime
    if (-not $runtime) { $runtime = (Get-Command node -CommandType Application -ErrorAction Stop).Source }
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $runtime
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WorkingDirectory = $PSScriptRoot
    $info.ArgumentList.Add((Join-Path $PSScriptRoot 'quiet-workbench.mjs'))
    if ($Stop) { $info.ArgumentList.Add('--stop') }
    if ($embedded) { $info.Environment['ELECTRON_RUN_AS_NODE'] = '1'; $info.Environment.Remove('NODE_OPTIONS') | Out-Null; $info.Environment.Remove('NODE_PATH') | Out-Null }
    $process = [Diagnostics.Process]::Start($info)
    $process.WaitForExit()
    exit $process.ExitCode
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show('PaperEcho could not start. Check the installed runtime, PowerShell 7 and Node environment.', 'PaperEcho Browser Workbench') | Out-Null
    exit 1
}
