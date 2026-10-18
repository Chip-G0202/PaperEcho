import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { resolveRuntimePaths, prepareRuntimePaths, resolveApplicationRuntimeContext } from './runtime_config.mjs';
import { BackupService, BACKUP_DATA_OWNERS, backupSafePath, backupSourceSelection, inspectBackupSources, readBackupFile } from './backup_service.mjs';
import { sha256 } from './backup_format.mjs';
import { readBoundedJson } from './atomic_json.mjs';
import { validateRunnerConfigObject, resolveRunnerConfiguration } from '../runner/config_loader.mjs';
import { parseRunnerArgs } from '../runner/args.mjs';
import { upgradeOutboundChannelsConfig } from './application_config_migration.mjs';
import { SecretService } from './control_credentials_service.mjs';
import { CONTROL_SECRET_NAMES } from './credential_registry.mjs';
import { createControlServices } from './control_application_services.mjs';
import { inspectRestoreTransaction } from '../recovery/restore_transaction_status.mjs';
import { validateOperationLedger } from '../recovery/operation_ledger.mjs';
import { inspectRestoreVolume } from './restore_filesystem.mjs';

export const UPGRADE_COMPATIBILITY = Object.freeze({ targetRelease: '2.6', targetSchema: 6, readableSchemas: [1, 2, 3, 4, 5, 6],
  previewSchemas: [3, 4, 5, 6], legacyTag: '2b5e65e0df376f67c2bee26fbc527264ddb8dd69', taggedSchema: 6,
  legacyRuntimeSha256: 'e26f18695b5c907a669d9e4190ff4476c7dc70514a0fce42beda34015be753de',
  backupSchema: 1, backupReleaseLine: '2.6', restoreContract: 1, ledgerSchema: 1, receiptSchema: 2 });
