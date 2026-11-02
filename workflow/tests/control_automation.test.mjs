import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ControlAutomationService } from '../tools/lib/control_automation_service.mjs';
import { ConfigService } from '../tools/lib/control_config_service.mjs';
import { scheduleSpec, scheduleDefinition } from '../tools/lib/os_scheduler.mjs';
import { WindowsTaskScheduler } from '../tools/lib/windows_task_scheduler.mjs';
import { XMLParser } from 'fast-xml-parser';

async function fixture(t, platform = 'darwin') {
  const base = path.resolve('tests/runs/automation-registration'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'unit-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'config.json');
  const initial = { schemaVersion: 6, mode: 'web', profile: 'standard', weekly: { enabled: false, intervalDays: 14 }, common: { radar: { enabled: false } } };
  await fs.writeFile(file, JSON.stringify(initial));
  const env = { PAPERECHO_SKIP_DOTENV: '1', PAPERECHO_LAYOUT: 'dev', PAPERECHO_APPLICATION_ROOT: root, PAPERECHO_APPLICATION_CONFIG: file };
  const config = new ConfigService({ root, configPath: file, env });
  const paths = platform === 'darwin' ? { layout: 'installed', applicationRoot: '/Applications/PaperEcho.app/Contents', userDataRoot: root, cacheRoot: path.join(root, 'cache') }
    : { layout: 'installed', applicationRoot: 'C:\\Apps\\PaperEcho', userDataRoot: 'C:\\Users\\test\\PaperEcho', cacheRoot: 'C:\\Users\\test\\Cache' };
  const native = { spec: null, calls: [], running: false, fail: null };
  const adapter = { execute: async (operation, spec) => {
    native.calls.push(operation);
    if (native.fail === operation) throw new Error('SCHEDULER_LAUNCHCTL_FAILED');
    if (operation === 'delete') native.spec = null;
    if (['register', 'update'].includes(operation)) native.spec = structuredClone(spec);
    const matches = JSON.stringify(native.spec) === JSON.stringify(spec);
    return platform === 'darwin' ? { operation: ({ query: 'status', delete: 'unregister' })[operation] || operation, taskId: spec.taskId,
      status: native.spec ? 'loaded' : 'not-installed', definitionMatches: matches }
      : { operation, taskId: spec.taskId, status: 'PASS', exists: Boolean(native.spec), enabled: native.spec?.enabled, definitionMatches: matches };
  } };
  const inspect = async () => {
    const owner = JSON.parse(await fs.readFile(file, 'utf8'));
    const spec = scheduleSpec({ paths, platform, config: owner });
    return { status: platform === 'darwin' ? 'UNKNOWN' : 'PASS', spec,
      checks: ['contract','application','secretSource','lease','recovery','claim','hostTimezone','runnerDecision'].map(name => ({ checkId: 'scheduler.' + name, status: 'PASS' }))
        .concat({ checkId: 'scheduler.platform', status: 'UNKNOWN' }) };
  };
  const service = new ControlAutomationService({ config, context: {}, env, paths, platform, adapter, inspect });
  config.afterSave = updates => service.changed(updates);
  return { config, service, native, paths, file, env };
}
for (const platform of ['darwin', 'win32']) test(`${platform}: save registers once, updates, unregisters and startup recovers owned task (mock OS)`, async t => {
  const f = await fixture(t, platform);
  assert.equal((await f.service.reconcile()).state, 'disabled');
  assert.equal(f.native.spec, null);
  let result = await f.config.update('radar.enabled', true);
  assert.equal(result.saved, true); assert.equal(result.scheduling.state, 'registered');
  const id = f.native.spec.taskId;
  assert.equal(f.native.spec.args[0], '--headless'); assert.ok(!f.native.spec.args.some(arg => /node|codex|agent/i.test(arg)));
  assert.match(f.native.spec.executable, platform === 'darwin' ? /PaperEcho\.app\/Contents\/MacOS\/PaperEcho$/ : /PaperEcho\.exe$/);
  await Promise.all([f.config.update('radar.enabled', true), f.service.reconcile()]);
  assert.equal(f.native.calls.filter(op => op === 'register').length, 1);
  await f.config.update('weekly.interval', 10);
  assert.equal(f.native.spec.taskId, id);
  assert.equal(f.native.calls.filter(op => op === 'update').length, 0); // interval belongs to runtime config, not task argv
  // Moving the installed app keeps the workspace identity and repairs only its owned definition.
  f.service.paths = { ...f.paths, applicationRoot: platform === 'darwin' ? '/Applications/Renamed/PaperEcho.app/Contents' : 'C:\\Moved\\PaperEcho' };
  // Native inspection validates the current application location, not stale cached paths.
  f.service.inspect = async () => ({ ...(await f.service.desired()), status: platform === 'darwin' ? 'UNKNOWN' : 'PASS', checks: ['contract','application','secretSource','lease','recovery','claim','hostTimezone','runnerDecision'].map(name => ({checkId:'scheduler.'+name,status:'PASS'})).concat({checkId:'scheduler.platform',status:'UNKNOWN'}) });
  assert.equal((await f.service.reconcile()).state, 'registered');
  assert.equal(f.native.calls.filter(op => op === 'update').length, 1);
  assert.equal(f.native.spec.taskId, id);
  f.native.spec = null;
  assert.equal((await f.service.reconcile()).state, 'registered');
  assert.equal(f.native.calls.filter(op => op === 'register').length, 2);
  // Simulate an older explicitly disabled Weekly owner without introducing a new UI toggle.
  const owner = JSON.parse(await fs.readFile(f.file, 'utf8')); owner.weekly.enabled = false; await fs.writeFile(f.file, JSON.stringify(owner));
  result = await f.config.update('radar.enabled', false);
  assert.equal(result.scheduling.state, 'disabled'); assert.equal(f.native.spec, null);
  await f.service.reconcile(); assert.equal(f.native.calls.filter(op => op === 'delete').length, 1);
  const after = JSON.parse(await fs.readFile(f.file, 'utf8')); assert.equal(after.weekly.intervalDays, 10); assert.equal(after.scheduler.enabled, false);
});

test('native failure preserves saved config, reports failure and can recover on next startup', async t => {
  const f = await fixture(t); f.native.fail = 'register';
  const result = await f.config.update('radar.enabled', true);
  assert.equal(result.saved, true); assert.equal(result.scheduling.state, 'failed'); assert.equal(result.scheduling.code, 'SCHEDULER_LAUNCHCTL_FAILED');
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).common.radar.enabled, true);
  assert.equal((await f.service.status()).state, 'failed');
  f.native.fail = null; assert.equal((await f.service.reconcile()).state, 'registered');
  f.native.fail = 'query'; assert.equal((await f.service.status()).state, 'unknown');
});

