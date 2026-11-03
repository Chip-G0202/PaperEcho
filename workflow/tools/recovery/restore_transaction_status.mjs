import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isRestoreStagingPath } from '../lib/restore_filesystem.mjs';

export const restoreTargetKey = target => createHash('sha256').update(path.resolve(target).toLowerCase()).digest('hex');
export const restoreTransactionRoot = target => path.join(path.dirname(path.resolve(target)), '.paperecho-restore-tx-' + restoreTargetKey(target).slice(0, 24));
export const restoreIdentity = stat => `${stat.dev}:${stat.ino}`;
export const upgradeSourcePointer = '.paperecho-upgrade-source.json';
function inspectUpgradeSource(source) {
  const file = path.join(source, upgradeSourcePointer); let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (['ENOENT', 'ENOTDIR'].includes(e.code)) return null; throw e; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw new Error();
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  const workspace = path.basename(source) === 'data' && path.basename(path.dirname(source)) === 'old-program' ? path.dirname(path.dirname(source)) : path.dirname(source);
  const id = path.basename(workspace);
  if (!/^[a-f0-9-]{36}$/.test(id) || path.basename(path.dirname(workspace)) !== 'phase6b' || path.basename(path.dirname(path.dirname(workspace))) !== 'runs'
    || path.basename(path.dirname(path.dirname(path.dirname(workspace)))) !== 'tests' || !['old-program', 'old-data', 'data'].includes(path.basename(source))
    || p.schemaVersion !== 1 || p.owner !== 'paperecho-restore' || p.role !== 'upgrade-source' || p.sourceKey !== restoreTargetKey(source) || !['installed', 'portable'].includes(p.targetLayout)) throw new Error();
  const target = p.targetLayout === 'installed' ? path.join(workspace, 'new-data') : path.join(workspace, 'new-program', 'future-data-' + id);
  const root = restoreTransactionRoot(target), dir = fs.lstatSync(root), s = fs.lstatSync(path.join(root, 'status.json'));
  if (!dir.isDirectory() || dir.isSymbolicLink() || !s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > 8192) throw new Error();
  const record = JSON.parse(fs.readFileSync(path.join(root, 'status.json'), 'utf8'));
  if (record.owner !== 'paperecho-restore' || record.kind !== 'upgrade-new-root' || record.operationId !== p.operationId || record.targetKey !== restoreTargetKey(target)
    || record.upgrade?.sourceRoot !== source) throw new Error();
  if (restoreIdentity(fs.lstatSync(source)) !== record.upgrade.sourceIdentity) throw new Error();
  const state = inspectRestoreTransaction(target);
  if (state.operationId !== p.operationId) throw new Error();
  return state;
}
export function inspectRestoreTransaction(target) {
  try { const source = inspectUpgradeSource(path.resolve(target)); if (source) return source; }
  catch { return { state: 'RECOVERY_REQUIRED', blocking: true }; }
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
    if (terminal) {
      if (record.kind === 'upgrade-new-root' && record.state === 'ROLLED_BACK' && record.oldIdentity === null) {
        try { fs.lstatSync(target); throw new Error(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      } else if (restoreIdentity(fs.lstatSync(target)) !== (record.state === 'COMMITTED' ? record.newIdentity : record.oldIdentity)) throw new Error();
    }
    return { state: record.state, blocking: !terminal, operationId: record.operationId };
  } catch (error) {
    if (error.code === 'ENOENT' && !fs.existsSync(root)) return { state: 'ABSENT', blocking: false };
    return { state: 'RECOVERY_REQUIRED', blocking: true };
  }
}

// Existing writers use their own locks. This admission check closes both sides of
// lock acquisition; the transaction refuses any writer already inside its lock.
export function assertRestoreWritable(file, { stagingGuard } = {}) {
  if (isRestoreStagingPath(stagingGuard, file)) { stagingGuard.assertHeld(); return; }
  if (inspectRestoreTransaction(file).blocking) throw Object.assign(new Error('RESTORE_RECOVERY_REQUIRED'), { code: 'RESTORE_RECOVERY_REQUIRED' });
  for (let root = path.resolve(file); ; root = path.dirname(root)) {
    if ((fs.existsSync(restoreTransactionRoot(root)) || fs.existsSync(path.join(root, upgradeSourcePointer))) && inspectRestoreTransaction(root).blocking) {
      throw Object.assign(new Error('RESTORE_RECOVERY_REQUIRED'), { code: 'RESTORE_RECOVERY_REQUIRED' });
    }
    if (root === path.dirname(root)) break;
  }
}
