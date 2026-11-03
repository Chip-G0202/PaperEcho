import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const self = fileURLToPath(import.meta.url);
const sourceService = new URL('../../workflow/tools/lib/upgrade_migration_service.mjs', import.meta.url).href;
export const migrationChildEnvironment = () => Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'USERPROFILE', 'PWSH_PATH'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
export function blockMigrationNetwork() {
  let calls = 0;
  const slots = [[globalThis, 'fetch'], [net, 'connect'], [net, 'createConnection'], [tls, 'connect'], [http, 'request'], [http, 'get'], [https, 'request'], [https, 'get']];
  const original = slots.map(([owner, key]) => owner[key]);
  for (const [owner, key] of slots) owner[key] = () => { calls++; throw new Error('MIGRATION_EXTERNAL_CALL_FORBIDDEN'); };
  syncBuiltinESMExports();
  return { get calls() { return calls; }, restore() { slots.forEach(([owner, key], i) => { owner[key] = original[i]; }); syncBuiltinESMExports(); } };
}
export async function recoverMigrationInFreshProcess(f, { rollback = false } = {}) {
  const encoded = Buffer.from(JSON.stringify({ env: f.hostEnv, workspace: f.root })).toString('base64');
  const child = spawn(process.execPath, [self, sourceService, encoded, 'RECOVER_ONLY', rollback ? 'rollback' : ''],
    { env: migrationChildEnvironment(), windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const messages = []; child.on('message', value => messages.push(value));
  const closed = once(child, 'close'); const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  try {
    const [code, signal] = await closed;
    assert.equal(signal, null, 'fresh recovery must exit normally'); assert.equal(code, 0, messages[0]?.error);
    assert.equal(messages.length, 1); assert.equal(messages[0].externalCalls, 0);
    await waitExited(child.pid); return messages[0].result;
  } finally { clearTimeout(timer); }
}
export async function waitExited(pid) {
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
  const network = blockMigrationNetwork();
  const { UpgradeMigrationService } = await import(serviceURL);
  let guardPids = [];
  const service = new UpgradeMigrationService({ env, hook: async (phase, details) => {
    if (phase === 'UPGRADE_GUARDS_HELD') guardPids = details.guardPids;
    if (phase === step) {
      assert.equal(network.calls, 0, 'migration must not attempt external calls before interruption');
      process.send({ phase, guardPids, runtime: { embedded: Boolean(process.versions.electron), browserProcess: process.type === 'browser' } });
      await new Promise(() => {});
    }
    if (phase === fault) throw new Error('DUMMY_MIGRATION_FAULT');
  } });
  const password = Buffer.from('dummy-upgrade-fixture-password');
  try {
    if (step === 'RECOVER_ONLY') {
      const result = await service.recover({ workspace, rollback: fault === 'rollback', confirm: async () => true });
      assert.equal(network.calls, 0); process.send({ result: { status: result.status, operationId: result.operationId }, externalCalls: network.calls });
    } else { await service.execute({ workspace, password, confirm: async () => true }); process.send({ error: 'MIGRATION_PHASE_NOT_REACHED' }); process.exitCode = 1; }
  }
  catch (error) { const code = error.code || error.message; process.send({ error: /^[A-Z_]+$/.test(code || '') ? code : 'MIGRATION_CHILD_FAILED' }); process.exitCode = 1; }
  finally { password.fill(0); process.disconnect(); }
}
