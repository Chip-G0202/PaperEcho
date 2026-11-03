import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runProduction } from '../tools/runner/main.mjs';
import { ControlRunService } from '../tools/lib/control_run_service.mjs';
import { ReviewQueryService } from '../tools/lib/control_review_query_service.mjs';
import { buildRuntimeConfig } from '../tools/lib/runtime_config.mjs';
import { runZoteroLiteratureFilter } from '../tools/stage0/main.mjs';
import { OperationLedgerStore, acquireWorkflowLease, releaseRunLease } from '../tools/recovery/operation_ledger.mjs';
import { emitRunProgress, finishRunPhase } from '../tools/lib/control_run_progress.mjs';
import { startControlCenter } from '../tools/web/server.mjs';
const repo=path.resolve('.');
async function fixture(t) {
 const base=path.join(repo,'tests/runs/manual-run');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'isolated-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const env={PAPERECHO_SKIP_DOTENV:'1',PAPERECHO_LAYOUT:'dev',PAPERECHO_APPLICATION_ROOT:root,ZOTERO_PROJECT_ROOT:root,review_results_OUTPUT_ROOT:root};
 const context={...buildRuntimeConfig({cwd:root,env}),applicationRoot:root,resourceRoot:repo};
 const review=new ReviewQueryService({root,context});
 let count=0, fail=false, hold;const calls=[];
 const config={readOwnerOrTemplate:async()=>({present:true,value:{mode:'web',common:{radar:{enabled:false}},scheduler:{enabled:false,time:'09:25'}}})};
 const doctor={configuration:async()=>({configurationIssues:[]})};
 const dependencies={
  runtimeLog:{write:async()=>{}},
  resolveRunnerConfigurationImpl:async (options,deps)=>({options:{...options,mode:'web',profile:'standard'},env:deps.env,config:{schemaVersion:6,mode:'web'}}),
  runPreflightImpl:async()=>({canRun:true,status:'ready',requiredMissing:[]}),
  validateProductionResultImpl:async({processResult})=>({exitCode:processResult.code,ok:processResult.code===0}),
  runProductionImpl:async(plan,deps)=>{
   count++;assert.match(plan.entry,/stage0\/main.mjs$/);assert.equal(plan.childEnv.review_results_ORCHESTRATOR_TRIGGER,'manual');assert.equal(plan.childEnv.PAPERECHO_SCHEDULED_DAILY,undefined);
   if(hold)await hold;
   const pipeline=path.join(context.researchRoot,'pipeline','fixture');await fs.mkdir(pipeline,{recursive:true});
   const output=path.join(context.reviewRoot,'fixture.xlsx');
   const previous=process.send, control=process.env.PAPERECHO_CONTROL_RUN;process.env.PAPERECHO_CONTROL_RUN='1';process.send=(event,callback)=>{deps.onProgress(event);callback?.();};
   try {
    const report=await runZoteroLiteratureFilter({
     runId:plan.runId,config:{...context,repoRoot:repo,projectRoot:root,pipelineDir:pipeline,now:new Date()},
     triggerMode:'manual',runMode:{isManualOrForce:true,isScheduled:false},env:{PAPERECHO_RUN_PROFILE:'standard',ZOTERO_BACKEND:'web_api'},
     stage1Only:false,ensureStartupReady:async()=>({ok:true}),
     runStage:async stage=>{
      calls.push(stage.name);
      if(stage.name==='stage1'){
       emitRunProgress('feedback_learning','running');finishRunPhase('feedback_learning',{skipped:true});
       emitRunProgress('retrieval','running');finishRunPhase('retrieval',{},12);
       await fs.writeFile(path.join(pipeline,'writeback_ready_items.json'),'[]');
      }
      if(fail&&stage.name==='stage2_writeback')return {exitCode:1,stdout:'',stderr:'private-dummy-key'};
      if(stage.name==='stage2_writeback')await fs.writeFile(path.join(pipeline,'zotero_writeback_summary.json'),JSON.stringify({writeback_items:[]}));
      if(stage.name==='stage3_translation')await fs.writeFile(path.join(pipeline,'abc_translation_backfill.json'),JSON.stringify({failure_count:0}));
      if(stage.name==='stage4_exports'){
       await fs.mkdir(path.dirname(output),{recursive:true});await fs.writeFile(output,'mock output');
       await fs.writeFile(path.join(pipeline,'run_report.json'),JSON.stringify({steps:{stage4_export_audit:{stage4_export_status:'success',actual_output_path:output}}}));
      }
      return {exitCode:0,stdout:'',stderr:'',data:{}};
     },stage5Runner:async()=>({status:'skipped',reason:'no_recipient',attachments:[]}),
    });
    // The CLI normally owns ledger creation around Stage0. This isolated business
    // fixture records the same bound artifact/stage facts without touching Zotero.
    const artifactPath=path.join(plan.runRoot,plan.runId,'input_artifact.json');
    await fs.writeFile(artifactPath,'[]');
    const store=plan.args.includes('--resume') ? await OperationLedgerStore.load({runRoot:plan.runRoot,runId:plan.runId}) : await OperationLedgerStore.create({runRoot:plan.runRoot,runId:plan.runId,mode:'web',profile:'standard',launcherId:'manual-test',configHash:plan.childEnv.PAPERECHO_CONFIG_HASH,inputHash:plan.childEnv.PAPERECHO_INPUT_HASH,artifactPath,stages:['stage1','stage2_writeback','stage3_translation','stage4_exports','stage5_notification']});
    await store.bindArtifact();
    if(report.status==='completed')for(const id of ['stage1','stage2_writeback','stage3_translation','stage4_exports','stage5_notification'])await store.setStage(id,id==='stage5_notification'?'skipped':'verified');
    await store.setRunStatus(report.status==='completed'?'completed':'failed');
    return {status:report.status==='completed'?'completed':'failed',code:report.status==='completed'?0:1,stdout:JSON.stringify(report),childExitConfirmed:true};
   }finally{process.send=previous;if(control===undefined)delete process.env.PAPERECHO_CONTROL_RUN;else process.env.PAPERECHO_CONTROL_RUN=control;}
  },
 };
 const create=()=>new ControlRunService({config,doctor,review,context,env,runnerDependencies:dependencies});
 const service=create();
 return {root,env,context,review,service,doctor,create,calls,count:()=>count,fail:value=>fail=value,hold:promise=>hold=promise};
}
test('manual request enters the real Runner and complete Stage0; optional progress, output, refresh, failure and retry',async t=>{
 const f=await fixture(t);assert.equal((await f.service.status()).status,'idle');assert.equal(f.count(),0);
 let release;f.hold(new Promise(r=>release=r));
 const accepted=await Promise.all([f.service.start(),f.service.start(),f.service.start()]);
 assert.ok(accepted.every(state=>state.status==='running'));
 for(let i=0;i<50&&f.count()===0;i++)await new Promise(r=>setTimeout(r,5));assert.equal(f.count(),1);
 const active=await f.create().status();assert.equal(active.status,'running');assert.ok(active.runId);
 release();await f.service.job;
 const result=await f.service.status();assert.equal(result.status,'success');assert.ok(result.endedAt);assert.ok(result.elapsed>=0);
 assert.equal(result.stages.find(s=>s.id==='feedback_learning').status,'skipped');assert.equal(result.stages.find(s=>s.id==='retrieval').elapsed,.012);
 assert.deepEqual(f.calls,['stage1','zotero_backend_ready','stage2_writeback','stage3_translation','stage4_exports']);
 assert.equal(result.products.length,1);assert.equal(await fs.readFile(result.products[0].path,'utf8'),'mock output');
 assert.equal((await f.create().status()).status,'success');assert.equal(await f.service.lease(),null);
 await fs.unlink(result.products[0].path);
 f.fail(true);f.hold(null);await f.service.start();await f.service.job;
 assert.equal((await f.service.status()).status,'failed');assert.equal(await f.service.lease(),null);assert.ok(!JSON.stringify(await f.service.status()).includes('private-dummy-key'));
 f.fail(false);await f.service.start();await f.service.job;assert.equal((await f.service.status()).status,'success');assert.equal(f.count(),3);
});
test('live scheduler lease from a separate process prevents manual business execution',async t=>{
 const f=await fixture(t);const code=`import {acquireWorkflowLease,releaseRunLease} from ${JSON.stringify(new URL('../tools/recovery/operation_ledger.mjs',import.meta.url).href)};const lease=await acquireWorkflowLease({runRoot:${JSON.stringify(f.review.runRoot)},runId:'scheduled-test',profile:'standard'});process.send({ready:lease.acquired});process.on('message',async()=>{await releaseRunLease(lease);process.exit(0)});`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{env:{...process.env,PAPERECHO_SKIP_DOTENV:'1'},stdio:['ignore','ignore','pipe','ipc']});
 t.after(()=>child.kill());await new Promise((r,j)=>{child.once('message',message=>message.ready?r():j(Error('fixture lease failed')));child.once('error',j)});
 const result=await f.service.start();assert.equal(result.status,'running');assert.equal(result.runId,'scheduled-test');await f.service.job;assert.equal(f.count(),0);
 child.send('release');await new Promise(r=>child.once('exit',r));assert.equal(await f.service.lease(),null);
});
test('configuration failures return a safe existing settings destination and do not execute',async t=>{
 const f=await fixture(t);f.doctor.configuration=async()=>({configurationIssues:[{settingTarget:'ai.key'}]});
 await f.service.start();await f.service.job;const state=await f.service.status();assert.equal(state.status,'failed');assert.equal(state.settingTarget,'ai.key');assert.equal(f.count(),0);
});
test('run HTTP routes retain session, Origin, CSRF and fixed input protection; GET never starts',async t=>{
 const f=await fixture(t);let starts=0;
 const app=await startControlCenter({root:f.root,context:f.context,port:0,services:{secrets:{redact:x=>x},manualRun:{status:()=>({status:'idle'}),start:()=>{starts++;return {status:'running'}}}}});
 t.after(()=>{app.server.closeAllConnections();app.server.close()});
 assert.equal((await fetch(app.url+'/api/run')).status,403);
 const session=await fetch(app.url+'/api/session');const {token}=await session.json();const cookie=session.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(app.url+'/api/run',{headers:{cookie}})).status,200);assert.equal(starts,0);
 for(const extra of [{},{origin:app.url},{origin:'https://foreign.invalid','x-csrf-token':token}])assert.equal((await fetch(app.url+'/api/run',{method:'POST',headers:{cookie,'content-type':'application/json',...extra},body:'{}'})).status,403);
 const headers={cookie,origin:app.url,'x-csrf-token':token,'content-type':'application/json'};
 assert.equal((await fetch(app.url+'/api/run',{method:'POST',headers,body:'{"path":"bad"}'})).status,400);
 assert.equal((await fetch(app.url+'/api/run',{method:'POST',headers,body:'{}'})).status,202);assert.equal(starts,1);
});