test('startup derives policy only from persisted enabled features and never overrides explicit scheduler disable', async t => {
  const f = await fixture(t); const owner = JSON.parse(await fs.readFile(f.file, 'utf8'));
  owner.common.radar.enabled = true; await fs.writeFile(f.file, JSON.stringify(owner));
  assert.equal((await f.service.reconcile()).state, 'registered');
  assert.equal(JSON.parse(await fs.readFile(f.file, 'utf8')).scheduler.enabled, true);
  const disabled = JSON.parse(await fs.readFile(f.file, 'utf8')); disabled.scheduler.enabled = false; await fs.writeFile(f.file, JSON.stringify(disabled));
  assert.equal((await f.service.reconcile()).state, 'disabled'); assert.equal(f.native.spec, null);
  f.service.paths = { ...f.paths, layout: 'dev' };
  const calls = f.native.calls.length; assert.equal((await f.service.reconcile()).state, 'unknown'); assert.equal(f.native.calls.length, calls);
});

test('preflight failure cannot reach registration and untouched unrelated save does not manage tasks', async t => {
  const f = await fixture(t); const initialCalls = f.native.calls.length;
  await f.config.update('email.enabled', false); assert.equal(f.native.calls.length, initialCalls);
  f.service.inspect = async () => ({ status: 'FAIL' });
  assert.equal((await f.config.update('radar.enabled', true)).scheduling.state, 'failed');
  assert.equal(f.native.calls.includes('register'), false);
  const calls = f.native.calls.length; await f.config.update('integrity.enabled', false);
  assert.equal(f.native.calls.includes('register'), false); assert.ok(f.native.calls.length > calls);
  await f.config.update('email.enabled', false); assert.equal(f.native.calls.includes('register'), false);
});

