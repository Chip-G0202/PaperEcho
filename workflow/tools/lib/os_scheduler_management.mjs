import { inspectOsSchedule } from './os_scheduler.mjs';
import { WindowsTaskScheduler, taskOperations } from './windows_task_scheduler.mjs';

// Management is explicit. Ordinary GET/preflight/dry-run never creates an adapter.
export async function manageOsSchedule(operation, { env = process.env, applicationRoot, adapter, inspect = inspectOsSchedule } = {}) {
  if (!taskOperations.includes(operation)) throw new Error('SCHEDULER_ARGUMENT_INVALID');
  const report = await inspect({ env, applicationRoot });
  if (!report.spec || report.spec.platform !== 'win32') throw new Error('SCHEDULER_WINDOWS_SPEC_REQUIRED');
  if (['register', 'update', 'enable', 'run'].includes(operation) && report.status !== 'PASS') throw new Error('SCHEDULER_PREFLIGHT_BLOCKED');
  if (['enable', 'run'].includes(operation) && !report.spec.enabled) throw new Error('SCHEDULER_CONFIG_DISABLED');
  return (adapter || new WindowsTaskScheduler({ env })).execute(operation, report.spec);
}
