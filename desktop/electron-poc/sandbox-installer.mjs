// Host handoff/reader only. All install/uninstall commands live in the guest script.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { sandboxConfiguration, directoriesSafe, readBoundaryReport } from './sandbox-lab.mjs';
const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function prepareInstallerSandbox({ negativeOnly = false } = {}) {
  if ((await readBoundaryReport()).status !== 'READY_FOR_TEST') throw new Error('SANDBOX_BOUNDARY_REQUIRED');
  const artifact = JSON.parse(await fs.readFile(path.join(repo, 'tests/runs/phase3a/latest-installer.json')));
  if (artifact.testOnly !== true || !/^\{[A-F0-9-]{36}\}$/.test(artifact.productCode)) throw new Error('INSTALLER_HANDOFF_INVALID');
  const msi = await fs.readFile(artifact.msi);
  if (hash(msi) !== artifact.sha256) throw new Error('INSTALLER_HASH_CHANGED');
  const pwsh = process.env.PWSH_PATH;
  if (!pwsh || !path.isAbsolute(pwsh) || path.basename(pwsh).toLowerCase() !== 'pwsh.exe') throw new Error('APPROVED_PWSH_7_REQUIRED');
  const runId = randomUUID(), base = path.join(repo, '.sandbox-lab/phase3a');
  await fs.mkdir(base, { recursive: true }); await directoriesSafe(base);
  const root = path.join(base, runId); await fs.mkdir(root); await directoriesSafe(root);
  const input = path.join(root, 'input'), output = path.join(root, 'output'); await fs.mkdir(input); await fs.mkdir(output);
  await fs.writeFile(path.join(input, 'PaperEcho-TEST-ONLY.msi'), msi, { flag: 'wx' });
  for (const [source, target] of [['sandbox_installer.ps1', 'installer-test.ps1'], ['sandbox_installer_check.mjs', 'installer-check.mjs']]) {
    await fs.copyFile(path.join(repo, 'tests/helpers', source), path.join(input, target), fs.constants.COPYFILE_EXCL);
  }
  await fs.writeFile(path.join(input, 'installer.cmd'), '@echo off\r\n"C:\\PaperEchoLab\\Input\\tools\\pwsh\\pwsh.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "C:\\PaperEchoLab\\Input\\installer-test.ps1"' + (negativeOnly ? ' -NegativeOnly' : '') + '\r\nexit /b %errorlevel%\r\n', { flag: 'wx' });
  // Only the approved public runtime installation is copied, never a user profile.
  let copied = 0, bytes = msi.length;
  async function copyRuntime(source, target) {
    const s = await fs.lstat(source); if (s.isSymbolicLink()) throw new Error('RUNTIME_LINK_REJECTED');
    if (s.isDirectory()) { await fs.mkdir(target, { recursive: true }); for (const name of await fs.readdir(source)) await copyRuntime(path.join(source, name), path.join(target, name)); }
    else {
      if (/profile\.ps1$/i.test(path.basename(source))) return;
      if (!s.isFile() || ++copied > 5000 || (bytes += s.size) > 1024 ** 3 || /^(?:\.env|.*profile\.ps1|.*\.(?:pfx|p12|pem|key))$/i.test(path.basename(source))) throw new Error('RUNTIME_COPY_UNSAFE');
      await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
    }
  }
  await copyRuntime(path.dirname(pwsh), path.join(input, 'tools/pwsh'));
  const latest = JSON.parse(await fs.readFile(path.join(repo, 'tests/runs/phase2b/latest-build.json')));
  const release = JSON.parse(await fs.readFile(path.join(latest.output, 'release-manifest.json')));
  if (release.artifactId !== artifact.artifactId) throw new Error('INSTALLER_PAYLOAD_CHANGED');
  const payload = [...release.files, { path: 'release-manifest.json', sha256: hash(await fs.readFile(path.join(latest.output, 'release-manifest.json'))) }];
  const files = [];
  async function inventory(dir) {
    for (const name of await fs.readdir(dir)) {
      const file = path.join(dir, name), s = await fs.lstat(file);
      if (s.isDirectory()) await inventory(file);
      else files.push({ path: path.relative(input, file).replaceAll('\\', '/'), sha256: hash(await fs.readFile(file)) });
    }
  }
  await inventory(input);
  const manifest = { schemaVersion: 1, runId, testOnly: true, productCode: artifact.productCode, msiSha256: artifact.sha256, files, payload };
  await fs.writeFile(path.join(input, 'test-manifest.json'), JSON.stringify(manifest), { flag: 'wx' });
  await fs.writeFile(path.join(root, 'PaperEcho-installer.wsb'), sandboxConfiguration(input, output, { entrypoint: 'installer.cmd' }), { flag: 'wx' });
  await fs.writeFile(path.join(root, 'handoff.json'), JSON.stringify({ schemaVersion: 1, runId, manifestSha256: hash(JSON.stringify(manifest)), msiSha256: artifact.sha256 }), { flag: 'wx' });
  return { runId, relativeRoot: path.relative(repo, root), status: 'AWAITING_REAL_SANDBOX_INSTALL' };
}
export async function readInstallerSandbox(runId) {
  if (!/^[a-f0-9-]{36}$/.test(runId || '')) throw new Error('SANDBOX_RUN_ID_INVALID');
  const root = path.join(repo, '.sandbox-lab/phase3a', runId); await directoriesSafe(root);
  await directoriesSafe(path.join(root, 'input')); await directoriesSafe(path.join(root, 'output'));
  const handoff = JSON.parse(await fs.readFile(path.join(root, 'handoff.json')));
  if (handoff.runId !== runId || handoff.manifestSha256 !== hash(await fs.readFile(path.join(root, 'input/test-manifest.json')))) throw new Error('SANDBOX_HANDOFF_CHANGED');
  const file = path.join(root, 'output/installer-result.json'), s = await fs.lstat(file);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 16384) throw new Error('SANDBOX_REPORT_UNSAFE');
  const report = JSON.parse(await fs.readFile(file));
  if (report.schemaVersion !== 1 || report.runId !== runId || !['SANDBOX_INSTALLER', 'SANDBOX_INSTALLER_NEGATIVE'].includes(report.stage) || report.guestIdentityVerified !== true || !['PASS', 'FAIL'].includes(report.status)) throw new Error('SANDBOX_REPORT_INVALID');
  if (report.status === 'PASS' && report.stage === 'SANDBOX_INSTALLER_NEGATIVE') {
    const step = report.steps?.[0];
    if (report.probeOnly !== true || report.steps.length !== 1 || report.msiSha256 !== handoff.msiSha256 || step.step !== 'reject-machine-scope' || step.exitCode !== 1603 || step.scopeConstraintSeen !== true || step.noMachineRegistration !== true || step.clean !== true) throw new Error('SANDBOX_REPORT_INVALID');
    return { runId, status: 'NEGATIVE_ONLY_PASS', stepCount: 1, msiSha256: report.msiSha256 };
  }
  if (report.status === 'PASS') {
    if (report.msiSha256 !== handoff.msiSha256 || report.steps.map(x => x.step).join() !== 'reject-machine-scope,install,runtime-roots,first-run-gui,headless-and-doctor,uninstall,reinstall,final-uninstall') throw new Error('SANDBOX_REPORT_INVALID');
    const required = [['rejected', 'clean'], ['installed', 'perUser'], ['defaultWorkspace', 'embeddedRuntime', 'emptyPath'],
      ['actualBrowserWindow', 'wizard', 'writeOnlyDummySecret'], ['check', 'doctorReadOnly'], ['applicationRemoved', 'secretPreserved'], ['dataBytePreserved'], ['userDataPreserved', 'noApplicationProcesses']];
    if (report.steps.some((step, i) => required[i].some(key => step[key] !== true))) throw new Error('SANDBOX_REPORT_INVALID');
    return { runId, status: 'PASS', guestIdentityVerified: true, stepCount: report.steps.length, msiSha256: report.msiSha256 };
  }
  if (!/^[a-z-]{1,50}$/.test(report.failedStep) || !/^[A-Z][A-Z0-9_]{0,80}$/.test(report.code)) throw new Error('SANDBOX_REPORT_INVALID');
  return { runId, status: 'FAIL', failedStep: report.failedStep, code: report.code, line: Number(report.line), hresult: Number(report.hresult), childExit: report.childExit, childCodes: (report.childCodes || []).filter(x => /^(?:ERR_|0x|PAPERECHO_)[A-Za-z0-9_]+$/.test(x)).slice(0, 6), msiCodes: (report.msiCodes || []).filter(Number.isInteger).slice(0, 6), lastMsiAction: /^[A-Za-z0-9_]{1,72}$/.test(report.lastMsiAction || '') ? report.lastMsiAction : null, installerServiceAtTimeout: ['Running', 'Stopped'].includes(report.installerServiceAtTimeout) ? report.installerServiceAtTimeout : null, cleanupExit: report.cleanupExit, completedSteps: report.steps.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = ['--prepare', '--prepare-negative'].includes(process.argv[2]) && process.argv.length === 3 ? await prepareInstallerSandbox({ negativeOnly: process.argv[2] === '--prepare-negative' })
    : process.argv[2] === '--read' && process.argv.length === 4 ? await readInstallerSandbox(process.argv[3]) : (() => { throw new Error('SANDBOX_ARGUMENT_INVALID'); })();
  console.log(JSON.stringify(result)); if (result.status === 'FAIL') process.exitCode = 1;
}
