import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { migrationFixture, upgradeFileHashes } from '../../tests/helpers/upgrade_migration_fixture.mjs';
import { inspectRestoreTransaction, assertRestoreWritable } from '../tools/recovery/restore_transaction_status.mjs';
import { validateOperationLedger } from '../tools/recovery/operation_ledger.mjs';
import { validateNotificationReceipt } from '../tools/stage5/email_receipt.mjs';
import { ResearchEvaluationService } from '../tools/lib/research_evaluation_service.mjs';
import { RuleSuggestionService } from '../tools/lib/control_rule_suggestion_service.mjs';
import { createRunRecoveryCoordinator } from '../tools/recovery/run_recovery.mjs';
import { blockMigrationNetwork } from '../../tests/helpers/upgrade_migration_process.mjs';
import { writeUpgradeFixture } from '../../tests/helpers/upgrade_fixture.mjs';
import { sha256 } from '../tools/lib/backup_format.mjs';
import { parseRssItems } from '../tools/stage1/retrieval_step.mjs';
import { getReviewDisplayMetadata } from '../tools/lib/review_display_metadata.mjs';
import { exportAllResearchOsXlsxWithNodeFallback } from '../tools/stage4/spreadsheet_adapter.mjs';

test('schema5 upgrade preserves RSS publication provenance and shared UI/XLSX venue semantics', async t => {
  const network = blockMigrationNetwork();
  t.after(() => { network.restore(); assert.equal(network.calls, 0); });
  const sources = [
    { name: 'Item metadata feed', url: 'https://example.invalid/a', publicationTitle: 'Configured Lower Priority Journal', enabled: true },
    { name: 'Single journal feed', url: 'https://example.invalid/b', publicationTitle: 'Configured Journal', enabled: true },
    { name: 'Combined research feed', url: 'https://example.invalid/c', enabled: true },
    { name: 'Unknown source', url: 'https://example.invalid/d', enabled: true },
  ];
  const feeds = sources.map((source, i) => `<rss xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"><channel><title>${i === 2 ? 'Neuroscience Research Roundup' : source.name}</title><item><title>Synthetic RSS paper ${i}</title><link>https://example.invalid/paper/${i}</link>${i === 0 ? '<prism:publicationName>Trusted Article Journal</prism:publicationName>' : ''}</item></channel></rss>`);
  const parse = config => sources.flatMap((source, i) => parseRssItems(feeds[i], source.url, config.rss.sources[i]).map(item => ({ ...item, grade: 'B', semantic_grade: 'B', semantic_stage_status: 'completed', final_grade: 'B' })));
  const relative = 'review_results/pipeline/rss-compat/triaged_items.json';
  const expected = ['Trusted Article Journal', 'Configured Journal', '', ''];
  const f = await migrationFixture(t, { schema: 5, prepareSource: async source => {
    source.config.rss = { sources };
    await writeUpgradeFixture(source.context.configPath, source.config);
    source.context.backupConfigHash = sha256(await fs.readFile(source.context.configPath));
    await writeUpgradeFixture(path.join(source.data, relative), parse(source.config));
  } });
  const original = await fs.readFile(path.join(f.data, relative));
  const archive = await fs.readFile(f.backup);
  const before = await upgradeFileHashes(f.data);
  const display = async (items, label) => {
    const metadata = items.map(item => getReviewDisplayMetadata(item));
    assert.deepEqual(metadata.map(item => item.journal), expected);
    assert.ok(metadata.every(item => item.source === 'RSS'));
    assert.equal(metadata[2].rawSourceLabel, 'Neuroscience Research Roundup');
    const dir = path.join(f.root, label), sourcePath = path.join(dir, 'export.json');
    await writeUpgradeFixture(sourcePath, { triaged: items });
    await exportAllResearchOsXlsxWithNodeFallback({ sourcePath, reviewRootDir: dir, reviewWeekDir: dir, reviewDayDir: dir });
    const { default: ExcelJS } = await import('exceljs');
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.join(dir, '周报.xlsx'));
    const sheet = workbook.getWorksheet('每日反馈');
    assert.equal(sheet.rowCount, 5);
    assert.deepEqual(items.map((_, i) => sheet.getRow(i + 2).getCell(6).value), expected.map(venue => venue || 'RSS'));
    return metadata;
  };
  const originalDisplay = await display(JSON.parse(original), 'display-before');
  const result = await f.execute();
  assert.equal(result.status, 'committed'); assert.equal(result.reactivatedClaims, false); assert.equal(result.doctor.canRun, false);
  const migrated = JSON.parse(await fs.readFile(path.join(f.target, 'config/paperecho.config.json')));
  assert.equal(migrated.schemaVersion, 6); assert.deepEqual(migrated.rss, f.config.rss);
  const history = await fs.readFile(path.join(f.target, relative));
  assert.deepEqual(history, original);
  assert.deepEqual(await display(JSON.parse(history), 'display-after'), originalDisplay);
  assert.deepEqual(parse(migrated), JSON.parse(original));
  assert.deepEqual(await upgradeFileHashes(f.data), before); assert.deepEqual(await fs.readFile(f.backup), archive);
  assert.ok(!JSON.stringify(result).includes('dummy-upgrade-local-secret')); assert.equal(network.calls, 0);
});

