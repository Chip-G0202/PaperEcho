import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CHANNEL_IDS, renderChannelNotification } from '../tools/notification/channels.mjs';
import { buildRadarNotificationContent, buildWeeklyNotificationContent } from '../tools/stage5/notification_content.mjs';
import { formatRadarReport } from '../tools/stage5/radar_report.mjs';
import { renderWeeklyReport } from '../tools/stage5/report_summary.mjs';
import { readNotificationReceipt } from '../tools/stage5/email_receipt.mjs';
import { businessChannelsFixture } from './helpers/channel_fixture.mjs';
import { assertNotificationParity } from './helpers/notification_parity.mjs';
const texts={qq:p=>p.markdown.content,wechat:p=>p.messages.map(part=>part.content).join(''),feishu:p=>[p.content.post.zh_cn.title,...p.content.post.zh_cn.content.flat().map(node=>node.text)].join('\n'),wecom:p=>p.markdown.content};
const papers=['C','A','B','D','A'].map((grade,i)=>({id:`paper-${i}`,title:`Paper [${i}] end`,translatedTitle:`译文${i}`,final_grade:grade,recommendation_reason:`Reason ${i}`,journal:'Journal',year:'2026',source_type:'RSS',excluded:i===4}));
for (const [enabled, daily, weekly] of [[['email', 'qq'], true, true], [['email', 'qq'], true, false], [['qq'], false, true], [[], true, true]]) {
  for (const profile of ['radar', 'standard']) test(`global selection [${enabled}] Daily=${daily} Weekly=${weekly} reaches ${profile} Stage5`, async t => {
    const notificationsEnabled = profile === 'radar' ? daily : weekly;
    const f = await businessChannelsFixture(t, { profile, enabled, notificationsEnabled });
    assert.equal(f.initial.businessStatus, 'success'); assert.equal(f.initial.notificationStatus, 'completed');
    for (const id of CHANNEL_IDS) assert.equal(f.messages[id].length, notificationsEnabled && enabled.includes(id) ? 1 : 0);
    assert.equal(await fs.readFile(path.join(f.state, 'business.json'), 'utf8'), f.before);
    if (!notificationsEnabled || !enabled.length) assert.equal(f.coordinator.store.ledger.operations.some(op => op.type === 'notification'), false);
  });
}
for(const event of ['radar','weekly'])test(`all five ${event} renderers show the same canonical summary and keep papers internal`,()=>{
  const content=event==='radar'?buildRadarNotificationContent(papers,{runId:'one-event',audit:{profile:'radar',runId:'one-event',candidateCount:8,candidateGrades:{A:2,B:2,C:3,D:1}}}):buildWeeklyNotificationContent({runId:'one-event',counts:{created:3,grades:{A:1,B:1,C:1}},finishedAt:'2026-09-30'},{literatureItems:papers,overview:'Existing overview'});
  assert.deepEqual(content.items.map(item=>item.id),['paper-0','paper-1','paper-2']); const before=structuredClone(content);
  const outputs={email:(event==='radar'?formatRadarReport(content):renderWeeklyReport(content)).text,...Object.fromEntries(CHANNEL_IDS.filter(id=>id!=='email').map(id=>[id,texts[id](renderChannelNotification(id,content))]))};
  for(const text of Object.values(outputs)){ assertNotificationParity(content,text);assert.ok(!text.includes(papers[3].title));assert.ok(!text.includes(papers[4].title));for(const marker of event==='radar'?['本轮候选','8','本封即时推荐','3','全轮候选分级概况（8 篇）']:['本次新增','3','A','B','C','Existing overview'])assert.ok(text.includes(marker),marker); }assert.deepEqual(content,before);
  const long={...content,summaryView:{...content.summaryView,overview:'Overview '.repeat(1000)},items:Array.from({length:30},(_,i)=>({...content.items[0],id:`long-${i}`,title:`Long [${i}] end`,translatedTitle:'中'.repeat(35),reason:'reason '.repeat(30).trim()}))};
  for(const id of CHANNEL_IDS.filter(id=>id!=='email'))assertNotificationParity(long,texts[id](renderChannelNotification(id,long)),{bounded:true});
});
for(const profile of ['radar','standard'])for(const enabled of [[],...CHANNEL_IDS.map(id=>[id]),CHANNEL_IDS])test(`${profile} enabled [${enabled}] completes independently; accepted channels never repeat`,async t=>{
  const f=await businessChannelsFixture(t,{profile,enabled});assert.equal(f.initial.businessStatus,'success');assert.equal(f.initial.notificationStatus,'completed');for(const id of CHANNEL_IDS)assert.equal(f.messages[id].length,enabled.includes(id)?1:0);
  if(enabled.length){await f.resume();for(const id of CHANNEL_IDS)assert.equal(f.messages[id].length,enabled.includes(id)?1:0);const receipts=await Promise.all(f.coordinator.store.ledger.operations.filter(op=>op.type==='notification').map(op=>readNotificationReceipt(op.target.path)));for(const receipt of receipts)assert.deepEqual(receipt.recoveryData.content,receipts[0].recoveryData.content);}
  assert.equal(await fs.readFile(path.join(f.state,'business.json'),'utf8'),f.before);
});
for(const profile of ['radar','standard'])for(const failed of [...CHANNEL_IDS.map(id=>[id]),['qq','wechat','wecom']])test(`${profile} failed [${failed}] isolated from business and accepted channels on formal resume`,async t=>{
  const f=await businessChannelsFixture(t,{profile,failed});assert.equal(f.initial.businessStatus,'success');assert.equal(f.initial.notificationStatus,'incomplete');assert.equal((await f.resume()).status,'completed');for(const id of CHANNEL_IDS)assert.equal(f.messages[id].length,failed.includes(id)?2:1);await f.resume();for(const id of CHANNEL_IDS)assert.equal(f.messages[id].length,failed.includes(id)?2:1);
});
for(const profile of ['radar','standard'])for(const unknown of CHANNEL_IDS)test(`${profile} unknown ${unknown} fails closed on resume`,async t=>{
  const f=await businessChannelsFixture(t,{profile,unknown:[unknown]});assert.equal(f.initial.businessStatus,'success');assert.equal(f.initial.notificationStatus,'incomplete');assert.notEqual((await f.resume()).status,'completed');for(const id of CHANNEL_IDS)assert.equal(f.messages[id].length,1);
});
