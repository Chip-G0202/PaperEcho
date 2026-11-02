import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
const app=await fs.readFile(new URL('../tools/web/static/app.js',import.meta.url),'utf8');
const adapter=await fs.readFile(new URL('../../tests/helpers/ui-preview-adapter.mjs',import.meta.url),'utf8');
const baseline=execFileSync('git',['show','f40e66c:workflow/tools/web/static/app.js'],{encoding:'utf8'});
const home=source=>{const start=source.indexOf('async function home()');return source.slice(start,source.indexOf('\n}',start)+2)};
test('Overview preserves every existing statement, action, destination and summary',()=>{
 assert.equal(home(app).replace('  planCard.append(manualRunView());\n',''),home(baseline));
 for(const text of ["button('开始文献评级', () => navigate('feedback/rating/normal'))","button('提交研究方向反馈', () => navigate('feedback/research'))"])assert.ok(home(app).includes(text));
 assert.ok(app.includes("if (location.hash === '#run') { manualRunExpanded = true; location.replace('#home'); return; }"));
 assert.doesNotMatch(app,/run: runDetails|async function runDetails/);
});
test('preview clock advances, rejects duplicate starts, completes or fails without requests or persistence',()=>{
 const nodes=[];let now=Date.parse('2026-11-02T07:00:00Z'),tick,cleared=0;
 const doc={createElement:tag=>{const node={tag,value:'',setAttribute(){},append(child){if(tag==='select'&&!this.value)this.value=child.value}};nodes.push(node);return node}};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[now]))}static now(){return now}}
 const scope={settings:[{id:'translation.enabled',value:true}],window:{},document:doc,structuredClone,Date:Clock,setInterval:fn=>{tick=fn;return 1},clearInterval:()=>cleared++,fetch:()=>assert.fail('no API calls'),localStorage:new Proxy({},{get:()=>assert.fail('no persistent store')})};
 const code=adapter.slice(adapter.indexOf('  const runOutcome ='),adapter.indexOf("  const reset = document.createElement('button');"));vm.runInNewContext(code,scope);
 const mock=scope.window.paperEchoWorkflowPreview;assert.equal(mock.snapshot().status,'idle');
 let updates=0;const unsubscribe=mock.subscribe(()=>updates++);mock.start();const began=mock.snapshot().startedAt;mock.start();assert.equal(mock.snapshot().startedAt,began);assert.equal(mock.snapshot().status,'running');
 for(let i=0;i<40&&mock.snapshot().status==='running';i++){now+=1000;tick()}
 assert.equal(mock.snapshot().status,'success');assert.equal(mock.snapshot().stages.every(s=>['completed','skipped'].includes(s.status)),true);assert.equal(mock.snapshot().stages.filter(s=>s.status==='skipped').length,5);assert.equal(mock.snapshot().elapsed,18);assert.ok(mock.snapshot().products[0].path.startsWith('/模拟工作空间/'));
 const detached=mock.snapshot();detached.status='failed';assert.equal(mock.snapshot().status,'success');
 nodes.find(n=>n.tag==='select').value='failed';mock.start();for(let i=0;i<40&&mock.snapshot().status==='running';i++){now+=1000;tick()}
 const failed=mock.snapshot();assert.equal(failed.status,'failed');assert.equal(failed.stages.find(s=>s.id==='stage3_translation').id,'stage3_translation');assert.equal(failed.stages.find(s=>s.id==='stage3_translation').status,'failed');assert.equal(failed.stages.at(-1).status,'pending');assert.equal(failed.products.length,0);assert.match(failed.error,/模拟/);assert.ok(failed.endedAt);assert.equal(cleared,2);
 unsubscribe();const before=updates;mock.start();assert.equal(updates,before);
});
test('real-mode renderer is explicitly unavailable and cannot start any operation',()=>{
 const nodes=[],navigation=[];const el=(tag,text,className)=>{const node={tag,textContent:text,className,append(){},setAttribute(){},dataset:{},replaceChildren(){}};nodes.push(node);return node};
 const scope={window:{},el,button:(text,action)=>Object.assign(el('button',text),{action}),navigate:route=>navigation.push(route),disposeManualRunView:()=>{},manualRunExpanded:false,fetch:()=>assert.fail('no backend request')};
 const code=app.slice(app.indexOf('function workflowPreview()'),app.indexOf('function empty('));
 vm.runInNewContext(code+';manualRunView(true)',scope);
 const start=nodes.find(n=>n.tag==='button'&&n.textContent==='立即运行');assert.equal(start.disabled,true);start.action();assert.deepEqual(navigation,[]);assert.ok(nodes.some(n=>n.textContent==='待接入'));
 const toggle=nodes.find(n=>n.textContent==='展开详情');toggle.action();assert.equal(toggle.textContent,'收起详情');assert.equal(nodes.find(n=>n.className==='manual-run-details').hidden,false);toggle.action();assert.equal(nodes.find(n=>n.className==='manual-run-details').hidden,true);assert.deepEqual(navigation,[]);
 assert.doesNotMatch(code,/fetch\(|api\(|paperEchoLoginStartup|localStorage|sessionStorage/);
});
