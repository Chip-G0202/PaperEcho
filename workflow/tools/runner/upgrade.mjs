import path from 'node:path';
import { UpgradePreflightService } from '../lib/upgrade_preflight_service.mjs';
import { readBackupPassword } from './backup.mjs';
import { readBoundedJson } from '../lib/atomic_json.mjs';
import { backupSafePath } from '../lib/backup_service.mjs';
import { createInterface } from 'node:readline/promises';

const reinstallError = code => Object.assign(new Error(code), { code });
export async function confirmReinstallPlan(report, { expectedPlanId, stdin, stderr, confirmReinstall, revalidate } = {}) {
  if (report.status !== 'READY_FOR_USER_CONFIRMATION' || !report.plan || report.uninstallAllowed !== false) throw reinstallError('UPGRADE_REINSTALL_PREFLIGHT_BLOCKED');
  if (report.plan.id !== expectedPlanId) throw reinstallError('UPGRADE_REINSTALL_PLAN_STALE');
  if (!confirmReinstall && !stdin?.isTTY) throw reinstallError('UPGRADE_REINSTALL_CONFIRMATION_REQUIRED');
  const summary = structuredClone(report.plan);
  stderr?.write('This requires downtime and manual uninstall. The verified backup and trusted old package must be retained. This is NOT atomic MSI rollback; you may CANCEL.\n');
  stderr?.write(`Verified backup: ${summary.backupVerified === true}; retained old package: ${summary.packages[0].version}, SHA256 ${summary.packages[0].sha256}.\n`);
  stderr?.write('Recovery: stop on failure, manually reinstall the retained old package, or explicitly restore the authenticated backup to a NEW EMPTY root; then verify data and Doctor.\n');
  if (report.testOnly) stderr?.write('TEST ONLY adapter evidence; this is not production installer authorization.\n');
  let approved;
  if (confirmReinstall) approved = await confirmReinstall(summary) === true;
  else {
    const terminal = createInterface({ input: stdin, output: stderr });
    try { approved = await terminal.question(`Type REINSTALL ${summary.id} to proceed manually, or CANCEL: `) === `REINSTALL ${summary.id}`; }
    finally { terminal.close(); }
  }
  if (approved) {
    if (typeof revalidate !== 'function') throw reinstallError('UPGRADE_REINSTALL_REVALIDATION_REQUIRED');
    const current = await revalidate();
    if (current.status !== 'READY_FOR_USER_CONFIRMATION' || current.plan?.id !== expectedPlanId) throw reinstallError('UPGRADE_REINSTALL_PLAN_STALE');
    report = current;
  }
  return { ...report, status: approved ? 'USER_CONFIRMED_MANUAL_REINSTALL' : 'CANCELLED', uninstallAllowed: approved,
    executionAllowed: false, osMutation: false, approvalId: approved ? summary.id : null };
}

