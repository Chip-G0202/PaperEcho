// Read-only Windows Installer metadata; never InstallProduct, repair or Win32_Product.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { backupSafePath } from './backup_service.mjs';

const script = String.raw`
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -cne 'Core'){throw 'PS7_REQUIRED'}
$engine=$null;$database=$null
try {
 $file=$env:PAPERECHO_INSPECT_MSI
 $digest=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
 $signature=Get-AuthenticodeSignature -LiteralPath $file
 $engine=New-Object -ComObject WindowsInstaller.Installer
 $database=$engine.OpenDatabase($file,0)
 $properties=@{}
 foreach($name in @('ProductCode','UpgradeCode','ProductVersion','ProductName','ALLUSERS')){
  $view=$database.OpenView("SELECT " + [char]96 + "Value" + [char]96 + " FROM " + [char]96 + "Property" + [char]96 + " WHERE " + [char]96 + "Property" + [char]96 + "='"+$name+"'")
  $record=$null
  try{$null=$view.Execute();$record=$view.Fetch();if($record){$properties[$name]=$record.StringData(1)}}
  finally{if($record){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($record)|Out-Null};$null=$view.Close();[Runtime.InteropServices.Marshal]::FinalReleaseComObject($view)|Out-Null}
 }
 $identity=[Security.Principal.WindowsIdentity]::GetCurrent()
 $admin=([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
 $running=$false
 foreach($process in @(Get-Process -Name PaperEcho -ErrorAction SilentlyContinue)){
  if($process.Id -eq [int]$env:PAPERECHO_INSPECT_CALLER_PID){continue}
  try{if([IO.Path]::GetFullPath($process.Path).Equals([IO.Path]::Combine($env:PAPERECHO_INSPECT_APP,'PaperEcho.exe'),[StringComparison]::OrdinalIgnoreCase)){$running=$true}}
  catch{$running=$true}
 }
 @{sha256=$digest;productCode=$properties.ProductCode;upgradeCode=$properties.UpgradeCode;version=$properties.ProductVersion;productName=$properties.ProductName;allUsers=$properties.ALLUSERS;
   productState=[int]$engine.ProductState($properties.ProductCode);userSid=$identity.User.Value;isAdmin=$admin;applicationRunning=$running;signatureStatus=[string]$signature.Status;
   signerThumbprint=if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{''}}|ConvertTo-Json -Compress
} finally {if($database){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($database)|Out-Null};if($engine){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($engine)|Out-Null}}
`;

export async function inspectWindowsInstaller(file, { applicationRoot } = {}) {
  const fail = code => Object.assign(new Error(code), { code });
  if (process.platform !== 'win32' || !path.isAbsolute(file || '') || !/^[A-Za-z]:[\\/]/.test(file) || path.extname(file).toLowerCase() !== '.msi'
    || !path.isAbsolute(applicationRoot || '')) throw fail('UPGRADE_INSTALLER_PATH_INVALID');
  const pwsh = process.env.PWSH_PATH;
  if (!path.isAbsolute(pwsh || '')) throw fail('UPGRADE_INSTALLER_PS7_REQUIRED');
  await backupSafePath(file); const before = await fs.lstat(file);
  if (!before.isFile() || before.size > 2 * 1024 ** 3) throw fail('UPGRADE_INSTALLER_SIZE_INVALID');
  const env = Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  env.PAPERECHO_INSPECT_MSI = file;
  env.PAPERECHO_INSPECT_APP = applicationRoot;
  // The current management CLI is read-only and exits before manual uninstall;
  // another GUI/workflow process at the installed path must still block.
  env.PAPERECHO_INSPECT_CALLER_PID = String(process.pid);
  try {
    const { stdout } = await promisify(execFile)(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { env, windowsHide: true, timeout: 15000, maxBuffer: 8192 });
    await backupSafePath(file); const after = await fs.lstat(file);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw fail('UPGRADE_INSTALLER_CHANGED');
    const value = JSON.parse(stdout);
    if (!/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Number.isInteger(value.productState) || typeof value.signatureStatus !== 'string') throw fail('UPGRADE_INSTALLER_METADATA_INVALID');
    return value;
  } catch (error) {
    if (/^UPGRADE_INSTALLER_[A-Z_]+$/.test(error.code || '')) throw error;
    throw fail('UPGRADE_INSTALLER_METADATA_UNAVAILABLE');
  }
}
