import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { renderFeishuNotification } from '../tools/notification/feishu_renderer.mjs';
import { createFeishuTransport, validFeishuWebhook } from '../tools/notification/feishu_transport.mjs';
import { buildRadarNotificationContent, buildWeeklyNotificationContent, buildTestNotificationContent } from '../tools/stage5/notification_content.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { businessChannelsFixture } from './helpers/channel_fixture.mjs';
import { assertNotificationParity } from './helpers/notification_parity.mjs';
const webhookUrl = new URL('/open-apis/bot/v2/hook/' + '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12), 'https://open.feishu.cn').href;
const papers = ['C','A','B'].map((grade,index) => ({ id:`item-${index}`,title:`Unique English ${index}`,translatedTitle:`中文${index}`,final_grade:grade,semantic_reason:`Reason ${index}`,journal:'Journal',source_type:'RSS',year:'2026' }));
for (const kind of ['radar','weekly']) test(`Feishu ${kind} native post preserves summary semantics`, () => {
  const content=kind==='radar'?buildRadarNotificationContent(papers,{audit:{candidateCount:3}}):buildWeeklyNotificationContent({runId:'weekly',counts:{created:3}},{literatureItems:papers,overview:'Canonical summary'});
  const payload=renderFeishuNotification(content); assert.equal(payload.msg_type,'post'); assertNotificationParity(content,[payload.content.post.zh_cn.title,...payload.content.post.zh_cn.content.flat().map(node=>node.text)].join('\n'));
  const long={...content,summaryView:{...content.summaryView,overview:'Long overview '.repeat(1000)},items:Array.from({length:50},(_,i)=>({...content.items[0],id:`long-${i}`,title:`Long [${i}] end`,translatedTitle:'中'.repeat(250),reason:'Reason'.repeat(150)}))};
  const short=renderFeishuNotification(long); assert.ok(Buffer.byteLength(JSON.stringify(short))<16384); assertNotificationParity(long,[short.content.post.zh_cn.title,...short.content.post.zh_cn.content.flat().map(node=>node.text)].join('\n'),{bounded:true});
});
test('Feishu official v2 URL rejects SSRF, altered paths and normalization before network',async()=>{
  assert.equal(validFeishuWebhook(webhookUrl),true); let calls=0;
  for(const url of [webhookUrl.replace('https:','http:'),webhookUrl.replace('open.feishu.cn','127.0.0.1'),webhookUrl.replace('open.feishu.cn','open.feishu.cn.evil.test'),webhookUrl+'?key=x',webhookUrl+'#x',webhookUrl.replace('open.feishu.cn','user@open.feishu.cn'),webhookUrl.replace('open.feishu.cn','open.feishu.cn:443'),webhookUrl.replace('/v2/','/v1/'),webhookUrl.replace('/bot/','/bot/../bot/')]){
    const out=await createFeishuTransport({webhookUrl:url},{fetchImpl:async()=>{calls++;}})(renderFeishuNotification(buildTestNotificationContent({generatedAt:"2026-09-30T00:00:00Z"}))); assert.equal(out.accepted,false);
  } assert.equal(calls,0);
});
test('Feishu optional signing uses official empty-message HMAC; request excludes recipient/receipt',async()=>{
  const calls=[]; const signingSecret='generated-secret'; const clock=()=>new Date('2026-09-30T00:00:00Z'); const payload=renderFeishuNotification(buildTestNotificationContent({generatedAt:"2026-09-30T00:00:00Z"}));
  for(const secret of ['',signingSecret]){
    const result=await createFeishuTransport({webhookUrl,signingSecret:secret},{clock,fetchImpl:async(url,input)=>{calls.push({url,input});return{status:200,json:async()=>({code:0,msg:'private body'})};}})({...payload,to:'hashed-recipient',messageId:'receipt'}); assert.equal(result.accepted,true); assert.ok(!JSON.stringify(result).includes(webhookUrl));
  }
  const unsigned=JSON.parse(calls[0].input.body); assert.deepEqual(unsigned,payload); assert.equal(calls[0].input.redirect,'error');
  const signed=JSON.parse(calls[1].input.body); assert.equal(signed.timestamp,String(clock().getTime()/1000)); assert.equal(signed.sign,createHmac('sha256',`${signed.timestamp}\n${signingSecret}`).update('').digest('base64')); assert.equal(signed.to,undefined);
});
for(const [name,status,data,accepted] of [['rejected',200,{code:19021},false],['malformed',200,{},undefined],['server',500,{code:0},undefined],['redirect',302,{code:0},undefined],['rate',429,{},false],['timeout',null,null,undefined]]) test(`Feishu ${name} stays safe and does not retry`,async()=>{
  let calls=0; const result=await createFeishuTransport({webhookUrl},{fetchImpl:async()=>{calls++;if(status===null)throw new Error(webhookUrl);return{status,json:async()=>data};}})(renderFeishuNotification(buildTestNotificationContent({generatedAt:"2026-09-30T00:00:00Z"}))); assert.equal(result.accepted,accepted); assert.equal(calls,1); assert.ok(!JSON.stringify(result).includes(webhookUrl));
});
test('Feishu Settings readiness, Replace/Clear redaction, disabled explicit test and recent outcome',async t=>{
  const f=await businessChannelsFixture(t,{enabled:[]}); const configPath=path.join(f.root,'config/paperecho.config.json'); await fs.mkdir(path.dirname(configPath),{recursive:true}); await fs.writeFile(configPath,JSON.stringify({schemaVersion:6,mode:'desktop',common:{email:{enabled:false},notifications:{channels:{feishu:{enabled:false}}}}}));
  const env={}; const reviewRoot=path.join(f.root,'review_results'); let sends=0; const services=createControlServices({root:f.root,context:{mode:'desktop',env,configPath,reviewRoot,researchRoot:reviewRoot,runRoot:path.join(reviewRoot,'runs')},env,channelTransports:{feishu:async()=>{sends++;return{accepted:true};}}});
  const state=async()=>(await services.notifications.settings()).channels.find(item=>item.id==='feishu'); assert.equal((await state()).readiness,'incomplete');
  await services.secrets.replace('FEISHU_WEBHOOK_URL',webhookUrl); assert.equal((await state()).readiness,'configured'); await services.secrets.replace('FEISHU_SIGNING_SECRET','generated-signing'); assert.ok(!JSON.stringify(await state()).includes(webhookUrl));
  assert.equal((await services.notifications.test({channel:'feishu',requestId:'fixture'})).status,'success'); await services.notifications.test({channel:'feishu',requestId:'fixture'}); assert.equal(sends,1); assert.equal((await state()).enabled,false); assert.equal((await state()).lastDelivery.status,'success');
  await services.secrets.clear('FEISHU_WEBHOOK_URL'); assert.equal((await state()).readiness,'incomplete');
});
for(const profile of ['radar','standard']) for(const failed of [['feishu'],['email','qq','wechat']]) test(`${profile} Feishu partial success resumes only failed channels (${failed})`,async t=>{
  const ids=['email','qq','wechat','feishu']; const f=await businessChannelsFixture(t,{profile,enabled:ids,failed}); assert.equal(f.initial.businessStatus,'success'); assert.equal(f.initial.notificationStatus,'incomplete'); assert.equal((await f.resume()).status,'completed');
  for(const id of ids)assert.equal(f.messages[id].length,failed.includes(id)?2:1); const counts=ids.map(id=>f.messages[id].length); await f.resume(); assert.deepEqual(ids.map(id=>f.messages[id].length),counts); assert.equal(await fs.readFile(path.join(f.state,'business.json'),'utf8'),f.before);
});
