import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveRuntimePaths, prepareRuntimePaths } from './runtime_config.mjs';
import { withAtomicJsonLock, boundedDirectory } from './atomic_json.mjs';
import { acquireWorkflowLease, releaseRunLease } from '../recovery/operation_ledger.mjs';
import { secureCredentialFile } from './credential_file_security.mjs';
import { CONTROL_SECRET_NAMES, credentialOrigin } from './credential_registry.mjs';
import { ruleSuggestionsLogPath, screeningStandardsPath } from './screening_standards_paths.mjs';
import { BACKUP_LIMITS, backupError, backupPath, sha256, sealBackup, openBackup } from './backup_format.mjs';
import { validateRunnerConfigObject } from '../runner/config_loader.mjs';
import { validateOperationLedger } from '../recovery/operation_ledger.mjs';
import { SecretService, inspectCredentialText } from './control_credentials_service.mjs';

const owners = ['config', 'secrets', 'research-feedback', 'rules', 'review-history', 'results', 'run-recovery', 'local-state', 'user-input'];
const inside = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const absent = async file => { try { await fs.lstat(file); return false; } catch (e) { if (e.code === 'ENOENT') return true; throw e; } };
const category = name => name === '.env' ? 'secrets' : name.startsWith('config/') ? 'config' : /research_evaluations\//.test(name) ? 'research-feedback'
  : /screening_standards|rule_suggestions/.test(name) ? 'rules' : /paper_feedback|manual|feedback\//i.test(name) ? 'review-history'
    : /\/runs\/|run_manifests\/|source_state\/|runtime_state\.json|schedule_decisions\//.test(name) ? 'run-recovery' : /\/state\//.test(name) ? 'local-state' : name.startsWith('review_results/') ? 'results' : 'user-input';
