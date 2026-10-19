import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const sourceService = new URL('../../workflow/tools/lib/upgrade_migration_service.mjs', import.meta.url).href;
export const migrationChildEnvironment = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'PWSH_PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
async function waitExited(pid) {
  const until = Date.now() + 5000;
  while (true) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') return; throw e; }
    if (Date.now() >= until) throw new Error('MIGRATION_GUARD_ORPHAN');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
export async function terminateMigrationAt(f, phase, { runtime = process.execPath, serviceURL = sourceService, env = migrationChildEnvironment(), fault = '', cwd } = {}) {
  const encoded = Buffer.from(JSON.stringify({ env: f.hostEnv, workspace: f.root })).toString('base64');
  const child = spawn(runtime, [self, serviceURL, encoded, phase, fault], { env, cwd, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(child, 'close'); let timer, message;
  try {
    message = await Promise.race([once(child, 'message').then(([value]) => value), closed.then(([code, signal]) => { throw new Error('MIGRATION_CHILD_EXIT_' + code + '_' + signal); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('MIGRATION_CHILD_TIMEOUT')), 90000); })]);
    assert.equal(message.phase, phase, message.error || 'MIGRATION_CHILD_PHASE_MISSING');
    assert.equal(message.guardPids.length, 2); assert.ok(message.guardPids.every(Number.isInteger));
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await closed; }
  await waitExited(child.pid); await Promise.all(message.guardPids.map(waitExited));
  return message.runtime;
}

if (process.argv[1] === self) {
  const [serviceURL, encoded, step, fault] = process.argv.slice(2);
  const { env, workspace } = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const { UpgradeMigrationService } = await import(serviceURL);
  let guardPids = [];
  const service = new UpgradeMigrationService({ env, hook: async (phase, details) => {
    if (phase === 'UPGRADE_GUARDS_HELD') guardPids = details.guardPids;
    if (phase === step) {
      process.send({ phase, guardPids, runtime: { embedded: Boolean(process.versions.electron), browserProcess: process.type === 'browser' } });
      await new Promise(() => {});
    }
    if (phase === fault) throw new Error('DUMMY_MIGRATION_FAULT');
  } });
  const password = Buffer.from('dummy-upgrade-fixture-password');
  try { await service.execute({ workspace, password, confirm: async () => true }); process.send({ error: 'MIGRATION_PHASE_NOT_REACHED' }); process.exitCode = 1; }
  catch (error) { process.send({ error: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'MIGRATION_CHILD_FAILED' }); process.exitCode = 1; }
  finally { password.fill(0); process.disconnect(); }
}
