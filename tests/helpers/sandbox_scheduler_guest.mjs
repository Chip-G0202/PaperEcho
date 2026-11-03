import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const input = 'C:\\PaperEchoLab\\Input', output = 'C:\\PaperEchoLab\\Output';
const work = 'C:\\PaperEchoLab\\Scheduler Workspace', app = path.join(work, '程序 & (空格)');
const core = path.join(app, 'resources/core'), exe = path.join(app, 'PaperEcho.exe');
const data = path.join(app, 'data'), cache = path.join(app, 'cache');
const steps = [], childPids = [];
let stage = 'runtime-identity', adapter, spec, control, lease, releaseRunLease, deleted = false;
const report = { schemaVersion: 1, stage: 'SANDBOX_SCHEDULER', status: 'FAIL', steps,
  longTermLogoffSleepResume: 'NOT_VERIFIED', msiInstallation: 'NOT_TESTED', realOsRegistration: false };
const load = file => import(pathToFileURL(path.join(core, file)).href);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value), { flag: 'wx' }); };
const step = (id, details = {}) => steps.push({ id, status: 'PASS', ...details });
async function poll(fn, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  while (true) { const value = await fn(); if (value) return value; if (Date.now() >= end) throw new Error('SCHEDULER_FIXTURE_CONDITION_TIMEOUT'); await delay(250); }
}
async function run(args, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PATH: '', ...extra }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.NODE_PATH;
    const child = spawn(exe, args, { cwd: work, env, shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    childPids.push(child.pid); let text = '', errorSeen = false;
    const timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on('data', b => { text = (text + b).slice(-262144); });
    child.stderr.on('data', () => { errorSeen = true; });
    child.once('error', reject);
    child.once('close', code => { clearTimeout(timer); resolve({ code, text, errorSeen }); });
  });
}
try {
  assert.equal(process.env.USERNAME, 'WDAGUtilityAccount');
  assert.equal(fileURLToPath(import.meta.url).toLowerCase(), path.join(input, 'scheduler-guest.mjs').toLowerCase());
  assert.equal(process.execPath.toLowerCase(), exe.toLowerCase()); assert.equal(process.versions.electron, '44.7.2');
  assert.equal(process.versions.node, '24.21.0'); assert.equal(process.type, undefined); assert.equal(process.env.PATH, '');
  const handoff = JSON.parse(await fs.readFile(path.join(input, 'handoff.json'), 'utf8'));
  report.focus = handoff.focus || 'all';
  report.runId = handoff.runId; report.guestIdentityVerified = true; report.runtimeNode = process.versions.node;
  const { resolveRuntimePaths, resolveApplicationRuntimeContext } = await load('workflow/tools/lib/runtime_config.mjs');
  const env = { ...process.env, PAPERECHO_APPLICATION_ROOT: app, PAPERECHO_RESOURCE_ROOT: core, PAPERECHO_LAYOUT: 'portable',
    PAPERECHO_DATA_ROOT: data, PAPERECHO_CACHE_ROOT: cache, PAPERECHO_SKIP_DOTENV: '1' };
  const paths = resolveRuntimePaths({ env }); assert.equal(paths.userDataRoot, data); assert.equal(paths.applicationRoot, app);
  const config = { schemaVersion: 6, mode: 'desktop', profile: 'standard',
    scheduler: { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' },
    common: { projectRoot: '..', llm: { enabled: false, mode: 'disabled' }, email: { enabled: false }, radar: { enabled: true } },
    desktop: { enabled: true, zoteroExe: exe, cliTool: exe } };
  await fs.mkdir(data); await fs.mkdir(cache); await write(paths.configPath, config);
  const { SecretService } = await load('workflow/tools/lib/control_credentials_service.mjs');
  const secretEnv = { ...env }; delete secretEnv.PAPERECHO_SKIP_DOTENV;
  const secrets = new SecretService({ root: app, env: secretEnv });
  await secrets.replace('TITLE_TRANSLATION_API_KEY', 'dummy-sandbox-scheduler-only-never-send');
  assert.equal((await secrets.health()).filePresent, true);
  const protectedFiles = [paths.configPath, path.join(data, '.env')];
  const context = await resolveApplicationRuntimeContext({ env, readOnly: true });
  const { startRunGroup, finishRunGroup } = await load('workflow/tools/lib/runtime_housekeeping.mjs');
  const { createRunRecoveryCoordinator, inspectStartupRecovery } = await load('workflow/tools/recovery/run_recovery.mjs');
  const { claimScheduleDayDecision, resolvePlannedSlotAt } = await load('workflow/tools/lib/schedule_support.mjs');
  const { createNotificationReceipt, writeNotificationReceipt } = await load('workflow/tools/stage5/email_receipt.mjs');
  const { EXIT_CODES } = await load('workflow/tools/runner/constants.mjs');
  const ledgerApi = await load('workflow/tools/recovery/operation_ledger.mjs'); releaseRunLease = ledgerApi.releaseRunLease;
  const runId = 'sandbox-completed-' + randomUUID(), artifactPath = path.join(context.runRoot, runId, 'input_artifact.json');
  const group = await startRunGroup({ runRoot: context.runRoot, runId, pipelineMode: 'desktop' });
  const coordinator = await createRunRecoveryCoordinator({ runRoot: context.runRoot, runId, mode: 'desktop', profile: 'standard',
    configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath });
  await coordinator.persistArtifact([]);
  for (const name of ['stage1','stage2_writeback','stage3_translation','stage4_exports']) await coordinator.store.setStage(name, 'verified');
  const receiptPath = path.join(context.runRoot, runId, 'stage5/email_receipt.json');
  const operation = await coordinator.prepareFileOperation({ type: 'notification', targetId: 'dummy-notification', targetPath: receiptPath,
    input: {}, retryable: false, intent: { notificationType: 'run_summary', eventEpoch: runId } });
  const receipt = createNotificationReceipt({ notificationType: 'run_summary', runId, businessSubject: runId, eventEpoch: runId,
    payload: {}, recipient: 'fixture@example.invalid', ledgerOperationId: operation.idempotencyKey });
  receipt.status = 'accepted'; await writeNotificationReceipt(receiptPath, receipt);
  await coordinator.completeNotification(operation, { receiptStatus: 'accepted', receiptPath });
  await coordinator.store.setStage('stage5_notification', 'verified'); await coordinator.store.setRunStatus('completed', 'completed');
  await finishRunGroup({ manifestPath: group.manifestPath, status: 'completed' });
  const now = new Date();
  report.slotCondition = now < resolvePlannedSlotAt(now) ? 'before-slot' : 'completed-day-claim';
  if(report.slotCondition==='completed-day-claim')
    await claimScheduleDayDecision({ stateRoot: path.join(context.researchRoot, 'schedule_decisions'), now, weeklyDue: true, requestedProfile: 'weekly', runId });
  protectedFiles.push(coordinator.store.filePath, group.manifestPath, artifactPath, receiptPath);
  const snapshots = new Map(await Promise.all(protectedFiles.map(async file => [file, await fs.readFile(file)])));
  assert.equal((await inspectStartupRecovery({ runRoot: context.runRoot, researchRoot: context.researchRoot, dataRoots: [data] })).state, 'SAFE_TO_CONTINUE');
  step('packaged-portable-identity', { embedded: true, emptyPath: true, outsideRepoCwd: true, dummySecretAcl: true });
  const { inspectOsSchedule, scheduleSpec, windowsArgument } = await load('workflow/tools/lib/os_scheduler.mjs');
  const { manageOsSchedule } = await load('workflow/tools/lib/os_scheduler_management.mjs');
  const { WindowsTaskScheduler } = await load('workflow/tools/lib/windows_task_scheduler.mjs');
  spec = scheduleSpec({ paths, config, platform: 'win32' }); adapter = new WindowsTaskScheduler({ env, sandboxOnly: true });
  control = async (operation, extra = {}) => new Promise((resolve, reject) => {
    const child = execFile(process.env.PWSH_PATH, ['-NoProfile','-NonInteractive','-File',path.join(input,'scheduler-control.ps1')],
      { env: { ...process.env, PATH: '' }, windowsHide: true, timeout: operation==='watch-run'?65000:30000, maxBuffer: 16384 },
      (error, text) => {
        try { const result = JSON.parse(text); if (error || result.status !== 'PASS' || !result.guestIdentityVerified) throw Object.assign(new Error(result.code || 'SCHEDULER_FIXTURE_CONTROL_FAILED'),{hresult:result.hresult,controlLine:result.line}); resolve(result); }
        catch (cause) { reject(cause); }
      });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ operation, taskId: spec.taskId, controllerPid: process.pid, ...extra }));
  });
  const manage = op => manageOsSchedule(op, { env, applicationRoot: app, adapter });
  const native = op => adapter.execute(op, spec);
  stage='schedule-preflight';
  const inspect = await inspectOsSchedule({ env, applicationRoot: app });
  report.preflight={runId:handoff.runId,phase:stage,status:inspect.status,checks:inspect.checks.map(c=>{
    assert.match(c.checkId,/^[A-Za-z][A-Za-z0-9_.-]{0,80}$/);
    assert.ok(['PASS','FAIL','UNKNOWN','BLOCKED'].includes(c.status));
    return {checkId:c.checkId,status:c.status,errorCode:c.status==='PASS'?null:'SCHEDULER_PREFLIGHT_'+c.status,
      reason:c.status==='PASS'?'CHECK_PASSED':c.status==='UNKNOWN'?'CHECK_UNCONFIRMED':'CHECK_REJECTED'};
  })};
  assert.equal(inspect.status, 'PASS');
  assert.ok(report.preflight.checks.length>0&&report.preflight.checks.every(c=>c.status==='PASS'));
  const bootstrap = ['--headless','--runtime-layout','portable','--user-data-root',data,'--cache-root',cache];
  const check = await run([...bootstrap, '--check', '--mode', 'desktop']);
  assert.equal(check.code, 0); assert.ok(check.text.includes('"canRun":true')); step('headless-check', { exitCode: check.code });
  async function events() {
    const file = path.join(paths.logsRoot, 'runtime.jsonl'); const stat = await fs.stat(file).catch(() => null);
    if (!stat) return [];
    assert.ok(stat.size <= 1048576);
    return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(x => JSON.parse(x));
  }
  async function preparedGate(){
    stage='restore-migration-gates';
    const {restoreTransactionRoot,restoreTargetKey,inspectRestoreTransaction}=await load('workflow/tools/recovery/restore_transaction_status.mjs');
    const transaction=restoreTransactionRoot(data);report.prepared=[];
    const hashes=async()=>Object.fromEntries(await Promise.all(protectedFiles.map(async f=>[sha(f),sha(await fs.readFile(f))])));
    const claimFiles=async()=>{const root=path.join(context.researchRoot,'schedule_decisions');const names=await fs.readdir(root).catch(e=>{if(e.code==='ENOENT')return [];throw e;});assert.ok(names.length<16);return Object.fromEntries(await Promise.all(names.map(async n=>[sha(n),sha(await fs.readFile(path.join(root,n)))])));};
    const original=await hashes(),claims=await claimFiles();
    for(const kind of ['restore-existing','upgrade-new-root']){
      await fs.mkdir(transaction);
      await write(path.join(transaction,'status.json'),{schemaVersion:1,owner:'paperecho-restore',operationId:randomUUID(),targetKey:restoreTargetKey(data),kind,state:'PREPARED'});
      const formal=inspectRestoreTransaction(data);assert.equal(formal.state,'PREPARED');assert.equal(formal.blocking,true);
      await assert.rejects(manage('run'),/PREFLIGHT_BLOCKED/);
      const before=new Set((await events()).map(e=>e.eventId));
      const blocked=await run([...bootstrap,'--run','--scheduled-daily','--mode','desktop','--profile','standard','--fixed-mode']);
      const messages=blocked.text.trim().split('\n').filter(x=>x.startsWith('{')).map(x=>JSON.parse(x));
      const result=messages.find(x=>x.type==='schedule');
      if(!result)throw new Error('SCHEDULER_FIXTURE_SCHEDULE_RESULT_MISSING');
      assert.ok(['before_scheduled_slot','already_completed','recovery_required','blocked'].includes(result.status));
      assert.match(result.reason||'',/^[A-Za-z_]+$/);
      const fresh=(await events()).filter(x=>!before.has(x.eventId));
      const unchanged=JSON.stringify(await hashes())===JSON.stringify(original)&&JSON.stringify(await claimFiles())===JSON.stringify(claims);
      report.prepared.push({kind,state:formal.state,blocking:formal.blocking,runKind:'scheduled-daily',exitCode:blocked.code,status:result.status,reason:result.reason,
        newLogEvents:fresh.map(x=>x.code),sourceUnchanged:unchanged});
      assert.equal(blocked.code,EXIT_CODES.pipeline);
      assert.equal(result.status,'recovery_required');assert.equal(result.reason,'RESTORE_RECOVERY_REQUIRED');
      assert.ok(unchanged);assert.ok(!fresh.some(x=>x.code==='RUNNER_ADMITTED'));
      await fs.rm(transaction,{recursive:true});
      step(kind+'-blocked',{actualHeadlessExit:blocked.code,ownerState:formal.state,reason:result.reason,sourceUnchanged:true});
    }
    const clean=await run([...bootstrap,'--run','--scheduled-daily','--mode','desktop','--profile','standard','--fixed-mode']);
    assert.equal(clean.code,0);assert.ok(!(await events()).some(x=>x.code==='RUNNER_ADMITTED'));
    assert.deepEqual(await hashes(),original);assert.deepEqual(await claimFiles(),claims);
  }
  if(handoff.focus==='prepared'){await preparedGate();}else{
  stage = 'register';
  assert.equal((await native('query')).exists, false);
  const registered = await manage('register'); assert.ok(registered.exists && registered.definitionMatches && registered.currentUser && registered.leastPrivilege && registered.interactiveToken);
  await assert.rejects(manage('register'), /SCHEDULER_DUPLICATE_TASK/);
  await assert.rejects(adapter.execute('register', { ...spec, executable: 'C:\\Windows\\System32\\cmd.exe' }));
  report.realOsRegistration=true;
  step('register-xml-identity', { duplicateRejected: true, injectionRejected: true, xmlMatches: true, leastPrivilege: true, currentUser: true });
  report.action=await control('describe');
  assert.equal(report.action.argumentsSha256,sha(spec.args.map(windowsArgument).join(' ')));
  assert.equal(report.action.executableSha256,sha(await fs.readFile(exe)));
  report.runs=[];
  async function runTask(expected = 0) {
    const previous=new Set((await events()).map(x=>x.eventId));
    const evidenceId=randomUUID(), ready=path.join(output,'observer-'+evidenceId+'.json');
    const observed=control('watch-run',{evidenceId}).then(value=>({value}),error=>({error}));
    try{await poll(async()=>{const state=await observedState();return state;},15000);}catch(error){await observed;throw error;}
    async function observedState(){
      const current=await Promise.race([observed,Promise.resolve(null)]);if(current?.error)throw current.error;
      try{const v=JSON.parse(await fs.readFile(ready,'utf8'));assert.equal(v.evidenceId,evidenceId);return v.status==='ready';}
      catch(e){if(e.code!=='ENOENT')throw e;return false;}
    }
    const triggeredAt = Date.now();
    report.trigger = { expected, startedAt: new Date(triggeredAt).toISOString(), observations: [] };
    await native('run');
    const completed=await poll(async () => {
      const q = await native('query');
      const records = await events();
      const snapshot = { elapsedMs: Date.now()-triggeredAt, state:q.state, runningInstances:q.runningInstances,
        lastTaskResult:q.lastTaskResult,lastRunAt:q.lastRunAt,
        events:records.slice(-8).map(x=>({code:x.code,timestamp:x.timestamp,exitCode:x.exitCode})) };
      if (report.trigger.observations.length < 2 || snapshot.elapsedMs > (report.trigger.observations.at(-1)?.elapsedMs || 0) + 10000)
        report.trigger.observations.push({...snapshot, processState:await control('observe')});
      if (q.runningInstances || q.state === 4 || !records.some(x => !previous.has(x.eventId)&&['RUNNER_FINISHED','RUNNER_FAILED'].includes(x.code))) return false;
      assert.equal(q.lastTaskResult, expected); assert.ok(Date.parse(q.lastRunAt) > 0);
      assert.ok(!records.some(x => x.code === 'RUNNER_ADMITTED')); return q;
    });
    const trace=await observed;if(trace.error)throw trace.error;
    const fresh=(await events()).filter(x=>!previous.has(x.eventId));
    const finished=fresh.find(x=>['RUNNER_FINISHED','RUNNER_FAILED'].includes(x.code));
    assert.ok(fresh.some(x=>x.code==='RUNNER_STARTED'));assert.equal(finished.exitCode,expected);
    assert.ok(Date.parse(completed.lastRunAt)>=triggeredAt-1000);
    assert.ok(trace.value.processes.every(x=>x.currentUser&&x.exitCode===expected));
    assert.ok(trace.value.processes.some(child=>trace.value.processes.some(parent=>child.parentPid===parent.pid)));
    report.runs.push({phase:stage,evidenceId,lastRunAt:completed.lastRunAt,lastTaskResult:completed.lastTaskResult,
      processes:trace.value.processes,startedEvent:fresh.find(x=>x.code==='RUNNER_STARTED').eventId,finishedEvent:finished.eventId,exitCode:finished.exitCode});
    await fs.unlink(ready);return completed;
  }
  stage='manual-trigger';
  await runTask(); await runTask(); step('manual-repeat-trigger', { actualRunner: true, lastTaskResult: 0, businessNotReplayed: true });
  if (handoff.focus !== 'manual') {
  stage='concurrent-trigger';
  const beforeConcurrent=new Set((await events()).map(x=>x.eventId));
  await Promise.all([native('run'), native('run')]);
  await poll(async()=>{const q=await native('query');const fresh=(await events()).filter(x=>!beforeConcurrent.has(x.eventId));
    return q.runningInstances===0&&q.state!==4&&q.lastTaskResult===0&&fresh.some(x=>x.code==='RUNNER_FINISHED'&&x.exitCode===0);});
  const concurrentEvents=(await events()).filter(x=>!beforeConcurrent.has(x.eventId));
  assert.ok(concurrentEvents.some(x=>x.code==='RUNNER_STARTED'));
  assert.ok(!concurrentEvents.some(x=>x.code==='RUNNER_FAILED'));
  assert.ok(!(await events()).some(x => x.code === 'RUNNER_ADMITTED')); step('concurrent-trigger', { ignoreNew: true, noBusinessReplay: true });
  stage='active-lease';
  lease = await ledgerApi.acquireWorkflowLease({ runRoot: context.runRoot, runId: 'sandbox-active', profile: 'standard' });
  assert.equal(lease.acquired, true);
  await assert.rejects(manage('run'), /PREFLIGHT_BLOCKED/); await runTask(EXIT_CODES.pipeline);
  await releaseRunLease(lease); lease=null;
  step('active-workflow-lease', { managementBlocked: true, actualRunnerExit: EXIT_CODES.pipeline });
  stage='unknown-startup';
  const legacy = path.join(context.runRoot,'.runner.operation.lock'); await write(legacy, { owner:'dummy-fixture' });
  await assert.rejects(manage('run'), /PREFLIGHT_BLOCKED/); await runTask(EXIT_CODES.pipeline); await fs.unlink(legacy);
  step('unknown-startup', { actualRunnerExit: EXIT_CODES.pipeline });
  stage='unknown-notification';
  await fs.writeFile(receiptPath, JSON.stringify({ ...receipt, status:'unknown' }));
  await assert.rejects(manage('run'), /PREFLIGHT_BLOCKED/); await runTask(EXIT_CODES.pipeline);
  assert.equal(JSON.parse(await fs.readFile(receiptPath)).status, 'unknown');
  await fs.writeFile(receiptPath, snapshots.get(receiptPath));
  step('unknown-notification', { noResend: true, actualRunnerExit: EXIT_CODES.pipeline });
  stage='active-day-claim';
  await coordinator.store.mutate(next => { next.status='running'; next.stages.stage1.status='pending'; });
  const changedManifest = { ...JSON.parse(snapshots.get(group.manifestPath)), status:'running' };
  await fs.writeFile(group.manifestPath, JSON.stringify(changedManifest));
  await assert.rejects(manage('run'), /PREFLIGHT_BLOCKED/); await runTask(EXIT_CODES.pipeline);
  await fs.writeFile(coordinator.store.filePath, snapshots.get(coordinator.store.filePath)); await fs.writeFile(group.manifestPath, snapshots.get(group.manifestPath));
  step('active-day-claim', { actualRunnerExit: EXIT_CODES.pipeline });
  await preparedGate();
  stage='disable-enable';
  const disabled=await manage('disable'); assert.equal(disabled.enabled,false);
  const baseline=(await native('query')).lastRunAt;
  let at=new Date(Date.now()+20000).toISOString(); const disabledTiming=(await control('near-trigger',{at})).timing;
  await poll(async()=>Date.now()>Date.parse(at)+5000,35000);
  const stillDisabled=await native('query'); assert.equal(stillDisabled.enabled,false); assert.equal(stillDisabled.lastRunAt,baseline);
  await manage('update'); assert.equal((await native('query')).definitionMatches,true);
  await manage('disable'); assert.equal((await manage('enable')).enabled,true);
  step('disable-enable-update',{disabledTriggerDidNotRun:true,noDuplicate:true,timing:disabledTiming});
  stage='automatic-trigger';
  const beforeAuto=new Set((await events()).map(x=>x.eventId));
  at=new Date(Date.now()+20000).toISOString(); const automaticTiming=(await control('near-trigger',{at})).timing;
  const automatic=await poll(async()=>{
    const q=await native('query');
    if (Date.parse(q.lastRunAt)<Date.parse(at)-1000 || q.runningInstances || !(await events()).some(x=>!beforeAuto.has(x.eventId)&&x.code==='RUNNER_FINISHED'&&x.exitCode===0)) return false;
    assert.equal(q.lastTaskResult,0); return q;
  },60000);
  await manage('update'); assert.equal((await native('query')).definitionMatches,true);
  step('automatic-trigger',{lastTaskResult:automatic.lastTaskResult,actualRunner:true,formalShanghai1500Unchanged:true,timing:automaticTiming});
  stage='doctor-readonly';
  const beforeDoctor=new Map(await Promise.all(protectedFiles.map(async f=>[f,sha(await fs.readFile(f))])));
  const doctor=await run([...bootstrap,'--doctor']); assert.equal(doctor.code,0);
  for(const [file,hash] of beforeDoctor) assert.equal(sha(await fs.readFile(file)),hash);
  step('doctor-readonly',{exitCode:doctor.code});
  stage='delete';
  await manage('delete'); deleted=true; assert.equal((await native('query')).exists,false);
  const inventory=await poll(async()=>{const v=await control('inventory');return v.ownedProcesses===0?v:false;},10000); assert.equal(inventory.ownedTasks,0);
  for(const [file,bytes] of snapshots) assert.deepEqual(await fs.readFile(file),bytes);
  for(const pid of childPids) assert.throws(()=>process.kill(pid,0));
  const records=await events(); assert.ok(records.some(x=>x.code==='HEADLESS_STARTED')); assert.ok(!records.some(x=>x.code.startsWith('GUI_')||x.code==='RUNNER_ADMITTED'));
  assert.ok(!JSON.stringify(records).includes('dummy-sandbox-scheduler-only-never-send'));
  step('delete-cleanup-data-preserved',{noTasks:true,noProcesses:true,sourceUnchanged:true,secretNotLogged:true});
  }
  }
  report.status='PASS'; report.noHostOsMutation=true; report.noExternalSideEffects=true; report.noSystemNode=true;
} catch(error) {
  report.code=/^SCHEDULER_[A-Z_]+$/.test(error.message)?error.message:'SCHEDULER_GUEST_ASSERTION_FAILED';
  report.failedStep=stage; report.errorClass=error.code==='ERR_ASSERTION'?'assertion':'operation';
  report.hresult=Number.isInteger(error.hresult)?error.hresult:null;
  if(Number.isInteger(error.controlLine))report.controlLine=error.controlLine;
  report.assertionOperator=typeof error.operator==='string'?error.operator:null;
  if(['number','boolean'].includes(typeof error.actual))report.actual=error.actual;
  if(['number','boolean'].includes(typeof error.expected))report.expected=error.expected;
  report.line=Number(/sandbox_scheduler_guest\.mjs:(\d+)|scheduler-guest\.mjs:(\d+)/.exec(error.stack||'')?.slice(1).find(Boolean)||0);
} finally {
  if(lease&&releaseRunLease) await releaseRunLease(lease).catch(()=>{report.cleanup='LEASE_RELEASE_FAILED';});
  if(adapter&&spec&&!deleted) {
    try {
      const present=await adapter.execute('query',spec);
      if(present.exists){
      await control?.('stop-owned');
      await poll(async()=>!(await adapter.execute('query',spec)).runningInstances,10000);
      await adapter.execute('delete',spec);
      report.cleanup=(await adapter.execute('query',spec)).exists?'FAILED':'TASK_DELETED';
      }else{report.cleanup='NO_TASK_PRESENT';}
    } catch {report.cleanup='UNCONFIRMED';}
  }
  report.guestExitCode=report.status==='PASS'?0:1;
  await fs.writeFile(path.join(output,'scheduler-result.pending'),JSON.stringify(report),{flag:'wx'});
  await fs.rename(path.join(output,'scheduler-result.pending'),path.join(output,'scheduler-result.json'));
  process.exitCode=report.status==='PASS'?0:1;
}
