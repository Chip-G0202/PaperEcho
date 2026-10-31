// Envelope only: keep the existing Packager runtime, fuses and source allowlist.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { build as buildRuntime, repo } from './package-win.mjs';
import { verifyReleaseArtifact } from './release.mjs';
import { appVersion } from './package-policy.mjs';
import { build, Platform, Arch } from 'electron-builder';

export function setupConfiguration(output, filename) {
  return {
    appId: 'com.electron.paperecho', productName: 'PaperEcho', electronVersion: '44.7.2',
    directories: { output }, artifactName: filename, forceCodeSigning: false, publish: null,
    win: { target: ['nsis'], signAndEditExecutable: false },
    nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false,
      runAfterFinish: false, deleteAppDataOnUninstall: false, packElevateHelper: false,
      differentialPackage: false, include: fileURLToPath(new URL('./setup-guard.nsh', import.meta.url)) },
  };
}

export async function buildSetup() {
  // The reused runtime builder verifies its bundled PowerShell by executing pwsh.exe.
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_RUNNER_REQUIRED');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json', 'workflow/tools', 'config', 'skills', 'desktop/electron-poc', '.github/workflows'], { cwd: repo }).length > 0;
  if (dirty || (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== commit)) throw new Error('COMMITTED_BUILD_INPUTS_REQUIRED');
  const runtime = await buildRuntime();
  const identity = await verifyReleaseArtifact({ root: runtime, parent: path.dirname(runtime), expectedCommit: commit });
  if (identity.dirty || identity.appVersion !== appVersion) throw new Error('SETUP_INPUT_IDENTITY_MISMATCH');
  const stage = await fs.mkdtemp(path.join(repo, 'tests/runs/phase2b/setup-'));
  const project = path.join(stage, 'project'); await fs.mkdir(project);
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'paperecho', version: appVersion, description: 'PaperEcho desktop', author: 'PaperEcho contributors', main: 'main.mjs' }));
  const filename = `PaperEcho-${appVersion}-win32-x64-${commit.slice(0, 8)}-Setup.exe`;
  const output = path.join(stage, 'artifact');
  await build({ projectDir: project, prepackaged: runtime, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
    publish: 'never', config: setupConfiguration(output, filename) });
  const file = path.join(output, filename), bytes = await fs.readFile(file);
  if (bytes.length < 1024 || bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('SETUP_EXE_MISSING');
  const report = { version: appVersion, platform: 'win32', architecture: 'x64', gitCommit: commit, dirty: false,
    filename, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
    runtimeArtifactId: identity.artifactId, installer: 'NSIS', scope: 'CURRENT_USER', signed: false,
    installationAndUninstallation: 'NOT_TESTED', msiMigration: 'BLOCKED_USE_MANUAL_BACKUP_AND_UNINSTALL' };
  await fs.writeFile(file + '.sha256', `${report.sha256}  ${filename}\n`, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'setup-build.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ ...report, outputPath: file }));
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSetup();
