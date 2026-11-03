// Host preparation only. This module never installs software or changes OS tasks.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const xml = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function sandboxConfiguration(input, output, { entrypoint = 'boundary.cmd' } = {}) {
  if (![input, output].every(p => path.win32.isAbsolute(p) && !/[\r\n"%]/.test(p)) || input.toLowerCase() === output.toLowerCase()) throw new Error('SANDBOX_MAPPING_INVALID');
  let root = path.win32.join(repo, '.sandbox-lab');
  if (entrypoint === 'installer.cmd') {
    const runId = path.win32.basename(path.win32.dirname(input));
    if (!/^[a-f0-9-]{36}$/.test(runId)) throw new Error('SANDBOX_MAPPING_INVALID');
    root = path.win32.join(root, 'phase3a', runId);
  } else if (entrypoint !== 'boundary.cmd') throw new Error('SANDBOX_MAPPING_INVALID');
  if (path.win32.resolve(input).toLowerCase() !== path.win32.join(root, 'input').toLowerCase()
    || path.win32.resolve(output).toLowerCase() !== path.win32.join(root, 'output').toLowerCase()) throw new Error('SANDBOX_MAPPING_INVALID');
  return `<Configuration>
  <vGPU>Disable</vGPU>
  <Networking>Disable</Networking>
  <ClipboardRedirection>Disable</ClipboardRedirection>
  <PrinterRedirection>Disable</PrinterRedirection>
  <VideoInput>Disable</VideoInput>
  <AudioInput>Disable</AudioInput>
  <ProtectedClient>Enable</ProtectedClient>
  <MappedFolders>
    <MappedFolder><HostFolder>${xml(input)}</HostFolder><SandboxFolder>C:\\PaperEchoLab\\Input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder>
    <MappedFolder><HostFolder>${xml(output)}</HostFolder><SandboxFolder>C:\\PaperEchoLab\\Output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder>
  </MappedFolders>
  <LogonCommand><Command>C:\\Windows\\System32\\cmd.exe /d /s /c &quot;&quot;C:\\PaperEchoLab\\Input\\${entrypoint}&quot;&quot;</Command></LogonCommand>
</Configuration>\n`;
}
export async function directoriesSafe(root) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    const s = await fs.lstat(dir);
    if (s.isSymbolicLink() || !s.isDirectory()) throw new Error('SANDBOX_DIRECTORY_UNSAFE');
    if (dir === repo) break;
    if (dir === path.dirname(dir)) throw new Error('SANDBOX_DIRECTORY_UNSAFE');
  }
}
export async function prepareBoundary() {
  const root = path.join(repo, '.sandbox-lab');
  // Re-running must never overwrite an existing handoff or a guest's evidence.
  await fs.mkdir(root);
  await directoriesSafe(root);
  const input = path.join(root, 'input'), output = path.join(root, 'output');
  await fs.mkdir(input); await fs.mkdir(output);
  const runId = randomUUID();
  await fs.writeFile(path.join(input, 'challenge.txt'), runId, { flag: 'wx' });
  const source = fileURLToPath(new URL('./sandbox-boundary.js', import.meta.url));
  await fs.copyFile(source, path.join(input, 'boundary.js'), fs.constants.COPYFILE_EXCL);
  await fs.writeFile(path.join(input, 'boundary.cmd'), '@echo off\r\nsetlocal\r\n"%SystemRoot%\\System32\\cscript.exe" //nologo "C:\\PaperEchoLab\\Input\\boundary.js"\r\nexit /b %errorlevel%\r\n', { flag: 'wx' });
  await fs.writeFile(path.join(root, 'PaperEcho-boundary.wsb'), sandboxConfiguration(input, output), { flag: 'wx' });
  const files = {};
  for (const name of ['challenge.txt', 'boundary.js', 'boundary.cmd']) files[name] = createHash('sha256').update(await fs.readFile(path.join(input, name))).digest('hex');
  await fs.writeFile(path.join(root, 'handoff.json'), JSON.stringify({ schemaVersion: 1, runId, purpose: 'BOUNDARY_ONLY_NO_OS_MUTATION', files }), { flag: 'wx' });
  return { runId, configuration: '.sandbox-lab/PaperEcho-boundary.wsb', status: 'AWAITING_REAL_GUEST' };
}
export async function readBoundaryReport() {
  const root = path.join(repo, '.sandbox-lab'); await directoriesSafe(root);
  for (const dir of ['input', 'output']) await directoriesSafe(path.join(root, dir));
  const record = JSON.parse(await fs.readFile(path.join(root, 'handoff.json'), 'utf8'));
  if (record.schemaVersion !== 1 || record.purpose !== 'BOUNDARY_ONLY_NO_OS_MUTATION'
    || !/^[a-f0-9-]{36}$/.test(record.runId) || Object.keys(record.files || {}).sort().join() !== 'boundary.cmd,boundary.js,challenge.txt') throw new Error('SANDBOX_HANDOFF_INVALID');
  for (const [name, expected] of Object.entries(record.files)) {
    if (!['challenge.txt', 'boundary.js', 'boundary.cmd'].includes(name)) throw new Error('SANDBOX_HANDOFF_INVALID');
    const s = await fs.lstat(path.join(root, 'input', name));
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 65536) throw new Error('SANDBOX_HANDOFF_INVALID');
    if (createHash('sha256').update(await fs.readFile(path.join(root, 'input', name))).digest('hex') !== expected) throw new Error('SANDBOX_HANDOFF_CHANGED');
  }
  const file = path.join(root, 'output/boundary-result.json'), s = await fs.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 8192) throw new Error('SANDBOX_REPORT_UNSAFE');
  const report = JSON.parse(await fs.readFile(file, 'utf8'));
  const names = ['guestUser', 'guestProfile', 'microsoftVirtualMachine', 'containerService', 'scriptLocation', 'mappedFolders'];
  if (report.schemaVersion !== 1 || report.runId !== record.runId || report.stage !== 'SANDBOX_BOUNDARY'
    || !['READY_FOR_TEST', 'BLOCKED'].includes(report.status) || report.osModifications !== 0
    || Object.keys(report.checks || {}).sort().join() !== names.sort().join()
    || Object.values(report.checks).some(x => typeof x !== 'boolean')) throw new Error('SANDBOX_REPORT_INVALID');
  if (report.status === 'READY_FOR_TEST' && !Object.values(report.checks).every(Boolean)) throw new Error('SANDBOX_REPORT_INVALID');
  return { schemaVersion: 1, runId: report.runId, stage: report.stage, status: report.status, checks: report.checks, osModifications: 0 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['--prepare', '--read'].includes(process.argv[2]) || process.argv.length !== 3) throw new Error('SANDBOX_ARGUMENT_INVALID');
    console.log(JSON.stringify(process.argv[2] === '--prepare' ? await prepareBoundary() : await readBoundaryReport()));
  } catch (e) { console.error(/^(?:SANDBOX_[A-Z_]+|EEXIST|ENOENT)$/.test(e.message) ? e.message : e.code === 'EEXIST' ? 'SANDBOX_HANDOFF_ALREADY_EXISTS' : e.code === 'ENOENT' ? 'SANDBOX_REPORT_NOT_AVAILABLE' : 'SANDBOX_PREPARATION_FAILED'); process.exitCode = 2; }
}
