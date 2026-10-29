import { inspectOsSchedule } from './os_scheduler.mjs';
import { WindowsTaskScheduler, taskOperations } from './windows_task_scheduler.mjs';

// Management is explicit. Ordinary GET/preflight/dry-run never creates an adapter.
export async function manageOsSchedule(operation, { env = process.env, applicationRoot, adapter, inspect = inspectOsSchedule } = {}) {
  if (!taskOperations.includes(operation)) throw new Error('SCHEDULER_ARGUMENT_INVALID');
  const report = await inspect({ env, applicationRoot });
  if (report.spec?.platform === 'darwin') {
    const mapped = { register: 'register', query: 'status', update: 'update', delete: 'unregister' }[operation];
    if (!mapped) throw new Error('SCHEDULER_OPERATION_UNSUPPORTED');
    const required = ['scheduler.contract', 'scheduler.application', 'scheduler.secretSource', 'scheduler.lease', 'scheduler.recovery', 'scheduler.claim', 'scheduler.hostTimezone',
      ...(report.spec.enabled ? ['scheduler.runnerDecision'] : [])];
    // Platform acceptance is release evidence, not permission to bypass any
    // local safety check. Unknown credentials/paths/recovery still block edits.
    const checks = Array.isArray(report.checks) ? report.checks : [];
    if (!['PASS', 'UNKNOWN'].includes(report.status) || !required.every(id => checks.some(c => c.checkId === id && c.status === 'PASS'))
      || !checks.some(c => c.checkId === 'scheduler.platform' && ['PASS', 'UNKNOWN'].includes(c.status))
      || checks.some(c => c.status !== 'PASS' && !(c.checkId === 'scheduler.platform' && c.status === 'UNKNOWN'))) throw new Error('SCHEDULER_PREFLIGHT_BLOCKED');
    const { MacLaunchAgent, validateMacScheduleSpec } = await import('./macos_launchagent.mjs');
    validateMacScheduleSpec(report.spec);
    const result = await (adapter || new MacLaunchAgent()).execute(mapped, report.spec);
    if (!result || !['loaded', 'installed-not-loaded', 'not-installed', 'UNKNOWN'].includes(result.status)
      || result.operation !== mapped || result.taskId !== report.spec.taskId) throw new Error('SCHEDULER_RESULT_INVALID');
    if (mapped !== 'status' && result.status !== (mapped === 'unregister' ? 'not-installed' : report.spec.enabled ? 'loaded' : 'installed-not-loaded')) throw new Error('SCHEDULER_RESULT_INVALID');
    const safe = { schemaVersion: 1, status: result.status, operation: mapped, taskId: result.taskId, osMutation: mapped !== 'status', readiness: report.status, releaseValidated: false };
    for (const key of ['pid', 'lastExit']) if (Number.isSafeInteger(result[key])) safe[key] = result[key];
    if (typeof result.unchanged === 'boolean') safe.unchanged = result.unchanged;
    return safe;
  }
  if (!report.spec || report.spec.platform !== 'win32') throw new Error('SCHEDULER_WINDOWS_SPEC_REQUIRED');
  if (['register', 'update', 'enable', 'run'].includes(operation) && report.status !== 'PASS') throw new Error('SCHEDULER_PREFLIGHT_BLOCKED');
  if (['enable', 'run'].includes(operation) && !report.spec.enabled) throw new Error('SCHEDULER_CONFIG_DISABLED');
  return (adapter || new WindowsTaskScheduler({ env })).execute(operation, report.spec);
}
