import path from 'node:path';
import { UpgradePreflightService } from '../lib/upgrade_preflight_service.mjs';
import { readBackupPassword } from './backup.mjs';

export async function upgradeMain(argv, { env = process.env, cwd, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin } = {}) {
  let password;
  try {
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
  } catch {
    stdout.write('{"schemaVersion":1,"status":"BLOCKED","code":"UPGRADE_ARGUMENT_OR_PASSWORD_CHANNEL_INVALID","executionAllowed":false,"osMutation":false}\n'); return 3;
  } finally { password?.fill(0); }
}
