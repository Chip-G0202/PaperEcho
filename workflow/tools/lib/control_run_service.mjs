import fs from 'node:fs/promises';
import path from 'node:path';
import { main as runnerMain, runProduction } from '../runner/main.mjs';
import { runPreflight, buildExecutionPlan } from '../runner/preflight.mjs';
import { readBoundedJson, writeAtomicJson } from './atomic_json.mjs';
import { inspectWorkflowLease } from '../recovery/operation_ledger.mjs';
import { copyEnvironment } from './credential_registry.mjs';
import { RUN_PHASES, PROGRESS_IDS } from './control_run_progress.mjs';
const phases = () => RUN_PHASES.map(([id,name])=>({id,name,description:'',status:'pending'}));
const empty = () => ({schemaVersion:1,status:'idle',runId:null,startedAt:null,endedAt:null,elapsed:0,current:-1,stages:phases(),products:[],error:null});
const alive = pid => {try {process.kill(pid,0); return true;} catch {return false;}};
const safeRunId = id => typeof id==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id);
export class ControlRunService {
  constructor({config,doctor,review,context,env,runner=runnerMain,runnerDependencies={}}) {
    Object.assign(this,{config,doctor,review,context,env,runner,runnerDependencies});
    this.file=path.join(review.runRoot,'.control-run.json'); this.writes=Promise.resolve();
  }
  persist() {
    const value=structuredClone(this.state);
    this.writes=this.writes.catch(()=>{}).then(()=>writeAtomicJson(this.file,value)); return this.writes;
  }
  async lease() {return readBoundedJson(this.review.runRoot,path.join(this.review.runRoot,'.workflow.lease.json'),{maxBytes:8192});}
  async status() {
    try {
      const lease=await this.lease(); const claim=inspectWorkflowLease(lease);
      let state=this.state || await readBoundedJson(this.review.runRoot,this.file);
      if (state && (state.schemaVersion!==1 || !Array.isArray(state.stages))) throw Error();
      if (claim !== 'absent' && (claim !== 'running' || state?.runId !== lease.runId)) {
        return {...empty(),runId:safeRunId(lease?.runId)?lease.runId:null,status:claim==='running'?'running':'unknown',startedAt:lease?.createdAt || null,elapsed:Number.isFinite(Date.parse(lease?.createdAt))?Math.max(0,Math.floor((Date.now()-Date.parse(lease.createdAt))/1000)):null,error:claim==='running'?'当前工作空间已有任务运行，请等待。':'现有运行锁状态未确认，请检查系统诊断。'};
      }
      state=structuredClone(state || empty());
      if(claim==='running' && state.status!=='running'){state.status='unknown';state.error='子任务退出状态尚未确认，保留运行锁；请检查系统诊断。';}
      if (state.status==='running' && !this.job && !alive(state.ownerPid)) {state.status='unknown';state.error='后端连接已中断，运行结果尚未确认。';}
      if (state.startedAt) state.elapsed=Math.max(0,Math.floor(((state.endedAt?Date.parse(state.endedAt):Date.now())-Date.parse(state.startedAt))/1000));
      const products=[];
      for(const product of state.products || []) {
        if(typeof product.path!=='string')continue;
        const rel=path.relative(this.context.reviewRoot,path.resolve(product.path));
        if(!rel || rel.startsWith('..') || path.isAbsolute(rel))continue;
        try {const real=await fs.realpath(product.path),root=await fs.realpath(this.context.reviewRoot),bound=path.relative(root,real);
          if(bound && !bound.startsWith('..') && !path.isAbsolute(bound) && (await fs.stat(real)).isFile())products.push({name:path.basename(real),path:real});
        } catch {}
      }
      state.products=products;return state;
    } catch {return {...empty(),status:'unknown',error:'无法确认运行状态，请检查系统诊断。'};}
  }
  async start() {
    if (this.job) { await this.accepted; return this.status(); }
    // Synchronous reservation closes double-click races before the first await.
    let ready; const accepted=new Promise(resolve=>ready=resolve); this.accepted=accepted;
    this.job=this.execute(ready).finally(ready);
    this.job.finally(()=>{this.job=null;}).catch(()=>{});
    await accepted; return this.status();
  }
  async execute(onReady = () => {}) {
    try {
      const lease=await this.lease(); if(inspectWorkflowLease(lease)!=='absent') return;
      const previous=this.state || await readBoundedJson(this.review.runRoot,this.file);
      const resume=previous?.status==='failed' && safeRunId(previous.runId) ? previous.runId : null;
      this.state={...empty(),status:'running',ownerPid:process.pid,startedAt:new Date().toISOString(),phase:'运行前检查'};
      await this.persist(); onReady();
      const owner=await this.config.readOwnerOrTemplate('paperecho.config.json');
      if(!owner.present || !['desktop','web'].includes(owner.value.mode)) throw Error('RUN_PATH_REQUIRED');
      const issues=(await this.doctor.configuration()).configurationIssues;
      if(issues?.length) {this.state.settingTarget=issues[0].settingTarget;throw Error('RUN_MODEL_CONFIGURATION_REQUIRED');}
      const env=copyEnvironment(this.env,{ELECTRON_RUN_AS_NODE:'1',PAPERECHO_CONTROL_RUN:'1',review_results_ORCHESTRATOR_TRIGGER:'manual'});
      for(const key of ['PAPERECHO_SCHEDULED_DAILY','PAPERECHO_SCHEDULED_SLOT','PAPERECHO_SCHEDULED_FLOW','PAPERECHO_SCHEDULED_WEEKLY_MODE','PAPERECHO_PARENT_WORKFLOW_LEASE']) delete env[key];
      const sink={write:()=>{}};
      const code=await this.runner(['--run','--mode',owner.value.mode,'--profile','standard','--fixed-mode',...(resume?['--resume',resume]:[])],{
        ...this.runnerDependencies,env,cwd:this.context.applicationRoot,repoRoot:this.context.resourceRoot || this.context.applicationRoot,
        stdout:sink,stderr:sink,
        runPreflightImpl:async(options,deps)=>{
          const report=await (this.runnerDependencies.runPreflightImpl || runPreflight)(options,deps);
          if(!report.canRun){
            const ai=report.requiredMissing?.some(item=>item.section==='common');
            this.state.error=ai?'AI 配置不完整，请前往 AI 功能配置。':'工作空间或 Zotero 连接未就绪，请检查运行路径与系统诊断。';
            this.state.settingTarget=ai?'ai.key':'runtime.path';
          }
          return report;
        },
        buildExecutionPlanImpl:(options,deps)=>{
          const plan=buildExecutionPlan(options,deps);this.state.runId=plan.runId;this.state.phase='运行中';return plan;
        },
        runProductionImpl:async(plan,deps)=>{
          await this.persist();
          const production=this.runnerDependencies.runProductionImpl || runProduction;
          return production(plan,{...deps,onProgress:message=>this.progress(message)});
        },
      });
      this.state.status=code===0?'success':'failed';this.state.endedAt=new Date().toISOString();
      if(code!==0) this.state.error ||= '运行未完成；请检查运行配置、连接和系统诊断。';
      await this.collectProducts().catch(()=>{this.state.error ||= '产物位置尚无法确认，请检查运行报告。';}); await this.persist();
    } catch(error) {
      if(!this.state) return;
      this.state.status='failed';this.state.endedAt=new Date().toISOString();
      const messages={RUN_PATH_REQUIRED:'请先配置 Desktop 或 Web 工作空间。',RUN_MODEL_CONFIGURATION_REQUIRED:'AI 配置不完整，请前往 AI 功能配置。'};
      this.state.error=messages[error.message] || '运行失败，请检查工作空间和系统诊断。';
      if(error.message==='RUN_PATH_REQUIRED') this.state.settingTarget='runtime.path';
      await this.persist().catch(()=>{});
    }
    if(this.state?.status==='failed') {
      for(const stage of this.state.stages) if(stage.status==='running')stage.status='failed';
      await this.persist().catch(()=>{});
    }
  }
  progress(message) {
    if(message?.type!=='paperecho-run-progress' || !PROGRESS_IDS.has(message.id) || !['running','completed','failed','skipped'].includes(message.status)) return;
    const stage=this.state.stages.find(item=>item.id===message.id);
    if(stage){stage.status=message.status;if(Number.isFinite(message.milliseconds)&&message.milliseconds>=0)stage.elapsed=message.milliseconds/1000;this.state.current=this.state.stages.indexOf(stage);}
    if(message.status==='failed')this.state.error ||= '部分阶段未完成，请查看运行结果和系统诊断。';
    this.state.phase=message.id==='zotero_backend_ready'?'检查 Zotero 连接':stage?.name || '运行中';
    void this.persist().catch(()=>{});
  }
  async collectProducts() {
    if(!safeRunId(this.state.runId))return;
    const run=await this.review.read(path.join(this.review.runRoot,this.state.runId,'run_group.json'));
    const pipeline=run && this.review.pipeline(run);if(!pipeline)return;
    const report=await this.review.read(path.join(pipeline,'orchestrator_report.json'));
    if(report?.runId!==this.state.runId && report?.runContext?.runId!==this.state.runId)return;
    const output=report.artifacts?.stage4_output;
    if(!output?.exists || !output.fresh || !output.path)return;
    const candidate=path.relative(this.context.reviewRoot,path.resolve(output.path));if(!candidate || candidate.startsWith('..') || path.isAbsolute(candidate))return;
    const real=await fs.realpath(output.path);const root=await fs.realpath(this.context.reviewRoot);
    const relative=path.relative(root,real);if(!relative || relative.startsWith('..') || path.isAbsolute(relative))return;
    const stat=await fs.stat(real);if(!stat.isFile() || stat.mtimeMs<Date.parse(run.startedAt))return;
    this.state.products=[{name:path.basename(real),path:real}];
  }
}
