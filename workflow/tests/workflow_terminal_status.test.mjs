import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { runZoteroLiteratureFilter } from '../tools/stage0/main.mjs';
import { OperationLedgerStore } from '../tools/recovery/operation_ledger.mjs';
import { reconcileOperationLedger } from '../tools/recovery/reconciliation.mjs';
import { terminalWorkflowStatus, workflowLedgerStatus } from '../tools/lib/orchestrator_status.mjs';
import { finishRunGroup } from '../tools/lib/runtime_housekeeping.mjs';
import { main as runner } from '../tools/runner/main.mjs';
const root=path.resolve('tests/runs/status-fixtures');
async function setup(t) {
 await fs.mkdir(root,{recursive:true});const dir=await fs.mkdtemp(path.join(root,'terminal-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const runId='fixture';const runRoot=path.join(dir,'review','runs');
 const store=await OperationLedgerStore.create({runRoot,runId,mode:'desktop',profile:'standard',configHash:'a'.repeat(64),inputHash:'b'.repeat(64),artifactPath:path.join(dir,'input.json')});
 return {dir,runRoot,runId,store};
}
for(const [failure,ledgerMode] of [['timed_out','absent'],['timed_out','empty'],['timed_out','verified'],['interrupted','empty'],['failed','empty']]) test(`orchestrator ${failure} with ${ledgerMode} ledger preserves outcome`,async t=>{
 const {dir,runRoot,runId,store}=await setup(t);
 if(ledgerMode==='absent') await fs.unlink(store.filePath);
 if(ledgerMode==='verified') { const operation=await store.planOperation({type:'fixture',target:{id:'fixture'},input:{}}); for(const status of ['started','remote_observed','verified']) await store.transition(operation.idempotencyKey,status); }
 const calls=[];
 const report=await runZoteroLiteratureFilter({runId,config:{repoRoot:dir,researchRoot:dir,reviewRoot:path.join(dir,'review'),pipelineDir:path.join(dir,'pipeline'),now:new Date()},env:{},triggerMode:'manual',runMode:{isManualOrForce:true,forceRun:true},stage1Only:false,
 recoveryCoordinator:ledgerMode==='absent'?null:{store},ensureStartupReady:async()=>({ok:true}),readJson:async()=>({}),statArtifact:async()=>({exists:false}),writeReport:async()=>{},writeJson:async()=>{},
 runStage:async stage=>{calls.push(stage.name);return {exitCode:1,data:{failureStatus:failure,last_known_phase:'feedback_item_actions.enrichArchivePlanWithZoteroTitleMatches'}};}});
 assert.equal(terminalWorkflowStatus(report.status),failure);assert.deepEqual(calls,['stage1']);
 assert.equal(JSON.parse(await fs.readFile(path.join(runRoot,runId,'run_group.json'),'utf8')).status,failure);
 if(ledgerMode!=='absent'){const loaded=await OperationLedgerStore.load({runRoot,runId});assert.equal(loaded.ledger.status,failure);assert.equal(loaded.ledger.operationCount,ledgerMode==='verified'?1:0);assert.equal((await reconcileOperationLedger({store:loaded})).status,failure);}
});
for(const ops of [[],[{status:'verified'}]]) test(`explicit success with ${ops.length} operations does not infer workflow from ledger`,()=>{
 assert.equal(terminalWorkflowStatus('completed'),'completed');assert.equal(workflowLedgerStatus('completed',ops),ops.length?'completed':'incomplete');
});
test('terminal priority is monotonic over lower summaries',()=>{
 assert.equal(terminalWorkflowStatus('completed','timed_out'),'timed_out');assert.equal(terminalWorkflowStatus('timed_out','interrupted'),'interrupted');assert.equal(terminalWorkflowStatus('completed','failed_stage1'),'failed');
});
test('runner watchdog overrides completed child ledger after confirmed exit',async t=>{
 const {runRoot,runId,store}=await setup(t);await store.setRunStatus('completed');
 const manifestPath=path.join(runRoot,runId,'run_group.json');await fs.writeFile(manifestPath,JSON.stringify({status:'completed',artifacts:[]}));
 const output=[];const code=await runner(['--mode','desktop','--run'],{stdout:{write:s=>output.push(s)},stderr:{write:s=>output.push(s)},resolveRunnerConfigurationImpl:async options=>({options,env:{}}),runPreflightImpl:async()=>({canRun:true,checks:[],requiredMissing:[]}),buildExecutionPlanImpl:()=>({runRoot,runId}),runProductionImpl:async()=>({status:'timed_out',code:1,childExitConfirmed:true,stdout:JSON.stringify({status:'completed'})})});
 assert.notEqual(code,0);assert.equal(JSON.parse(await fs.readFile(manifestPath,'utf8')).status,'timed_out');assert.equal((await OperationLedgerStore.load({runRoot,runId})).ledger.status,'timed_out');
 await finishRunGroup({manifestPath,status:'completed'});assert.equal(JSON.parse(await fs.readFile(manifestPath,'utf8')).status,'timed_out');
});
test('nonzero child cannot be validated from an empty completed summary',async()=>{
 const {validateProductionResult}=await import('../tools/runner/result_validation.mjs');
 const result=await validateProductionResult({options:{mode:'desktop'},plan:{},processResult:{code:1,stdout:JSON.stringify({status:'completed',operations:[]})}});assert.equal(result.ok,false);
});
