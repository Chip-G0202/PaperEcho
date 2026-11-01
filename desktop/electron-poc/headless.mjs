import { preparePackagedStartup, applyHeadlessRuntimeArguments } from './runtime.mjs';
import { RuntimeLog } from '../../workflow/tools/lib/runtime_logging.mjs';

export async function runHeadless(argv = process.argv.slice(2)) {
let prepared = false;
try {
  argv = applyHeadlessRuntimeArguments(argv);
  const readOnly = argv.some(x => ['--upgrade-preflight', '--upgrade-dry-run', '--reinstall-preflight', '--reinstall-confirm', '--upgrade-execute', '--upgrade-recover', '--upgrade-rollback', '--schedule-remove-installation', '--schedule-preflight', '--schedule-dry-run', '--schedule-register', '--schedule-query', '--schedule-enable', '--schedule-disable', '--schedule-update', '--schedule-run', '--schedule-delete', '--doctor', '--backup', '--verify-backup', '--verify-backup-data', '--restore-backup', '--restore-existing', '--restore-preflight', '--restore-recover', '--restore-rollback'].includes(x));
  await preparePackagedStartup({ readOnly });
  prepared = true;
  if (process.platform === 'darwin' && argv.includes('--scheduled-daily') && Intl.DateTimeFormat().resolvedOptions().timeZone !== 'Asia/Shanghai') throw new Error('SCHEDULER_HOST_TIMEZONE_REQUIRED');
  if (argv.length === 1 && argv[0] === '--schedule-remove-installation') {
    if (process.platform !== 'win32') throw new Error('SCHEDULER_WINDOWS_REQUIRED');
    const { resolveRuntimePaths } = await import('../../workflow/tools/lib/runtime_config.mjs');
    const { WindowsTaskScheduler } = await import('../../workflow/tools/lib/windows_task_scheduler.mjs');
    await new WindowsTaskScheduler().removeInstallationTasks(resolveRuntimePaths({ env: process.env }));
    return 0;
  }
  if (!readOnly) await new RuntimeLog({ warning: code => process.stderr.write(`[logging] ${code}\n`) }).write('HEADLESS_STARTED', { subsystem: 'headless' });
  const { main } = await import('../../workflow/tools/runner/main.mjs');
  return await main(argv);
} catch {
  if (prepared && !argv.some(x => ['--upgrade-preflight', '--upgrade-dry-run', '--reinstall-preflight', '--reinstall-confirm', '--upgrade-execute', '--upgrade-recover', '--upgrade-rollback', '--schedule-remove-installation', '--schedule-preflight', '--schedule-dry-run', '--schedule-register', '--schedule-query', '--schedule-enable', '--schedule-disable', '--schedule-update', '--schedule-run', '--schedule-delete', '--doctor', '--backup', '--verify-backup', '--verify-backup-data', '--restore-backup', '--restore-existing', '--restore-preflight', '--restore-recover', '--restore-rollback'].includes(x))) await new RuntimeLog().write('HEADLESS_START_FAILED', { subsystem: 'headless' });
  process.stderr.write('PAPERECHO_HEADLESS_START_FAILED\n');
  return 2;
}
}
if (process.type !== 'browser') process.exitCode = await runHeadless();
