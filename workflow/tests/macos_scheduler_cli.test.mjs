import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { main } from '../tools/runner/main.mjs';
import { scheduleSpec } from '../tools/lib/os_scheduler.mjs';
import { schedulerCommands } from '../tools/runner/os_scheduler.mjs';

const spec = scheduleSpec({ platform: 'darwin', paths: { applicationRoot: '/Users/lab/程序', userDataRoot: '/Users/lab/数据', cacheRoot: '/Users/lab/缓存', layout: 'installed' },
  config: { schemaVersion: 6, mode: 'desktop', scheduler: { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' } } });
const report = () => ({ schemaVersion: 1, status: 'UNKNOWN', spec, osMutation: false, registration: 'not-tested',
  checks: ['contract', 'application', 'secretSource', 'lease', 'recovery', 'claim', 'hostTimezone', 'runnerDecision'].map(id => ({ checkId: 'scheduler.' + id, status: 'PASS' })).concat({ checkId: 'scheduler.platform', status: 'UNKNOWN' }) });
async function cli(argv, value = report(), execute = async operation => ({ operation, status: operation === 'unregister' ? 'not-installed' : 'loaded', taskId: spec.taskId })) {
  let output = ''; const calls = [];
  const code = await main(argv, { env: { PAPERECHO_SKIP_DOTENV: '1' }, stdout: { write: text => { output += text; } },
    schedulerInspect: async () => value, schedulerAdapter: execute === null ? undefined : { execute: async (operation, input) => { calls.push(operation); assert.equal(input, value.spec); return execute(operation, input); } } });
  return { code, value: JSON.parse(output), calls, output };
}

test('existing explicit CLI maps four Mac lifecycle commands without promoting release readiness', async () => {
  for (const [command, operation] of [['register', 'register'], ['query', 'status'], ['update', 'update'], ['delete', 'unregister']]) {
    const r = report(); const before = JSON.stringify(r);
    const result = await cli(['--schedule-' + command], r);
    assert.equal(result.code, 0); assert.deepEqual(result.calls, [operation]); assert.equal(result.value.operation, operation);
    assert.equal(result.value.readiness, 'UNKNOWN'); assert.equal(result.value.releaseValidated, false); assert.equal(JSON.stringify(r), before);
  }
});

test('formal preflight/dry-run remain UNKNOWN and never contact a management adapter', async () => {
  for (const command of ['preflight', 'dry-run']) {
    const result = await cli(['--schedule-' + command], report(), () => assert.fail('readonly command cannot manage a job'));
    assert.equal(result.code, 3); assert.equal(result.value.status, 'UNKNOWN'); assert.equal(result.value.definition, undefined); assert.deepEqual(result.calls, []);
  }
});

test('every safety check remains mandatory; unknown, failed and missing checks cannot reach launchctl', async () => {
  for (const index of report().checks.keys()) {
    if (index === report().checks.length - 1) continue;
    for (const status of ['FAIL', 'UNKNOWN']) {
      const r = report(); r.checks[index].status = status;
      const result = await cli(['--schedule-register'], r); assert.equal(result.code, 2); assert.equal(result.value.code, 'SCHEDULER_PREFLIGHT_BLOCKED'); assert.deepEqual(result.calls, []);
    }
    const r = report(); r.checks.splice(index, 1);
    assert.equal((await cli(['--schedule-update'], r)).value.code, 'SCHEDULER_PREFLIGHT_BLOCKED');
  }
  const r = report(); r.status = 'FAIL'; assert.equal((await cli(['--schedule-register'], r)).value.code, 'SCHEDULER_PREFLIGHT_BLOCKED');
});

test('status distinguishes native states, while uncertain query and native failures retain truthful exit codes', async () => {
  for (const status of ['not-installed', 'installed-not-loaded', 'loaded', 'UNKNOWN']) {
    const result = await cli(['--schedule-query'], report(), async operation => ({ operation, taskId: spec.taskId, status }));
    assert.equal(result.value.status, status); assert.equal(result.code, status === 'UNKNOWN' ? 3 : 0);
  }
  for (const error of ['SCHEDULER_QUERY_FAILED', 'SCHEDULER_TASK_OWNERSHIP_MISMATCH', 'SCHEDULER_UPDATE_RECOVERY_REQUIRED', 'private-token-and-path']) {
    const result = await cli(['--schedule-update'], report(), async () => { throw new Error(error); });
    assert.equal(result.code, 2); assert.equal(result.value.osMutation, 'not-confirmed'); assert.deepEqual(result.calls, ['update']);
    assert.equal(result.value.code, error.startsWith('SCHEDULER_') ? error : 'SCHEDULER_OPERATION_FAILED'); assert.doesNotMatch(result.output, /private-token-and-path/);
  }
});

test('native platform guard, unsupported operations, invalid arguments and malformed results fail closed', async () => {
  if (process.platform !== 'darwin') assert.equal((await cli(['--schedule-register'], report(), null)).value.code, 'SCHEDULER_MACOS_REQUIRED');
  for (const op of ['enable', 'disable', 'run']) {
    const result = await cli(['--schedule-' + op]); assert.equal(result.value.code, 'SCHEDULER_OPERATION_UNSUPPORTED'); assert.deepEqual(result.calls, []);
  }
  assert.equal((await cli(['--schedule-register', 'Secret=not-allowed'])).code, 3);
  assert.equal((await cli(['--schedule-query'], report(), async () => ({ status: 'loaded', taskId: 'foreign' }))).value.code, 'SCHEDULER_RESULT_INVALID');
  assert.equal((await cli(['--schedule-delete'], report(), async operation => ({ status: 'loaded', operation, taskId: spec.taskId }))).value.code, 'SCHEDULER_RESULT_INVALID');
  const local = report(); local.spec = structuredClone(spec); local.spec.args[10] = 'local';
  const rejected = await cli(['--schedule-register'], local); assert.equal(rejected.value.code, 'SCHEDULER_MODE_UNSUPPORTED'); assert.deepEqual(rejected.calls, []);
  const r = report(); r.spec = { ...spec, platform: 'linux' }; assert.deepEqual((await cli(['--schedule-register'], r)).calls, []);
});

test('only safe lifecycle result fields reach CLI; default startup has no implicit management call', async () => {
  const result = await cli(['--schedule-register'], report(), async operation => ({ status: 'loaded', operation, taskId: spec.taskId, secret: 'private-token', args: ['private-token'], pid: 123, lastExit: -15 }));
  assert.doesNotMatch(result.output, /private-token|secret|args/); assert.equal(result.value.pid, 123); assert.equal(result.value.lastExit, -15);
  assert.deepEqual(schedulerCommands.filter(command => /register|query|update|delete/.test(command)), ['--schedule-register', '--schedule-query', '--schedule-update', '--schedule-delete']);
  for (const file of ['../../desktop/electron-poc/main.mjs', '../../desktop/electron-poc/runtime.mjs']) {
    const source = await fs.readFile(new URL(file, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /new MacLaunchAgent|manageOsSchedule\(/);
  }
});
