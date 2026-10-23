import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { packager } from '@electron/packager';
import { flipFuses, getCurrentFuseWire, FuseV1Options as F, FuseState } from '@electron/fuses';
import { appVersion, sourceAllowed, fuseConfig } from './package-policy.mjs';
export { sourceAllowed, fuseConfig } from './package-policy.mjs';
import { createReleaseManifest } from './release.mjs';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export async function build() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_BUILD_REQUIRED');
  const base = path.join(repo, 'tests/runs/phase2b'); await fs.mkdir(base, { recursive: true });
  const stage = await fs.mkdtemp(path.join(base, 'build-'));
  const shell = path.join(stage, 'shell'); const core = path.join(stage, 'core');
  await fs.mkdir(shell); await fs.mkdir(core);
  const tracked = execFileSync('git', ['ls-files', '-z', 'workflow/tools', 'skills', 'config'], { cwd: repo }).toString().split('\0').filter(Boolean);
  tracked.push('workflow/tools/lib/os_scheduler.mjs', 'workflow/tools/runner/os_scheduler.mjs', 'workflow/tools/lib/os_scheduler_management.mjs', 'workflow/tools/lib/windows_task_scheduler.mjs');
  tracked.push('workflow/tools/lib/upgrade_preflight_service.mjs', 'workflow/tools/runner/upgrade.mjs');
  tracked.push('workflow/tools/lib/upgrade_migration_service.mjs');
  tracked.push('workflow/tools/lib/backup_service.mjs', 'workflow/tools/lib/backup_format.mjs', 'workflow/tools/runner/backup.mjs');
  tracked.push('workflow/tools/lib/restore_service.mjs', 'workflow/tools/lib/restore_filesystem.mjs');
  tracked.push('workflow/tools/recovery/restore_transaction.mjs', 'workflow/tools/recovery/restore_transaction_status.mjs');
  const sources = [...new Set([...tracked, 'workflow/tools/lib/control_support_bundle_service.mjs', 'workflow/tools/lib/runtime_logging.mjs', 'workflow/tools/lib/control_setup_service.mjs', 'workflow/tools/lib/control_doctor_service.mjs', 'workflow/tools/runner/doctor.mjs', 'desktop/electron-poc/runtime.mjs', 'desktop/electron-poc/headless.mjs', 'desktop/electron-poc/main.mjs', 'desktop/electron-poc/shell.mjs', 'tests/helpers/electron_smoke.mjs', 'tests/helpers/first_run_smoke.mjs', 'tests/helpers/packaged_probe.mjs'])].filter(sourceAllowed);
  for (const file of sources) { const target = path.join(core, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(repo, file), target); }
  const metadata = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(core, 'package.json'), JSON.stringify({ name: 'paperecho-core', version: appVersion, private: true, type: 'module', dependencies: metadata.dependencies }));
  // npm's installed production tree is copied once; no Electron/build dependencies enter core.
  const installed = execFileSync(process.execPath, [process.env.npm_execpath, 'ls', '--omit=dev', '--all', '--parseable'], { cwd: repo }).toString().trim().split(/\r?\n/).slice(1);
  const modules = installed.filter(file => !installed.some(parent => parent !== file && file.startsWith(parent + path.sep)));
  for (const directory of modules) {
    assert.ok(directory.startsWith(path.join(repo, 'node_modules') + path.sep));
    await fs.cp(directory, path.join(core, path.relative(repo, directory)), { recursive: true, dereference: false });
  }
  for (const file of ['main.mjs', 'shell.mjs']) await fs.copyFile(path.join(repo, 'desktop/electron-poc', file), path.join(shell, file));
  await fs.writeFile(path.join(shell, 'package.json'), JSON.stringify({ name: 'paperecho', productName: 'PaperEcho', author: 'PaperEcho contributors', version: appVersion, private: true, type: 'module', main: 'main.mjs' }));
  // Official checksums shipped in the locked Electron package also validate cached ZIPs offline.
  const electron = JSON.parse(await fs.readFile(new URL('./node_modules/electron/package.json', import.meta.url), 'utf8'));
  assert.equal(electron.version, '44.7.2');
  const checksums = JSON.parse(await fs.readFile(new URL('./node_modules/electron/checksums.json', import.meta.url), 'utf8'));
  const outputs = await packager({ dir: shell, name: 'PaperEcho', appVersion, electronVersion: '44.7.2', platform: 'win32', arch: 'x64', asar: true,
    extraResource: [core], prune: false, out: path.join(stage, 'output'), tmpdir: path.join(stage, 'tmp'),
    download: { cacheRoot: path.join(repo, 'tests/runs/electron-cache'), checksums } });
  const output = outputs[0]; const exe = path.join(output, 'PaperEcho.exe');
  await flipFuses(exe, fuseConfig);
  const wire = await getCurrentFuseWire(exe);
  for (const key of Object.values(F).filter(x => typeof x === 'number')) assert.equal(wire[key], fuseConfig[key] ? FuseState.ENABLE : FuseState.DISABLE);
  await fs.writeFile(path.join(output, 'PaperEcho-headless.cmd'), '@echo off\r\nsetlocal\r\nset "NODE_OPTIONS="\r\nset "NODE_PATH="\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"%~dp0PaperEcho.exe" "%~dp0resources\\core\\desktop\\electron-poc\\headless.mjs" %*\r\nexit /b %errorlevel%\r\n');
  const modulePaths = modules.map(x => path.relative(repo, x).replaceAll('\\', '/'));
  const gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'package.json', 'package-lock.json', 'workflow/tools', 'config', 'skills', 'desktop/electron-poc'], { cwd: repo }).length > 0;
  const manifest = await createReleaseManifest({ root: output, parent: path.join(stage, 'output'), sources, modules: modulePaths,
    gitCommit, dirty, builtAt: new Date().toISOString() });
  await fs.writeFile(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  await fs.writeFile(path.join(stage, 'build-report.json'), JSON.stringify({ output, sources, modules: modulePaths, fuses: wire, artifactId: manifest.artifactId }));
  await fs.writeFile(path.join(base, 'latest-build.json'), JSON.stringify({ output, report: path.join(stage, 'build-report.json') }));
  console.log('PACKAGED_WINDOWS_OUTPUT ' + output);
  return output;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