test('schema5 upgrade preserves prepared/published feedback fingerprints and reviewed history without replay', async t => {
  const network = blockMigrationNetwork();
  t.after(() => { network.restore(); assert.equal(network.calls, 0); });
  let calls = 0;
  const f = await migrationFixture(t, { schema: 5, history: true, prepareSource: async source => {
    const reviewRoot = path.join(source.data, 'review_results/文献评价');
    const research = new ResearchEvaluationService({ root: source.data, reviewRoot, env: source.env, llmClient: async () => {
      calls++; return { rules_added: [], rules_deleted: [], rules_changed: [], keywords_added: { required: [], optional: [`compatibility_term_${calls}`], negative: [] }, keywords_removed: [], negative_keywords_added: [], unmapped_feedback: [] };
    } });
    for (const state of ['published', 'prepared']) {
      const runId = `compat-${state}`;
      await research.submit({ requestId: runId, text: `合成研究反馈 ${state}` });
      const coordinator = await createRunRecoveryCoordinator({ runRoot: path.join(reviewRoot, 'runs'), runId, mode: 'web', profile: 'standard', launcherId: 'compatibility-fixture',
        configHash: source.context.backupConfigHash, inputHash: 'b'.repeat(64), artifactPath: path.join(reviewRoot, 'runs', runId, 'input_artifact.json') });
      await coordinator.persistArtifact([], []);
      assert.equal((await research.prepare({ store: coordinator.store })).status, 'prepared');
      for (const stage of ['stage1', 'stage2_writeback', 'stage3_translation', 'stage4_exports']) await coordinator.store.setStage(stage, 'verified');
      await coordinator.store.setRunStatus('completed', 'completed');
      if (state === 'published') {
        assert.equal((await research.publish({ store: coordinator.store })).status, 'published');
        const rules = new RuleSuggestionService({ root: source.data, reviewRoot, env: source.env });
        const suggestion = (await rules.list()).find(item => item.feedback_event_ids?.includes(runId));
        assert.ok(suggestion); await rules.decide({ id: suggestion.id, decision: 'rejected', humanApproval: true });
      }
    }
    await research.submit({ requestId: 'compat-pending', text: '合成待处理反馈' });
  } });
  assert.equal(calls, 2);
  const archive = await fs.readFile(f.backup), before = await upgradeFileHashes(f.data);
  let guarded = false;
  const result = await f.execute({ service: { hook: async phase => {
    if (phase !== 'PREPARED') return; guarded = true;
    assert.equal(inspectRestoreTransaction(f.data).blocking, true); assert.equal(inspectRestoreTransaction(f.target).blocking, true);
    assert.throws(() => assertRestoreWritable(f.context.configPath), /RESTORE_RECOVERY_REQUIRED/);
  } } });
  assert.equal(guarded, true); assert.equal(result.status, 'committed'); assert.equal(result.reactivatedClaims, false); assert.equal(result.doctor.canRun, false);
  const review = path.join(f.target, 'review_results/文献评价');
  for (const state of ['prepared', 'published']) {
    const batch = JSON.parse(await fs.readFile(path.join(review, 'runs', `compat-${state}`, 'research_evaluation_batch.json')));
    assert.equal(batch.status, state); assert.match(batch.inputHash, /^[a-f0-9]{64}$/); assert.match(batch.resultHash, /^[a-f0-9]{64}$/);
    assert.ok(batch.candidates.every(item => item.feedback_event_ids.includes(`compat-${state}`)));
  }
  const targetResearch = new ResearchEvaluationService({ root: f.target, reviewRoot: review, env: f.hostEnv, llmClient: () => assert.fail('migration must not regenerate feedback') });
  assert.equal((await targetResearch.health()).prepared, 1);
  const log = JSON.parse(await fs.readFile(path.join(review, 'standards_rule_suggestions_log.json')));
  assert.ok(log.suggestions.some(item => item.status === 'rejected' && item.decision_history?.length));
  assert.ok(log.suggestions.some(item => ['pending', 'candidate'].includes(item.status)));
  for (const relative of Object.keys(before)) {
    if (!relative.startsWith('review_results' + path.sep)) continue;
    assert.deepEqual(await fs.readFile(path.join(f.target, relative)), await fs.readFile(path.join(f.data, relative)), relative);
  }
  assert.deepEqual(await upgradeFileHashes(f.data), before); assert.deepEqual(await fs.readFile(f.backup), archive);
  assert.deepEqual(await fs.readFile(path.join(f.target, '.env')), await fs.readFile(path.join(f.data, '.env')));
  const receipt = JSON.parse(await fs.readFile(path.join(f.target, '.paperecho-restore.json')));
  assert.equal(receipt.workflowAllowed, false); assert.equal(receipt.reactivateClaims, false);
  const response = JSON.stringify(result);
  for (const text of ['dummy-upgrade-local-secret', '合成研究反馈', '合成待处理反馈']) assert.ok(!response.includes(text));
  const targetBefore = await upgradeFileHashes(f.target);
  assert.equal((await f.recover()).status, 'committed'); assert.equal((await f.recover()).status, 'committed');
  assert.deepEqual(await upgradeFileHashes(f.target), targetBefore); assert.equal(calls, 2); assert.equal(network.calls, 0);
  assert.equal((await f.recover({ rollback: true })).status, 'rolled-back'); assert.equal((await f.recover()).status, 'rolled-back');
  assert.deepEqual(await upgradeFileHashes(f.data), before); assert.deepEqual(await fs.readFile(f.backup), archive);
});

