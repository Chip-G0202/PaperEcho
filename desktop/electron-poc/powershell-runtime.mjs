// Build-only: official self-contained ZIP, never a host installation or PATH edit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const powershell = Object.freeze({ version: '7.6.5',
  url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.5/PowerShell-7.6.5-win-x64.zip',
  sha256: '32eb8f6cdce08f86e987d625a2733e54ac3e289ae7e1621b14c0b5bcec2434ea' });
const cache = fileURLToPath(new URL('../../tests/runs/powershell-cache/', import.meta.url));
export function runtimeEntry(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 512
    && !/[\\:\u0000-\u001f]/.test(name) && !name.startsWith('/')
    && name.split('/').every(part => part && part !== '.' && part !== '..' && !/[. ]$/.test(part));
}
export async function bundlePowerShell(destination) {
  await fs.mkdir(cache, { recursive: true });
  const archive = path.join(cache, `PowerShell-${powershell.version}-win-x64.zip`);
  let bytes;
  try { bytes = await fs.readFile(archive); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(powershell.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok || Number(response.headers.get('content-length')) > 200 * 1024 ** 2) throw new Error('POWERSHELL_DOWNLOAD_FAILED');
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length > 200 * 1024 ** 2 || createHash('sha256').update(bytes).digest('hex') !== powershell.sha256) throw new Error('POWERSHELL_ARCHIVE_HASH_MISMATCH');
  try { await fs.writeFile(archive, bytes, { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  const zip = await JSZip.loadAsync(bytes), entries = Object.values(zip.files).filter(entry => !entry.dir);
  let total = 0; const seen = new Set();
  if (entries.length > 6000) throw new Error('POWERSHELL_ARCHIVE_INVALID');
  await fs.mkdir(destination); // Exclusive fresh build directory; never overlay a runtime.
  for (const entry of entries) {
    const name = entry.unsafeOriginalName || entry.name;
    if (!runtimeEntry(name) || name !== entry.name || seen.has(name.toLowerCase()) || ((entry.unixPermissions || 0) & 0o170000) === 0o120000) throw new Error('POWERSHELL_ARCHIVE_INVALID');
    seen.add(name.toLowerCase());
    const data = await entry.async('nodebuffer'); total += data.length;
    if (total > 1024 ** 3) throw new Error('POWERSHELL_ARCHIVE_INVALID');
    const file = path.join(destination, name); await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, data, { flag: 'wx' });
  }
  for (const name of ['pwsh.exe', 'pwsh.dll', 'System.Management.Automation.dll', 'LICENSE.txt', 'ThirdPartyNotices.txt']) {
    if (!seen.has(name.toLowerCase())) throw new Error('POWERSHELL_RESOURCE_MISSING');
  }
  const { stdout } = await promisify(execFile)(path.join(destination, 'pwsh.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write("$($PSVersionTable.PSVersion)|$($PSVersionTable.PSEdition)")'], { windowsHide: true, timeout: 15000, maxBuffer: 128 });
  if (stdout !== `${powershell.version}|Core`) throw new Error('POWERSHELL_RESOURCE_VERSION_MISMATCH');
}
