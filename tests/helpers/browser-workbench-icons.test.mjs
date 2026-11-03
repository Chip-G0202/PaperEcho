import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildMacIconEntry, buildWindowsIconEntry, relativeShortcut } from '../../desktop/browser-workbench/build-icon-entry.mjs';
async function fixture(t) {
  const base=path.resolve('tests/runs/browser-icons');await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'unit-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;
}
test('Mac entry carries official ICNS and uses bundled scripts without a console after folder moves',async t=>{
  const root=await fixture(t),output=path.join(root,'original');const built=await buildMacIconEntry(output);
  assert.deepEqual(await fs.readFile(path.join(built.app,'Contents/Resources/paperecho.icns')),await fs.readFile('desktop/electron-poc/icons/paperecho.icns'));
  const plist=await fs.readFile(path.join(built.app,'Contents/Info.plist'),'utf8');assert.match(plist,/<key>CFBundleIconFile<\/key><string>paperecho.icns<\/string>/);
  const executable=await fs.readFile(path.join(built.app,'Contents/MacOS/open-workbench'),'utf8');assert.ok(executable.includes('${folder:h}/Resources/workbench'));assert.match(executable,/LC_CTYPE=UTF-8/);assert.match(executable,/\/bin\/zsh "\$folder\/Start-Workbench-Quiet.command" <\/dev\/null >\/dev\/null 2>&1 &!/);assert.doesNotMatch(executable,/Terminal/);assert.ok(!executable.includes(process.cwd()));assert.equal((await fs.stat(path.join(built.app,'Contents/MacOS/open-workbench'))).mode&0o111,0o111);
  for(const file of ['Start-Workbench.command','start.mjs'])assert.deepEqual(await fs.readFile(path.join(output,file)),await fs.readFile('desktop/browser-workbench/'+file));
  await assert.rejects(buildMacIconEntry(output),{code:'EEXIST'});
  await fs.rename(output,path.join(root,'moved folder'));assert.ok((await fs.stat(path.join(root,'moved folder/Start-Workbench.command'))).isFile());
});
test('Windows shortcut has only a relative target and a stable environment-based official icon',async t=>{
 const root=await fixture(t);const built=await buildWindowsIconEntry(path.join(root,'drop-in'));const bytes=await fs.readFile(path.join(built.output,'PaperEcho 浏览器工作台.lnk'));
 assert.equal(bytes.readUInt32LE(0),76);assert.equal(bytes.subarray(4,20).toString('hex'),'0114020000000000c000000000000046');assert.equal(bytes.readUInt32LE(20),0x40cc);assert.equal(bytes.readUInt32LE(60),1);
 let position=76;const readString=()=>{const length=bytes.readUInt16LE(position);position+=2;const value=bytes.subarray(position,position+length*2).toString('utf16le');position+=length*2;return value};
 assert.equal(readString(),'PaperEcho 浏览器工作台');assert.equal(readString(),'.\\Open-Workbench.vbs');assert.equal(readString(),'.\\paperecho.ico');
 assert.equal(bytes.readUInt32LE(position),0x314);assert.equal(bytes.readUInt32LE(position+4),0xa0000007);assert.equal(bytes.subarray(position+268,position+788).toString('utf16le').split('\0')[0],built.iconPath);assert.equal(bytes.readUInt32LE(position+788),0);assert.equal(bytes.length,position+792);
 const ico=await fs.readFile('desktop/electron-poc/icons/paperecho.ico');assert.deepEqual(await fs.readFile(path.join(built.output,'paperecho.ico')),ico);const digest=createHash('sha256').update(ico).digest('hex').slice(0,12);assert.equal(built.iconPath,`%LOCALAPPDATA%\\PaperEcho\\launcher-icons\\paperecho-${digest}.ico`);
 assert.equal(bytes.includes(Buffer.from(process.cwd(),'utf16le')),false);assert.equal(bytes.readUInt32LE(20)&0x2003,0); // no RunAsUser, ID list or absolute LinkInfo
 const setup=await fs.readFile(path.join(built.output,'Prepare-Workbench-Icon.ps1'),'utf8');assert.match(setup,/Substring\(0, 12\)/);assert.match(setup,/LocalApplicationData/);assert.match(setup,/File\]::Copy\(\$source, \$destination, \$false\)/);assert.doesNotMatch(setup,/ExecutionPolicy|Start-Process|Remove-Item|RunAs/i);
 assert.deepEqual(await fs.readFile(path.join(built.output,'Start-Workbench.cmd')),await fs.readFile('desktop/browser-workbench/Start-Workbench.cmd')); // debug launcher is preserved byte-for-byte
 const vbs=await fs.readFile(path.join(built.output,'Open-Workbench.vbs'),'utf8'),quiet=await fs.readFile(path.join(built.output,'Start-Workbench-Quiet.ps1'),'utf8');assert.match(vbs,/shell.Run\(command, 0, True\)/);assert.match(vbs,/-WindowStyle Hidden/);assert.match(quiet,/CreateNoWindow = \$true/);assert.match(quiet,/UseShellExecute = \$false/);assert.match(quiet,/Prepare-Workbench-Icon.ps1/);
 assert.match(vbs,/ElseIf result <> 0 Then/);assert.match(vbs,/shell.Popup/);assert.match(vbs,/resources\\powershell\\pwsh.exe/);
 assert.match(quiet,/PSEdition -ne 'Core'/);assert.match(quiet,/headless.mjs/);assert.doesNotMatch(quiet,/ExecutionPolicy|RunAs|Stop-Process|taskkill/i);
 const stop=await fs.readFile(path.join(built.output,'Stop-Workbench.vbs'),'utf8');assert.equal(stop,vbs);assert.match(stop,/stop-workbench.vbs/);assert.match(stop,/ -Stop/);
 await fs.access(path.join(built.output,'停止 PaperEcho 浏览器工作台.lnk'));
 await fs.rename(built.output,path.join(root,'moved Windows folder'));await fs.access(path.join(root,'moved Windows folder/Open-Workbench.vbs'));
 const controller=await fs.readFile('desktop/browser-workbench/quiet-workbench.mjs','utf8');assert.match(controller,/process.platform === 'win32'/);assert.match(controller,/stop-.*record.nonce/);assert.doesNotMatch(controller,/process.kill\(record.pid,\s*[^0]/);

 assert.throws(()=>relativeShortcut('C:\\Developer\\icon.ico'),/ICON_CACHE_PATH_INVALID/);
});
test('real workbench already serves the formal SVG favicon; original Windows chain stays unchanged',async()=>{
 const html=await fs.readFile('workflow/tools/web/static/index.html','utf8');assert.match(html,/<link rel="icon" href="\/paperecho-mark.svg\?v=2.4" type="image\/svg\+xml">/);
 const cmd=await fs.readFile('desktop/browser-workbench/Start-Workbench.cmd','utf8'),ps=await fs.readFile('desktop/browser-workbench/Start-Workbench.ps1','utf8');assert.match(cmd,/pwsh.exe -NoLogo -NoProfile -File/);assert.match(ps,/& node \$entry/);assert.match(ps,/PSEdition -ne 'Core'/);
});