const inside = (root, file) => { const r = path.relative(root, file); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const error = code => Object.assign(new Error(code), { code });
const exists = async file => { try { return await fs.lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const safeCode = e => /^UPGRADE_[A-Z_]+$/.test(e?.code || '') ? e.code : /^BACKUP_[A-Z_]+$/.test(e?.code || '') ? e.code : 'UPGRADE_INSPECTION_FAILED';
const controls = (app, data, layout, resource = app) => ({ PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_RESOURCE_ROOT: resource,
  PAPERECHO_LAYOUT: layout, ...(layout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: data }), PAPERECHO_SKIP_DOTENV: '1' });

// Metadata identifies a contract family, not a signed executable. The old tag
// has no package version: only its exact public Runtime Root fingerprint is used.
async function releaseEvidence(app, layout) {
  const metadata = await readBoundedJson(app, path.join(app, 'resources/core/package.json'));
  const old = path.join(app, 'workflow/tools/lib/runtime_config.mjs'); let legacy = false;
  await backupSafePath(old);
  if (await exists(old)) { const bytes = await readBackupFile(old, 65536); try { legacy = sha256(bytes.toString('utf8').replace(/\r\n/g, '\n')) === UPGRADE_COMPATIBILITY.legacyRuntimeSha256; } finally { bytes.fill(0); } }
  if (metadata?.version !== undefined) {
    if (metadata.name !== 'paperecho-core' || typeof metadata.version !== 'string' || !/^2\.6\.\d+$/.test(metadata.version)) throw error('UPGRADE_VERSION_UNSUPPORTED');
    if (legacy) throw error('UPGRADE_VERSION_CONFLICT');
    return { releaseLine: '2.6', evidence: 'packaged-core-metadata', resourceRoot: path.join(app, 'resources/core') };
  }
  const rootMetadata = await readBoundedJson(app, path.join(app, 'package.json'));
  if (rootMetadata?.version !== undefined) throw error('UPGRADE_VERSION_UNSUPPORTED');
  if (legacy && rootMetadata?.name === 'paperecho') {
    if (layout !== 'dev') throw error('UPGRADE_LEGACY_LAYOUT_UNSUPPORTED');
    return { releaseLine: '2.5', evidence: 'pinned-tag-runtime-contract', revision: UPGRADE_COMPATIBILITY.legacyTag, resourceRoot: app };
  }
  return { releaseLine: null, evidence: 'unknown', resourceRoot: app };
}

// Planning only. No migration/restore method, OS registration or write API is called.
export class UpgradePreflightService {
  constructor({ applicationRoot, env = process.env, volume = inspectRestoreVolume } = {}) { Object.assign(this, { applicationRoot, env, volume }); }
  async inspect({ sourceApplicationRoot, sourceDataRoot, sourceLayout, targetDataRoot, targetLayout, backup, password } = {}) {
    const checks = []; const add = (checkId, status) => checks.push({ checkId, status });
    let source = { releaseLine: null, schema: null, layout: ['dev', 'portable', 'installed'].includes(sourceLayout) ? sourceLayout : null };
    const target = { releaseLine: '2.6', schema: 6, layout: ['portable', 'installed'].includes(targetLayout) ? targetLayout : null };
    const result = extra => ({ schemaVersion: 1, scope: 'offline-upgrade-plan', status: checks.some(c => c.status === 'BLOCKED') ? 'BLOCKED' : checks.some(c => c.status === 'UNKNOWN') ? 'UNKNOWN' : checks.some(c => c.status === 'WARN') ? 'WARN' : 'PASS',
      source, target, checks, executionAllowed: false, osMutation: false, ...extra });
    try {
      if (![sourceApplicationRoot, sourceDataRoot, targetDataRoot].every(p => typeof p === 'string' && path.isAbsolute(p))
        || !['dev', 'portable', 'installed'].includes(sourceLayout) || !['portable', 'installed'].includes(targetLayout)) throw error('UPGRADE_ARGUMENT_INVALID');
      sourceApplicationRoot = path.resolve(sourceApplicationRoot); sourceDataRoot = path.resolve(sourceDataRoot); targetDataRoot = path.resolve(targetDataRoot);
      if (process.platform === 'win32' && [sourceApplicationRoot, sourceDataRoot, targetDataRoot].some(p => !/^[A-Za-z]:[\\/]/.test(p))) throw error('UPGRADE_LOCAL_ROOT_REQUIRED');
      if (inside(sourceDataRoot, targetDataRoot) || inside(targetDataRoot, sourceDataRoot)) throw error('UPGRADE_ROOT_CONFLICT');
      const host = resolveRuntimePaths({ applicationRoot: this.applicationRoot, env: this.env });
      if (resolveRuntimePaths({ env: controls(sourceApplicationRoot, sourceDataRoot, sourceLayout) }).userDataRoot !== sourceDataRoot) throw error('UPGRADE_ROOT_MISMATCH');
      if (inside(targetDataRoot, sourceApplicationRoot) || inside(sourceApplicationRoot, targetDataRoot) && !(sourceApplicationRoot === host.applicationRoot && targetLayout === 'portable')) throw error('UPGRADE_PROGRAM_DATA_CONFLICT');
      for (const file of [sourceApplicationRoot, sourceDataRoot, targetDataRoot, host.applicationRoot]) await backupSafePath(file);
      if (!(await fs.lstat(sourceDataRoot)).isDirectory() || await exists(targetDataRoot)) throw error('UPGRADE_TARGET_NOT_NEW');
      const parent = path.dirname(targetDataRoot); if (!(await fs.lstat(parent)).isDirectory()) throw error('UPGRADE_PARENT_REQUIRED');
      await fs.access(sourceDataRoot, constants.R_OK | constants.W_OK); await fs.access(parent, constants.W_OK);
      const evidence = await releaseEvidence(sourceApplicationRoot, sourceLayout);
      source = { ...source, releaseLine: evidence.releaseLine, evidence: evidence.evidence, ...(evidence.revision ? { revision: evidence.revision } : {}) };
      add('source.version', evidence.releaseLine ? 'PASS' : 'UNKNOWN');
      const targetEvidence = await releaseEvidence(host.applicationRoot, targetLayout);
      add('target.version', targetEvidence.releaseLine === '2.6' ? 'PASS' : 'UNKNOWN');
      const env = controls(sourceApplicationRoot, sourceDataRoot, sourceLayout, evidence.resourceRoot);
      const paths = prepareRuntimePaths(resolveRuntimePaths({ env }), { readOnly: true });
      const targetPaths = prepareRuntimePaths(resolveRuntimePaths({ applicationRoot: host.applicationRoot, env: controls(host.applicationRoot, targetDataRoot, targetLayout, host.resourceRoot) }), { readOnly: true });
      if (paths.userDataRoot !== sourceDataRoot || targetPaths.userDataRoot !== targetDataRoot) throw error('UPGRADE_ROOT_MISMATCH');
      if (sourceLayout !== 'dev' && await exists(path.join(sourceApplicationRoot, 'config/paperecho.config.json'))) add('source.multipleRoots', 'UNKNOWN');
      for (const [id, root] of [['source', sourceDataRoot], ['target', targetDataRoot]]) add(`${id}.restoreTransaction`, inspectRestoreTransaction(root).blocking ? 'BLOCKED' : 'PASS');
      if (await exists(path.join(sourceDataRoot, '.paperecho-restore.json'))) add('source.restoredHistoryReview', 'BLOCKED');
      const raw = await readBoundedJson(sourceDataRoot, paths.configPath);
      if (!raw) throw error('UPGRADE_CONFIG_REQUIRED');
      validateRunnerConfigObject(raw); source.schema = raw.schemaVersion;
      if (evidence.releaseLine === '2.5' && raw.scheduler !== undefined) throw error('UPGRADE_SOURCE_SCHEDULER_UNSUPPORTED');
      const configHash = sha256(await readBackupFile(paths.configPath, 1048576));
      if (!UPGRADE_COMPATIBILITY.previewSchemas.includes(raw.schemaVersion)) {
        add('config.legacyDomainMerge', 'BLOCKED');
        return result({ compatibility: UPGRADE_COMPATIBILITY, manualActions: ['LEGACY_DOMAIN_AND_ENV_COMPOSITION_REQUIRES_SEPARATE_VALIDATION'] });
      }
      const preview = raw.schemaVersion === 6 ? structuredClone(raw) : upgradeOutboundChannelsConfig(raw, () => new Date(0));
      validateRunnerConfigObject(preview); add('config.schemaPath', 'PASS');
      // A byte-preserving relocation must not silently rewrite absolute data paths.
      for (const p of [raw.common?.projectRoot, raw.common?.sourceState?.root, raw.common?.notifications?.receiptStore?.root, raw.local?.input, raw.local?.outputRoot, raw.local?.feedback,
        raw.common?.llm?.preferenceConfig, raw.common?.llm?.translationConfig]) if (p && path.isAbsolute(p)) throw error('UPGRADE_ABSOLUTE_OWNER_REMAP_REQUIRED');
      const cli = parseRunnerArgs(['--check', '--config', paths.configPath], { cwd: sourceDataRoot, allowUnresolvedMode: true });
      const resolved = await resolveRunnerConfiguration(cli, { env, cwd: sourceApplicationRoot, readOnly: true });
      const context = await resolveApplicationRuntimeContext({ cwd: sourceApplicationRoot, env, readOnly: true });
      context.backupInputs = [resolved.options.input, resolved.options.feedback].filter(Boolean);
      context.backupConfigHash = configHash;
      backupSourceSelection(paths, context);
      const secrets = new SecretService({ root: sourceApplicationRoot, env }); const health = await secrets.health(); add('secrets.localAcl', 'PASS');
      const references = new Set(CONTROL_SECRET_NAMES);
      const visit = obj => { for (const [key, value] of Object.entries(obj || {})) { if (/Env$/.test(key) && typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(value)) references.add(value); else if (value && typeof value === 'object') visit(value); } }; visit(raw);
      const external = [...references].filter(name => Object.hasOwn(this.env, name)).sort();
      const services = createControlServices({ root: sourceApplicationRoot, context, env });
      const state = await services.review.health();
      add('workflow.lease', state.claim === 'absent' ? 'PASS' : state.claim === 'running' ? 'BLOCKED' : 'UNKNOWN');
      add('workflow.recovery', state.recoveryPending || state.conflicts || !['none', 'completed'].includes(state.lastRun) ? 'BLOCKED' : 'PASS');
      const schedule = await services.schedule.status();
      add('workflow.scheduleClaim', schedule.status === 'invalid' ? 'UNKNOWN' : schedule.status === 'recovery_required' || schedule.currentRun?.state === 'running' ? 'BLOCKED' : 'PASS');
      const inventory = await inspectBackupSources(paths, context);
      for (const file of inventory.files) {
        if (file.path.endsWith('/operation_ledger.json')) {
          const ledger = validateOperationLedger(await readBoundedJson(sourceDataRoot, path.join(sourceDataRoot, file.path)));
          if (ledger.status !== 'completed') add('workflow.historicalLedger', 'BLOCKED');
        }
        if (/\.claim(?:\.json)?$/.test(file.path)) add('workflow.legacyClaim', 'UNKNOWN');
        // Current-day status cannot establish that every retained historical
        // Stage0 decision is safe to reactivate. Preserve it and require review.
        if (file.path.includes('/schedule_decisions/')) add('workflow.retainedScheduleClaim', 'UNKNOWN');
      }
      const owners = BACKUP_DATA_OWNERS.map(id => ({ id, files: inventory.ownerInventory[id], status: inventory.ownerInventory[id] ? 'covered' : 'not-present' }));
      add('owners.config', inventory.files.some(f => f.path === 'config/paperecho.config.json') ? 'PASS' : 'BLOCKED');
      let verified = false;
      if (backup && password) {
        await backupSafePath(backup);
        if (inside(sourceDataRoot, backup) || inside(targetDataRoot, backup)) throw error('UPGRADE_BACKUP_LOCATION_UNSAFE');
        await new BackupService().withVerifiedContents({ input: backup, password }, async manifest => {
          if (manifest.layout !== sourceLayout || manifest.mode !== context.mode || JSON.stringify(manifest.files) !== JSON.stringify(inventory.files)
            || JSON.stringify(manifest.ownerInventory) !== JSON.stringify(inventory.ownerInventory)) throw error('UPGRADE_BACKUP_SOURCE_MISMATCH');
          for (const name of manifest.externalSecrets) if (!external.includes(name)) external.push(name);
          verified = true;
        }, false);
      }
      add('rollback.authenticatedSourceBackup', verified ? 'PASS' : 'UNKNOWN');
      external.sort(); add('secrets.externalProvisioning', external.length ? 'UNKNOWN' : 'PASS');
      const sameVolume = (await fs.stat(sourceDataRoot)).dev === (await fs.stat(parent)).dev;
      add('filesystem.sameVolume', sameVolume ? 'PASS' : 'BLOCKED');
      try {
        const volume = await this.volume(parent);
        add('filesystem.ntfs', volume.filesystem === 'NTFS' ? 'PASS' : 'UNKNOWN');
        add('filesystem.space', volume.freeBytes >= BigInt(inventory.totalBytes) * 3n + 67108864n ? 'PASS' : 'BLOCKED');
      } catch (e) { add(e.code === 'RESTORE_PARENT_ACCESS_DENIED' ? 'filesystem.parentWrite' : 'filesystem.volume', e.code === 'RESTORE_PARENT_ACCESS_DENIED' ? 'BLOCKED' : 'UNKNOWN'); }
      // Detect observed source changes without taking or releasing any writer lock.
      await secrets.health(); const after = await inspectBackupSources(paths, context);
      if (JSON.stringify(after) !== JSON.stringify(inventory)) throw error('UPGRADE_SOURCE_CHANGED');
      if (JSON.stringify(await releaseEvidence(sourceApplicationRoot, sourceLayout)) !== JSON.stringify(evidence)) throw error('UPGRADE_SOURCE_CHANGED');
      const steps = [
        { id: 'quiesce-and-revalidate', requires: [], owner: 'Runner/Stage0/workflow-lease', action: 'EXPLICIT_6B_ONLY' },
        { id: 'backup-verify', requires: ['quiesce-and-revalidate'], owner: 'BackupService', action: 'AUTHENTICATED_SOURCE_BOUND_BACKUP_REQUIRED' },
        ...BACKUP_DATA_OWNERS.map(id => ({ id: `preserve-${id}`, requires: ['backup-verify'], owner: id, action: 'COPY_TO_PRIVATE_STAGING_WITH_ORIGINAL_BYTES_RETAINED' })),
        { id: 'config-contract', requires: ['preserve-config'], owner: 'application_config_migration', action: raw.schemaVersion === 6 ? 'PRESERVE_SCHEMA6_BYTES' : 'PREVIEW_EXISTING_3_4_5_TO_6_CHAIN' },
        { id: 'secret-review', requires: ['preserve-secrets'], owner: 'SecretService', action: 'REVALIDATE_LOCAL_ACL_AND_REPROVISION_EXTERNAL_SEPARATELY' },
        { id: 'validate-before-publish', requires: ['config-contract', 'secret-review', ...BACKUP_DATA_OWNERS.map(id => `preserve-${id}`)], owner: 'Doctor/RuntimeRoot/recovery', action: 'VERIFY_OWNERS_AND_KEEP_HISTORY_INACTIVE' },
        { id: 'publish-or-rollback', requires: ['validate-before-publish'], owner: 'RestoreTransaction', action: 'REQUIRES_PHASE6B_COMPATIBILITY_AND_FAILURE_INJECTION' },
      ];
      const plan = { schemaVersion: 1, sourceSchema: raw.schemaVersion, targetSchema: 6, sourceLayout, targetLayout, owners, steps,
        sourceDigest: sha256(JSON.stringify(inventory)), configHash, preserveOriginalRoot: true, automaticRestoreAcrossVersions: false,
        scheduler: raw.scheduler ? 'PRESERVE_EXISTING_NO_REGISTRATION' : 'KEEP_ABSENT_DO_NOT_ENABLE',
        secrets: { localFile: health.filePresent, externalCount: external.length,
          externalCredentialIds: external.filter(name => CONTROL_SECRET_NAMES.includes(name)),
          customExternalReferenceCount: external.filter(name => !CONTROL_SECRET_NAMES.includes(name)).length, copyEnvironmentValues: false },
        rollback: { backupVerified: verified, backupSchema: 1, restoreContract: 1, originalProgramAndDataRequired: true, historyActivation: false, actualCrossVersionRestoreTested: false },
        releaseGates: ['PHASE6B_ISOLATED_EXECUTION_AND_ROLLBACK', 'PHASE3A_INSTALLER_BLOCKED', 'PHASE5B_OS_REGISTRATION_UNVERIFIED', 'SIGNING_AND_MACOS_UNVERIFIED'] };
      plan.id = sha256(JSON.stringify({ ...plan, sourceDataRoot, targetDataRoot }));
      return result({ compatibility: UPGRADE_COMPATIBILITY, plan, ownerCoverage: owners, manualActions: external.length ? ['REPROVISION_EXTERNAL_CREDENTIALS', 'COMPLETE_PHASE6B_AND_RELEASE_GATES'] : ['COMPLETE_PHASE6B_AND_RELEASE_GATES'] });
    } catch (e) { add(safeCode(e), 'BLOCKED'); return result(); }
  }
}
