import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UpgradePreflightService } from './upgrade_preflight_service.mjs';
import { resolveRuntimePaths, resolveApplicationRuntimeContext } from './runtime_config.mjs';
import { BackupService, backupSafePath, readBackupFile } from './backup_service.mjs';
import { BACKUP_LIMITS, sha256 } from './backup_format.mjs';
import { readBoundedJson } from './atomic_json.mjs';
import { secureCredentialFile } from './credential_file_security.mjs';
import { migrateApplicationConfig } from './application_config_migration.mjs';
import { validateRunnerConfigObject } from '../runner/config_loader.mjs';
import { RestoreTransaction, inspectRestoreInventory } from '../recovery/restore_transaction.mjs';
import { restoreTransactionRoot, inspectRestoreTransaction } from '../recovery/restore_transaction_status.mjs';

const moduleRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const fail = code => Object.assign(new Error(code), { code });
const hash = value => sha256(JSON.stringify(value));
export const UPGRADE_EXECUTION_MATRIX = Object.freeze({ 1: 'BLOCKED', 2: 'BLOCKED', 3: 'SUPPORTED', 4: 'SUPPORTED', 5: 'SUPPORTED', 6: 'NO_OP' });

// Phase 6B is deliberately a synthetic-workspace capability, not an upgrader for
// normal installations. Admission precedes any source/target filesystem access.
export class UpgradeMigrationService extends UpgradePreflightService {
  constructor(options = {}) { super(options); this.fsApi = options.fsApi || fs; this.hook = options.hook || (async () => {}); }
  async scope(workspace) {
    if (!path.isAbsolute(workspace || '') || path.resolve(workspace) !== path.normalize(workspace)) throw fail('UPGRADE_ISOLATED_WORKSPACE_REQUIRED');
    const id = path.basename(workspace), base = resolveRuntimePaths({ applicationRoot: this.applicationRoot, env: this.env });
    if (!/^[a-f0-9-]{36}$/.test(id)) throw fail('UPGRADE_ISOLATED_WORKSPACE_REQUIRED');
    const sourceHarness = workspace === path.join(moduleRoot, 'tests/runs/phase6b', id);
    const packagedHarness = moduleRoot === path.join(base.applicationRoot, 'resources/core') && base.applicationRoot === path.join(workspace, 'new-program')
      && ['phase6b', 'runs', 'tests'].every((name, i) => { let p = workspace; for (let n = 0; n <= i; n++) p = path.dirname(p); return path.basename(p) === name; });
    if ((!sourceHarness && !packagedHarness) || base.applicationRoot !== path.join(workspace, 'new-program')) throw fail('UPGRADE_ISOLATED_WORKSPACE_REQUIRED');
    await backupSafePath(workspace); await secureCredentialFile(workspace, { checkOnly: true });
    const marker = await readBoundedJson(workspace, path.join(workspace, 'synthetic-workspace.json'));
    if (marker?.schemaVersion !== 1 || marker.kind !== 'paperecho-synthetic-upgrade' || marker.fixtureId !== id
      || !['dev', 'portable', 'installed'].includes(marker.sourceLayout) || !['portable', 'installed'].includes(marker.targetLayout)) throw fail('UPGRADE_ISOLATED_WORKSPACE_REQUIRED');
    const sourceApplicationRoot = path.join(workspace, 'old-program');
    const sourceDataRoot = marker.sourceLayout === 'dev' ? sourceApplicationRoot : marker.sourceLayout === 'portable' ? path.join(sourceApplicationRoot, 'data') : path.join(workspace, 'old-data');
    const targetDataRoot = marker.targetLayout === 'installed' ? path.join(workspace, 'new-data') : path.join(base.applicationRoot, 'future-data-' + id);
    const input = { sourceApplicationRoot, sourceDataRoot, sourceLayout: marker.sourceLayout, targetDataRoot, targetLayout: marker.targetLayout, backup: path.join(workspace, 'source.pebackup') };
    for (const p of Object.values(input).filter(p => path.isAbsolute(p))) await backupSafePath(p);
    const plan = await readBoundedJson(workspace, path.join(workspace, 'plan.json'), { maxBytes: 16384 });
    if (plan?.schemaVersion !== 1 || plan.targetSchema !== 6 || !/^[a-f0-9]{64}$/.test(plan.id || '') || !['SUPPORTED', 'NO_OP'].includes(UPGRADE_EXECUTION_MATRIX[plan.sourceSchema])) throw fail('UPGRADE_EXECUTION_PATH_BLOCKED');
    return { base, input, plan, binding: { sourceRoot: sourceDataRoot, planId: plan.id, planHash: hash(plan), sourceDigest: plan.sourceDigest, targetLayout: input.targetLayout } };
  }
  transaction() { return new RestoreTransaction({ applicationRoot: this.applicationRoot, env: this.env, fsApi: this.fsApi, hook: this.hook }); }
  async existing(scope, { rollback, confirm }) {
    const root = restoreTransactionRoot(scope.input.targetDataRoot);
    const record = await readBoundedJson(root, path.join(root, 'status.json'), { maxBytes: 8192 });
    if (!record?.upgrade || record.upgrade.backupSha256 !== sha256(await readBackupFile(scope.input.backup, BACKUP_LIMITS.totalBytes + BACKUP_LIMITS.manifestBytes + 56))) throw fail('UPGRADE_BACKUP_CHANGED');
    const result = await this.transaction().recover({ target: scope.input.targetDataRoot, rollback, confirm, upgrade: scope.binding });
    return { schemaVersion: 1, scope: 'isolated-upgrade', ...result, sourcePreserved: true, reactivatedClaims: false, osMutation: false };
  }
  async execute({ workspace, password, confirm, signal } = {}) {
    const scope = await this.scope(workspace), { input, plan, base } = scope;
    if (typeof confirm !== 'function' || await confirm({ action: 'isolated-upgrade', planId: plan.id }) !== true) throw fail('UPGRADE_CONFIRMATION_REQUIRED');
    const retained = inspectRestoreTransaction(input.targetDataRoot);
    if (retained.state !== 'ABSENT') {
      if (!['COMMITTED', 'ROLLED_BACK'].includes(retained.state)) throw fail('UPGRADE_RECOVERY_REQUIRED');
      return this.existing(scope, { confirm });
    }
    const sourceSnapshot = await inspectRestoreInventory(input.sourceDataRoot, { quiescent: true, base });
    const report = await this.inspect({ ...input, password });
    if (report.status !== 'PASS' || JSON.stringify(report.plan) !== JSON.stringify(plan)) throw fail('UPGRADE_PLAN_STALE_OR_BLOCKED');
    let manifest;
    await new BackupService().withVerifiedContents({ input: input.backup, password, signal }, async value => { manifest = value; }, false);
    const sourceEnv = { PAPERECHO_APPLICATION_ROOT: input.sourceApplicationRoot, PAPERECHO_RESOURCE_ROOT: report.source.releaseLine === '2.5' ? input.sourceApplicationRoot : path.join(input.sourceApplicationRoot, 'resources/core'),
      PAPERECHO_LAYOUT: input.sourceLayout, ...(input.sourceLayout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: input.sourceDataRoot }), PAPERECHO_SKIP_DOTENV: '1' };
    const sourcePaths = resolveRuntimePaths({ env: sourceEnv });
    const sourceContext = await resolveApplicationRuntimeContext({ env: sourceEnv, readOnly: true });
    const upgrade = { ...scope.binding, fromSchema: plan.sourceSchema, targetSchema: 6, expectedSourceSnapshotDigest: hash(sourceSnapshot),
      backupSha256: sha256(await readBackupFile(input.backup, BACKUP_LIMITS.totalBytes + BACKUP_LIMITS.manifestBytes + 56)) };
    const result = await this.transaction().publishNew({ input: input.backup, target: input.targetDataRoot, password, signal, sourcePaths, sourceContext, upgrade, confirm: async () => true,
      transform: async (stage, record, stagingGuard) => {
        await this.hook('CONVERT_BEFORE', { stage, target: input.targetDataRoot });
        const configPath = path.join(stage, 'config/paperecho.config.json'); await backupSafePath(configPath);
        if (plan.sourceSchema !== 6) {
          const converted = await migrateApplicationConfig({ root: stage, configPath, atomicOptions: { stagingGuard, fsApi: this.fsApi }, now: () => new Date(record.upgrade.startedAt) });
          if (!converted.migrated || converted.schemaVersion !== 6) throw fail('UPGRADE_CONVERSION_FAILED');
        }
        const config = await readBoundedJson(stage, configPath); validateRunnerConfigObject(config);
        if (config.schemaVersion !== 6) throw fail('UPGRADE_CONVERSION_FAILED');
        for (const file of manifest.files) {
          if (file.path === manifest.configEntry && plan.sourceSchema !== 6) continue;
          const dest = path.join(stage, file.path); await backupSafePath(dest);
          const bytes = await readBackupFile(dest, BACKUP_LIMITS.fileBytes);
          try { if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw fail('UPGRADE_OWNER_MISMATCH'); } finally { bytes.fill(0); }
        }
        const receipt = await readBoundedJson(stage, path.join(stage, '.paperecho-restore.json'));
        if (receipt?.workflowAllowed !== false || receipt.reactivateClaims !== false) throw fail('UPGRADE_HISTORY_UNSAFE');
        record.upgrade.completedSteps = [plan.sourceSchema === 6 ? 'config-schema6-no-op' : `config-${plan.sourceSchema}-to-6`, 'nine-owner-integrity', 'history-remains-inactive'];
        await this.hook('CONVERTED', { stage, target: input.targetDataRoot });
      } });
    return { schemaVersion: 1, scope: 'isolated-upgrade', status: result.status, operationId: result.operationId, targetSchema: 6, sourceSchema: plan.sourceSchema,
      conversion: result.conversion, ownerCoverage: plan.owners, sourcePreserved: true, rollbackRetained: true, reactivatedClaims: false, osMutation: false, doctor: result.doctor };
  }
  async recover({ workspace, rollback = false, confirm } = {}) {
    const scope = await this.scope(workspace);
    if (typeof confirm !== 'function' || await confirm({ action: rollback ? 'rollback' : 'recover', planId: scope.plan.id }) !== true) throw fail('UPGRADE_CONFIRMATION_REQUIRED');
    return this.existing(scope, { rollback, confirm: async () => true });
  }
}
