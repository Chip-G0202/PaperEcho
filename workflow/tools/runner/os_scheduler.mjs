import { inspectOsSchedule } from '../lib/os_scheduler.mjs';

export async function schedulerMain(argv, { env = process.env, cwd, stdout = process.stdout } = {}) {
  if (argv.length !== 1 || !['--schedule-preflight', '--schedule-dry-run'].includes(argv[0])) {
    stdout.write('{"schemaVersion":1,"status":"FAIL","code":"SCHEDULER_ARGUMENT_INVALID","osMutation":false}\n'); return 3;
  }
  const report = await inspectOsSchedule({ env, applicationRoot: cwd });
  const { spec, definition, ...safe } = report;
  safe.runtime = { embedded: Boolean(process.versions.electron), node: process.versions.node, browserProcess: process.type === 'browser', pid: process.pid };
  if (spec) {
    safe.schedule = { taskId: spec.taskId, enabled: spec.enabled, layout: spec.layout, time: spec.time, timezone: spec.timezone,
      missedRun: spec.missedRun, dst: spec.dst, identity: spec.identity, concurrentRun: spec.concurrentRun, duplicateTask: spec.duplicateTask };
    // The downloadable definition is a reviewable template, not a registration command.
    // No username, actual root, environment value or Secret crosses stdout.
    if (argv[0] === '--schedule-dry-run' && report.status === 'PASS') {
      const replacements = [[spec.userDataRoot, '__USER_DATA_ROOT__'], [spec.cacheRoot, '__CACHE_ROOT__'], [spec.workingDirectory, '__APPLICATION_ROOT__']].sort((a, b) => b[0].length - a[0].length);
      let content = definition.content;
      for (const [value, label] of replacements) {
        const escaped = value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
        content = content.split(escaped).join(label);
      }
      safe.definition = { ...definition, content, paths: 'redacted-template' };
    }
  }
  stdout.write(JSON.stringify(safe) + '\n');
  return report.status === 'PASS' ? 0 : report.status === 'UNKNOWN' ? 3 : 2;
}
