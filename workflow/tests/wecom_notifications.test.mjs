import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderWecomNotification } from '../tools/notification/wecom_renderer.mjs';
import { createWecomTransport, validWecomWebhook } from '../tools/notification/wecom_transport.mjs';
import { buildRadarNotificationContent, buildWeeklyNotificationContent, buildTestNotificationContent } from '../tools/stage5/notification_content.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { businessChannelsFixture } from './helpers/channel_fixture.mjs';
import { assertNotificationParity } from './helpers/notification_parity.mjs';
const webhookUrl=new URL('/cgi-bin/webhook/send?key='+'generated-key','https://qyapi.weixin.qq.com').href;
const testContent=()=>buildTestNotificationContent({generatedAt:'2026-09-30T00:00:00Z'});
const papers=['C','A','B'].map((grade,index)=>({id:`item-${index}`,title:`Unique English ${index}`,translatedTitle:`中文${index}`,final_grade:grade,semantic_reason:`Reason ${index}`,journal:'Journal',source_type:'RSS',year:'2026'}));
for(const kind of ['radar','weekly'])test(`WeCom ${kind} text preserves canonical semantics, 1800-byte prefix budget`,()=>{
  const content=kind==='radar'?buildRadarNotificationContent(papers,{audit:{candidateCount:3}}):buildWeeklyNotificationContent({runId:'weekly',counts:{created:3}},{literatureItems:papers,overview:'Canonical summary'});
  const payload=renderWecomNotification(content); assert.equal(payload.msgtype,'text'); assertNotificationParity(content,payload.text.content); assert.ok(Buffer.byteLength(payload.text.content)<=1800);
  const long={...content,items:Array.from({length:30},(_,i)=>({...content.items[0],title:`Long [${i}] end`,id:`long-${i}`,translatedTitle:'中'.repeat(40),reason:'Reason'.repeat(20)}))}; const shortened=renderWecomNotification(long);
  assertNotificationParity(long,shortened.text.content,{prefix:true}); assert.match(shortened.text.content,/另有 \d+ 项未展开/); assert.ok(Buffer.byteLength(shortened.text.content)<=1800);
});
test('WeCom strict official URL rejects SSRF, query pollution and altered path before sending',async()=>{
  assert.equal(validWecomWebhook(webhookUrl),true);let calls=0;
  for(const url of [webhookUrl.replace('https:','http:'),webhookUrl.replace('qyapi.weixin.qq.com','127.0.0.1'),webhookUrl.replace('qyapi.weixin.qq.com','qyapi.weixin.qq.com.evil.test'),webhookUrl.replace('qyapi.weixin.qq.com','user@qyapi.weixin.qq.com'),webhookUrl.replace('qyapi.weixin.qq.com','qyapi.weixin.qq.com:443'),webhookUrl+'&key=other',webhookUrl+'&url=anything',webhookUrl+'#x',webhookUrl.replace('/send?','/upload_media?'),webhookUrl.replace('generated-key','%67enerated-key'),webhookUrl.replace('/cgi-bin/','/cgi-bin/../cgi-bin/')]){
    const result=await createWecomTransport({webhookUrl:url},{fetchImpl:async()=>{calls++;}})(renderWecomNotification(testContent()));assert.equal(result.accepted,false);
  }assert.equal(calls,0);
});
test('WeCom request is plain text without mentions or secret echo; byte boundary checked before send',async()=>{
  const calls=[];const send=createWecomTransport({webhookUrl},{fetchImpl:async(url,input)=>{calls.push({url,input});return{status:200,json:async()=>({errcode:0,errmsg:webhookUrl})};}});
  const payload=renderWecomNotification(testContent());assert.equal((await send({...payload,to:'hash',messageId:'id',mentioned_list:['@all']})).accepted,true);assert.deepEqual(JSON.parse(calls[0].input.body),payload);assert.equal(calls[0].input.redirect,'error');
  assert.equal((await send({msgtype:'text',text:{content:'中'.repeat(600)}})).accepted,true);assert.equal((await send({msgtype:'text',text:{content:'中'.repeat(601)}})).accepted,false);assert.equal(calls.length,2);
});
for(const [name,status,data,accepted]of [['rejected',200,{errcode:93000,errmsg:'secret'},false],['malformed',200,{code:0},undefined],['server',500,{errcode:0},undefined],['redirect',302,{errcode:0},undefined],['rate',429,{},false],['timeout',null,null,undefined]])test(`WeCom ${name} normalized and no blind retry`,async()=>{
  let calls=0;const out=await createWecomTransport({webhookUrl},{fetchImpl:async()=>{calls++;if(status===null)throw new Error(webhookUrl);return{status,json:async()=>data};}})(renderWecomNotification(testContent()));assert.equal(out.accepted,accepted);assert.equal(calls,1);assert.ok(!JSON.stringify(out).includes('secret'));assert.ok(!JSON.stringify(out).includes(webhookUrl));
});
test('WeCom Settings supports safe credentials and disabled explicit test without enabling',async t=>{
  const f=await businessChannelsFixture(t,{enabled:[]});const configPath=path.join(f.root,'config/paperecho.config.json');await fs.mkdir(path.dirname(configPath),{recursive:true});await fs.writeFile(configPath,JSON.stringify({schemaVersion:6,mode:'desktop',common:{email:{enabled:false},notifications:{channels:{wecom:{enabled:false}}}}}));const env={};const reviewRoot=path.join(f.root,'review_results');let calls=0;
  const services=createControlServices({root:f.root,context:{mode:'desktop',env,configPath,reviewRoot,researchRoot:reviewRoot,runRoot:path.join(reviewRoot,'runs')},env,channelTransports:{wecom:async()=>{calls++;return{accepted:true};}}});const state=async()=>(await services.notifications.settings()).channels.find(item=>item.id==='wecom');assert.equal((await state()).readiness,'incomplete');assert.equal((await state()).displayName,'企业微信群机器人');
  await services.secrets.replace('WECOM_WEBHOOK_URL',webhookUrl);assert.equal((await state()).readiness,'configured');assert.ok(!JSON.stringify(await services.notifications.settings()).includes(webhookUrl));assert.equal((await services.notifications.test({channel:'wecom',requestId:'fixture'})).status,'success');await services.notifications.test({channel:'wecom',requestId:'fixture'});assert.equal(calls,1);assert.equal((await state()).enabled,false);
  await services.secrets.clear('WECOM_WEBHOOK_URL');assert.equal((await state()).readiness,'incomplete');
});
for(const profile of ['radar','standard'])for(const failed of [['wecom'],['email','qq','wechat','feishu']])test(`${profile} WeCom partial success and channel-only formal resume (${failed})`,async t=>{
  const ids=['email','qq','wechat','feishu','wecom'];const f=await businessChannelsFixture(t,{profile,enabled:ids,failed});assert.equal(f.initial.businessStatus,'success');assert.equal(f.initial.notificationStatus,'incomplete');assert.equal((await f.resume()).status,'completed');for(const id of ids)assert.equal(f.messages[id].length,failed.includes(id)?2:1);const counts=ids.map(id=>f.messages[id].length);await f.resume();assert.deepEqual(ids.map(id=>f.messages[id].length),counts);assert.equal(await fs.readFile(path.join(f.state,'business.json'),'utf8'),f.before);
});