test('Windows definition fixes Beijing 15:00 to UTC across DST zones; uninstall request targets exact installation', async () => {
  const paths = { layout: 'installed', applicationRoot: 'C:\\Apps\\PaperEcho', userDataRoot: 'C:\\User\\Data', cacheRoot: 'C:\\User\\Cache' };
  const spec = scheduleSpec({ paths, platform: 'win32', config: { schemaVersion:6, mode:'web',scheduler:{schemaVersion:1,enabled:true,time:'15:00',timezone:'Asia/Shanghai'} } });
  const xml = new XMLParser().parse(scheduleDefinition(spec).content);
  assert.equal(xml.Task.Triggers.CalendarTrigger.StartBoundary, '2026-01-01T07:00:00Z');
  for (const zone of ['Asia/Shanghai','America/New_York','Europe/London']) {
    const parts = new Intl.DateTimeFormat('en', { timeZone:zone,hour:'2-digit',hourCycle:'h23' }).format(new Date('2026-11-01T07:00:00Z'));
    assert.equal(parts, ({'Asia/Shanghai':'15','America/New_York':'02','Europe/London':'07'})[zone]);
  }
  let request;
  const adapter = new WindowsTaskScheduler({ transport: async value => { request=value; return {schemaVersion:1,status:'PASS',exists:false,removedCount:2}; } });
  assert.equal((await adapter.removeInstallationTasks(paths)).removedCount,2);
  assert.equal(request.installationCleanup,true); assert.equal(request.executable,spec.executable); assert.equal(request.operation,'delete');
});

test('real HTTP startup and save are wired, and closing backend does not delete the independent task (mock OS)', async t => {
  const { startControlCenter } = await import('../tools/web/server.mjs');
  const f = await fixture(t);
  const services = { config: f.config, automation: f.service, secrets: { redact: value => value }, schedule: { status: async () => ({ status: 'ready' }) } };
  const context = { userDataRoot: f.config.root, configPath: f.file, layout: 'dev' };
  const running = await startControlCenter({ root: f.config.root, port: 0, context, services });
  t.after(() => { running.server.closeAllConnections(); return new Promise(resolve => running.server.close(resolve)); });
  assert.ok(f.native.calls.includes('query'));
  const session = await fetch(running.url + '/api/session'); const cookie = session.headers.get('set-cookie').split(';')[0];
  const token = (await session.json()).token;
  const save = await fetch(running.url + '/api/settings', { method:'POST', headers:{'Content-Type':'application/json',Cookie:cookie,Origin:running.url,'X-CSRF-Token':token}, body:JSON.stringify({id:'radar.enabled',value:true}) });
  assert.equal(save.status,200); assert.equal((await save.json()).scheduling.state,'registered');
  const state = await fetch(running.url + '/api/schedule-status',{headers:{Cookie:cookie}});
  assert.equal((await state.json()).registration.state,'registered');
  const count=f.native.calls.length; running.server.closeAllConnections(); await new Promise(resolve=>running.server.close(resolve));
  assert.ok(f.native.spec); assert.equal(f.native.calls.length,count); // backend shutdown never unregisters
});