export const BACKUP_DATA_OWNERS = Object.freeze([...owners]);
// One selection policy for Backup and read-only upgrade planning; no new store.
export function backupSourceSelection(p, context) {
  const root = p.userDataRoot;
  const roots = [...new Set([...(p.layout !== 'dev' ? [root] : []), path.join(root, 'config'), path.join(root, 'review_results'), context.researchRoot, context.reviewRoot, context.localRepository?.root,
    context.env?.PAPERECHO_SOURCE_STATE_ROOT, context.env?.PAPERECHO_NOTIFICATION_RECEIPT_ROOT, context.env?.PAPERECHO_NOTIFICATION_HEALTH_ROOT].filter(Boolean).map(x => path.resolve(x)))];
  const files = [p.secretPath, context.configPath, ...(context.backupInputs || [])].filter(Boolean);
  const cacheDirectories = new Set([p.cacheRoot, p.logsRoot, path.join(root, '.cache')].map(x => path.resolve(x)));
  const cacheFiles = new Set([context.researchRoot, path.join(root, 'review_results')].flatMap(r => ['translation_cache.json', 'journal_quality_cache.json'].map(name => path.join(r, name))));
  for (const f of [...roots, ...files]) if (!inside(root, f)) throw backupError('BACKUP_EXTERNAL_OWNER');
  return { roots, files, cacheDirectories, cacheFiles };
}
export async function inspectBackupSources(p, context) {
  const { roots, files, cacheDirectories, cacheFiles } = backupSourceSelection(p, context);
  const entries = new Map(); const visited = new Set(); let totalBytes = 0;
  const walk = async file => {
    if (visited.has(file)) return; visited.add(file);
    if (visited.size > BACKUP_LIMITS.files * 4 || path.relative(p.userDataRoot, file).split(path.sep).length > 64) throw backupError('BACKUP_LIMIT_EXCEEDED');
    await backupSafePath(file); if (await absent(file)) return;
    const stat = await fs.lstat(file);
    if (stat.isDirectory()) {
      if (cacheDirectories.has(file)) return;
      for (const entry of (await boundedDirectory(file, BACKUP_LIMITS.files)).sort((a, b) => a.name.localeCompare(b.name))) await walk(path.join(file, entry.name));
      return;
    }
    const relative = path.relative(p.userDataRoot, file).split(path.sep).join('/'); backupPath(relative);
    if (/\.lock$|\.lease\.json$|\.tmp$/.test(relative)) throw backupError('BACKUP_ACTIVE_STATE');
    if (cacheFiles.has(file)) return;
    if (stat.size > BACKUP_LIMITS.fileBytes || entries.size >= BACKUP_LIMITS.files || (totalBytes += stat.size) > BACKUP_LIMITS.totalBytes) throw backupError('BACKUP_LIMIT_EXCEEDED');
    const bytes = await readBackupFile(file, BACKUP_LIMITS.fileBytes);
    try { entries.set(relative, { path: relative, owner: category(relative), size: bytes.length, sha256: sha256(bytes) }); }
    finally { bytes.fill(0); }
  };
  for (const file of [...roots, ...files].sort()) await walk(file);
  const result = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files: result, totalBytes, ownerInventory: Object.fromEntries(owners.map(owner => [owner, result.filter(f => f.owner === owner).length])) };
}
export async function backupSafePath(file, fsApi = fs) {
  if (!path.isAbsolute(file)) throw backupError('BACKUP_PATH_UNSAFE');
  if (process.platform === 'win32' && (/^\\\\[?.]\\/.test(file) || file.slice(path.parse(file).root.length).includes(':'))) throw backupError('BACKUP_PATH_UNSAFE');
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    try { const s = await fsApi.lstat(p); if (s.isSymbolicLink() || !s.isFile() && !s.isDirectory() || s.isFile() && s.nlink !== 1) throw backupError('BACKUP_PATH_UNSAFE'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (p === path.dirname(p)) break;
  }
}
export async function readBackupFile(file, limit, fsApi = fs) {
  const handle = await fsApi.open(file, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw backupError('BACKUP_LIMIT_EXCEEDED');
    const buffer = Buffer.alloc(before.size + 1); let read = 0;
    try {
      while (read < buffer.length) { const part = await handle.read(buffer, read, buffer.length - read, read); if (!part.bytesRead) break; read += part.bytesRead; }
      const after = await handle.stat();
      if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw backupError('BACKUP_SOURCE_CHANGED');
      return Buffer.from(buffer.subarray(0, read));
    } finally { buffer.fill(0); }
  } finally { await handle.close(); }
}
export function validateBackupManifest(m) {
  if (m?.schemaVersion !== 1 || m?.product?.releaseLine !== '2.6' || m?.restoreContract !== 1) throw backupError('BACKUP_SCHEMA_UNSUPPORTED');
  if (m.status !== 'complete' || !['dev', 'portable', 'installed'].includes(m.layout) || !['desktop', 'web', 'local'].includes(m.mode)
    || m.consistency?.strategy !== 'quiescent-owner-locks-and-double-read' || m.restorePolicy?.reactivateClaims !== false
    || !Array.isArray(m.files) || m.files.length > BACKUP_LIMITS.files || !Array.isArray(m.excluded) || !Array.isArray(m.externalSecrets)
    || !m.ownerInventory || owners.some(owner => !Number.isSafeInteger(m.ownerInventory[owner]) || m.ownerInventory[owner] < 0)) throw backupError('BACKUP_MANIFEST_INVALID');
  const seen = new Set(); let total = 0; const counts = Object.fromEntries(owners.map(owner => [owner, 0]));
  for (const file of m.files) {
    backupPath(file.path); const key = file.path.toLowerCase();
    if (seen.has(key) || !owners.includes(file.owner) || file.owner !== category(file.path) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > BACKUP_LIMITS.fileBytes || !/^[a-f0-9]{64}$/.test(file.sha256)) throw backupError('BACKUP_MANIFEST_INVALID');
    seen.add(key); total += file.size; counts[file.owner]++;
  }
  if (total > BACKUP_LIMITS.totalBytes || total !== m.totalBytes || owners.some(owner => counts[owner] !== m.ownerInventory[owner])
    || m.externalSecrets.some(id => !/^[A-Z][A-Z0-9_]{0,127}$/.test(id)) || m.externalSecrets.length > 100
    || JSON.stringify(m.encryption) !== JSON.stringify({ algorithm: 'AES-256-GCM', kdf: 'scrypt', N: 32768, r: 8, p: 1, saltBytes: 16, nonceBytes: 12, tagBytes: 16 })) throw backupError('BACKUP_MANIFEST_INVALID');
  for (const entry of m.excluded) { backupPath(entry.path); if (!['rebuildable-cache-or-diagnostics', 'rebuildable-cache', 'never-reactivate'].includes(entry.reason)) throw backupError('BACKUP_MANIFEST_INVALID'); }
  if (m.configEntry !== 'config/paperecho.config.json' || !seen.has(m.configEntry)) throw backupError('BACKUP_OWNER_INCOMPLETE');
  if (m.roots?.data !== '.' || !Array.isArray(m.roots.runRoots) || !Array.isArray(m.roots.inputs)) throw backupError('BACKUP_OWNER_INCOMPLETE');
  for (const relative of [m.roots.research, m.roots.review, ...m.roots.runRoots, ...m.roots.inputs]) if (relative !== '.') backupPath(relative);
  return m;
}
export async function backupWriterLockTargets(p, context, runRoots) {
  const reviewRoots = [...new Set([context.reviewRoot, path.join(p.userDataRoot, 'review_results/文献评价')])];
  const targets = [p.secretPath, context.configPath, ...reviewRoots.flatMap(review => [screeningStandardsPath(review), ruleSuggestionsLogPath(review),
    path.join(review, 'paper_feedback.json'), path.join(review, 'research_evaluations/events')]), ...runRoots.map(r => path.join(r, '.runner.operation'))].filter(Boolean);
  for (const e of await boundedDirectory(path.join(p.userDataRoot, 'config'), BACKUP_LIMITS.files)) if (/\.(json|md)$/.test(e.name)) targets.push(path.join(p.userDataRoot, 'config', e.name));
  return [...new Set(targets)].sort();
}
export class BackupService {
  constructor({ context, env = process.env, fsApi = fs, hook = async () => {} } = {}) { Object.assign(this, { context, env, fsApi, hook }); this.active = false; }
  async verify({ input, password, signal } = {}) {
    return this.withVerifiedContents({ input, password, signal }, m => ({ schemaVersion: 1, status: 'verified', encrypted: true, authenticated: true, files: m.files.length, bytes: m.totalBytes, restoreContract: 1,
      restoreReady: false, requiresRestorePlanning: true, externalSecretCount: m.externalSecrets.length }), false);
  }
  async verifyData({ input, password, signal } = {}) {
    if (!this.context) throw backupError('BACKUP_CONTEXT_REQUIRED');
    const p = prepareRuntimePaths(resolveRuntimePaths({ applicationRoot: this.context.applicationRoot, env: this.env }), { readOnly: true });
    if (typeof this.context.userDataRoot !== 'string' || !path.isAbsolute(this.context.userDataRoot)
      || path.resolve(this.context.userDataRoot) !== p.userDataRoot) throw backupError('BACKUP_TARGET_UNSAFE');
    const selection = backupSourceSelection(p, this.context);
    if ([...selection.roots, ...selection.files].some(file => !inside(p.userDataRoot, file))) throw backupError('BACKUP_EXTERNAL_OWNER');
    const relative = value => path.relative(p.userDataRoot, value).split(path.sep).join('/') || '.';
    return this.withVerifiedContents({ input, password, signal }, async manifest => {
      if (manifest.roots.research !== relative(this.context.researchRoot) || manifest.roots.review !== relative(this.context.reviewRoot)
        || !manifest.roots.runRoots.includes(relative(this.context.runRoot))) throw backupError('BACKUP_ROOT_MISMATCH');
      await backupSafePath(p.userDataRoot); const identity = await fs.lstat(p.userDataRoot);
      if (!await absent(p.secretPath)) await secureCredentialFile(p.secretPath, { checkOnly: true });
      const before = await inspectBackupSources(p, this.context); signal?.throwIfAborted();
      if (JSON.stringify(before.files) !== JSON.stringify(manifest.files) || before.totalBytes !== manifest.totalBytes
        || JSON.stringify(before.ownerInventory) !== JSON.stringify(manifest.ownerInventory)) throw backupError('BACKUP_DATA_MISMATCH');
      const after = await inspectBackupSources(p, this.context);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw backupError('BACKUP_SOURCE_CHANGED');
      if (!await absent(p.secretPath)) await secureCredentialFile(p.secretPath, { checkOnly: true });
      await backupSafePath(p.userDataRoot); const finalIdentity = await fs.lstat(p.userDataRoot);
      if (identity.dev !== finalIdentity.dev || identity.ino !== finalIdentity.ino) throw backupError('BACKUP_SOURCE_CHANGED');
      signal?.throwIfAborted();
      // A byte/ACL audit is not permission to uninstall, resume workflow or restore.
      return { schemaVersion: 1, status: 'data-preserved', authenticated: true, readOnly: true, files: manifest.files.length,
        bytes: manifest.totalBytes, ownerInventory: manifest.ownerInventory, externalSecretCount: manifest.externalSecrets.length,
        restoreReady: false, installerAuthorization: false, osMutation: false };
    }, false);
  }
  async withVerifiedContents({ input, password, signal } = {}, operation, capture = true) {
    const contents = new Map();
    let bytes;
    try {
      signal?.throwIfAborted(); await backupSafePath(input, this.fsApi);
      const s = await this.fsApi.lstat(input);
      if (!s.isFile() || s.size > BACKUP_LIMITS.totalBytes + BACKUP_LIMITS.manifestBytes + 56) throw backupError('BACKUP_LIMIT_EXCEEDED');
      await secureCredentialFile(input, { checkOnly: true });
      bytes = await readBackupFile(input, BACKUP_LIMITS.totalBytes + BACKUP_LIMITS.manifestBytes + 56, this.fsApi);
      await secureCredentialFile(input, { checkOnly: true });
      const m = await openBackup(bytes, password, validateBackupManifest, (file, bytes) => {
        try {
          if (file.path === 'config/paperecho.config.json') validateRunnerConfigObject(JSON.parse(bytes.toString('utf8')));
          if (path.posix.basename(file.path) === 'operation_ledger.json') validateOperationLedger(JSON.parse(bytes.toString('utf8')));
          if (file.path === '.env') inspectCredentialText(bytes.toString('utf8'));
        } catch { throw backupError('BACKUP_OWNER_INVALID'); }
        if (capture) contents.set(file.path, Buffer.from(bytes));
      }); signal?.throwIfAborted();
      return await operation(m, contents);
    } finally { bytes?.fill(0); for (const value of contents.values()) value.fill(0); }
  }
  async create({ output, password, signal } = {}) {
    if (this.active) throw backupError('BACKUP_BUSY'); this.active = true;
    const data = []; let temporary; let published = false;
    try {
      const p = prepareRuntimePaths(resolveRuntimePaths({ applicationRoot: this.context.applicationRoot, env: this.env }), { readOnly: true });
      const root = p.userDataRoot;
      if (path.resolve(this.context.userDataRoot) !== root) throw backupError('BACKUP_TARGET_UNSAFE');
      await backupSafePath(root);
      for (const entry of await boundedDirectory(root, BACKUP_LIMITS.files)) if (/^\.env\..*\.(?:tmp|rollback)$/.test(entry.name)) throw backupError('BACKUP_CREDENTIAL_RECOVERY_REQUIRED');
      const localSecrets = new SecretService({ root: p.applicationRoot, env: { PAPERECHO_LAYOUT: p.layout, PAPERECHO_APPLICATION_ROOT: p.applicationRoot,
        ...(p.layout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: p.userDataRoot, PAPERECHO_CACHE_ROOT: p.cacheRoot }) } });
      if (path.resolve(this.context.userDataRoot) !== root || !path.isAbsolute(output) || inside(root, output) || inside(p.applicationRoot, output)) throw backupError('BACKUP_TARGET_UNSAFE');
      await backupSafePath(output); if (!await absent(output)) throw backupError('BACKUP_TARGET_EXISTS');
      await this.fsApi.access(path.dirname(output));
      const { roots, files, cacheDirectories, cacheFiles } = backupSourceSelection(p, this.context);
      // The runtime owner resolves paths. Backup only verifies that every selected
      // owner belongs to this one data root; external owners require a later contract.
      for (const f of [...roots, ...files]) if (!inside(root, f)) throw backupError('BACKUP_EXTERNAL_OWNER');
      const reviewRoots = [...new Set([this.context.reviewRoot, path.join(root, 'review_results/文献评价')])];
      const runRoots = [...new Set([...reviewRoots.map(r => path.join(r, 'runs')), this.context.runRoot])];
      // Include existing legacy/custom run roots inside the selected data trees.
      // Never inspect the Dev program tree or unrelated workspace directories.
      const visitedDirs = new Set();
      const findRuns = async directory => {
        if (visitedDirs.has(directory) || await absent(directory)) return;
        if (!inside(root, directory) || visitedDirs.size >= BACKUP_LIMITS.files || path.relative(root, directory).split(path.sep).length > 64) throw backupError('BACKUP_PATH_UNSAFE');
        visitedDirs.add(directory); await backupSafePath(directory);
        if (cacheDirectories.has(path.resolve(directory))) return;
        if (path.basename(directory) === 'runs') runRoots.push(directory);
        for (const entry of await boundedDirectory(directory, BACKUP_LIMITS.files)) if (entry.isDirectory()) await findRuns(path.join(directory, entry.name));
      };
      for (const directory of roots) await findRuns(directory);
      const missing = new Set(); const ignored = new Set(); const leases = [];
      const holdLeases = async () => {
        for (const runRoot of [...new Set(runRoots)].sort()) {
          if (!inside(root, runRoot)) throw backupError('BACKUP_EXTERNAL_OWNER');
          if (await absent(runRoot)) { missing.add(runRoot); continue; }
          await backupSafePath(runRoot);
          const lease = await acquireWorkflowLease({ runRoot, runId: 'backup-' + randomUUID(), profile: 'backup', allowTakeover: false });
          if (!lease.acquired) throw backupError('BACKUP_WORKFLOW_BUSY'); leases.push(lease); ignored.add(lease.leasePath);
        }
      };
      const locked = await backupWriterLockTargets(p, this.context, runRoots);
      const withLocks = async (index, work) => {
        if (index === locked.length) return work();
        const file = locked[index]; await backupSafePath(file);
        if (await absent(path.dirname(file))) { missing.add(path.dirname(file)); return withLocks(index + 1, work); }
        ignored.add(file + '.lock');
        return withAtomicJsonLock(file, () => withLocks(index + 1, work), { timeoutMs: 0, staleMs: Infinity });
      };
      let count; let total;
      try {
        await withLocks(0, async () => {
          await holdLeases();
          if (!this.context.backupConfigHash || sha256(await readBackupFile(this.context.configPath, 1048576)) !== this.context.backupConfigHash) throw backupError('BACKUP_CONFIG_CHANGED');
          const collect = async capture => {
            const map = new Map(); const excluded = []; let total = 0; let visited = 0;
            const walk = async file => {
              signal?.throwIfAborted(); if (ignored.has(file)) return;
              if (++visited > BACKUP_LIMITS.files * 4 || path.relative(root, file).split(path.sep).length > 64) throw backupError('BACKUP_LIMIT_EXCEEDED');
              await backupSafePath(file); let stat;
              try { stat = await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
              const relative = path.relative(root, file).split(path.sep).join('/'); if (relative) backupPath(relative);
              if (map.has(relative)) return;
              if (stat.isDirectory()) {
                if (cacheDirectories.has(path.resolve(file))) { excluded.push({ path: relative, reason: 'rebuildable-cache-or-diagnostics' }); return; }
                for (const entry of (await boundedDirectory(file, BACKUP_LIMITS.files)).sort((a, b) => a.name.localeCompare(b.name))) await walk(path.join(file, entry.name)); return;
              }
              if (/\.lock$|\.lease\.json$|\.tmp$/.test(relative)) throw backupError('BACKUP_ACTIVE_STATE');
              if (cacheFiles.has(file)) { excluded.push({ path: relative, reason: 'rebuildable-cache' }); return; }
              if (stat.size > BACKUP_LIMITS.fileBytes || map.size >= BACKUP_LIMITS.files) throw backupError('BACKUP_LIMIT_EXCEEDED');
              total += stat.size; if (total > BACKUP_LIMITS.totalBytes) throw backupError('BACKUP_LIMIT_EXCEEDED');
              const bytes = await readBackupFile(file, BACKUP_LIMITS.fileBytes); const after = await fs.lstat(file);
              if (stat.ino !== after.ino || stat.dev !== after.dev || stat.size !== bytes.length || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs) { bytes.fill(0); throw backupError('BACKUP_SOURCE_CHANGED'); }
              if (file === p.secretPath) await localSecrets.health();
              const item = { path: relative, owner: category(relative), size: bytes.length, sha256: sha256(bytes) };
              map.set(relative, { item, identity: [stat.ino, stat.dev, stat.mode, stat.mtimeMs, stat.ctimeMs] });
              if (capture) data.push({ item, bytes }); else bytes.fill(0);
            };
            for (const file of [...roots, ...files].sort()) await walk(file);
            const entries = [...map].sort(([a], [b]) => a.localeCompare(b));
            if (entries.reduce((n, [, v]) => n + v.item.size, 0) > BACKUP_LIMITS.totalBytes) throw backupError('BACKUP_LIMIT_EXCEEDED');
            return { entries, excluded };
          };
          const before = await collect(true); await this.hook('captured');
          const after = await collect(false);
          if (JSON.stringify(before) !== JSON.stringify(after)) throw backupError('BACKUP_SOURCE_CHANGED');
          for (const file of missing) if (!await absent(file)) throw backupError('BACKUP_SOURCE_CHANGED');
          const sorted = data.sort((a, b) => a.item.path.localeCompare(b.item.path));
          count = sorted.length; total = sorted.reduce((n, v) => n + v.item.size, 0);
          const relative = file => path.relative(root, file).split(path.sep).join('/') || '.';
          const manifest = { schemaVersion: 1, product: { name: 'PaperEcho', releaseLine: '2.6' }, restoreContract: 1, configEntry: 'config/paperecho.config.json', status: 'complete', createdAt: new Date().toISOString(), mode: this.context.mode, layout: p.layout,
            roots: { data: '.', research: relative(this.context.researchRoot), review: relative(this.context.reviewRoot), runRoots: [...new Set(runRoots)].map(relative), inputs: (this.context.backupInputs || []).map(relative) },
            files: sorted.map(x => x.item), totalBytes: total, ownerInventory: Object.fromEntries(owners.map(owner => [owner, sorted.filter(x => x.item.owner === owner).length])),
            excluded: [...before.excluded, { path: 'operational-leases-and-writer-locks', reason: 'never-reactivate' }],
            externalSecrets: [...new Set([...CONTROL_SECRET_NAMES, ...(this.context.backupSecretNames || [])])].filter(id => credentialOrigin(this.env, id).kind === 'external-managed'),
            encryption: { algorithm: 'AES-256-GCM', kdf: 'scrypt', N: 32768, r: 8, p: 1, saltBytes: 16, nonceBytes: 12, tagBytes: 16 },
            consistency: { strategy: 'quiescent-owner-locks-and-double-read', limitation: 'uncoordinated editors and old executables must be closed; not an OS filesystem snapshot' },
            restorePolicy: { reactivateClaims: false, requirePathMapping: true, requireSecretAclValidation: true, requireCompatibilityCheck: true } };
          validateBackupManifest(manifest);
          const encrypted = await sealBackup(manifest, sorted.map(x => x.bytes), password); signal?.throwIfAborted();
          // Only encrypted bytes reach disk. Exclusive link publication never
          // replaces an existing target; the temporary alias is removed below.
          temporary = path.join(path.dirname(output), `.paperecho-backup-${randomUUID()}.partial`);
          await backupSafePath(path.dirname(output));
          const handle = await this.fsApi.open(temporary, 'wx', 0o600);
          try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); encrypted.fill(0); }
          // This exclusive new file can carry the launch token's default logon ACE.
          // Reuse the validated, locked source credential DACL, never an arbitrary
          // export directory's inherited principals or the transient logon ACE.
          await secureCredentialFile(temporary, { source: await absent(p.secretPath) ? '' : p.secretPath }); await this.verify({ input: temporary, password, signal }); await this.hook('before-publish');
          if (JSON.stringify(before) !== JSON.stringify(await collect(false))) throw backupError('BACKUP_SOURCE_CHANGED');
          await backupSafePath(output);
          try { await this.fsApi.link(temporary, output); }
          catch (error) { if (error.code === 'EEXIST') throw backupError('BACKUP_TARGET_EXISTS'); throw error; }
          published = true;
        });
      } finally {
        for (const lease of leases.reverse()) if (!(await releaseRunLease(lease)).released) throw backupError('BACKUP_LOCK_RELEASE_FAILED');
      }
      for (const file of ignored) if (!await absent(file)) throw backupError('BACKUP_LOCK_RELEASE_FAILED');
      return { schemaVersion: 1, status: 'created', encrypted: true, authenticated: true, output, files: count, bytes: total };
    } catch (error) {
      if (published) throw backupError('BACKUP_CLEANUP_REQUIRED');
      if (String(error?.message).startsWith('ATOMIC_JSON_LOCK_TIMEOUT:')) throw backupError('BACKUP_WRITER_BUSY');
      if (error?.code === 'EEXIST') throw backupError('BACKUP_BUSY_OR_TARGET_EXISTS');
      throw error;
    } finally { for (const { bytes } of data) bytes.fill(0); if (temporary) await this.fsApi.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw backupError('BACKUP_CLEANUP_REQUIRED'); }); this.active = false; }
  }
}