test('completed ledger, receipt and nine data owners survive migration without reactivation or source changes', async t => {
  const f = await migrationFixture(t, { schema: 5, history: true });
  const result = await f.execute(); assert.equal(result.status, 'committed'); assert.equal(result.ownerCoverage.length, 9);
  assert.ok(result.ownerCoverage.every(owner => owner.status === 'covered'));
  for (const file of ['operation_ledger.json', 'stage5/email_receipt.json']) {
    const relative = path.join('review_results/pipeline/dummy-history', file);
    assert.deepEqual(await fs.readFile(path.join(f.target, relative)), await fs.readFile(path.join(f.data, relative)));
  }
  assert.equal(validateOperationLedger(JSON.parse(await fs.readFile(path.join(f.target, 'review_results/pipeline/dummy-history/operation_ledger.json')))).status, 'completed');
  assert.equal(validateNotificationReceipt(JSON.parse(await fs.readFile(path.join(f.target, 'review_results/pipeline/dummy-history/stage5/email_receipt.json')))).status, 'accepted');
  assert.equal(result.doctor.canRun, false); assert.equal(result.reactivatedClaims, false);
  assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes); assert.equal((await f.recover({ rollback: true })).status, 'rolled-back');
});

test('staging ENOSPC and postpublication Doctor failure roll back without modifying source or backup', async t => {
  for (const cause of ['disk', 'doctor']) {
    const f = await migrationFixture(t, { secret: false }); const archive = await fs.readFile(f.backup); let fired = false;
    const fsApi = { ...fs, open: async (...args) => {
      if (cause === 'disk' && args[1] === 'wx' && path.basename(args[0]) === '.paperecho-restore.json') { fired = true; throw Object.assign(new Error('DUMMY_DISK_FULL'), { code: 'ENOSPC' }); }
      return fs.open(...args);
    } };
    await assert.rejects(f.execute({ service: { fsApi, hook: async phase => {
      if (cause === 'doctor' && phase === 'NEW_PUBLISHED') { fired = true; await fs.unlink(path.join(f.targetApp, 'resources/core/workflow/tools/web/static/index.html')); }
    } } }), e => e.code === (cause === 'disk' ? 'ENOSPC' : 'RESTORE_DOCTOR_BLOCKED'));
    assert.equal(fired, true); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK');
    assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes); assert.deepEqual(await fs.readFile(f.backup), archive);
    assert.equal((await f.recover()).status, 'rolled-back');
  }
});

test('real unsafe Secret DACL is rejected during staging; junctions and unsupported plans never publish', async t => {
  const f = await migrationFixture(t);
  const script = `$ErrorActionPreference='Stop';$file=[IO.FileInfo]::new($env:TEST_FILE);$acl=[IO.FileSystemAclExtensions]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access);$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'Read','Allow'));[IO.FileSystemAclExtensions]::SetAccessControl($file,$acl);$again=[IO.FileSystemAclExtensions]::GetAccessControl($file,[Security.AccessControl.AccessControlSections]::Access);if (@($again.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object{$_.IdentityReference.Value -eq 'S-1-1-0' -and $_.AccessControlType -eq 'Allow'}).Count -lt 1) {throw 'FIXTURE_INVALID'}`;
  let fired = false;
  await assert.rejects(f.execute({ service: { hook: async (phase, { stage }) => {
    if (phase !== 'STAGING_before-publish') return; fired = true;
    await promisify(execFile)(process.env.PWSH_PATH || 'pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEST_FILE: path.join(stage, '.env') } });
  } } }), /CREDENTIAL_ACL_UNSAFE/);
  assert.equal(fired, true); assert.equal(inspectRestoreTransaction(f.target).state, 'ROLLED_BACK'); assert.deepEqual(await upgradeFileHashes(f.data), f.sourceHashes);
  const other = await migrationFixture(t, { secret: false }), alias = path.join(other.data, 'linked-directory');
  await fs.symlink(path.join(other.root, 'new-program'), alias, 'junction');
  await assert.rejects(other.execute(), /BACKUP_PATH_UNSAFE/); await fs.unlink(alias);
  for (const schema of [1, 2, 999]) {
    await fs.writeFile(path.join(other.root, 'plan.json'), JSON.stringify({ ...other.plan, sourceSchema: schema }));
    await assert.rejects(other.execute(), /UPGRADE_EXECUTION_PATH_BLOCKED/);
  }
  assert.equal(inspectRestoreTransaction(other.target).state, 'ABSENT');
});
