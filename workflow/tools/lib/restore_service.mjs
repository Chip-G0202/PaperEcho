import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BackupService, backupSafePath, readBackupFile } from './backup_service.mjs';
import { BACKUP_LIMITS, backupPath, sha256 } from './backup_format.mjs';
import { resolveRuntimePaths, prepareRuntimePaths, resolveApplicationRuntimeContext } from './runtime_config.mjs';
import { secureCredentialFile } from './credential_file_security.mjs';
import { createControlServices } from './control_application_services.mjs';
import { resolveRunnerConfiguration } from '../runner/config_loader.mjs';
import { parseRunnerArgs } from '../runner/args.mjs';
import { holdRestoreParent, restoreError, isRestoreStagingGuard } from './restore_filesystem.mjs';

const receiptName = '.paperecho-restore.json';
const inside = (root, file) => { const r = path.relative(root, file); return !path.isAbsolute(r) && r !== '..' && !r.startsWith('..' + path.sep); };
const absent = async (file, api = fs) => { try { await api.lstat(file); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };
const identity = s => `${s.dev}:${s.ino}`;
// Restore owns the transaction, not configuration, secrets or business history.
export class RestoreService {
  constructor({ applicationRoot, env = process.env, fsApi = fs, hook = async () => {}, stagingGuard, stagingLayout } = {}) { Object.assign(this, { applicationRoot, env, fsApi, hook, stagingGuard, stagingLayout }); this.active = false; }
  async restore({ input, target, password, signal } = {}) {
    if (this.active) throw restoreError('RESTORE_BUSY'); this.active = true;
    let stage; let stageId; let guard; let published = false;
    try {
      if (!path.isAbsolute(target || '') || path.resolve(target) !== path.normalize(target)) throw restoreError('RESTORE_TARGET_UNSAFE');
      target = path.resolve(target);
      const base = resolveRuntimePaths({ ...(this.applicationRoot ? { applicationRoot: this.applicationRoot } : {}), env: this.env });
      const privateStaging = this.stagingGuard && isRestoreStagingGuard(this.stagingGuard, target);
      if (privateStaging) this.stagingGuard.assertHeld();
      for (const protectedRoot of [base.applicationRoot, base.userDataRoot]) if ((inside(protectedRoot, target) || inside(target, protectedRoot)) && !privateStaging) throw restoreError('RESTORE_TARGET_UNSAFE');
      if (!path.isAbsolute(input || '') || inside(target, input)) throw restoreError('RESTORE_TARGET_UNSAFE');
      const envFor = root => ({ PAPERECHO_LAYOUT: privateStaging && this.stagingLayout === 'portable' ? 'portable' : 'installed', PAPERECHO_APPLICATION_ROOT: base.applicationRoot, PAPERECHO_RESOURCE_ROOT: base.resourceRoot, PAPERECHO_DATA_ROOT: root, PAPERECHO_CACHE_ROOT: path.join(root, '.cache'), PAPERECHO_SKIP_DOTENV: '1' });
      const paths = prepareRuntimePaths(resolveRuntimePaths({ env: envFor(target) }), { readOnly: true });
      await backupSafePath(target, this.fsApi);
      if (!await absent(target, this.fsApi)) throw restoreError('RESTORE_TARGET_EXISTS');
      if (!(await this.fsApi.lstat(path.dirname(target))).isDirectory()) throw restoreError('RESTORE_PARENT_REQUIRED');
      return await new BackupService({ fsApi: this.fsApi }).withVerifiedContents({ input, password, signal }, async (manifest, contents) => {
        const names = new Set(manifest.files.map(f => f.path.toLowerCase()));
        for (const file of manifest.files) {
          if (file.path.toLowerCase() === receiptName || /(?:\.lock|\.lease\.json|\.tmp)$/i.test(file.path)) throw restoreError('RESTORE_ACTIVE_STATE_UNSAFE');
          const parts = file.path.split('/');
          for (let i = 1; i < parts.length; i++) if (names.has(parts.slice(0, i).join('/').toLowerCase())) throw restoreError('RESTORE_PATH_CONFLICT');
        }
        for (const name of [manifest.roots.research, manifest.roots.review, ...manifest.roots.runRoots]) if (name !== '.' && names.has(name.toLowerCase())) throw restoreError('RESTORE_PATH_CONFLICT');
        signal?.throwIfAborted();
        stage = path.join(path.dirname(target), '.paperecho-restore-' + randomUUID());
        guard = await holdRestoreParent(stage); stageId = identity(await this.fsApi.lstat(stage));
        const assertOwned = async root => {
          guard.assertHeld(); await backupSafePath(root, this.fsApi);
          const s = await this.fsApi.lstat(root); if (!s.isDirectory() || identity(s) !== stageId) throw restoreError('RESTORE_STAGING_CHANGED');
        };
        const checkFiles = async root => {
          await assertOwned(root);
          for (const file of manifest.files) {
            signal?.throwIfAborted(); const dest = path.join(root, ...file.path.split('/'));
            await backupSafePath(dest, this.fsApi);
            const bytes = await readBackupFile(dest, BACKUP_LIMITS.fileBytes, this.fsApi);
            try { if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw restoreError('RESTORE_HASH_MISMATCH'); }
            finally { bytes.fill(0); }
          }
          await secureCredentialFile(root, { checkOnly: true });
          if (names.has('.env')) await secureCredentialFile(path.join(root, '.env'), { checkOnly: true });
        };
        await secureCredentialFile(stage, { checkOnly: true });
        await this.hook('staging-created', { stage, target });
        for (const file of manifest.files) {
          signal?.throwIfAborted(); await assertOwned(stage);
          const dest = path.join(stage, ...file.path.split('/'));
          if (!inside(stage, dest)) throw restoreError('RESTORE_PATH_UNSAFE');
          await this.fsApi.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
          await backupSafePath(dest, this.fsApi);
          const handle = await this.fsApi.open(dest, 'wx', 0o600);
          try { if (file.path === '.env') await secureCredentialFile(dest); await handle.writeFile(contents.get(file.path)); await handle.sync(); }
          finally { await handle.close(); }
        }
        for (const relative of [...manifest.roots.runRoots, path.relative(target, paths.cacheRoot)]) {
          if (relative !== '.') backupPath(relative.split(path.sep).join('/'));
          const directory = path.resolve(stage, relative); if (!inside(stage, directory)) throw restoreError('RESTORE_PATH_UNSAFE');
          await this.fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
        }
        // Validate path relocation using the real resolver, with no external env
        // values. Absolute legacy paths are refused, never silently rewritten.
        const contextFor = async root => {
          try {
            const env = envFor(root); const context = await resolveApplicationRuntimeContext({ cwd: base.applicationRoot, env, readOnly: true });
            const relative = value => path.relative(root, value).split(path.sep).join('/') || '.';
            if (relative(context.researchRoot) !== manifest.roots.research || relative(context.reviewRoot) !== manifest.roots.review || !manifest.roots.runRoots.includes(relative(context.runRoot))) throw new Error();
            const resolved = await resolveRunnerConfiguration(parseRunnerArgs(['--check'], { cwd: root, allowUnresolvedMode: true }), { cwd: base.applicationRoot, env, defaultConfigPath: path.join(root, manifest.configEntry), readOnly: true });
            for (const value of [resolved.options.input, resolved.options.feedback].filter(Boolean)) {
              const name = relative(value); backupPath(name);
              if (!inside(root, value) || !manifest.roots.inputs.includes(name) || await absent(value, this.fsApi)) throw new Error();
            }
            return { context, env };
          } catch { throw restoreError('RESTORE_PATH_MAPPING_REQUIRED'); }
        };
        const stagingContext = await contextFor(stage);
        const services = createControlServices({ root: base.applicationRoot, ...stagingContext });
        await services.config.readOwner('paperecho.config.json'); await services.secrets.health();
        await checkFiles(stage);
        // This is a restore receipt, not a second business state store. Historical
        // claims remain bytes; ordinary preflight blocks automatic reactivation.
        const receipt = { schemaVersion: 1, status: 'restored-history-only', workflowAllowed: false, requiresStateReview: true,
          manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))), externalSecrets: manifest.externalSecrets, reactivateClaims: false };
        const handle = await this.fsApi.open(path.join(stage, receiptName), 'wx', 0o600);
        try { await handle.writeFile(JSON.stringify(receipt) + '\n'); await handle.sync(); } finally { await handle.close(); }
        await this.hook('before-publish', { stage, target });
        await checkFiles(stage); signal?.throwIfAborted();
        if (!await absent(target, this.fsApi)) throw restoreError('RESTORE_TARGET_EXISTS');
        // Windows/NTFS directory rename refuses an existing destination (including
        // an empty directory). No copy fallback and no POSIX replacement semantics.
        await this.fsApi.rename(stage, target); published = true;
        await checkFiles(target);
        const restored = await contextFor(target);
        const doctor = await createControlServices({ root: base.applicationRoot, ...restored }).doctor.status({ signal });
        await checkFiles(target);
        return { schemaVersion: 1, status: 'restored', authenticated: true, userDataRoot: target, files: manifest.files.length, bytes: manifest.totalBytes,
          byteIdentical: true, reactivatedClaims: false, requiresStateReview: true, externalSecretCount: manifest.externalSecrets.length, requiresExternalConfiguration: manifest.externalSecrets.length > 0,
          doctor: { status: doctor.status, canRun: doctor.canRun, checks: doctor.checks.map(({ checkId, status, severity }) => ({ checkId, status, severity })) } };
      });
    } catch (error) {
      if (published) throw restoreError('RESTORE_PUBLISHED_INSPECTION_REQUIRED');
      throw error;
    } finally {
      let cleanupFailed = false;
      if (stageId && !published) {
        try {
          guard.assertHeld(); await backupSafePath(stage, this.fsApi);
          if (identity(await this.fsApi.lstat(stage)) !== stageId) throw new Error();
          await this.fsApi.rm(stage, { recursive: true });
        } catch { cleanupFailed = true; }
      }
      try { await guard?.release(); } catch { cleanupFailed = true; }
      this.active = false;
      if (cleanupFailed) throw restoreError('RESTORE_CLEANUP_REQUIRED');
    }
  }
}
