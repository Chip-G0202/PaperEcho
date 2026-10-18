import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const restoreTargetKey = target => createHash('sha256').update(path.resolve(target).toLowerCase()).digest('hex');
export const restoreTransactionRoot = target => path.join(path.dirname(path.resolve(target)), '.paperecho-restore-tx-' + restoreTargetKey(target).slice(0, 24));
export const restoreIdentity = stat => `${stat.dev}:${stat.ino}`;
export function inspectRestoreTransaction(target) {
  if (/(?:^|[\\/])\.paperecho-restore-tx-[a-f0-9]{24}[\\/](?:old|new|rejected|\.paperecho-restore-[a-f0-9-]+)(?:[\\/]|$)/i.test(path.resolve(target))) return { state: 'RECOVERY_REQUIRED', blocking: true };
  const root = restoreTransactionRoot(target);
  try {
    const dir = fs.lstatSync(root);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw new Error();
    const file = path.join(root, 'status.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error();
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (record.schemaVersion !== 1 || record.owner !== 'paperecho-restore' || record.targetKey !== restoreTargetKey(target)
      || !/^[a-f0-9-]{36}$/.test(record.operationId) || !['PREPARING', 'PREPARED', 'PRESERVING', 'OLD_PRESERVED', 'PUBLISHING', 'NEW_PUBLISHED', 'VERIFIED', 'COMMITTED', 'ROLLBACK', 'ROLLED_BACK', 'RECOVERY_REQUIRED'].includes(record.state)) throw new Error();
    const terminal = ['COMMITTED', 'ROLLED_BACK'].includes(record.state);
    if (terminal && restoreIdentity(fs.lstatSync(target)) !== (record.state === 'COMMITTED' ? record.newIdentity : record.oldIdentity)) throw new Error();
    return { state: record.state, blocking: !terminal, operationId: record.operationId };
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(root)) return { state: 'ABSENT', blocking: false };
    return { state: 'RECOVERY_REQUIRED', blocking: true };
  }
}

// Existing writers use their own locks. This admission check closes both sides of
// lock acquisition; the transaction refuses any writer already inside its lock.
export function assertRestoreWritable(file) {
  if (inspectRestoreTransaction(file).blocking) throw Object.assign(new Error('RESTORE_RECOVERY_REQUIRED'), { code: 'RESTORE_RECOVERY_REQUIRED' });
  for (let root = path.resolve(file); ; root = path.dirname(root)) {
    if (fs.existsSync(restoreTransactionRoot(root)) && inspectRestoreTransaction(root).blocking) {
      throw Object.assign(new Error('RESTORE_RECOVERY_REQUIRED'), { code: 'RESTORE_RECOVERY_REQUIRED' });
    }
    if (root === path.dirname(root)) break;
  }
}
