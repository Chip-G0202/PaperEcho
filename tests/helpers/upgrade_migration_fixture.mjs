import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { upgradeFixture, upgradePassword, upgradeFileHashes, writeUpgradeFixture } from './upgrade_fixture.mjs';
import { holdRestoreParent } from '../../workflow/tools/lib/restore_filesystem.mjs';
import { UpgradeMigrationService } from '../../workflow/tools/lib/upgrade_migration_service.mjs';
import { BackupService } from '../../workflow/tools/lib/backup_service.mjs';
import { sha256 } from '../../workflow/tools/lib/backup_format.mjs';
import { OperationLedgerStore } from '../../workflow/tools/recovery/operation_ledger.mjs';
import { createNotificationReceipt, validateNotificationReceipt } from '../../workflow/tools/stage5/email_receipt.mjs';
const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export async function migrationFixture(t, options = {}) {
  const parent = path.join(repo, 'tests/runs/phase6b'); await fs.mkdir(parent, { recursive: true });
  const root = options.workspace || path.join(parent, randomUUID());
  if (path.dirname(root) !== parent || !/^[a-f0-9-]{36}$/.test(path.basename(root))) throw new Error('FIXTURE_SCOPE_INVALID');
  if (!options.workspace) { const guard = await holdRestoreParent(root); await guard.release(); }
  const layout = options.layout || (options.legacy === false ? 'installed' : 'dev');
  const source = layout === 'dev' ? path.join(root, 'old-program') : layout === 'portable' ? path.join(root, 'old-program/data') : path.join(root, 'old-data');
  await fs.mkdir(path.dirname(source), { recursive: true }); const sourceGuard = await holdRestoreParent(source); await sourceGuard.release();
  const f = await upgradeFixture(t, { ...options, legacy: options.legacy !== false, layout, fixtureRoot: root, makeBackup: false });
  if (!options.applicationRoot) for (const file of ['workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html']) {
    const target = path.join(f.targetApp, 'resources/core', file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(repo, file), target);
  }
  if (options.scheduler) {
    f.config.scheduler = options.scheduler; await writeUpgradeFixture(f.context.configPath, f.config);
    f.context.backupConfigHash = sha256(await fs.readFile(f.context.configPath));
  }
  await writeUpgradeFixture(path.join(f.data, 'review_results/文献评价/standards_rule_suggestions_log.json'), { suggestions: [] });
  await writeUpgradeFixture(path.join(f.data, 'review_results/文献评价/测试 & 导出.xlsx'), 'dummy-private-export-bytes');
  if (options.history) {
    const runRoot = path.join(f.data, 'review_results/pipeline'), runId = 'dummy-history';
    const artifactPath = path.join(runRoot, runId, 'run_report.json');
    await writeUpgradeFixture(artifactPath, { schemaVersion: 1, status: 'completed', fixture: true });
    const store = await OperationLedgerStore.create({ runRoot, runId, mode: 'desktop', profile: 'standard',
      configHash: f.context.backupConfigHash, inputHash: sha256('dummy-history-input'), artifactPath });
    await store.bindArtifact(); await store.setRunStatus('completed', 'completed');
    const receipt = createNotificationReceipt({ notificationType: 'weekly', runId, businessSubject: 'dummy-history', eventEpoch: 'dummy-epoch', payload: {}, recipient: 'fixture@example.invalid' });
    receipt.status = 'accepted'; receipt.attempts = 1;
    await writeUpgradeFixture(path.join(runRoot, runId, 'stage5/email_receipt.json'), validateNotificationReceipt(receipt));
  }
  await writeUpgradeFixture(path.join(root, 'synthetic-workspace.json'), { schemaVersion: 1, kind: 'paperecho-synthetic-upgrade', fixtureId: path.basename(root), sourceLayout: f.input.sourceLayout, targetLayout: f.input.targetLayout });
  const make = extra => new UpgradeMigrationService({ env: f.hostEnv, ...extra });
  const beforeBackup = await make().inspect({ ...f.input });
  if (beforeBackup.status !== 'UNKNOWN') throw new Error('FIXTURE_PREFLIGHT_EXPECTED_BACKUP_UNKNOWN');
  await new BackupService({ context: f.context, env: f.env }).create({ output: f.backup, password: upgradePassword() });
  const report = await make().inspect({ ...f.input, password: upgradePassword() });
  if (report.status !== 'PASS') throw new Error('FIXTURE_PREFLIGHT_FAILED:' + JSON.stringify(report.checks));
  await writeUpgradeFixture(path.join(root, 'plan.json'), report.plan);
  return { ...f, make, plan: report.plan, beforeBackup, sourceHashes: await upgradeFileHashes(f.data),
    execute: extra => make(extra?.service).execute({ workspace: root, password: upgradePassword(), confirm: async () => true, ...extra }),
    recover: extra => make(extra?.service).recover({ workspace: root, confirm: async () => true, ...extra }) };
}
export { upgradePassword, upgradeFileHashes };