test('real child IPC forwards only fixed progress metadata; missing products are not displayed',async t=>{
 const f=await fixture(t);const childFile=path.join(f.root,'progress-child.mjs');
 await fs.writeFile(childFile,`import {emitRunProgress,finishRunPhase} from ${JSON.stringify(new URL('../tools/lib/control_run_progress.mjs',import.meta.url).href)};emitRunProgress('stage3_translation','running');finishRunPhase('stage3_translation',{skipped:true,private:'must-not-leak'},14);console.log('{}');`);
 const events=[];const result=await runProduction({entry:childFile,args:[],cwd:f.root,childEnv:{...process.env,PAPERECHO_SKIP_DOTENV:'1',PAPERECHO_CONTROL_RUN:'1'}},{stdout:{write(){}},stderr:{write(){}},onProgress:event=>events.push(event)});
 assert.equal(result.code,0);assert.equal(result.childExitConfirmed,true);assert.equal(events.length,2);assert.equal(events[1].status,'skipped');assert.equal(events[1].milliseconds,14);assert.ok(!JSON.stringify(events).includes('must-not-leak'));
 f.service.state={schemaVersion:1,status:'success',stages:[],products:[{name:'missing.xlsx',path:path.join(f.context.reviewRoot,'missing.xlsx')}],startedAt:new Date().toISOString()};
 assert.equal((await f.service.status()).products.length,0);
});
