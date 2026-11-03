import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { transactionFixture, fileHashes } from '../../tests/helpers/restore_transaction_fixture.mjs';
import { inspectRestoreTransaction, restoreTransactionRoot, restoreIdentity } from '../tools/recovery/restore_transaction_status.mjs';

const crashPhases = ['PREPARING', 'STAGING_BEFORE', 'STAGING_staging-created', 'STAGING_before-publish', 'PREPARED', 'PRESERVING', 'OLD_PRESERVED',
  'PUBLISHING', 'NEW_PUBLISHED', 'VERIFIED', 'COMMITTED', 'ROLLBACK', 'ROLLBACK_NEW_PRESERVED', 'ROLLBACK_OLD_RETURNED', 'ROLLED_BACK', 'RECOVERY_REQUIRED'];
function waitForPhase(child, target, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    let timer, previous = -1;
    const finish = (error, value) => {
      clearTimeout(timer); child.off('message', message); child.off('close', close); child.off('error', fail);
      if (error) reject(error); else resolve(value);
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish(new Error('TEST_CHILD_PHASE_TIMEOUT')), timeoutMs); };
    const fail = error => finish(error);
    const close = (code, signal) => finish(new Error('TEST_CHILD_EXIT_' + code + '_' + signal));
    const message = value => {
      const index = crashPhases.indexOf(value?.phase);
      if (index < 0 || index < previous || value.error) return finish(new Error(value?.error || 'TEST_CHILD_PHASE_INVALID'));
      if (index === previous) return; // Duplicate PREPARING cannot prolong a stalled operation.
      previous = index;
      if (value.phase === target) return finish(null, value);
      // ponytail: finite ordered checkpoints, each bounded by the same 60s of no progress; no heartbeat or retry.
      arm();
    };
    child.on('message', message); child.once('close', close); child.once('error', fail); arm();
  });
}

test('crash phase wait accepts only ordered progress and the exact target, and never hides exit or stalled children', async () => {
  const child = new EventEmitter(); const pending = waitForPhase(child, 'OLD_PRESERVED');
  child.emit('message', { phase: 'PREPARING' }); child.emit('message', { phase: 'PREPARING' });
  child.emit('message', { phase: 'PREPARED' }); child.emit('message', { phase: 'PRESERVING' });
  child.emit('message', { phase: 'OLD_PRESERVED' }); assert.equal((await pending).phase, 'OLD_PRESERVED');
  for (const event of ['message', 'close', 'error']) assert.equal(child.listenerCount(event), 0);
  const stalled = waitForPhase(child, 'PRESERVING', 10);
  child.emit('message', { phase: 'PREPARING' }); child.emit('message', { phase: 'PREPARING' });
  await assert.rejects(stalled, /TEST_CHILD_PHASE_TIMEOUT/);
  const exited = waitForPhase(child, 'PRESERVING'); child.emit('close', 1, null);
  await assert.rejects(exited, /TEST_CHILD_EXIT_1_null/);
  const invalid = waitForPhase(child, 'PRESERVING'); child.emit('message', { phase: 'PREPARED' }); child.emit('message', { phase: 'PREPARING' });
  await assert.rejects(invalid, /TEST_CHILD_PHASE_INVALID/);
});

async function terminateAt(f, phase, fault = '') {
  const encoded = Buffer.from(JSON.stringify({ env: f.env, input: f.input, target: f.target })).toString('base64');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../tests/helpers/restore_transaction_child.mjs', import.meta.url)), 'replace', encoded, phase, fault],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(child, 'close');
  try {
    const message = await waitForPhase(child, phase);
    assert.equal(message.phase, phase, message.error || 'missing crash phase');
    if (phase === 'PRESERVING' || phase === 'OLD_PRESERVED') {
      assert.equal(inspectRestoreTransaction(f.target).state, phase);
      const root = restoreTransactionRoot(f.target), record = JSON.parse(await fs.readFile(path.join(root, 'status.json')));
      const old = phase === 'PRESERVING' ? f.target : path.join(root, 'old');
      assert.equal(restoreIdentity(await fs.lstat(old)), record.oldIdentity);
      await assert.rejects(fs.lstat(phase === 'PRESERVING' ? path.join(root, 'old') : f.target), error => error.code === 'ENOENT');
    }
  } finally { child.kill('SIGKILL'); await closed; }
  assert.throws(() => process.kill(child.pid, 0));
}

test('real process termination at staging, switch, verification and rollback windows preserves old state and recovery is idempotent', async t => {
  for (const [phase, fault] of [['STAGING_BEFORE'], ['STAGING_staging-created'], ['STAGING_before-publish'], ['PREPARED'], ['PRESERVING'], ['OLD_PRESERVED'], ['PUBLISHING'], ['NEW_PUBLISHED'], ['VERIFIED'], ['ROLLBACK_NEW_PRESERVED', 'NEW_PUBLISHED'], ['ROLLBACK_OLD_RETURNED', 'NEW_PUBLISHED']]) {
    await t.test(phase, async t => {
      const f = await transactionFixture(t), before = await fileHashes(f.target), archive = await fs.readFile(f.input);
      await terminateAt(f, phase, fault);
      assert.equal(inspectRestoreTransaction(f.target).blocking, true);
      const result = await f.make().recover({ target: f.target, confirm: async () => true }); assert.equal(result.status, 'rolled-back');
      assert.deepEqual(await fileHashes(f.target), before); assert.deepEqual(await fs.readFile(f.input), archive);
      assert.equal((await f.make().recover({ target: f.target })).status, 'rolled-back');
      assert.equal(inspectRestoreTransaction(f.target).blocking, false);
    });
  }
});

test('completed transaction survives lost response; ambiguous identity and damaged journal fail closed without deletion', async t => {
  const f = await transactionFixture(t); await terminateAt(f, 'COMMITTED');
  assert.equal((await f.make().recover({ target: f.target })).status, 'committed');
  const root = restoreTransactionRoot(f.target); const before = await fileHashes(f.target), old = await fileHashes(path.join(root, 'old'));
  const saved = await fs.readFile(path.join(root, 'status.json')); await fs.writeFile(path.join(root, 'status.json'), '{}');
  await assert.rejects(f.make().recover({ target: f.target }), /RESTORE_RECOVERY_REQUIRED/);
  assert.equal(inspectRestoreTransaction(f.target).blocking, true); assert.deepEqual(await fileHashes(f.target), before); assert.deepEqual(await fileHashes(path.join(root, 'old')), old);
  await fs.writeFile(path.join(root, 'status.json'), saved);
  await fs.rename(f.target, path.join(f.home, 'preserved-other')); await fs.mkdir(f.target);
  await assert.rejects(f.make().recover({ target: f.target }), /RESTORE_RECOVERY_REQUIRED/);
  assert.deepEqual(await fs.readdir(f.target), []); assert.deepEqual(await fileHashes(path.join(root, 'old')), old);
});
