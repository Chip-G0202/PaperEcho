import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { scheduleSpec, scheduleDefinition, inspectOsSchedule, windowsArgument } from '../tools/lib/os_scheduler.mjs';
import { validateRunnerConfigObject } from '../tools/runner/config_loader.mjs';
import { resolveRuntimePaths, resolveApplicationRuntimeContext } from '../tools/lib/runtime_config.mjs';
import { main } from '../tools/runner/main.mjs';
import { applyHeadlessRuntimeArguments } from '../../desktop/electron-poc/runtime.mjs';
import { restoreTransactionRoot } from '../tools/recovery/restore_transaction_status.mjs';
import { resolvePlannedSlotAt, plannedSlotCalendarDateKey, scheduleDayDecisionPath } from '../tools/lib/schedule_support.mjs';
import { SecretService } from '../tools/lib/control_credentials_service.mjs';
import { selectScheduledDailyRun } from '../tools/runner/scheduled_daily.mjs';
import { XMLValidator, XMLParser } from 'fast-xml-parser';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const schedule = { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' };
const config = () => ({ schemaVersion: 6, mode: 'desktop', profile: 'standard', scheduler: { ...schedule },
  common: { llm: { enabled: false, mode: 'disabled' }, email: { enabled: false }, radar: { enabled: true } }, desktop: { enabled: true } });
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); }
async function fixture(t, layout = 'installed') {
  const base = path.join(repo, 'tests/runs/scheduler'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '离线 & (安全)-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, '程序'); const data = layout === 'portable' ? path.join(app, 'data') : layout === 'dev' ? app : path.join(root, '数据');
  const resource = path.join(app, 'resources/core');
  for (const name of ['workflow/tools/runner/main.mjs', 'workflow/tools/web/static/index.html', 'desktop/electron-poc/headless.mjs']) await write(path.join(resource, name), 'fixture-only');
  for (const name of ['PaperEcho.exe', 'Zotero.exe', 'bridge.exe', 'resources/app.asar']) await write(path.join(app, name), 'MZ-dummy-only');
  const value = config(); value.desktop.zoteroExe = path.join(app, 'Zotero.exe'); value.desktop.cliTool = path.join(app, 'bridge.exe');
  const env = { PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_RESOURCE_ROOT: resource, PAPERECHO_LAYOUT: layout,
    ...(layout === 'dev' ? {} : { PAPERECHO_DATA_ROOT: data }), PATH: '', PAPERECHO_SKIP_DOTENV: '1' };
  const paths = resolveRuntimePaths({ env }); await write(paths.configPath, value); await fs.mkdir(paths.cacheRoot, { recursive: true });
  return { root, app, data, env, paths, value, inspect: input => inspectOsSchedule({ env, ...input }) };
}
async function snapshot(root) {
  const result = {};
  async function walk(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name); const stat = await fs.lstat(file);
    result[path.relative(root, file)] = [stat.mode, stat.mtimeMs, e.isFile() ? createHash('sha256').update(await fs.readFile(file)).digest('hex') : null];
    if (e.isDirectory()) await walk(file);
  } }
  await walk(root); return result;
}
test('canonical scheduler schema rejects unknown fields, altered cadence, DST zones and invalid types; legacy remains accepted', () => {
  assert.doesNotThrow(() => validateRunnerConfigObject(config()));
  for (const changes of [{ enabled: 'true' }, { time: '02:30' }, { timezone: 'America/New_York' }, { schemaVersion: 2 }, { command: 'untrusted' }]) assert.throws(() => validateRunnerConfigObject({ ...config(), scheduler: { ...schedule, ...changes } }));
  const old = config(); delete old.scheduler; assert.doesNotThrow(() => validateRunnerConfigObject(old));
  assert.throws(() => validateRunnerConfigObject({ ...config(), schemaVersion: 5 }));
});
test('offline native definitions keep argv separate, escape XML, stable workspace identity and safe enabled/disabled policy', async t => {
  const f = await fixture(t); const s = scheduleSpec({ paths: f.paths, config: f.value });
  assert.equal(s.args[0], '--headless'); assert.ok(s.args.includes('--scheduled-daily')); assert.equal(s.utcTime, '07:00');
  assert.equal(s.dst, 'fixed-zone-no-dst'); assert.equal(s.missedRun, 'one-current-day-slot-only');
  const definition = scheduleDefinition(s); assert.match(definition.content, /&amp;/); assert.match(definition.content, /InteractiveToken/);
  assert.equal(XMLValidator.validate(definition.content), true);
  const parsed = new XMLParser().parse(definition.content); assert.equal(parsed.Task.Actions.Exec.Command, s.executable);
  assert.equal(parsed.Task.Triggers.CalendarTrigger.ScheduleByDay.DaysInterval, 1);
  assert.match(definition.content, /LeastPrivilege/); assert.match(definition.content, /IgnoreNew/); assert.doesNotMatch(definition.content, /cmd\.exe|powershell|SYSTEM|node\.exe|npm|<UserId>/i);
  assert.equal(definition.registration, 'not-performed'); assert.throws(() => scheduleSpec({ paths: f.paths, config: f.value, existingTaskIds: [s.taskId] }), /DUPLICATE/);
  assert.equal(scheduleSpec({ paths: f.paths, config: f.value }).taskId, s.taskId);
  const other = await fixture(t); assert.notEqual(scheduleSpec({ paths: other.paths, config: other.value }).taskId, s.taskId);
  assert.match(scheduleDefinition({ ...s, enabled: false }).content, /<Enabled>false<\/Enabled>/);
  await assert.rejects(selectScheduledDailyRun({ options: {}, env: {}, config: { scheduler: { enabled: false } } }), /SCHEDULE_DISABLED/);
  await write(f.paths.configPath, { ...f.value, scheduler: { ...schedule, enabled: false } }); assert.equal((await f.inspect()).status, 'PASS');
  const mac = scheduleDefinition({ ...s, platform: 'darwin' }); assert.match(mac.content, /StartCalendarInterval/); assert.match(mac.content, /<key>KeepAlive<\/key><false\/>/);
  assert.equal(XMLValidator.validate(mac.content), true);
  assert.equal(windowsArgument('a b\\'), '"a b\\\\"'); assert.equal(windowsArgument('a"b'), '"a\\"b"');
  assert.throws(() => windowsArgument('bad\narg'));
  for (const value of ['C:\\bad" --run', 'C:\\%COMSPEC%']) assert.throws(() => scheduleSpec({ paths: { ...f.paths, applicationRoot: value }, config: f.value }));
  assert.throws(() => scheduleSpec({ paths: { ...f.paths, applicationRoot: '\\\\server\\share\\app' }, config: f.value }), /LOCAL_DRIVE_REQUIRED/);
});
test('readonly preflight and repeated dry-run PASS with no writes or OS adapter calls across Portable/Installed; Dev fails closed', async t => {
  for (const layout of ['installed', 'portable', 'dev']) {
    const f = await fixture(t, layout); const before = await snapshot(f.root); const result = await f.inspect();
    assert.equal(result.status, layout === 'dev' ? 'FAIL' : 'PASS', JSON.stringify(result.checks)); assert.equal(result.osMutation, false);
    let text = ''; const stdout = { write: x => { text += x; } };
    for (let i = 0; i < 2; i++) {
      text = ''; const code = await main(['--schedule-dry-run'], { env: f.env, stdout, runProductionImpl: () => assert.fail('workflow forbidden'), runtimeLog: { write: () => assert.fail('no logging') }, schedulerAdapter: { execute: () => assert.fail('readonly command must not call OS') } });
      assert.equal(code, layout === 'dev' ? 2 : 0); assert.ok(!text.includes(f.root));
      if (layout !== 'dev') { const report = JSON.parse(text); assert.match(report.definition.content, /__USER_DATA_ROOT__/); assert.match(report.definition.content, /__APPLICATION_ROOT__/); }
    }
    assert.deepEqual(await snapshot(f.root), before);
  }
});
test('missing executable, redirected resources, bad data root and unsupported Local cannot generate a runnable dry-run', async t => {
  const f = await fixture(t); await fs.unlink(path.join(f.app, 'PaperEcho.exe')); assert.equal((await f.inspect()).status, 'FAIL');
  await write(path.join(f.app, 'PaperEcho.exe'), 'not-an-executable'); assert.equal((await f.inspect()).status, 'FAIL');
  assert.equal((await f.inspect({ env: { ...f.env, PAPERECHO_RESOURCE_ROOT: f.data } })).status, 'FAIL');
  assert.equal((await f.inspect({ env: { ...f.env, PAPERECHO_DATA_ROOT: f.app } })).status, 'FAIL');
  assert.equal((await f.inspect({ env: { ...f.env, PAPERECHO_CONFIG: path.join(f.root, 'other/config.json') } })).status, 'FAIL');
  assert.throws(() => scheduleSpec({ paths: f.paths, config: { ...f.value, mode: 'local' } }), /MODE_UNSUPPORTED/);
  let text = ''; assert.equal(await main(['--schedule-dry-run', '--run'], { stdout: { write: x => text += x } }), 3); assert.doesNotMatch(text, /definition/);
});
test('live, stale and remote workflow leases are not cleared; active and unfinished restoration blocks definition use', async t => {
  const f = await fixture(t); const context = await resolveApplicationRuntimeContext({ env: f.env, readOnly: true });
  const file = path.join(context.runRoot, '.workflow.lease.json');
  for (const hostname of [os.hostname(), 'remote-dummy']) {
    await write(file, { schemaVersion: 1, runId: 'dummy', ownerId: 'dummy', hostname, pid: process.pid, expiresAt: '2000-01-01T00:00:00Z' });
    const before = await snapshot(f.root); const report = await f.inspect(); assert.notEqual(report.status, 'PASS');
    assert.notEqual(report.checks.find(c => c.checkId === 'scheduler.lease').status, 'PASS'); assert.deepEqual(await snapshot(f.root), before);
  }
  await fs.unlink(file); await fs.mkdir(restoreTransactionRoot(f.data), { recursive: true });
  const before = await snapshot(f.root); const report = await f.inspect(); assert.notEqual(report.status, 'PASS'); assert.deepEqual(await snapshot(f.root), before);
});
test('external Secret is UNKNOWN and never embedded in summaries; native bootstrap validates exclusive absolute roots', async t => {
  const f = await fixture(t); const dummy = 'dummy-external-scheduler-sensitive';
  const report = await f.inspect({ env: { ...f.env, TITLE_TRANSLATION_API_KEY: dummy } });
  assert.equal(report.status, 'UNKNOWN'); assert.equal(report.checks.find(c => c.checkId === 'scheduler.secretSource').status, 'UNKNOWN'); assert.ok(!JSON.stringify(report).includes(dummy));
  const env = {}; const argv = ['--runtime-layout', 'installed', '--user-data-root', f.data, '--cache-root', f.paths.cacheRoot, '--schedule-preflight'];
  assert.deepEqual(applyHeadlessRuntimeArguments(argv, env), ['--schedule-preflight']); assert.equal(env.PAPERECHO_DATA_ROOT, f.data);
  for (const args of [['--user-data-root', f.data], ['--runtime-layout', 'dev', '--user-data-root', f.data], [...argv, '--user-data-root', f.data], ['--runtime-layout', 'installed', '--user-data-root', 'relative']]) assert.throws(() => applyHeadlessRuntimeArguments(args, {}));
});
test('offline definition owner contains no native process or registration implementation', async () => {
  for (const name of ['workflow/tools/lib/os_scheduler.mjs']) {
    const code = await fs.readFile(path.join(repo, name), 'utf8');
    assert.doesNotMatch(code, /child_process|execFile|spawn\(|Register-ScheduledTask|schtasks|launchctl/);
  }
});
test('today claimed run with missing ledger fails closed, forced schedule env is rejected, restored history is not reactivated', async t => {
  const f = await fixture(t); const now = new Date('2026-10-18T08:00:00.000Z');
  const context = await resolveApplicationRuntimeContext({ env: f.env, readOnly: true });
  const file = scheduleDayDecisionPath(path.join(context.researchRoot, 'schedule_decisions'), plannedSlotCalendarDateKey(now));
  await write(file, { schemaVersion: 1, dateKey: plannedSlotCalendarDateKey(now), plannedSlotAt: resolvePlannedSlotAt(now).toISOString(), decision: 'weekly_takeover', businessRunId: 'dummy-missing-ledger' });
  const before = await snapshot(f.root); const result = await f.inspect({ clock: () => now }); assert.notEqual(result.status, 'PASS');
  assert.equal(result.checks.find(c => c.checkId === 'scheduler.claim').status, 'FAIL'); assert.deepEqual(await snapshot(f.root), before);
  await fs.unlink(file); assert.equal((await f.inspect({ env: { ...f.env, FORCE_review_results_RUN: 'true' } })).status, 'FAIL');
  await write(path.join(f.data, '.paperecho-restore.json'), { schemaVersion: 1, stateReviewRequired: true, reactivateClaims: false });
  assert.equal((await f.inspect()).status, 'FAIL');
});
test('real Secret owner validates ACL and local dotenv in Web noninteractive preflight; missing key is blocking', async t => {
  const f = await fixture(t); f.value.mode = 'web'; f.value.desktop.enabled = false;
  f.value.web = { enabled: true, userId: '12345', apiKeyEnv: 'ZOTERO_API_KEY' }; await write(f.paths.configPath, f.value);
  assert.equal((await f.inspect()).status, 'FAIL');
  const env = { ...f.env }; delete env.PAPERECHO_SKIP_DOTENV;
  const secrets = new SecretService({ root: f.app, env });
  await secrets.replace('ZOTERO_API_KEY', 'dummy-local-offline-scheduler-key');
  const before = await snapshot(f.root); const report = await f.inspect({ env }); assert.equal(report.status, 'PASS', JSON.stringify(report.checks));
  assert.equal(report.checks.find(c => c.checkId === 'scheduler.secretSource').status, 'PASS'); assert.deepEqual(await snapshot(f.root), before);
  assert.ok(!JSON.stringify(report).includes('dummy-local-offline-scheduler-key'));
});
test('junction to another fixture is rejected without reading or changing that workspace', async t => {
  const f = await fixture(t), other = await fixture(t); const before = await snapshot(other.root);
  const link = path.join(f.root, 'linked-data'); await fs.symlink(other.data, link, 'junction');
  const result = await f.inspect({ env: { ...f.env, PAPERECHO_DATA_ROOT: link } }); assert.equal(result.status, 'FAIL'); assert.deepEqual(await snapshot(other.root), before);
  await fs.unlink(link);
});
