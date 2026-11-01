import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pngPixels } from '../../desktop/electron-poc/generate-icons.mjs';
import { sourceAllowed, dependencyFileAllowed, appVersion } from '../../desktop/electron-poc/package-policy.mjs';
import { macOptions, macBundleId } from '../../desktop/electron-poc/package-mac-dmg.mjs';
import { setupConfiguration } from '../../desktop/electron-poc/package-setup.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url)), icons=path.join(repo,'desktop/electron-poc/icons');

test('native icons derive from the canonical SVG, preserve alpha and provide common sizes',async()=>{
 const source=await fs.readFile(path.join(repo,'workflow/tools/web/static/paperecho-mark.svg'));
 const provenance=JSON.parse(await fs.readFile(path.join(icons,'source.json')));
 assert.equal(provenance.sha256,createHash('sha256').update(source).digest('hex'));
 const image=pngPixels(await fs.readFile(path.join(icons,'paperecho.png')));assert.equal(image.width,256);assert.equal(image.height,256);assert.equal(image.rgba[3],0);
 const ico=await fs.readFile(path.join(icons,'paperecho.ico'));assert.equal(ico.readUInt16LE(0),0);assert.equal(ico.readUInt16LE(2),1);assert.equal(ico.readUInt16LE(4),7);
 const sizes=[];
 for(let i=0;i<ico.readUInt16LE(4);i++){
  const e=6+i*16,size=ico[e]||256,offset=ico.readUInt32LE(e+12),length=ico.readUInt32LE(e+8);sizes.push(size);
  assert.ok(offset+length<=ico.length);assert.equal(ico.readUInt32LE(offset),40);assert.equal(ico.readInt32LE(offset+4),size);assert.equal(ico.readInt32LE(offset+8),size*2);assert.equal(ico.readUInt16LE(offset+14),32);
  const pixel=(x,y)=>offset+40+((size-y-1)*size+x)*4;
  assert.equal(ico[pixel(0,0)+3],0);assert.ok(ico[pixel(Math.floor(size/2),Math.floor(size/2))+3]>0);
  if(size===256)for(let y=0;y<size;y++)for(let x=0;x<size;x++){
   const a=pixel(x,y),b=(y*size+x)*4;assert.deepEqual([...ico.subarray(a,a+4)],[image.rgba[b+2],image.rgba[b+1],image.rgba[b],image.rgba[b+3]]);
  }
 }
 assert.deepEqual(sizes,[16,24,32,48,64,128,256]);
 const icns=await fs.readFile(path.join(icons,'paperecho.icns'));assert.equal(icns.toString('ascii',0,4),'icns');assert.equal(icns.readUInt32BE(4),icns.length);
 let count=0;for(let p=8;p<icns.length;){const length=icns.readUInt32BE(p+4);assert.ok(length>=8&&p+length<=icns.length);count++;p+=length;}assert.ok(count>=7);
});

test('Mac, EXE, window and NSIS icon paths preserve the existing application identity and installer scope',async()=>{
 const mac=macOptions('/fixture',{},'44.7.2'),win=setupConfiguration('/fixture','Setup.exe');
 assert.equal(mac.icon,path.join(icons,'paperecho.icns'));assert.equal(mac.appVersion,'2.6.0');assert.equal(appVersion,'2.6.0');assert.equal(macBundleId,'com.electron.paperecho');
 assert.equal(win.appId,macBundleId);assert.equal(win.win.icon,path.join(icons,'paperecho.ico'));
 assert.equal(win.nsis.installerIcon,win.win.icon);assert.equal(win.nsis.uninstallerIcon,win.win.icon);assert.equal(win.nsis.oneClick,false);assert.equal(win.nsis.perMachine,false);assert.equal(win.nsis.allowElevation,false);assert.equal(win.nsis.allowToChangeInstallationDirectory,true);
 const main=await fs.readFile(path.join(repo,'desktop/electron-poc/main.mjs'),'utf8');assert.match(main,/icon: app.isPackaged \? path.join\(process.resourcesPath, 'core\/desktop\/electron-poc\/icons\/paperecho.png'\)/);
 for(const file of ['desktop/electron-poc/icons/paperecho.png','desktop/electron-poc/headless.mjs','workflow/tools/stage0/main.mjs','workflow/tools/lib/control_automation_service.mjs','workflow/tools/lib/macos_launchagent.mjs','workflow/tools/lib/windows_task_scheduler.mjs','workflow/tools/web/static/index.html'])assert.equal(sourceAllowed(file),true,file);
 const workflow=await fs.readFile(path.join(repo,'.github/workflows/windows-setup-manual.yml'),'utf8');assert.match(workflow,/workflow_dispatch:/);assert.match(workflow,/contents: read/);assert.match(workflow,/windows-2025/);assert.match(workflow,/npm run package:setup:win/);assert.doesNotMatch(workflow,/release create|secrets\.|^\s+push:/m);
});

test('production pruning removes only duplicate browser bundles and source maps; copied Node dependencies still work offline',async t=>{
 const base=path.join(repo,'tests/runs/branding');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'dependencies-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 for(const file of ['node_modules/exceljs/dist/exceljs.js','node_modules/jszip/dist/jszip.min.js','node_modules/async/dist/async.js.map'])assert.equal(dependencyFileAllowed(file),false);
 for(const file of ['node_modules/exceljs/excel.js','node_modules/exceljs/lib/exceljs.nodejs.js','node_modules/jszip/lib/index.js','node_modules/exceljs/LICENSE','node_modules/dayjs/plugin/utc.js'])assert.equal(dependencyFileAllowed(file),true);
 const all=execFileSync('npm',['ls','--omit=dev','--all','--parseable'],{cwd:repo,encoding:'utf8'}).trim().split(/\r?\n/).slice(1);
 const modules=all.filter(file=>!all.some(parent=>parent!==file&&file.startsWith(parent+path.sep)));
 for(const module of modules)await fs.cp(module,path.join(root,path.relative(repo,module)),{recursive:true,dereference:false,filter:file=>dependencyFileAllowed(path.relative(repo,file))});
 await fs.writeFile(path.join(root,'package.json'),'{}');
 const code=`const {createRequire}=require('node:module');const r=createRequire(${JSON.stringify(path.join(root,'package.json'))});(async()=>{for(const n of ['exceljs','jszip','nodemailer','fast-xml-parser'])r(n);const E=r('exceljs'),w=new E.Workbook();w.addWorksheet('offline').addRow(['resource',1]);const b=await w.xlsx.writeBuffer();const x=new E.Workbook();await x.xlsx.load(b);if(x.worksheets[0].getCell('A1').value!=='resource')throw Error('WORKBOOK_RESOURCE_FAILURE');const J=r('jszip'),z=new J();z.file('proof','offline');if(await(await J.loadAsync(await z.generateAsync({type:'nodebuffer'}))).file('proof').async('string')!=='offline')throw Error('ZIP_RESOURCE_FAILURE');for(const p of Object.keys(require.cache))if(!p.startsWith(${JSON.stringify(root+path.sep)}))throw Error('EXTERNAL_DEPENDENCY_FALLBACK');console.log('OFFLINE_DEPENDENCIES_PASS')})().catch(()=>process.exit(1))`;
 assert.equal(execFileSync(process.execPath,['-e',code],{cwd:root,env:{PATH:'',PAPERECHO_SKIP_DOTENV:'1'},encoding:'utf8'}).trim(),'OFFLINE_DEPENDENCIES_PASS');
 await assert.rejects(fs.stat(path.join(root,'node_modules/exceljs/dist')),{code:'ENOENT'});
});
