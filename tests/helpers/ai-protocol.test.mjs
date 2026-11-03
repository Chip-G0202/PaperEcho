import test from 'node:test';
import assert from 'node:assert/strict';
import { capabilities, buildModelRequest, requestModelText, testModelConnection } from '../../workflow/tools/lib/model_transport.mjs';
const runtime = (values = {}) => ({ provider:'openai', endpoint:'https://provider.invalid/v1', model:'gpt-5.1', apiKey:'dummy-test-key', thinking:true, temperature:0.3, top_p:0.8, ...values });
const sse = events => new Response(events.map(event => 'data: '+ (typeof event === 'string' ? event : JSON.stringify(event)) +'\r\n\r\n').join(''));
test('OpenAI reasoning controls are model-specific; unknown compatible models receive no guessed fields', () => {
  const request = buildModelRequest(runtime(), 'dummy');
  assert.equal(request.endpoint, 'https://provider.invalid/v1/chat/completions'); assert.equal(request.body.reasoning_effort, 'low'); assert.equal(request.body.temperature, undefined);
  assert.equal(buildModelRequest(runtime({thinking:false}), 'dummy').body.reasoning_effort, 'low');
  assert.equal(buildModelRequest(runtime({model:'gpt-5',thinking:false}), 'dummy').body.reasoning_effort, 'low');
  assert.equal(buildModelRequest(runtime({provider:'compatible'}), 'dummy').body.reasoning_effort, undefined);
  const basic = buildModelRequest(runtime({provider:'compatible',model:'custom-model',thinking:false}), 'dummy');
  assert.equal(basic.body.reasoning_effort, undefined); assert.equal(basic.body.temperature, undefined);
  const sampling = buildModelRequest(runtime({model:'gpt-4.1',thinking:false}), 'dummy'); assert.equal(sampling.body.temperature, undefined); assert.equal(sampling.body.top_p, undefined);
});
test('Anthropic native auth, manual/adaptive thinking and version-specific sampling are legal', () => {
  const anthropic = runtime({provider:'anthropic', endpoint:'https://api.anthropic.com', model:'claude-sonnet-4-6'});
  const adaptive = buildModelRequest(anthropic, 'dummy');
  assert.equal(adaptive.endpoint,'https://api.anthropic.com/v1/messages'); assert.equal(adaptive.headers['x-api-key'],'dummy-test-key'); assert.equal(adaptive.headers['anthropic-version'],'2023-06-01');
  assert.deepEqual(adaptive.body.thinking,{type:'adaptive'}); assert.equal(adaptive.body.temperature,undefined); assert.equal(adaptive.headers.Authorization,undefined);
  const manual = buildModelRequest({...anthropic,model:'claude-opus-4-1-20250805'},'dummy'); assert.equal(manual.body.thinking.type,'enabled'); assert.ok(manual.body.thinking.budget_tokens < manual.body.max_tokens);
  const off = buildModelRequest({...anthropic,thinking:false},'dummy'); assert.deepEqual(off.body.thinking,{type:'adaptive'}); assert.equal(off.body.temperature,undefined);
  const next = buildModelRequest({...anthropic,thinking:false,api_version:'2026-10-21'},'dummy'); assert.equal(next.body.temperature,undefined); assert.equal(next.body.top_p,undefined);
  assert.equal(capabilities('anthropic','claude-opus-4-7').sampling,false); assert.deepEqual(buildModelRequest({...anthropic,model:'claude-opus-5-5',thinking:false},'dummy').body.thinking,{type:'adaptive'});
});
test('streaming requires normal completion, rejects truncation and handles native text deltas', async () => {
  const openai = [{choices:[{delta:{content:'OK'},finish_reason:null}]},{choices:[{delta:{},finish_reason:'stop'}]},'[DONE]'];
  assert.equal(await requestModelText(runtime(), 'dummy',{fetchImpl:async()=>sse(openai)}),'OK');
  await assert.rejects(requestModelText(runtime(),'dummy',{fetchImpl:async()=>sse([{choices:[{delta:{content:'partial'},finish_reason:'length'}]},'[DONE]'])}),/INCOMPLETE/);
  await assert.rejects(requestModelText(runtime(),'dummy',{fetchImpl:async()=>sse([openai[0]])}),/INCOMPLETE/);
  const native = runtime({provider:'anthropic',model:'claude-sonnet-4-6'});
  const events = [{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'do not expose'}},{type:'content_block_delta',delta:{type:'text_delta',text:'OK'}},{type:'message_delta',delta:{stop_reason:'end_turn'}},{type:'message_stop'}];
  assert.equal(await requestModelText(native,'dummy',{fetchImpl:async()=>sse(events)}),'OK');
  await assert.rejects(requestModelText(native,'dummy',{fetchImpl:async()=>sse([{type:'message_delta',delta:{stop_reason:'max_tokens'}},{type:'message_stop'}])}),/INCOMPLETE/);
});
test('active connection test is one bounded request with sanitized errors, never saved or retried', async () => {
  const input = {provider:'openai',endpoint:'https://provider.invalid/v1',model:'gpt-5.1',thinking:false,apiKey:'dummy-never-print'};
  let calls=0;
  const result = await testModelConnection(input,{fetchImpl:async(_url, request)=>{calls++; assert.equal(request.redirect,'error'); assert.equal(JSON.parse(request.body).max_completion_tokens,64); assert.equal(JSON.parse(request.body).reasoning_effort,'low'); return sse([{choices:[{delta:{content:'OK'},finish_reason:'stop'}]},'[DONE]']); }});
  assert.equal(calls,1); assert.equal(result.status,'callable');
  for(const [status,expected,code] of [[401,'authentication'],[404,'model','model_not_found'],[404,'model_or_address'],[429,'limited'],[400,'configuration']]) {
    calls=0; const value=await testModelConnection(input,{fetchImpl:async()=>{calls++; return new Response(JSON.stringify({error:{message:input.apiKey,code}}),{status});}});
    assert.equal(value.status,expected); assert.equal(calls,1); assert.equal(JSON.stringify(value).includes(input.apiKey),false);
  }
  assert.equal((await testModelConnection(input,{fetchImpl:async()=>{throw new Error(input.apiKey);}})).status,'network');
  assert.equal((await testModelConnection(input,{fetchImpl:async()=>sse(['[DONE]'])})).status,'protocol');
});

test('desktop source policy includes the shared browser/request capability module only', async () => {
  const { sourceAllowed } = await import('../../desktop/electron-poc/package-policy.mjs');
  assert.equal(sourceAllowed('workflow/tools/lib/ai_capabilities.cjs'), true);
  assert.equal(sourceAllowed('workflow/tools/lib/unrelated.cjs'), false);
});
