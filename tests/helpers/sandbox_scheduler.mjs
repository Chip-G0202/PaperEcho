import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { verifyReleaseArtifact } from '../../desktop/electron-poc/release.mjs';

const repo=fileURLToPath(new URL('../../',import.meta.url)), base=path.join(repo,'tests/runs/phase5b');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const xml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const fail=code=>{throw new Error(code);};
async function safe(file, directory=false) {
  for(let p=path.resolve(file);;p=path.dirname(p)) {
    const stat=await fs.lstat(p);
    if(stat.isSymbolicLink() || (p===path.resolve(file) && (directory?!stat.isDirectory():!stat.isFile()||stat.nlink!==1))) fail('SCHEDULER_LAB_PATH_UNSAFE');
    if(p===path.dirname(p))break;
  }
}
export async function prepare(focus = 'all') {
  if(!['all','manual','prepared'].includes(focus))fail('SCHEDULER_FOCUS_INVALID');
  if(process.platform!=='win32')fail('SCHEDULER_WINDOWS_REQUIRED');
  const pointer=JSON.parse(await fs.readFile(path.join(repo,'tests/runs/phase2b/latest-build.json'),'utf8'));
  const packageBase=path.join(repo,'tests/runs/phase2b');
  if(!pointer.output.startsWith(packageBase+path.sep))fail('SCHEDULER_PACKAGE_OUTSIDE_LAB');
  const verified=await verifyReleaseArtifact({root:pointer.output,parent:path.dirname(pointer.output)});
  const manifest=JSON.parse(await fs.readFile(path.join(pointer.output,'release-manifest.json'),'utf8'));
  for(const source of manifest.sources) {
    if(sha(await fs.readFile(path.join(repo,source)))!==sha(await fs.readFile(path.join(pointer.output,'resources/core',source))))fail('SCHEDULER_PACKAGE_STALE');
  }
  const pwsh=process.env.PWSH_PATH;
  if(!pwsh||!path.isAbsolute(pwsh)||path.basename(pwsh).toLowerCase()!=='pwsh.exe')fail('SCHEDULER_POWERSHELL_PATH_REQUIRED');
  await safe(pwsh);
  await fs.mkdir(base,{recursive:true}); await safe(base,true);
  const runId=randomUUID(), root=path.join(base,runId), input=path.join(root,'input'), output=path.join(root,'output');
  await fs.mkdir(root); await fs.mkdir(input); await fs.mkdir(output);
  await fs.cp(pointer.output,path.join(input,'Runtime'),{recursive:true,dereference:false});
  await fs.cp(path.dirname(pwsh),path.join(input,'tools/pwsh'),{recursive:true,dereference:false,
    filter: async source=>{const s=await fs.lstat(source);if(s.isSymbolicLink())fail('SCHEDULER_RUNTIME_LINK_UNSAFE');return !/profile\.ps1$/i.test(source);}});
  for(const [source,target] of [['sandbox_scheduler.ps1','scheduler.ps1'],['sandbox_scheduler_guest.mjs','scheduler-guest.mjs'],['sandbox_scheduler_control.ps1','scheduler-control.ps1']])
    await fs.copyFile(path.join(repo,'tests/helpers',source),path.join(input,target),fs.constants?.COPYFILE_EXCL||1);
  await fs.writeFile(path.join(input,'scheduler.cmd'),'@echo off\r\n"C:\\PaperEchoLab\\Input\\tools\\pwsh\\pwsh.exe" -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "C:\\PaperEchoLab\\Input\\scheduler.ps1"\r\n',{flag:'wx'});
  await fs.writeFile(path.join(input,'ready.cmd'),'@echo off\r\necho {"runId":"'+runId+'"}>"C:\\PaperEchoLab\\Output\\session-ready.json"\r\n',{flag:'wx'});
  const files=[];let total=0;
  async function inventory(dir){
    for(const e of await fs.readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,e.name); const stat=await fs.lstat(file);
      if(stat.isSymbolicLink())fail('SCHEDULER_INPUT_LINK_UNSAFE');
      if(stat.isDirectory())await inventory(file);
      else{
        if(!stat.isFile()||stat.nlink!==1)fail('SCHEDULER_INPUT_FILE_UNSAFE');
        const name=path.relative(input,file).replaceAll('\\','/');
        if(/(?:^|\/)\.env(?:\.|$)|(?:^|\/)(?:id_rsa|id_ed25519)$|\.pfx$|\.p12$|\.key$/i.test(name))fail('SCHEDULER_SENSITIVE_INPUT_REJECTED');
        total+=stat.size;if(total>2*1024**3||files.length>=20000)fail('SCHEDULER_INPUT_LIMIT');
        files.push({name,size:stat.size,sha256:sha(await fs.readFile(file))});
      }
    }
  }
  await inventory(input);
  const handoff={schemaVersion:1,runId,focus,artifactId:verified.artifactId,files};
  const handoffText=JSON.stringify(handoff);
  await fs.writeFile(path.join(input,'handoff.json'),handoffText,{flag:'wx'});
  const configuration='<?xml version="1.0" encoding="utf-8"?>\n<Configuration><VGpu>Disable</VGpu><Networking>Disable</Networking><AudioInput>Disable</AudioInput><VideoInput>Disable</VideoInput><PrinterRedirection>Disable</PrinterRedirection><ClipboardRedirection>Disable</ClipboardRedirection><ProtectedClient>Enable</ProtectedClient><MappedFolders><MappedFolder><HostFolder>'+xml(input)+'</HostFolder><SandboxFolder>C:\\PaperEchoLab\\Input</SandboxFolder><ReadOnly>true</ReadOnly></MappedFolder><MappedFolder><HostFolder>'+xml(output)+'</HostFolder><SandboxFolder>C:\\PaperEchoLab\\Output</SandboxFolder><ReadOnly>false</ReadOnly></MappedFolder></MappedFolders><LogonCommand><Command>C:\\Windows\\System32\\cmd.exe /d /s /c &quot;&quot;C:\\PaperEchoLab\\Input\\scheduler.cmd&quot;&quot;</Command></LogonCommand></Configuration>';
  const wsb=path.join(root,'PaperEcho-scheduler.wsb');await fs.writeFile(wsb,configuration,{flag:'wx'});
  await fs.writeFile(path.join(root,'binding.json'),JSON.stringify({runId,handoffSha256:sha(handoffText)}),{flag:'wx'});
  return {status:'PREPARED',runId,wsb,inputFiles:files.length,network:false,msi:false,hostOsMutation:false};
}
export async function read(runId){
  if(!/^[a-f0-9-]{36}$/.test(runId))fail('SCHEDULER_RUN_ID_INVALID');
  const root=path.join(base,runId);await safe(root,true);
  const binding=JSON.parse(await fs.readFile(path.join(root,'binding.json'),'utf8'));
  const handoff=path.join(root,'input/handoff.json');await safe(handoff);
  if(binding.handoffSha256!==sha(await fs.readFile(handoff)))fail('SCHEDULER_HANDOFF_CHANGED');
  const result={};
  for(const [key,name] of [['launcher','launcher-result.json'],['scheduler','scheduler-result.json']]){
    const file=path.join(root,'output',name);await safe(file);
    if((await fs.stat(file)).size>16384)fail('SCHEDULER_REPORT_LIMIT');
    const value=JSON.parse(await fs.readFile(file,'utf8'));
    if(value.schemaVersion!==1||!value.guestIdentityVerified)fail('SCHEDULER_REPORT_IDENTITY_INVALID');
    result[key]=value;
  }
  if(result.launcher.runId!==runId||result.scheduler.runId!==runId)fail('SCHEDULER_REPORT_BINDING_INVALID');
  if(result.scheduler.status==='PASS'){
    const required=['packaged-portable-identity','headless-check','register-xml-identity','manual-repeat-trigger','concurrent-trigger','active-workflow-lease','unknown-startup','unknown-notification','active-day-claim','restore-existing-blocked','upgrade-new-root-blocked','disable-enable-update','automatic-trigger','doctor-readonly','delete-cleanup-data-preserved'];
    if(result.scheduler.focus==='manual')required.splice(4);
    if(result.scheduler.focus==='prepared')required.splice(0,required.length,'packaged-portable-identity','headless-check','restore-existing-blocked','upgrade-new-root-blocked');
    const requiredChecks=['scheduler.contract','scheduler.application','restore.transaction','runtime.roots','runtime.application','runtime.data','runtime.cache','runtime.node','runtime.resources','configuration','workflow.startup','preflight','secrets','scheduler.secretSource','scheduler.lease','scheduler.recovery','scheduler.claim','scheduler.runnerDecision'];
    if(result.scheduler.preflight?.status!=='PASS'||!Array.isArray(result.scheduler.preflight.checks)
      ||result.scheduler.preflight.checks.some(c=>c.status!=='PASS')||requiredChecks.some(id=>!result.scheduler.preflight.checks.some(c=>c.checkId===id)))fail('SCHEDULER_PREFLIGHT_REPORT_INCOMPLETE');
    if(result.launcher.exitCode!==0||!result.launcher.childExited||!result.launcher.inputHashesVerified||!result.launcher.localCopyVerified
      ||result.scheduler.steps.length!==required.length||required.some(id=>!result.scheduler.steps.some(s=>s.id===id&&s.status==='PASS')))fail('SCHEDULER_GATE_INCOMPLETE');
  }
  return result;
}
export async function automate(focus='all') {
  const executable=process.env.WSB_PATH;
  if(!executable||!path.isAbsolute(executable)||path.basename(executable).toLowerCase()!=='wsb.exe')fail('SCHEDULER_WSB_REQUIRED');
  const invoke=promisify(execFile);
  const cli=async(args,timeout=90000)=>{const r=await invoke(executable,[...args,'--raw'],{windowsHide:true,timeout,maxBuffer:16384});return r.stdout.trim()?JSON.parse(r.stdout):null;};
  const managed=await cli(['list']);
  if(managed?.WindowsSandboxEnvironments?.length)fail('SCHEDULER_EXISTING_SANDBOX_REQUIRES_BINDING');
  await invoke(process.env.PWSH_PATH,['-NoProfile','-NonInteractive','-Command',"if(Get-Process -Name WindowsSandbox,WindowsSandboxClient -ErrorAction SilentlyContinue){exit 3}"],{windowsHide:true,timeout:10000}).catch(e=>{if(e.code===3)fail('SCHEDULER_EXISTING_SANDBOX_REQUIRES_BINDING');throw e;});
  const prepared=await prepare(focus), root=path.dirname(prepared.wsb);
  console.log(JSON.stringify({status:'PREPARED',runId:prepared.runId,focus}));
  const configuration=(await fs.readFile(prepared.wsb,'utf8')).replace('scheduler.cmd','ready.cmd');
  const wait=async(name,budget)=>{const end=Date.now()+budget;while(Date.now()<end){
    const file=path.join(root,'output',name);
    try{await safe(file);const text=await fs.readFile(file,'utf8');if(text.length>16384)fail('SCHEDULER_REPORT_LIMIT');const v=JSON.parse(text);if(v.runId!==prepared.runId)fail('SCHEDULER_REPORT_BINDING_INVALID');return v;}
    catch(e){if(e.code!=='ENOENT')throw e;}await delay(500);
  }fail('SCHEDULER_AUTOMATION_TIMEOUT');};
  let owned=false, execution;
  try{
    await cli(['start','--id',prepared.runId,'--config',configuration]); owned=true;
    const connection=spawn(executable,['connect','--id',prepared.runId],{stdio:'ignore',windowsHide:true});
    connection.on('error',()=>{});connection.unref();
    await wait('session-ready.json',90000);
    execution=cli(['exec','--id',prepared.runId,'--run-as','ExistingLogin','--working-directory','C:\\PaperEchoLab\\Input','--command','C:\\Windows\\System32\\cmd.exe /d /s /c C:\\PaperEchoLab\\Input\\scheduler.cmd'],660000);
    const settled=execution.then(()=>({ok:true}),()=>({ok:false}));
    await wait('completed.json',660000);
    if(!(await settled).ok)fail('SCHEDULER_GUEST_EXEC_FAILED');
    const result=await read(prepared.runId);
    const r=result.scheduler;
    console.log(JSON.stringify({runId:prepared.runId,status:r.status,focus:r.focus,slotCondition:r.slotCondition,
      preflight:r.preflight,prepared:r.prepared,guestExitCode:r.guestExitCode,steps:r.steps,code:r.code,failedStep:r.failedStep,cleanup:r.cleanup,
      lastObservation:r.trigger?.observations.at(-1),launcherExit:result.launcher.exitCode}));
    if(result.scheduler.status!=='PASS')process.exitCode=1;
    return result;
  }finally{
    if(owned){await cli(['stop','--id',prepared.runId]);const listed=await cli(['list']);
      if(JSON.stringify(listed).toLowerCase().includes(prepared.runId))fail('SCHEDULER_SANDBOX_CLEANUP_UNCONFIRMED');}
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(['--run','--manual','--prepared'].includes(process.argv[2]))await automate(process.argv[2]==='--run'?'all':process.argv[2].slice(2));
    else{const r=process.argv[2]==='--prepare'?await prepare():await read(process.argv[2]);console.log(JSON.stringify(r));if(r.scheduler?.status==='FAIL')process.exitCode=1;}
  }catch(error){console.log(JSON.stringify({status:'FAIL',code:/^SCHEDULER_[A-Z_]+$/.test(error.message)?error.message:'SCHEDULER_LAB_FAILED'}));process.exitCode=1;}
}
