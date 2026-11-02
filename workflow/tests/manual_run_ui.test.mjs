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
test('live controller only reads on open, starts once on explicit click, restores state and keeps disconnect unknown',async()=>{
 let listener,timer,posts=0,reads=0;
 const state={status:'idle',stages:[],products:[],elapsed:0};
 const scope={api:async(_url,body)=>{if(body){posts++;return {...state,status:'running'}}reads++;return state},setTimeout:fn=>{timer=fn;return 1},clearTimeout:()=>{}};
 const code=app.slice(app.indexOf('function liveRunController()'),app.indexOf('function manualRunView()'));
 vm.runInNewContext(code+';globalThis.controller=liveRunController()',scope);
 const controller=scope.controller;let updates=0;const stop=controller.subscribe(()=>updates++);
 await new Promise(r=>setImmediate(r));assert.equal(reads,1);assert.equal(posts,0);assert.equal(controller.snapshot().status,'idle');
 await Promise.all([controller.start(),controller.start()]);assert.equal(posts,1);assert.equal(controller.snapshot().status,'running');
 state.status='success';state.elapsed=7;await timer();assert.equal(controller.snapshot().status,'success');assert.equal(controller.snapshot().elapsed,7);
 scope.api=async()=>{throw Error('secret-must-not-leak')};await controller.start();assert.equal(controller.snapshot().status,'unknown');assert.ok(!controller.snapshot().error.includes('secret'));assert.equal(posts,1);
 stop();assert.ok(updates>0);
 assert.ok(app.includes("const controller = preview || liveRunController()"));
 assert.doesNotMatch(code,/localStorage|sessionStorage|setInterval/);
});