test('packaged Mac inspection binds Contents/MacOS and Contents/Resources rather than a development path', async t => {
  const { inspectOsSchedule } = await import('../tools/lib/os_scheduler.mjs');
  const f=await fixture(t); const app=path.join(f.config.root,'app/PaperEcho.app/Contents');
  const data=path.join(f.config.root,'data'),cache=path.join(f.config.root,'cache'),resource=path.join(app,'Resources/core');
  for(const dir of [path.join(app,'MacOS'),path.join(data,'config'),cache,path.join(resource,'desktop/electron-poc'),path.join(resource,'workflow/tools/runner')])await fs.mkdir(dir,{recursive:true});
  for(const file of [path.join(app,'MacOS/PaperEcho'),path.join(app,'Resources/app.asar'),path.join(resource,'desktop/electron-poc/headless.mjs'),path.join(resource,'workflow/tools/runner/main.mjs')])await fs.writeFile(file,'fixture-only',{mode:0o700});
  const owner={schemaVersion:6,mode:'web',profile:'standard',common:{llm:{enabled:false,mode:'disabled'},email:{enabled:false},radar:{enabled:true}},web:{userId:'123'},scheduler:{schemaVersion:1,enabled:true,time:'15:00',timezone:'Asia/Shanghai'}};
  await fs.writeFile(path.join(data,'config/paperecho.config.json'),JSON.stringify(owner));
  const env={PAPERECHO_SKIP_DOTENV:'1',PAPERECHO_LAYOUT:'installed',PAPERECHO_APPLICATION_ROOT:app,PAPERECHO_RESOURCE_ROOT:resource,PAPERECHO_DATA_ROOT:data,PAPERECHO_CACHE_ROOT:cache,PATH:''};
  const report=await inspectOsSchedule({env,applicationRoot:app,platform:'darwin'});
  assert.equal(report.checks.find(c=>c.checkId==='scheduler.application')?.status,'PASS');
  assert.equal(report.spec.executable,path.join(app,'MacOS/PaperEcho'));
  assert.equal(report.spec.args[0],'--headless');
  assert.ok(!report.spec.args.includes(process.execPath));
});

test('macOS unknown query and unsupported host timezone cannot claim registration success', async t=>{
  const f=await fixture(t); await f.config.update('radar.enabled',true);
  const adapter=f.service.adapter;f.service.adapter={execute:async()=>({status:'UNKNOWN'})};
  assert.equal((await f.service.status()).state,'unknown');
  f.service.adapter=adapter;f.native.spec=null;
  f.service.inspect=async()=>({status:'FAIL',checks:[{checkId:'scheduler.hostTimezone',status:'FAIL'}]});
  const state=await f.service.reconcile();assert.equal(state.state,'failed');assert.equal(state.code,'SCHEDULER_HOST_TIMEZONE_REQUIRED');
});

test('startup upgrades a persisted legacy enabled owner with an exact backup before registration', async t=>{
  const f=await fixture(t);const old=JSON.parse(await fs.readFile(f.file,'utf8'));
  old.schemaVersion=3;old.common.radar.enabled=true;await fs.writeFile(f.file,JSON.stringify(old));
  assert.equal((await f.service.reconcile()).state,'registered');
  assert.deepEqual(JSON.parse(await fs.readFile(f.file+'.v3-backup','utf8')),old);
  assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).scheduler.enabled,true);
});

test('changed Mac host timezone revokes only the owned task and reports a failure instead of local 15:00',async t=>{
  const f=await fixture(t);await f.config.update('radar.enabled',true);assert.ok(f.native.spec);
  f.service.timezone=()=> 'America/New_York';
  assert.equal((await f.service.status()).state,'failed');
  assert.equal((await f.service.reconcile()).code,'SCHEDULER_HOST_TIMEZONE_REQUIRED');
  assert.equal(f.native.spec,null);assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).common.radar.enabled,true);
});

for (const platform of ['darwin', 'win32']) test(`${platform}: editable Beijing time persists and updates only the owned task`, async t => {
 const f = await fixture(t, platform);
 assert.equal((await f.config.list()).find(row=>row.id==='scheduler.time').value,'15:00');
 await f.config.update('radar.enabled',true);
 const id=f.native.spec.taskId;
 const saved=await f.config.update('scheduler.time','09:25');
 assert.equal(saved.scheduling.state,'registered');assert.equal(saved.scheduling.time,'09:25');
 assert.equal(f.native.spec.time,'09:25');assert.equal(f.native.spec.utcTime,'01:25');assert.equal(f.native.spec.taskId,id);
 assert.equal((await f.config.list()).find(row=>row.id==='scheduler.time').value,'09:25');
 await f.config.update('scheduler.time','09:25');assert.equal(f.native.calls.filter(op=>op==='update').length,1);
 for (const invalid of ['24:00','7:30','12:60','12:30:00','']) await assert.rejects(f.config.update('scheduler.time',invalid),/SETTING_VALUE_INVALID/);
 assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).weekly.enabled,false);
 assert.equal((await f.service.reconcile()).state,'registered');
 const definition=scheduleDefinition(f.native.spec).content;
 assert.match(definition,platform==='darwin'?/<integer>9<\/integer><key>Minute<\/key><integer>25<\/integer>/:/T01:25:00Z/);
});
