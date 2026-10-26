import { preparePackagedRuntime, applyHeadlessRuntimeArguments } from './runtime.mjs';
import { RuntimeLog } from '../../workflow/tools/lib/runtime_logging.mjs';

export async function runHeadless(argv = process.argv.slice(2)) {
let prepared = false;
try {
  argv = applyHeadlessRuntimeArguments(argv);
  const readOnly = argv.some(x => ['--upgrade-preflight', '--upgrade-dry-run', '--upgrade-execute', '--upgrade-recover', '--upgrade-rollback', '--schedule-preflight', '--schedule-dry-run', '--schedule-register', '--schedule-query', '--schedule-enable', '--schedule-disable', '--schedule-update', '--schedule-run', '--schedule-delete', '--doctor', '--backup', '--verify-backup', '--verify-backup-data', '--restore-backup', '--restore-existing', '--restore-preflight', '--restore-recover', '--restore-rollback'].includes(x));
  preparePackagedRuntime({ readOnly });
  prepared = true;
  if (!readOnly) await new RuntimeLog({ warning: code => process.stderr.write(`[logging] ${code}\n`) }).write('HEADLESS_STARTED', { subsystem: 'headless' });
  const { main } = await import('../../workflow/tools/runner/main.mjs');
  return await main(argv);
} catch {
  if (prepared && !argv.some(x => ['--upgrade-preflight', '--upgrade-dry-run', '--upgrade-execute', '--upgrade-recover', '--upgrade-rollback', '--schedule-preflight', '--schedule-dry-run', '--schedule-register', '--schedule-query', '--schedule-enable', '--schedule-disable', '--schedule-update', '--schedule-run', '--schedule-delete', '--doctor', '--backup', '--verify-backup', '--verify-backup-data', '--restore-backup', '--restore-existing', '--restore-preflight', '--restore-recover', '--restore-rollback'].includes(x))) await new RuntimeLog().write('HEADLESS_START_FAILED', { subsystem: 'headless' });
  process.stderr.write('PAPERECHO_HEADLESS_START_FAILED\n');
  return 2;
}
}
if (process.type !== 'browser') process.exitCode = await runHeadless();
