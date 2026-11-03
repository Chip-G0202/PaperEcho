import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ConfigService } from '../tools/lib/control_config_service.mjs';
import { resolveRunnerConfiguration } from '../tools/runner/config_loader.mjs';
import { selectScheduledDailyRun } from '../tools/runner/scheduled_daily.mjs';
import { ControlScheduleStatusService } from '../tools/lib/control_schedule_status_service.mjs';
import { runWeeklyIntegrityMonitor } from '../tools/integrity/main.mjs';
async function fixture(t, weekly) {
 const base=path.resolve('tests/runs/automation-ui');await fs.mkdir(base,{recursive:true});
 const root=await fs.mkdtemp(path.join(base,'isolated-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const owner=JSON.parse(await fs.readFile('config/paperecho.config.example.json','utf8'));
 owner.schemaVersion=3;owner.mode='desktop';owner.common.projectRoot=root;
 if(weekly)owner.weekly=weekly;
 const file=path.join(root,'paperecho.config.json');await fs.writeFile(file,JSON.stringify(owner));
 const env={PAPERECHO_ROOT_LAYOUT:'dev',ZOTERO_PROJECT_ROOT:root,PAPERECHO_APPLICATION_CONFIG:file};
 const service=()=>new ConfigService({root,configPath:file,env});
 const resolve=()=>resolveRunnerConfiguration({configPath:file,mode:'desktop',action:'run'},{cwd:root,env,readOnly:true});
 return {root,file,service,resolve};
}
test('automation defaults, independent switches, legacy disabled state and interval round trip',async t=>{
 const f=await fixture(t,{intervalDays:14,enabled:false});const before=await fs.readFile(f.file,'utf8');
 let rows=await f.service().list();assert.equal(rows.find(x=>x.id==='weekly.interval').value,14);assert.equal(rows.find(x=>x.id==='weekly.interval').enabled,false);assert.equal(await fs.readFile(f.file,'utf8'),before);
 await f.service().update('radar.enabled',false);await f.service().update('integrity.enabled',true);
 rows=await f.service().list();assert.equal(rows.find(x=>x.id==='radar.enabled').value,false);assert.equal(rows.find(x=>x.id==='integrity.enabled').value,true);assert.equal(rows.find(x=>x.id==='weekly.interval').enabled,false);
 const unchanged=await fs.readFile(f.file,'utf8');
 for(const value of [0,-1,1.5,367,'7',NaN])await assert.rejects(f.service().update('weekly.interval',value),/SETTING_VALUE_INVALID/);
 assert.equal(await fs.readFile(f.file,'utf8'),unchanged);
 await f.service().update('weekly.interval',10);rows=await f.service().list();assert.equal(rows.find(x=>x.id==='weekly.interval').value,10);assert.equal(rows.find(x=>x.id==='weekly.interval').enabled,true);
 assert.equal(rows.find(x=>x.id==='radar.enabled').value,false);assert.equal(rows.find(x=>x.id==='integrity.enabled').value,true);
 const resolved=await f.resolve();assert.equal(resolved.env.review_results_RUN_INTERVAL_DAYS,'10');assert.equal(resolved.env.PAPERECHO_WEEKLY_ENABLED,'true');assert.equal(resolved.env.PAPERECHO_INTEGRITY_ENABLED,'true');
 const day=n=>new Date(Date.UTC(2026,8,21+n,7));const state={last_successful_scheduled_run_at:day(0).toISOString()};
 const fsApi={readFile:async file=>{if(file.endsWith('runtime_state.json'))return JSON.stringify(state);throw Object.assign(new Error('missing'),{code:'ENOENT'});}};
 assert.equal((await selectScheduledDailyRun(resolved,{repoRoot:f.root,fsApi,now:day(7)})).status,'scheduled_radar_disabled');
 assert.equal((await selectScheduledDailyRun(resolved,{repoRoot:f.root,fsApi,now:day(10)})).decision.selectedFlow,'weekly');
 const status=new ControlScheduleStatusService({context:{mode:'desktop',env:resolved.env,researchRoot:f.root,reviewRoot:f.root},config:f.service(),fsApi,clock:()=>day(7)});
 assert.equal((await status.status()).weekly.nextDuePlannedSlot,day(10).toISOString());
 // A completed daily claim cannot start again merely because the interval changed.
 const claimedFs={readFile:async file=>file.includes('schedule_decisions')?JSON.stringify({schemaVersion:1,dateKey:'2026-10-01',plannedSlotAt:day(10).toISOString(),decision:'weekly_takeover',businessRunId:'done'}):JSON.stringify(state)};
 assert.equal((await selectScheduledDailyRun(resolved,{repoRoot:f.root,fsApi:claimedFs,now:day(10),loadLedger:async()=>({ledger:{status:'completed'}})})).status,'already_completed');
});
test('new users default to seven days and old radar-only profiles change only on interval save',async t=>{
 const f=await fixture(t);assert.equal((await f.service().list()).find(x=>x.id==='weekly.interval').value,7);
 const owner=JSON.parse(await fs.readFile(f.file,'utf8'));owner.profile='radar';owner.weekly={intervalDays:21,enabled:false};await fs.writeFile(f.file,JSON.stringify(owner));
 await f.service().update('integrity.enabled',false);assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).profile,'radar');
 await f.service().update('weekly.interval',21);assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).profile,'standard');
 let calls=0;const result=await runWeeklyIntegrityMonitor({enabled:false,fetchCrossref:()=>calls++,fetchPubmedBatch:()=>calls++});assert.equal(result.status,'disabled');assert.equal(calls,0);
});
test('failed interval write preserves the complete previous owner',async t=>{
 const f=await fixture(t,{intervalDays:14,enabled:false});const before=await fs.readFile(f.file,'utf8');
 const fail=new ConfigService({root:f.root,configPath:f.file,env:{PAPERECHO_ROOT_LAYOUT:'dev'},atomicOptions:{validateTemporary:async()=>{throw new Error('ISOLATED_WRITE_FAILURE');}}});
 await assert.rejects(fail.update('weekly.interval',9),/ISOLATED_WRITE_FAILURE/);assert.equal(await fs.readFile(f.file,'utf8'),before);
});
test('legacy owners reuse the existing atomic migration when first saving an interval',async t=>{
 const f=await fixture(t);const owner=JSON.parse(await fs.readFile(f.file,'utf8'));owner.schemaVersion=2;await fs.writeFile(f.file,JSON.stringify(owner));
 for(const field of ['translationConfig','preferenceConfig'])await fs.writeFile(path.join(f.root,owner.common.llm[field]),'{}');
 const service=new ConfigService({root:f.root,configPath:f.file,env:{PAPERECHO_ROOT_LAYOUT:'dev',ZOTERO_PROJECT_ROOT:f.root,review_results_RUN_INTERVAL_DAYS:'14'}});
 assert.equal((await service.list()).find(x=>x.id==='weekly.interval').value,14);
 await service.update('weekly.interval',14);
 assert.equal((await f.service().list()).find(x=>x.id==='weekly.interval').value,14);
 assert.deepEqual(JSON.parse(await fs.readFile(f.file+'.legacy-backup','utf8')),owner);
});
