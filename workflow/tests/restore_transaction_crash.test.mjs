import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { transactionFixture, fileHashes } from '../../tests/helpers/restore_transaction_fixture.mjs';
import { inspectRestoreTransaction, restoreTransactionRoot } from '../tools/recovery/restore_transaction_status.mjs';

async function terminateAt(f, phase, fault = '') {
  const encoded = Buffer.from(JSON.stringify({ env: f.env, input: f.input, target: f.target })).toString('base64');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../tests/helpers/restore_transaction_child.mjs', import.meta.url)), 'replace', encoded, phase, fault],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = once(child, 'close'); let timer;
  try {
    const message = await Promise.race([once(child, 'message').then(([value]) => value), closed.then(([code, signal]) => { throw new Error('TEST_CHILD_EXIT_' + code + '_' + signal); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TEST_CHILD_PHASE_TIMEOUT')), 60000); })]);
    assert.equal(message.phase, phase, message.error || 'missing crash phase');
  } finally { clearTimeout(timer); child.kill('SIGKILL'); await closed; }
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
