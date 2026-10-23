import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleSpec } from '../tools/lib/os_scheduler.mjs';
import { WindowsTaskScheduler, validateWindowsScheduleSpec, taskOperations } from '../tools/lib/windows_task_scheduler.mjs';
import { manageOsSchedule } from '../tools/lib/os_scheduler_management.mjs';

const spec = () => scheduleSpec({ platform: 'win32', paths: { applicationRoot: 'C:\\测试 & (程序)', userDataRoot: 'C:\\测试 数据',
  cacheRoot: 'C:\\测试 缓存', layout: 'installed' }, config: { schemaVersion: 6, mode: 'desktop', profile: 'standard',
    scheduler: { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' } } });
const response = (s, extra = {}) => ({ schemaVersion: 1, status: 'PASS', exists: true, currentUser: true, leastPrivilege: true,
  interactiveToken: true, definitionMatches: true, enabled: s.enabled, state: 3, runningInstances: 0, lastTaskResult: 0, ...extra });

test('native boundary accepts only canonical spec, exact argv, local roots and no arbitrary shell target', () => {
  const s = spec(); assert.deepEqual(validateWindowsScheduleSpec(s), s);
  for (const altered of [{ ...s, executable: 'C:\\Windows\\System32\\cmd.exe' },
    { ...s, args: [...s.args, '&', 'calc.exe'] }, { ...s, taskId: '../foreign' }, { ...s, time: '02:00' },
    { ...s, args: s.args.map(x => x === '--scheduled-daily' ? '--force' : x) }]) assert.throws(() => validateWindowsScheduleSpec(altered));
});

test('all management operations use structured data and project only allowlisted native result fields (mock OS)', async () => {
  const s = spec(); const requests = [];
  const adapter = new WindowsTaskScheduler({ sandboxOnly: true, transport: async request => {
    requests.push(request);
    return response(s, { exists: request.operation !== 'delete', secret: 'dummy-never-project',
      xml: '<unsafe/>', path: s.userDataRoot, lastRunAt: '2026-10-22T07:00:00.000Z' });
  } });
  for (const op of taskOperations) {
    const result = await adapter.execute(op, s);
    assert.equal(result.operation, op); assert.equal(result.osMutation, op !== 'query');
    assert.ok(!JSON.stringify(result).includes('dummy-never-project')); assert.ok(!JSON.stringify(result).includes(s.userDataRoot));
  }
  assert.ok(requests.every(x => x.name.startsWith('PaperEcho-Sandbox-Test-') && x.sandboxOnly));
  assert.ok(requests.every(x => x.arguments.includes('--scheduled-daily') && x.arguments.includes('测试 数据')));
  assert.ok(requests.filter(x => x.definition).every(x => ['register', 'update'].includes(x.operation)));
  assert.match(requests[0].definition, /InteractiveToken/); assert.match(requests[0].definition, /LeastPrivilege/);
  assert.match(requests[0].definition, /^<\?xml version="1.0" encoding="UTF-16"\?>/);
});

test('unknown operations, malformed native responses, unsafe identity and unconfirmed deletion/registration fail closed (mock OS)', async () => {
  const s = spec(); let calls = 0;
  const make = value => new WindowsTaskScheduler({ transport: async () => { calls++; return value; } });
  await assert.rejects(make(response(s)).execute('foreign-command', s), /ARGUMENT_INVALID/); assert.equal(calls, 0);
  for (const value of [null, response(s, { currentUser: false }), response(s, { leastPrivilege: false }),
    response(s, { interactiveToken: false }), response(s, { definitionMatches: false }), response(s, { enabled: false })])
    await assert.rejects(make(value).execute('register', s));
  await assert.rejects(make(response(s)).execute('delete', s), /DELETE_UNCONFIRMED/);
  const adapter = new WindowsTaskScheduler({ transport: async () => { throw new Error('SCHEDULER_DUPLICATE_TASK'); } });
  await assert.rejects(adapter.execute('register', s), /DUPLICATE_TASK/);
});

test('preflight FAIL and UNKNOWN prevent register/update/enable/run without contacting OS; query/disable/delete remain available (mock OS)', async () => {
  let calls = 0; const s = spec();
  const adapter = { execute: async op => { calls++; return { operation: op }; } };
  for (const status of ['FAIL', 'UNKNOWN']) {
    const inspect = async () => ({ status, spec: s });
    for (const op of ['register', 'update', 'enable', 'run']) await assert.rejects(manageOsSchedule(op, { inspect, adapter }), /PREFLIGHT_BLOCKED/);
    assert.equal(calls, status === 'FAIL' ? 0 : 3);
    for (const op of ['query', 'disable', 'delete']) assert.equal((await manageOsSchedule(op, { inspect, adapter })).operation, op);
  }
  const inspect = async () => ({ status: 'PASS', spec: { ...s, enabled: false } });
  for (const op of ['enable', 'run']) await assert.rejects(manageOsSchedule(op, { inspect, adapter }), /CONFIG_DISABLED/);
});

test('successful management delegates the exact inspected spec; missing runtime cannot contact OS (mock OS)', async () => {
  const s = spec(); let calls = 0;
  const adapter = { execute: async (op, value) => { calls++; assert.deepEqual(value, s); return { operation: op }; } };
  for (const op of taskOperations) await manageOsSchedule(op, { inspect: async () => ({ status: 'PASS', spec: s }), adapter });
  assert.equal(calls, taskOperations.length);
  await assert.rejects(manageOsSchedule('register', { inspect: async () => ({ status: 'FAIL' }), adapter }), /SPEC_REQUIRED/);
  assert.equal(calls, taskOperations.length);
});
