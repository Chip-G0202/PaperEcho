import test from "node:test";
import assert from "node:assert/strict";
import { executeCli } from "../tools/lib/zotero_cli_executor.mjs";
import { ZoteroCliBackend } from "../tools/lib/zotero_cli_backend.mjs";
import { withZoteroLookupSignal } from "../tools/lib/zotero_lookup_scope.mjs";
import { enrichArchivePlanWithZoteroTitleMatches as enrich } from "../tools/maintenance/zotero_feedback_collection_corrections.mjs";
const wait = (ms) => new Promise(r=>setTimeout(r,ms));
const payload = (x) => ({ content: [{ text: JSON.stringify(x) }] });

test("independent CLI children preserve result/stdout/stderr under out-of-order completion", async () => {
  const run = (label, delay) => executeCli(process.execPath, ["-e", `setTimeout(()=>{console.error('${label}-stderr');console.log(JSON.stringify({label:'${label}'}))},${delay})`]);
  const [a,b] = await Promise.all([run('A',120),run('B',10)]);
  assert.equal(a.data.label,'A'); assert.equal(a.stderr,'A-stderr');
  assert.equal(b.data.label,'B'); assert.equal(b.stderr,'B-stderr');
});

test("aborting one read does not terminate the other read or share cancellation state", async () => {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(new Error('fixture_aborted')),150);
  try {
    const results = await Promise.allSettled([
      withZoteroLookupSignal(controller.signal,()=>executeCli(process.execPath,['-e',"setTimeout(()=>console.log('{}'),1000)"])),
      executeCli(process.execPath,['-e',"setTimeout(()=>console.log('{\"ok\":true}'),250)"]),
    ]);
    assert.equal(results[0].status,'rejected'); assert.match(results[0].reason.message,/fixture_aborted/);
    assert.equal(results[1].status,'fulfilled'); assert.equal(results[1].value.data.ok,true);
  } finally { clearTimeout(timer); }
});

test("one CLI timeout leaves a separate request result intact", async () => {
  const results=await Promise.allSettled([
    executeCli(process.execPath,['-e',"setInterval(()=>{},1000)"],{timeoutMs:150}),
    executeCli(process.execPath,['-e',"setTimeout(()=>console.log('{\"label\":\"survivor\"}'),250)"],{timeoutMs:2000}),
  ]);
  assert.equal(results[0].status,'rejected'); assert.match(results[0].reason.message,/timed out/);
  assert.equal(results[1].value.data.label,'survivor');
});

test("parallel read retries remain request-local and diagnostics count only the retry owner", async () => {
  const attempts = new Map(), retries = [0,0];
  const backend = new ZoteroCliBackend({ intervalMs:1, executeCli:async (_cmd,args)=>{
    const title=args[2]; const n=(attempts.get(title)||0)+1;attempts.set(title,n);await wait(title==='A'?10:2);
    if(title==='A'&&n===1)throw Error('503 transient');return {exitCode:0,data:[{key:title,title}]};
  } });
  const values=await Promise.all(['A','B'].map((title,i)=>withZoteroLookupSignal(new AbortController().signal,()=>backend.searchLibrary({title}),()=>retries[i]++)));
  assert.deepEqual(values.map(v=>v[0].key),['A','B']);assert.deepEqual(retries,[1,0]);
  assert.equal(backend.supportsConcurrentReads,true);
});

test("enrichment concurrency is CLI-only, capped at 2, keeps row order and deduplicates in-flight reads", async () => {
  let active=0,max=0,calls=0,progress;
  const call=async (_name,args)=>{calls++;active++;max=Math.max(max,active);await wait(args.title.endsWith('0')?15:3);active--;return payload([{key:args.title,title:args.title}]);};
  call.backendType='cli';call.readConcurrencySafe=true;
  const rows=Array.from({length:40},(_,i)=>({status:'needs_review',reason:'no_matching_literature_record',feedback:{english_title:`Title ${i%10}`,feedback:'keep'}}));
  await enrich(rows,{localLibraryIndex:{live_items:{}},mcpToolCall:call,readConcurrency:99,onProgress:p=>{progress=p;}});
  assert.equal(max,2);assert.equal(calls,10);assert.equal(progress.concurrency,2);
  assert.deepEqual(rows.map(r=>r.record.itemKey),Array.from({length:40},(_,i)=>`TITLE ${i%10}`));
  max=0;call.backendType='web_api';await enrich(rows.map(r=>({...r,record:{}})),{localLibraryIndex:{live_items:{}},mcpToolCall:call,readConcurrency:2});assert.equal(max,1);
});

test("concurrent enrichment abort dispatches at most 2 reads and cannot build mutation plan", async () => {
  let calls=0;
  const call=async()=>{calls++;await wait(120);return payload([]);};call.backendType='cli';call.readConcurrencySafe=true;
  const rows=Array.from({length:1000},(_,i)=>({status:'needs_review',reason:'no_matching_literature_record',feedback:{english_title:`Title ${i}`,feedback:'keep'}}));
  await assert.rejects(enrich(rows,{localLibraryIndex:{live_items:{}},mcpToolCall:call,timeoutMs:50}),{status:'timed_out'});
  await wait(150);assert.equal(calls,2);assert.equal(rows.length,1000);assert.equal(rows.filter(r=>r.record).length,0);
});
