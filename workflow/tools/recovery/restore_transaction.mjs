import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BackupService, backupSafePath, readBackupFile, backupWriterLockTargets } from '../lib/backup_service.mjs';
import { BACKUP_LIMITS, sha256 } from '../lib/backup_format.mjs';
import { RestoreService } from '../lib/restore_service.mjs';
import { holdRestoreParent, restoreError } from '../lib/restore_filesystem.mjs';
import { secureCredentialFile } from '../lib/credential_file_security.mjs';
import { resolveRuntimePaths, resolveApplicationRuntimeContext } from '../lib/runtime_config.mjs';
import { writeAtomicJson, readBoundedJson } from '../lib/atomic_json.mjs';
import { validateOperationLedger } from './operation_ledger.mjs';
import { createControlServices } from '../lib/control_application_services.mjs';
import { restoreIdentity, restoreTargetKey, restoreTransactionRoot, inspectRestoreTransaction } from './restore_transaction_status.mjs';

const inside = (root, value) => { const r = path.relative(root, value); return !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep); };
const present = async file => { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const digest = value => sha256(Buffer.from(JSON.stringify(value)));
const environment = (base, root) => ({ PAPERECHO_LAYOUT: 'installed', PAPERECHO_APPLICATION_ROOT: base.applicationRoot, PAPERECHO_RESOURCE_ROOT: base.resourceRoot, PAPERECHO_DATA_ROOT: root, PAPERECHO_SKIP_DOTENV: '1' });

// Inventory covers the entire old directory, including unknown user files. Its
// private, bounded record is evidence for rollback, never a second business store.
async function inventory(root, { quiescent = false, base, operationId } = {}) {
  const entries = []; let bytes = 0, count = 0, metadataBytes = 0;
  const add = entry => { if ((metadataBytes += Buffer.byteLength(JSON.stringify(entry))) > BACKUP_LIMITS.manifestBytes) throw restoreError('RESTORE_LIMIT_EXCEEDED'); entries.push(entry); };
  const visit = async file => {
    if (++count > BACKUP_LIMITS.files * 2 || path.relative(root, file).split(path.sep).length > 64) throw restoreError('RESTORE_LIMIT_EXCEEDED');
    await backupSafePath(file); const s = await fs.lstat(file), name = path.relative(root, file).split(path.sep).join('/');
    if (s.isDirectory()) {
      add({ name, directory: true, identity: restoreIdentity(s), mode: s.mode });
      for (const entry of (await fs.readdir(file)).sort()) await visit(path.join(file, entry));
    } else {
      if (s.size > BACKUP_LIMITS.fileBytes || (bytes += s.size) > BACKUP_LIMITS.totalBytes) throw restoreError('RESTORE_LIMIT_EXCEEDED');
      const data = await readBackupFile(file, BACKUP_LIMITS.fileBytes);
      try {
        if (operationId && name.endsWith('.lock')) {
          let lock; try { lock = JSON.parse(data); } catch {}
          if (lock?.owner === 'paperecho-restore' && lock.operationId === operationId) return;
        }
        if (quiescent && /(?:\.lock|\.lease\.json|\.claim(?:\.json)?)$/i.test(name)) throw restoreError('RESTORE_WORKSPACE_BUSY');
        if (quiescent && path.basename(file) === 'operation_ledger.json' && validateOperationLedger(JSON.parse(data)).status === 'running') throw restoreError('RESTORE_WORKSPACE_BUSY');
        // A historical schedule claim is safe only with an already-completed
        // matching ledger. Unknown, incomplete or unbound claims are never cleared.
        if (quiescent && name.includes('/schedule_decisions/') && name.endsWith('.json')) {
          const claim = JSON.parse(data); if (claim.schemaVersion !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(claim.businessRunId || '')) throw restoreError('RESTORE_CLAIM_UNKNOWN');
          // Directory order must not decide claim safety; resolve via formal run root below.
          const context = await resolveApplicationRuntimeContext({ env: environment(base, root), readOnly: true });
          const ledger = await readBoundedJson(root, path.join(context.runRoot, claim.businessRunId, 'operation_ledger.json'));
          if (!ledger || validateOperationLedger(ledger).status !== 'completed') throw restoreError('RESTORE_CLAIM_UNKNOWN');
        }
        add({ name, directory: false, identity: restoreIdentity(s), mode: s.mode, mtime: s.mtimeMs, size: s.size, sha256: sha256(data) });
      } finally { data.fill(0); }
    }
  };
  await visit(root); return entries;
}

export class RestoreTransaction {
  constructor({ applicationRoot, env = process.env, fsApi = fs, hook = async () => {} } = {}) { Object.assign(this, { applicationRoot, env, fsApi, hook }); }
  async target(target) {
    if (process.platform !== 'win32') throw restoreError('RESTORE_PLATFORM_UNVERIFIED');
    if (!path.isAbsolute(target || '') || path.resolve(target) !== path.normalize(target)) throw restoreError('RESTORE_TARGET_UNSAFE');
    const base = resolveRuntimePaths({ applicationRoot: this.applicationRoot, env: this.env });
    target = path.resolve(target);
    if (target.split(path.sep).some(part => /^\.paperecho-restore-tx-/i.test(part))) throw restoreError('RESTORE_TARGET_UNSAFE');
    if (inside(base.applicationRoot, target) || inside(target, base.applicationRoot) || target === path.parse(target).root) throw restoreError('RESTORE_TARGET_UNSAFE');
    if (target !== base.userDataRoot && (inside(base.userDataRoot, target) || inside(target, base.userDataRoot))) throw restoreError('RESTORE_TARGET_UNSAFE');
    const temporaryRoots = [base.tempRoot, ...['TEMP', 'TMP', 'TMPDIR'].flatMap(key => [this.env[key], process.env[key]])].filter(value => typeof value === 'string' && path.isAbsolute(value));
    if (temporaryRoots.some(root => inside(target, path.resolve(root)) || inside(path.resolve(root), target))) throw restoreError('RESTORE_TEMP_CONFLICT');
    await backupSafePath(target); await backupSafePath(restoreTransactionRoot(target));
    return { base, target };
  }
  async validateOld(base, target, operationId) {
    if (!(await fs.lstat(target)).isDirectory()) throw restoreError('RESTORE_TARGET_UNSAFE');
    await secureCredentialFile(target, { checkOnly: true });
    const env = environment(base, target), context = await resolveApplicationRuntimeContext({ env, readOnly: true });
    if (path.resolve(context.userDataRoot) !== target || !inside(target, context.runRoot) || !inside(target, context.researchRoot) || !inside(target, context.reviewRoot)) throw restoreError('RESTORE_TARGET_UNSAFE');
    const services = createControlServices({ root: base.applicationRoot, context, env });
    await services.config.readOwner('paperecho.config.json'); await services.secrets.health();
    return inventory(target, { quiescent: true, base, operationId });
  }
  async preflight({ input, target, password, signal } = {}) {
    const info = await this.target(target);
    if (inspectRestoreTransaction(info.target).state !== 'ABSENT') throw restoreError('RESTORE_TRANSACTION_RETAINED');
    if (!path.isAbsolute(input || '') || inside(info.target, input) || inside(restoreTransactionRoot(info.target), input)) throw restoreError('RESTORE_TARGET_UNSAFE');
    return new BackupService().withVerifiedContents({ input, password, signal }, async manifest => {
      const probe = await holdRestoreParent(info.target, { existing: true });
      let old;
      try { old = await this.validateOld(info.base, info.target); probe.assertHeld(); } finally { await probe.release(); }
      const createdAt = Number.isFinite(Date.parse(manifest.createdAt)) ? new Date(manifest.createdAt).toISOString() : null;
      return { schemaVersion: 1, status: 'preflight', target: info.target, releaseLine: manifest.product.releaseLine, createdAt,
        categories: Object.keys(manifest.ownerInventory).filter(key => manifest.ownerInventory[key] > 0), files: manifest.files.length, bytes: manifest.totalBytes,
        externalSecretNames: manifest.externalSecrets, rollbackPolicy: 'private-same-volume-retained-until-explicit-cleanup', confirmationRequired: true,
        oldIdentity: old[0].identity, oldDigest: digest(old) };
    }, false);
  }
  async checkpoint(root, record, state) {
    if (record.sequence >= 100) throw restoreError('RESTORE_LIMIT_EXCEEDED');
    const next = { ...record, state, sequence: record.sequence + 1, evidenceFile: randomUUID() + '.json' };
    if (Buffer.byteLength(JSON.stringify(next)) > 8192) throw restoreError('RESTORE_LIMIT_EXCEEDED');
    const file = path.join(root, next.evidenceFile);
    const handle = await this.fsApi.open(file, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(next) + '\n'); await handle.sync(); } finally { await handle.close(); }
    await writeAtomicJson(path.join(root, 'status.json'), next, { fsApi: this.fsApi });
    Object.assign(record, next);
    await this.hook(state, { root, target: record.target });
  }
  async replace({ input, target, password, confirm, signal } = {}) {
    const preview = await this.preflight({ input, target, password, signal });
    if (typeof confirm !== 'function' || await confirm(preview) !== true) throw restoreError('RESTORE_CONFIRMATION_REQUIRED');
    const { base } = await this.target(target); target = preview.target;
    const root = restoreTransactionRoot(target);
    const guard = await holdRestoreParent(root, { exclusive: true });
    const record = { schemaVersion: 1, owner: 'paperecho-restore', operationId: randomUUID(), targetKey: restoreTargetKey(target), target,
      state: 'PREPARING', sequence: -1, oldIdentity: preview.oldIdentity, oldDigest: preview.oldDigest, newIdentity: null };
    const handles = [];
    try {
      await secureCredentialFile(root, { checkOnly: true });
      await this.checkpoint(root, record, 'PREPARING');
      const old = await this.validateOld(base, target);
      if (digest(old) !== preview.oldDigest) throw restoreError('RESTORE_TARGET_CHANGED');
      await writeAtomicJson(path.join(root, 'old-inventory.json'), old, { fsApi: this.fsApi });
      const paths = resolveRuntimePaths({ env: environment(base, target) });
      const context = await resolveApplicationRuntimeContext({ env: environment(base, target), readOnly: true });
      const runRoots = [...new Set([context.runRoot, ...old.filter(e => e.directory && path.basename(e.name) === 'runs').map(e => path.join(target, e.name))])];
      record.locks = (await backupWriterLockTargets(paths, context, runRoots)).filter(file => inside(target, file)).map(file => path.relative(target, file));
      await this.checkpoint(root, record, 'PREPARING');
      for (const relative of record.locks) {
        const file = path.join(target, relative); if (!await present(path.dirname(file))) continue;
        await backupSafePath(file);
        const handle = await fs.open(file + '.lock', 'wx', 0o600); handles.push(handle);
        await handle.writeFile(JSON.stringify({ owner: 'paperecho-restore', operationId: record.operationId, pid: process.pid })); await handle.sync();
      }
      if (digest(await this.validateOld(base, target, record.operationId)) !== record.oldDigest) throw restoreError('RESTORE_TARGET_CHANGED');
      await this.hook('STAGING_BEFORE', { root, target });
      const result = await new RestoreService({ applicationRoot: base.applicationRoot, env: this.env, fsApi: this.fsApi,
        hook: async (step, context) => { await this.hook('STAGING_' + step, { ...context, root, target }); } }).restore({ input, target: path.join(root, 'new'), password, signal });
      record.newIdentity = restoreIdentity(await fs.lstat(path.join(root, 'new')));
      const newPaths = resolveRuntimePaths({ env: environment(base, path.join(root, 'new')) });
      await fs.mkdir(newPaths.tempRoot, { recursive: true, mode: 0o700 });
      record.newDigest = digest(await inventory(path.join(root, 'new')));
      await this.checkpoint(root, record, 'PREPARED');
      if (digest(await this.validateOld(base, target, record.operationId)) !== record.oldDigest) throw restoreError('RESTORE_TARGET_CHANGED');
      guard.assertHeld(); signal?.throwIfAborted();
      // NTFS refuses a parent rename while these child handles are open. Keep
      // their exclusive lock files and the persistent admission gate until commit.
      for (const handle of handles.splice(0)) await handle.close();
      await this.checkpoint(root, record, 'PRESERVING');
      await this.fsApi.rename(target, path.join(root, 'old'));
      await this.checkpoint(root, record, 'OLD_PRESERVED');
      if (digest(await inventory(path.join(root, 'old'), { operationId: record.operationId })) !== record.oldDigest) throw restoreError('RESTORE_OLD_CHANGED');
      await this.checkpoint(root, record, 'PUBLISHING');
      await this.fsApi.rename(path.join(root, 'new'), target);
      await this.checkpoint(root, record, 'NEW_PUBLISHED');
      await this.verifyPublished(base, record);
      await this.checkpoint(root, record, 'VERIFIED');
      for (const handle of handles.splice(0)) await handle.close();
      await this.releaseLocks(root, record);
      await this.checkpoint(root, record, 'COMMITTED');
      return { ...result, userDataRoot: target, status: 'committed', operationId: record.operationId, rollbackRetained: true };
    } catch (error) {
      for (const handle of handles.splice(0)) await handle.close();
      try { await this.releaseLocks(root, record); await this.rollback(base, root, record); }
      catch { await this.checkpoint(root, record, 'RECOVERY_REQUIRED').catch(() => {}); throw restoreError('RESTORE_RECOVERY_REQUIRED'); }
      throw error;
    } finally { for (const handle of handles) await handle.close(); await guard.release(); }
  }
  async releaseLocks(root, record) {
    for (const candidate of [record.target, path.join(root, 'old')]) {
      const stat = await present(candidate); if (!stat || restoreIdentity(stat) !== record.oldIdentity) continue;
      for (const relative of record.locks || []) {
        if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw restoreError('RESTORE_RECOVERY_REQUIRED');
        const file = path.join(candidate, relative + '.lock'); if (!await present(file)) continue;
        await backupSafePath(file); const value = await readBoundedJson(candidate, file, { maxBytes: 1024 });
        if (value?.owner !== 'paperecho-restore' || value.operationId !== record.operationId) throw restoreError('RESTORE_RECOVERY_REQUIRED');
        await fs.unlink(file);
      }
    }
  }
  async verifyPublished(base, record) {
    if (digest(await inventory(record.target)) !== record.newDigest) throw restoreError('RESTORE_HASH_MISMATCH');
    await secureCredentialFile(record.target, { checkOnly: true });
    if (await present(path.join(record.target, '.env'))) await secureCredentialFile(path.join(record.target, '.env'), { checkOnly: true });
    const env = environment(base, record.target), context = await resolveApplicationRuntimeContext({ env, readOnly: true });
    const report = await createControlServices({ root: base.applicationRoot, context, env }).doctor.status();
    // Historical execution is intentionally blocked; resource/config/Secret
    // failures must still cause rollback, not be hidden by that expected block.
    if (['configuration', 'secrets', 'runtime.resources'].some(id => report.checks.find(c => c.checkId === id)?.status !== 'PASS')) throw restoreError('RESTORE_DOCTOR_BLOCKED');
    if (digest(await inventory(record.target)) !== record.newDigest) throw restoreError('RESTORE_HASH_MISMATCH');
  }
  async rollback(base, root, record) {
    await this.checkpoint(root, record, 'ROLLBACK');
    const current = await present(record.target), old = await present(path.join(root, 'old'));
    if (old) {
      if (restoreIdentity(old) !== record.oldIdentity || digest(await inventory(path.join(root, 'old'))) !== record.oldDigest) throw restoreError('RESTORE_OLD_CHANGED');
      await secureCredentialFile(path.join(root, 'old'), { checkOnly: true });
      if (await present(path.join(root, 'old/.env'))) await secureCredentialFile(path.join(root, 'old/.env'), { checkOnly: true });
      if (current) {
        if (restoreIdentity(current) !== record.newIdentity || await present(path.join(root, 'rejected'))) throw restoreError('RESTORE_TARGET_CHANGED');
        await this.fsApi.rename(record.target, path.join(root, 'rejected'));
        await this.hook('ROLLBACK_NEW_PRESERVED', { root, target: record.target });
      }
      await this.fsApi.rename(path.join(root, 'old'), record.target);
      await this.hook('ROLLBACK_OLD_RETURNED', { root, target: record.target });
    }
    if (restoreIdentity(await fs.lstat(record.target)) !== record.oldIdentity || digest(await inventory(record.target)) !== record.oldDigest) throw restoreError('RESTORE_OLD_CHANGED');
    await secureCredentialFile(record.target, { checkOnly: true });
    if (await present(path.join(record.target, '.env'))) await secureCredentialFile(path.join(record.target, '.env'), { checkOnly: true });
    await this.checkpoint(root, record, 'ROLLED_BACK');
  }
  async recover({ target, rollback = false, confirm } = {}) {
    const { base, target: selected } = await this.target(target); target = selected;
    const root = restoreTransactionRoot(target);
    await secureCredentialFile(root, { checkOnly: true });
    const guard = await holdRestoreParent(root, { existing: true, exclusive: true });
    try {
      const record = await readBoundedJson(root, path.join(root, 'status.json'), { maxBytes: 8192 });
      if (!record || record.owner !== 'paperecho-restore' || record.target !== target || record.targetKey !== restoreTargetKey(target) || !/^[a-f0-9-]{36}$/.test(record.operationId)) throw restoreError('RESTORE_RECOVERY_REQUIRED');
      if (!/^[a-f0-9-]{36}\.json$/.test(record.evidenceFile || '')) throw restoreError('RESTORE_RECOVERY_REQUIRED');
      const evidence = await readBoundedJson(root, path.join(root, record.evidenceFile), { maxBytes: 8192 });
      if (JSON.stringify(evidence) !== JSON.stringify(record)) throw restoreError('RESTORE_RECOVERY_REQUIRED');
      if (record.state === 'ROLLED_BACK') {
        if (inspectRestoreTransaction(target).blocking) throw restoreError('RESTORE_RECOVERY_REQUIRED');
        return { status: 'rolled-back', operationId: record.operationId };
      }
      if (record.state === 'COMMITTED' && !rollback) {
        if (inspectRestoreTransaction(target).blocking) throw restoreError('RESTORE_RECOVERY_REQUIRED');
        return { status: 'committed', operationId: record.operationId, rollbackRetained: true };
      }
      if (record.state === 'COMMITTED' && (typeof confirm !== 'function' || await confirm({ target, operationId: record.operationId, action: 'rollback' }) !== true)) throw restoreError('RESTORE_CONFIRMATION_REQUIRED');
      if (record.state === 'COMMITTED') {
        await this.validateOld(base, target);
        await this.checkpoint(root, record, 'ROLLBACK');
        await this.validateOld(base, target);
      }
      if (record.state !== 'COMMITTED' && (typeof confirm !== 'function' || await confirm({ target, operationId: record.operationId, action: 'recover-and-rollback' }) !== true)) throw restoreError('RESTORE_CONFIRMATION_REQUIRED');
      // Recovery conservatively rolls back incomplete work. Physical identities
      // distinguish either side of a rename even when its checkpoint was lost.
      try { await this.releaseLocks(root, record); await this.rollback(base, root, record); }
      catch { await this.checkpoint(root, record, 'RECOVERY_REQUIRED').catch(() => {}); throw restoreError('RESTORE_RECOVERY_REQUIRED'); }
      return { status: 'rolled-back', operationId: record.operationId };
    } finally { await guard.release(); }
  }
}
