import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { renderWechatNotification, WECHAT_PART_BYTES } from '../tools/notification/wechat_renderer.mjs';
import { splitUtf8Paragraphs } from '../tools/notification/text_presentation.mjs';
import { createWxpusherTransport } from '../tools/notification/wxpusher_transport.mjs';
import { buildRadarNotificationContent, buildWeeklyNotificationContent } from '../tools/stage5/notification_content.mjs';
import { deliverReliableNotification } from '../tools/notification/delivery.mjs';
import { readNotificationReceipt } from '../tools/stage5/email_receipt.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
import { migrateApplicationConfig } from '../tools/lib/application_config_migration.mjs';
import { validateRunnerConfigObject } from '../tools/runner/config_loader.mjs';
import { businessChannelsFixture } from './helpers/channel_fixture.mjs';
import { assertNotificationParity } from './helpers/notification_parity.mjs';

const uid = 'UID_' + 'generatedFixture'; const appToken = 'AT_' + 'generatedSecret';
const papers = ['C','A','B'].map((grade,index) => ({ id: `item-${index}`, title: `Unique English ${index}`, translatedTitle: `中文${index}`, final_grade: grade, semantic_reason: `Reason ${index}`, journal: 'Journal', source_type: 'RSS', year: '2026' }));
for (const kind of ['radar','weekly']) test(`WeChat ${kind} canonical semantics/prefix, text not Email HTML`, () => {
  const content = kind === 'radar' ? buildRadarNotificationContent(papers, { audit: { candidateCount: 3 } }) : buildWeeklyNotificationContent({ runId: 'weekly', counts: { created: 3 } }, { literatureItems: papers, overview: 'Canonical summary' });
  const payload = renderWechatNotification(content); assertNotificationParity(content, payload.messages.map(item => item.content).join(''));
  for (const message of payload.messages) { assert.equal(message.contentType, 1); assert.ok(Buffer.byteLength(message.content) <= WECHAT_PART_BYTES); assert.ok(!message.content.includes('<html')); }
});
test('UTF-8 chunks preserve all scalars/graphemes and prefer paragraph boundaries', () => {
  const text = ('中文👩🏽‍🔬e\u0301\n').repeat(2500); const chunks = splitUtf8Paragraphs(text, 8000); assert.ok(chunks.length > 1); assert.equal(chunks.join(''), text);
  for (const chunk of chunks) { assert.ok(Buffer.byteLength(chunk) <= 8000); assert.ok(!/\p{Surrogate}/u.test(chunk)); }
  assert.deepEqual(splitUtf8Paragraphs('1234\n5678\n', 6), ['1234\n', '5678\n']);
});
test('WxPusher fixed POST request, accepted record metadata excludes UID/token/body', async () => {
  const calls = []; const send = createWxpusherTransport({ uid, appToken }, { fetchImpl: async (url,input) => { calls.push({url,input}); return { status: 200, json: async () => ({ code: 1000, success: true, data: [{ uid, code: 1000, sendRecordId: 42 }] }) }; } });
  const result = await send({ contentType: 1, content: 'Hello 中文', summary: 'PaperEcho' }); assert.equal(result.accepted,true); assert.deepEqual(result.sendRecordIds,[42]); assert.ok(!JSON.stringify(result).includes(uid)); assert.ok(!JSON.stringify(result).includes(appToken));
  assert.equal(calls[0].url,'https://wxpusher.zjiecode.com/api/send/message'); assert.equal(calls[0].input.redirect,'error'); assert.deepEqual(JSON.parse(calls[0].input.body), { appToken, content:'Hello 中文', contentType:1, summary:'PaperEcho', uids:[uid], verifyPayType:0 });
  const before = calls.length; assert.equal((await send({ contentType: 1, content: 'x'.repeat(8001), summary:'x' })).accepted,false); assert.equal(calls.length,before);
});
for (const scenario of ['rejected','destination','malformed','timeout','server']) test(`WxPusher ${scenario} is normalized without private response or blind retry`, async () => {
  let calls=0; const send=createWxpusherTransport({uid,appToken},{fetchImpl:async()=>{calls++; if(scenario==='timeout') throw new Error(appToken); return {status:scenario==='server'?500:200,json:async()=>scenario==='malformed'?null:scenario==='rejected'?{code:1001}:{code:1000,success:true,data:[{uid,code:scenario==='destination'?1001:1000,sendRecordId:42}]}};}});
  const result=await send({contentType:1,content:'x',summary:'x'}); assert.equal(result.accepted,['rejected','destination'].includes(scenario)?false:undefined); assert.equal(calls,1); assert.ok(!JSON.stringify(result).includes(appToken));
});
test('multipart receipt retries only failed/unattempted parts and never repeats accepted parts; unknown is held', async t => {
  const f=await businessChannelsFixture(t,{enabled:[]}); const receiptPath=path.join(f.state,'parts.json'); const payload={messages:[{content:'one'},{content:'two'},{content:'three'}]}; const calls=[];
  const args={receiptPath,notificationType:'channel_test',runId:'parts',businessSubject:'parts',eventEpoch:'parts',payload,recipient:uid,channel:'wechat'};
  const first=await deliverReliableNotification({...args,transport:async msg=>{calls.push(msg.content);return {accepted:msg.content!=='two',provider:'wxpusher',sendRecordIds:[42]};}}); assert.equal(first.status,'failed'); assert.deepEqual(calls,['one','two']);
  assert.equal((await deliverReliableNotification({...args,transport:async msg=>{calls.push(msg.content);return {accepted:true,provider:'wxpusher',sendRecordIds:[43]};}})).status,'accepted'); assert.deepEqual(calls,['one','two','two','three']);
  await deliverReliableNotification({...args,transport:async()=>assert.fail('duplicate')});
  const receipt=await readNotificationReceipt(receiptPath); assert.equal(receipt.parts[0].provider.sendRecordIds[0],42); assert.ok(!JSON.stringify(receipt).includes(uid));
  const uncertain={...args,receiptPath:path.join(f.state,'unknown.json')}; await deliverReliableNotification({...uncertain,transport:async()=>({})}); assert.equal((await deliverReliableNotification({...uncertain,transport:async()=>assert.fail('unknown resend')})).status,'unknown');
});
test('v5 migration and Settings isolate appToken/UID, disabled test accepted once without enabling', async t => {
  const f=await businessChannelsFixture(t,{enabled:[]}); const configPath=path.join(f.root,'config/paperecho.config.json'); await fs.mkdir(path.dirname(configPath),{recursive:true});
  const old={schemaVersion:5,mode:'desktop',common:{email:{enabled:false},notifications:{channels:{qq:{enabled:true,appId:'existing'}}}}}; await fs.writeFile(configPath,JSON.stringify(old));
  await migrateApplicationConfig({root:f.root}); const next=JSON.parse(await fs.readFile(configPath)); assert.equal(next.schemaVersion,6); assert.deepEqual(next.common.notifications.channels.qq,old.common.notifications.channels.qq); for(const id of ['wechat','feishu','wecom']) assert.deepEqual(next.common.notifications.channels[id],{enabled:false});
  const env={WXPUSHER_APP_TOKEN:appToken}; const reviewRoot=path.join(f.root,'review_results'); const context={mode:'desktop',env,configPath,reviewRoot,researchRoot:reviewRoot,runRoot:path.join(reviewRoot,'runs')}; let sends=0;
  const services=createControlServices({root:f.root,context,env,channelTransports:{wechat:async()=>{sends++;return {accepted:true,provider:'wxpusher',sendRecordIds:[123]};}}});
  assert.equal((await services.notifications.settings()).channels.find(item=>item.id==='wechat').readiness,'incomplete'); await services.config.update('wechat.uid',uid);
  const settings=await services.config.list(); assert.ok(!JSON.stringify(settings).includes(uid)); assert.ok(!JSON.stringify(await services.notifications.settings()).includes(appToken));
  assert.equal((await services.notifications.test({channel:'wechat',requestId:'fixture-test'})).status,'success'); await services.notifications.test({channel:'wechat',requestId:'fixture-test'}); assert.equal(sends,1); assert.equal((await services.notifications.settings()).channels.find(item=>item.id==='wechat').enabled,false); assert.equal(services.secrets.redact(appToken),'[REDACTED]');
  for(const value of [{appToken:'x'},{uid:'nickname'},{remoteInteraction:{enabled:true}}]) assert.throws(()=>validateRunnerConfigObject({schemaVersion:6,common:{notifications:{channels:{wechat:value}}}}));
});
for (const profile of ['radar','standard']) for (const failed of [['wechat'],['email','qq']]) test(`${profile} Email/QQ/WeChat partial success and formal channel-only resume (${failed})`,async t=>{
  const f=await businessChannelsFixture(t,{profile,enabled:['email','qq','wechat'],failed}); assert.equal(f.initial.businessStatus,'success'); assert.equal(f.initial.notificationStatus,'incomplete');
  assert.equal((await f.resume()).status,'completed'); for(const id of ['email','qq','wechat']) assert.equal(f.messages[id].length,failed.includes(id)?2:1); const counts=Object.values(f.messages).map(items=>items.length); await f.resume(); assert.deepEqual(Object.values(f.messages).map(items=>items.length),counts); assert.equal(await fs.readFile(path.join(f.state,'business.json'),'utf8'),f.before);
});
