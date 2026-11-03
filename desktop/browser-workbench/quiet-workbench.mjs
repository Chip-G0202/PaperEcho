// GUI lifecycle adapter only. The existing workbench owns HTTP, auth and business.
import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const codes = { PORT_OCCUPIED: '启动端口被无法确认的程序占用，请关闭冲突程序后重试。', BROWSER_FAILED: '服务已启动，但无法打开默认浏览器。请检查默认浏览器设置。', WORKBENCH_NOT_OWNED: '没有找到由此入口启动的后台；不会关闭桌面应用或其他服务。' };
export function safeError(error) {
  const value = error?.code || error?.message || '';
  return ['PORT_OCCUPIED','BROWSER_FAILED','WORKBENCH_NOT_OWNED'].includes(value) ? value : 'WORKBENCH_START_FAILED';
}
async function execute(file, args) {
  await new Promise((resolve,reject)=>{
    const child=spawn(file,args,{shell:false,windowsHide:true,stdio:'ignore'});
    const timeout=setTimeout(()=>{child.kill();reject(Error('BROWSER_FAILED'))},15000);
    child.once('error',()=>{clearTimeout(timeout);reject(Error('BROWSER_FAILED'))});
    child.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(Error('BROWSER_FAILED'))});
  });
}
export async function showError(code) {
  const message = codes[code] || '工作台启动失败。请确认已安装 PaperEcho，或源码环境具备 Node.js 18+ 与项目依赖。';
  if(process.platform==='darwin') await execute('/usr/bin/osascript',['-e','on run argv\ndisplay alert "PaperEcho 浏览器工作台" message (item 1 of argv) giving up after 10\nend run',message]);
}
async function privateDirectory(folder) {
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  const s=await fs.lstat(folder);if(!s.isDirectory()||s.isSymbolicLink()||process.platform!=='win32'&&(s.uid!==process.getuid()||(s.mode&0o077)))throw Error('WORKBENCH_PRIVATE_PATH_REQUIRED');
}
async function owner(folder) {
  const file=path.join(folder,'owner.json');
  try{const s=await fs.lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>2048)throw Error('WORKBENCH_PRIVATE_PATH_REQUIRED');return JSON.parse(await fs.readFile(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw e}
}
export async function runQuiet({ stop=false, env=process.env, openBrowser, onReady=()=>{} }={}) {
  const { browserEnvironment,startBrowserWorkbench }=await import('./start.mjs');
  const selected=await browserEnvironment({env});
  // This dedicated Mac GUI process also hosts legacy configuration readers.
  // They consult process.env after startup; retain the same resolved layout
  // and paths used by the service instead of falling back to dev mode.
  if (process.platform === 'darwin') {
    for (const key of ['PAPERECHO_LAYOUT','PAPERECHO_APPLICATION_ROOT','PAPERECHO_RESOURCE_ROOT','PAPERECHO_DATA_ROOT','PAPERECHO_CACHE_ROOT','PAPERECHO_WORKSPACE_ID']) {
      if (selected[key] !== undefined) process.env[key] = selected[key];
    }
  }
  const {resolveRuntimePaths}=await import(pathToFileURL(path.join(selected.PAPERECHO_RESOURCE_ROOT,'workflow/tools/lib/runtime_config.mjs')).href);
  const paths=resolveRuntimePaths({env:selected});
  const folder=path.join(paths.cacheRoot,'browser-workbench-gui');await privateDirectory(folder);
  if(stop){
    const record=await owner(folder);
    if(!record||!Number.isInteger(record.pid)||!/^\w{48}$/.test(record.nonce))throw Error('WORKBENCH_NOT_OWNED');
    try{process.kill(record.pid,0)}catch{throw Error('WORKBENCH_NOT_OWNED')}
    await fs.writeFile(path.join(folder,'stop-'+record.nonce),record.nonce,{flag:'wx',mode:0o600}).catch(e=>{if(e.code!=='EEXIST')throw e});
    return {stopping:true};
  }
  const result=await startBrowserWorkbench({env,openBrowser:true,openBrowserImpl:openBrowser || (async url=>{
    const target=new URL(url);if(target.protocol!=='http:'||target.hostname!=='127.0.0.1'||target.pathname!=='/'||target.search||target.hash)throw Error('BROWSER_FAILED');
    if(process.platform==='darwin')await execute('/usr/bin/open',[target.origin+'/#home']);
    else throw Error('BROWSER_FAILED');
  })});
  if(!result.browserOpened){await result.close();throw Error('BROWSER_FAILED')}
  if(!result.owned){await onReady({url:result.url,reused:true});return {reused:true,url:result.url};}
  const nonce=randomBytes(24).toString('hex'),file=path.join(folder,'owner.json');let watcher,closing=false;
  try { const old=await owner(folder);if(old){let alive=false;try{process.kill(old.pid,0);alive=true}catch{}if(alive){await result.close();throw Error('WORKBENCH_OWNER_UNCERTAIN')}await fs.unlink(file)}
  await fs.writeFile(file,JSON.stringify({pid:process.pid,nonce}),{flag:'wx',mode:0o600});
  } catch(error) { await result.close(); throw error; }
  const close=async()=>{
    if(closing)return;closing=true;watcher?.close();await result.close();
    if((await owner(folder))?.nonce===nonce)await fs.unlink(file);
    await fs.unlink(path.join(folder,'stop-'+nonce)).catch(e=>{if(e.code!=='ENOENT')throw e});
  };
  const checkStop=()=>{void fs.readFile(path.join(folder,'stop-'+nonce),'utf8').then(value=>{if(value===nonce)return close()}).catch(()=>{})};
  watcher=watch(folder,checkStop);checkStop();
  result.server.once('close',()=>{void close()});
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void close()});
  await onReady({url:result.url,reused:false});return {url:result.url,close};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
  const args=process.argv.slice(2);
  if(args.some(a=>a!=='--stop')||args.length>1)process.exitCode=1;
  else runQuiet({stop:args[0]==='--stop'}).catch(async error=>{
    const code=safeError(error);
    // Fixed codes only: never persist exception text, URLs, config or secrets.
    const folder=process.env.PAPERECHO_CACHE_ROOT || path.join(os.tmpdir(),'paperecho-browser-launch-'+os.userInfo().username);
    try{await privateDirectory(folder);const file=path.join(folder,'browser-launch.log');await fs.writeFile(file,JSON.stringify({at:new Date().toISOString(),code})+'\n',{mode:0o600,flag:'w'})}catch{}
    await showError(code).catch(()=>{});process.exitCode=1;
  });
}
