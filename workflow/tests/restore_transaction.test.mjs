import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { transactionFixture, testPassword, fileHashes } from '../../tests/helpers/restore_transaction_fixture.mjs';
import { restoreTransactionRoot, inspectRestoreTransaction } from '../tools/recovery/restore_transaction_status.mjs';
import { secureCredentialFile } from '../tools/lib/credential_file_security.mjs';
import { writeAtomicJson, withAtomicJsonLock } from '../tools/lib/atomic_json.mjs';

test('existing-root preflight is read-only; explicit confirmation, commit and retained rollback preserve both complete states', async t => {
  const f = await transactionFixture(t), before = await fileHashes(f.target), backup = await fs.readFile(f.input);
  const preview = await f.make().preflight({ input: f.input, target: f.target, password: testPassword() });
  assert.equal(preview.status, 'preflight'); assert.equal(preview.confirmationRequired, true); assert.deepEqual(await fileHashes(f.target), before);
  assert.equal(inspectRestoreTransaction(f.target).state, 'ABSENT');
  await assert.rejects(f.replace({ confirm: async () => false }), /RESTORE_CONFIRMATION_REQUIRED/);
  const result = await f.replace(); assert.equal(result.status, 'committed'); assert.equal(result.rollbackRetained, true);
  const root = restoreTransactionRoot(f.target); assert.deepEqual(await fileHashes(path.join(root, 'old')), before);
  assert.match(await fs.readFile(path.join(f.target, '.env'), 'utf8'), /dummy-new/);
  assert.equal(inspectRestoreTransaction(f.target).state, 'COMMITTED');
  await secureCredentialFile(path.join(f.target, '.env'), { checkOnly: true });
  await assert.rejects(f.make().recover({ target: f.target, rollback: true }), /RESTORE_CONFIRMATION_REQUIRED/);
  assert.equal((await f.make().recover({ target: f.target, rollback: true, confirm: async () => true })).status, 'rolled-back');
  assert.deepEqual(await fileHashes(f.target), before);
  assert.equal((await f.make().recover({ target: f.target })).status, 'rolled-back');
  assert.deepEqual(await fs.readFile(f.input), backup);
});

test('active or uncertain leases, writer locks and ambiguous target paths reject without modifying old state', async t => {
  const f = await transactionFixture(t);
  for (const name of ['local/runs/.workflow.lease.json', 'config/paperecho.config.json.lock']) {
    await fs.writeFile(path.join(f.target, name), '{}'); const before = await fileHashes(f.target);
    await assert.rejects(f.replace(), /RESTORE_WORKSPACE_BUSY/); assert.deepEqual(await fileHashes(f.target), before); await fs.unlink(path.join(f.target, name));
  }
  await assert.rejects(f.replace({ target: f.app }));
  const link = path.join(f.home, 'linked'); await fs.symlink(f.target, link, 'junction'); await assert.rejects(f.replace({ target: link }));
  await assert.rejects(f.replace({ password: Buffer.from('dummy-wrong-password') }), /BACKUP_AUTH_FAILED/);
  assert.equal(inspectRestoreTransaction(f.target).state, 'ABSENT');
});

test('prepublish and postpublish faults roll back; admission gates preserve old state and new data remains quarantined', async t => {
  for (const fault of ['STAGING_BEFORE', 'STAGING_before-publish', 'PREPARED', 'OLD_PRESERVED', 'NEW_PUBLISHED', 'VERIFIED']) {
    const f = await transactionFixture(t), before = await fileHashes(f.target); let fired = false;
    await assert.rejects(f.make({ hook: async step => {
      if (step !== fault || fired) return; fired = true;
      await assert.rejects(writeAtomicJson(path.join(f.target, 'config/blocked.json'), {}), /RESTORE_RECOVERY_REQUIRED/);
      await assert.rejects(withAtomicJsonLock(path.join(f.target, '.env'), async () => {}), /RESTORE_RECOVERY_REQUIRED/);
      throw new Error('DUMMY_INJECTED_FAILURE');
    } }).replace({ input: f.input, target: f.target, password: testPassword(), confirm: async () => true }), /DUMMY_INJECTED_FAILURE/);
    assert.equal(fired, true); assert.deepEqual(await fileHashes(f.target), before); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
  }
});