export async function upgradeMain(argv, { env = process.env, cwd, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, confirmReinstall } = {}) {
  let password;
  try {
    if (['--reinstall-preflight', '--reinstall-confirm'].includes(argv[0])) {
      const confirming = argv[0] === '--reinstall-confirm', count = confirming ? 5 : 3;
      if (![count, count + 1].includes(argv.length) || argv[1] !== '--request' || !path.isAbsolute(argv[2] || '')
        || argv.length === count + 1 && argv.at(-1) !== '--password-stdin'
        || confirming && (argv[3] !== '--confirm-plan' || !/^[a-f0-9]{64}$/.test(argv[4] || ''))) throw reinstallError('UPGRADE_REINSTALL_ARGUMENT_INVALID');
      if (confirming && !confirmReinstall && !stdin.isTTY) throw reinstallError('UPGRADE_REINSTALL_CONFIRMATION_REQUIRED');
      await backupSafePath(argv[2]); const input = await readBoundedJson(path.dirname(argv[2]), argv[2]);
      const fields = ['schemaVersion', 'sourceApplicationRoot', 'sourceDataRoot', 'sourceLayout', 'targetDataRoot', 'targetLayout', 'backup', 'installers'];
      if (!input || input.schemaVersion !== 1 || Object.keys(input).some(key => !fields.includes(key))
        || ![input.sourceApplicationRoot, input.sourceDataRoot].every(root => path.isAbsolute(root || ''))) throw reinstallError('UPGRADE_REINSTALL_ARGUMENT_INVALID');
      for (const root of [input.sourceApplicationRoot, input.sourceDataRoot]) {
        const relative = path.relative(root, argv[2]);
        if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) throw reinstallError('UPGRADE_REINSTALL_REQUEST_NOT_RETAINED');
      }
      password = await readBackupPassword(stdin, stderr, argv.includes('--password-stdin'));
      const { schemaVersion, ...options } = input;
      let report = await new UpgradePreflightService({ applicationRoot: cwd, env }).inspectReinstall({ ...options, password });
      if (confirming && report.status === 'READY_FOR_USER_CONFIRMATION') stderr.write(`Application: ${options.sourceApplicationRoot}\nPreserved User Root: ${options.sourceDataRoot}\nVerified backup: ${options.backup}\nEmpty recovery root: ${options.targetDataRoot}\n`);
      if (confirming) report = await confirmReinstallPlan(report, { expectedPlanId: argv[4], stdin, stderr, confirmReinstall, revalidate: async () => {
        await backupSafePath(argv[2]);
        if (JSON.stringify(await readBoundedJson(path.dirname(argv[2]), argv[2])) !== JSON.stringify(input)) throw reinstallError('UPGRADE_REINSTALL_PLAN_STALE');
        return new UpgradePreflightService({ applicationRoot: cwd, env }).inspectReinstall({ ...options, password });
      } });
      stdout.write(JSON.stringify(report) + '\n');
      return ['READY_FOR_USER_CONFIRMATION', 'USER_CONFIRMED_MANUAL_REINSTALL'].includes(report.status) ? 0 : 3;
    }
    if (['--upgrade-execute', '--upgrade-recover', '--upgrade-rollback'].includes(argv[0])) {
      const { UpgradeMigrationService } = await import('../lib/upgrade_migration_service.mjs');
      const execute = argv[0] === '--upgrade-execute';
      if (argv.length !== (execute ? 6 : 5) || argv[1] !== '--isolated-workspace' || !path.isAbsolute(argv[2] || '')
        || argv[3] !== '--confirm-plan' || !/^[a-f0-9]{64}$/.test(argv[4] || '') || execute && argv[5] !== '--password-stdin') throw new Error();
      if (execute) password = await readBackupPassword(stdin, stderr, true);
      const service = new UpgradeMigrationService({ applicationRoot: cwd, env });
      const options = { workspace: argv[2], password, confirm: async summary => summary.planId === argv[4] };
      const report = execute ? await service.execute(options) : await service.recover({ ...options, rollback: argv[0] === '--upgrade-rollback' });
      stdout.write(JSON.stringify({ ...report, runtime: { embedded: Boolean(process.versions.electron), browserProcess: process.type === 'browser', pid: process.pid } }) + '\n'); return 0;
    }
    if (!['--upgrade-preflight', '--upgrade-dry-run'].includes(argv[0])) throw new Error();
    const keys = { 'source-application-root': 'sourceApplicationRoot', 'source-data-root': 'sourceDataRoot', 'source-layout': 'sourceLayout', 'target-data-root': 'targetDataRoot', 'target-layout': 'targetLayout', 'verified-backup': 'backup' };
    const values = {}; let pipe = false;
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--password-stdin') { if (pipe) throw new Error(); pipe = true; continue; }
      const key = keys[argv[i].slice(2)];
      if (!argv[i].startsWith('--') || !key || values[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error();
      values[key] = argv[++i];
    }
    if (!['sourceApplicationRoot', 'sourceDataRoot', 'sourceLayout', 'targetDataRoot', 'targetLayout'].every(k => values[k])
      || !['sourceApplicationRoot', 'sourceDataRoot', 'targetDataRoot'].every(k => path.isAbsolute(values[k])) || values.backup && !path.isAbsolute(values.backup) || pipe && !values.backup) throw new Error();
    if (values.backup) password = await readBackupPassword(stdin, stderr, pipe);
    const report = await new UpgradePreflightService({ applicationRoot: cwd, env }).inspect({ ...values, password });
    if (argv[0] === '--upgrade-preflight' && report.plan) {
      const { steps, ...summary } = report.plan; report.plan = { ...summary, steps: steps.map(({ id, owner }) => ({ id, owner })) };
    }
    stdout.write(JSON.stringify({ ...report, runtime: { embedded: Boolean(process.versions.electron), browserProcess: process.type === 'browser', pid: process.pid } }) + '\n');
    return ['PASS', 'WARN'].includes(report.status) ? 0 : report.status === 'UNKNOWN' ? 3 : 2;
  } catch (error) {
    const code = /^(?:UPGRADE|RESTORE|BACKUP)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'UPGRADE_ARGUMENT_OR_PASSWORD_CHANNEL_INVALID';
    stdout.write(JSON.stringify({ schemaVersion: 1, status: 'BLOCKED', code, executionAllowed: false, osMutation: false }) + '\n'); return 3;
  } finally { password?.fill(0); }
}
