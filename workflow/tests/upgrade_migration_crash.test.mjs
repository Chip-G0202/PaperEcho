import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { migrationFixture, upgradeFileHashes } from '../../tests/helpers/upgrade_migration_fixture.mjs';
import { terminateMigrationAt } from '../../tests/helpers/upgrade_migration_process.mjs';
import { inspectRestoreTransaction } from '../tools/recovery/restore_transaction_status.mjs';

test('real migration crashes before/after publish and during rollback recover from the same journal without changing source bytes', async t => {
  for (const phase of ['PREPARED', 'PUBLISHING', 'NEW_PUBLISHED', 'ROLLBACK_NEW_PRESERVED', 'COMMITTED']) {
    await t.test(phase, async t => {
      const f = await migrationFixture(t, { schema: 4, secret: false });
      const archive = await fs.readFile(f.backup);
      const runtime = await terminateMigrationAt(f, phase, { fault: phase === 'ROLLBACK_NEW_PRESERVED' ? 'NEW_PUBLISHED' : '' });
      assert.equal(runtime.browserProcess, false);
      assert.equal(inspectRestoreTransaction(f.target).blocking, phase !== 'COMMITTED');
      assert.equal(inspectRestoreTransaction(f.data).blocking, phase !== 'COMMITTED');
      const expected = phase === 'COMMITTED' ? 'committed' : 'rolled-back';
      const recovered = await f.recover(); assert.equal(recovered.status, expected);
      assert.equal((await f.recover()).status, expected);
      assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes); assert.deepEqual(await fs.readFile(f.backup), archive);
      assert.equal(inspectRestoreTransaction(f.data).blocking, false);
      if (expected === 'rolled-back') await assert.rejects(fs.lstat(f.target), e => e.code === 'ENOENT');
      else assert.equal((await f.recover({ rollback: true })).status, 'rolled-back');
    });
  }
});
