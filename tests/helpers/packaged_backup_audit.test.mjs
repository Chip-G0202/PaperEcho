// Read-only embedded-runtime Gate. No MSI, workflow or external service is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upgradeFixture, upgradePassword, upgradeFileHashes } from './upgrade_fixture.mjs';
import { verifyReleaseArtifact } from '../../desktop/electron-poc/release.mjs';

test('packaged read-only backup data audit preserves data and rejects mismatches with empty PATH outside repository cwd', async t => {
  assert.equal(process.platform, 'win32');
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const application = process.env.PAPERECHO_TEST_PACKAGED_ROOT;
  assert.ok(path.isAbsolute(application || ''), 'TEST_PACKAGED_ROOT_REQUIRED');
  await verifyReleaseArtifact({ root: application, parent: path.join(repo, 'tests/runs/phase2b') });
  for (const source of ['workflow/tools/lib/backup_service.mjs', 'workflow/tools/runner/backup.mjs', 'workflow/tools/runner/main.mjs', 'desktop/electron-poc/headless.mjs']) {
    assert.deepEqual(await fs.readFile(path.join(application, 'resources/core', source)), await fs.readFile(path.join(repo, source)), 'STALE_PACKAGED_AUDIT_SOURCE');
  }
  const f = await upgradeFixture(t, { layout: 'installed', legacy: false });
  const temp = path.join(f.data, '.cache/tmp'); await fs.mkdir(temp, { recursive: true });
  const exe = path.join(application, 'PaperEcho.exe');
  const env = { PATH: '', SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, USERPROFILE: process.env.USERPROFILE,
    LOCALAPPDATA: process.env.LOCALAPPDATA, PWSH_PATH: process.env.PWSH_PATH, ELECTRON_RUN_AS_NODE: '1',
    PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: f.data, PAPERECHO_SKIP_DOTENV: '1', TEMP: temp, TMP: temp };
  const invoke = () => new Promise((resolve, reject) => {
    const child = spawn(exe, [path.join(application, 'resources/core/desktop/electron-poc/headless.mjs'), '--verify-backup-data', f.backup, '--password-stdin'],
      { cwd: os.tmpdir(), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('PACKAGED_AUDIT_TIMEOUT')); }, 60000);
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.stdin.on('error', () => {}); child.stdin.end(Buffer.concat([upgradePassword(), Buffer.from('\n')]));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      try {
        assert.ok(!output.includes(upgradePassword().toString()) && !output.includes('dummy-upgrade-local-secret'));
        assert.throws(() => process.kill(child.pid, 0), 'PACKAGED_AUDIT_PROCESS_REMAINS');
        resolve({ code, report: JSON.parse(output) });
      } catch (error) { reject(error); }
    });
  });
  const before = await upgradeFileHashes(f.data);
  const ok = await invoke(); assert.equal(ok.code, 0); assert.equal(ok.report.status, 'data-preserved');
  assert.equal(ok.report.installerAuthorization, false); assert.equal(ok.report.readOnly, true);
  assert.deepEqual(await upgradeFileHashes(f.data), before);
  const input = path.join(f.data, 'input.json'), bytes = await fs.readFile(input);
  await fs.appendFile(input, '\n');
  const modified = await upgradeFileHashes(f.data);
  const changed = await invoke(); assert.notEqual(changed.code, 0); assert.equal(changed.report.code, 'BACKUP_DATA_MISMATCH');
  assert.deepEqual(await upgradeFileHashes(f.data), modified);
  await fs.unlink(input); const missingBefore = await upgradeFileHashes(f.data);
  const missing = await invoke(); assert.notEqual(missing.code, 0); assert.equal(missing.report.code, 'BACKUP_DATA_MISMATCH');
  assert.deepEqual(await upgradeFileHashes(f.data), missingBefore);
  await fs.writeFile(input, bytes); assert.deepEqual(await upgradeFileHashes(f.data), before);
});
