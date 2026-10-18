import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

export const restoreError = code => Object.assign(new Error(code), { code });
export async function inspectRestoreVolume(directory) {
  if (process.platform !== 'win32') throw restoreError('RESTORE_PLATFORM_UNVERIFIED');
  const env = Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  env.PAPERECHO_VOLUME_ROOT = path.parse(directory).root;
  env.PAPERECHO_VOLUME_PARENT = directory;
  // Windows access(W_OK) does not evaluate the DACL. Request ADD_SUBDIRECTORY
  // on an existing directory, then close the handle without creating anything.
  const command = `$ErrorActionPreference='Stop'; if($PSVersionTable.PSVersion.Major -lt 7){exit 2}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class UpgradeDirectoryAccess {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
}
'@
$h=[UpgradeDirectoryAccess]::CreateFileW($env:PAPERECHO_VOLUME_PARENT,4,7,[IntPtr]::Zero,3,0x02000000,[IntPtr]::Zero)
try { if($h.IsInvalid){[Console]::Out.Write('PARENT_ACCESS_DENIED');exit 0} } finally {$h.Dispose()}
$d=[IO.DriveInfo]::new($env:PAPERECHO_VOLUME_ROOT); [Console]::Out.Write($d.DriveFormat+'|'+$d.AvailableFreeSpace)`;
  const { stdout } = await promisify(execFile)(process.env.PWSH_PATH || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { env, windowsHide: true, timeout: 5000, maxBuffer: 128 });
  if (stdout === 'PARENT_ACCESS_DENIED') throw restoreError('RESTORE_PARENT_ACCESS_DENIED');
  const match = /^(NTFS)\|(\d+)$/.exec(stdout);
  if (!match) throw restoreError('RESTORE_PLATFORM_UNVERIFIED');
  return { filesystem: match[1], freeBytes: BigInt(match[2]) };
}
// A live Windows handle without FILE_SHARE_DELETE pins each existing ancestor.
// The staging DACL is private from creation, before any plaintext is written.
const script = `
$ErrorActionPreference = 'Stop'
$handles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$created = $false
try {
  if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'runtime' }
  Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RestoreNative {
  [StructLayout(LayoutKind.Sequential)] public struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential)] public struct Info { public uint attributes; public System.Runtime.InteropServices.ComTypes.FILETIME c,a,w; public uint volume,sizeHigh,sizeLow,links,indexHigh,indexLow; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern SafeFileHandle CreateFileW(string p,uint access,uint share,IntPtr sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetFileInformationByHandle(SafeFileHandle h,out Info i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CreateDirectoryW(string p,ref SA sa);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s,uint v,out IntPtr p,out uint n);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr p);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool GetVolumeInformationW(string p,StringBuilder v,uint z,out uint serial,out uint max,out uint flags,StringBuilder f,uint size);
}
'@
  $paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:PAPERECHO_RESTORE_ANCESTORS)) | ConvertFrom-Json
  $volume = [Text.StringBuilder]::new(32); [uint32]$serial=0; [uint32]$max=0; [uint32]$flags=0
  if (-not [RestoreNative]::GetVolumeInformationW($paths[0],$null,0,[ref]$serial,[ref]$max,[ref]$flags,$volume,32) -or $volume.ToString() -ne 'NTFS') { throw 'filesystem' }
  foreach ($p in $paths) {
    $h = [RestoreNative]::CreateFileW($p,1,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
    if ($h.IsInvalid) { $h.Dispose(); throw 'handle' }
    $handles.Add($h); $info = [RestoreNative+Info]::new()
    if (-not [RestoreNative]::GetFileInformationByHandle($h,[ref]$info) -or ($info.attributes -band 0x400) -ne 0 -or ($info.attributes -band 0x10) -eq 0) { throw 'reparse' }
  }
  if ($env:PAPERECHO_RESTORE_EXISTING -eq '1') {
    $item = Get-Item -LiteralPath $env:PAPERECHO_RESTORE_STAGE -Force
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'directory' }
  } else {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $descriptor = [IntPtr]::Zero; [uint32]$size=0
  try {
    if (-not [RestoreNative]::ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;OICI;FA;;;$sid)(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)",1,[ref]$descriptor,[ref]$size)) { throw 'acl' }
    $sa = [RestoreNative+SA]::new(); $sa.length = [Runtime.InteropServices.Marshal]::SizeOf($sa); $sa.descriptor = $descriptor
    if (-not [RestoreNative]::CreateDirectoryW($env:PAPERECHO_RESTORE_STAGE,[ref]$sa)) { throw 'mkdir' }
    $created = $true
  } finally { if ($descriptor -ne [IntPtr]::Zero) { [void][RestoreNative]::LocalFree($descriptor) } }
  }
  if ($env:PAPERECHO_RESTORE_EXCLUSIVE -eq '1') {
    $directory = [RestoreNative]::CreateFileW($env:PAPERECHO_RESTORE_STAGE,1,3,[IntPtr]::Zero,3,0x02200000,[IntPtr]::Zero)
    if ($directory.IsInvalid) { $directory.Dispose(); throw 'directory' }; $handles.Add($directory)
    $lock = [RestoreNative]::CreateFileW([IO.Path]::Combine($env:PAPERECHO_RESTORE_STAGE,'operation.lock'),3221225472,0,[IntPtr]::Zero,4,0x00200000,[IntPtr]::Zero)
    if ($lock.IsInvalid) { $lock.Dispose(); throw 'busy' }
    $handles.Add($lock)
  }
  [Console]::Out.WriteLine('RESTORE_GUARD_READY')
  [void][Console]::ReadLine()
} catch {
  if ($created) { try { [IO.Directory]::Delete($env:PAPERECHO_RESTORE_STAGE,$false) } catch {} }
  [Console]::Error.Write('RESTORE_GUARD_FAILED'); exit 1
} finally { foreach ($h in $handles) { $h.Dispose() } }
`;
export async function holdRestoreParent(stage, { existing = false, exclusive = false } = {}) {
  if (process.platform !== 'win32' || !/^[A-Za-z]:[\\/]/.test(stage)) throw restoreError('RESTORE_PLATFORM_UNVERIFIED');
  const ancestors = []; for (let p = path.dirname(stage); ; p = path.dirname(p)) { ancestors.unshift(p); if (p === path.dirname(p)) break; }
  const env = Object.fromEntries(['SystemRoot', 'PATH', 'TEMP', 'TMP', 'USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
  Object.assign(env, { PAPERECHO_RESTORE_STAGE: stage, PAPERECHO_RESTORE_ANCESTORS: Buffer.from(JSON.stringify(ancestors)).toString('base64'), PAPERECHO_RESTORE_EXISTING: existing ? '1' : '', PAPERECHO_RESTORE_EXCLUSIVE: exclusive ? '1' : '' });
  const child = spawn(process.env.PWSH_PATH || 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let closed = false; let ready = false;
  const completion = new Promise(resolve => { child.once('close', code => { closed = true; resolve(code); }); });
  child.stdin.on('error', () => {}); child.stderr.on('data', () => {});
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(restoreError('RESTORE_GUARD_UNAVAILABLE')); }, 15000);
      child.once('error', () => { clearTimeout(timer); reject(restoreError('RESTORE_GUARD_UNAVAILABLE')); });
      child.once('close', () => { clearTimeout(timer); if (!ready) reject(restoreError('RESTORE_GUARD_UNAVAILABLE')); });
      let text = ''; child.stdout.on('data', chunk => {
        text = (text + chunk).slice(-128);
        if (text.trim() === 'RESTORE_GUARD_READY') { ready = true; clearTimeout(timer); resolve(); }
      });
    });
  } catch (error) { child.kill(); await completion; throw error; }
  return {
    assertHeld() { if (closed || !ready) throw restoreError('RESTORE_GUARD_LOST'); },
    async release() {
      child.stdin.end('\n'); const timer = setTimeout(() => child.kill(), 5000);
      try { if (await completion !== 0) throw restoreError('RESTORE_GUARD_RELEASE_FAILED'); } finally { clearTimeout(timer); }
    },
  };
}
