import test from 'node:test';
import { visibleSummary } from './helpers/notification_parity.mjs';
import assert from 'node:assert/strict';
import { buildRadarNotificationContent, buildWeeklyNotificationContent } from '../tools/stage5/notification_content.mjs';
import { formatRadarReport } from '../tools/stage5/radar_report.mjs';
import { renderWeeklyReport } from '../tools/stage5/report_summary.mjs';
import { CHANNEL_IDS, renderChannelNotification } from '../tools/notification/channels.mjs';
import { createWxpusherTransport } from '../tools/notification/wxpusher_transport.mjs';
import { createWecomTransport } from '../tools/notification/wecom_transport.mjs';

const papers = [{ title: 'ARTICLE_CANARY', translatedTitle: 'TRANSLATION_CANARY', recommendation_reason: 'REASON_CANARY', doi: '10.fixture/DOI_CANARY', final_grade: 'B' }];
function render(content, channel) {
  return channel === 'email' ? (content.eventType === 'radar_completed' ? formatRadarReport(content) : renderWeeklyReport(content)) : renderChannelNotification(channel, content);
}
function visible(channel, payload) {
  return channel === 'email' ? payload.text : channel === 'qq' ? visibleSummary(payload.markdown.content) : channel === 'wechat' ? payload.messages.map(part => part.content).join('') : channel === 'feishu' ? [payload.content.post.zh_cn.title, ...payload.content.post.zh_cn.content.flat().map(node => node.text)].join('\n') : payload.markdown.content.replace(/\\([*_\[\]#!|.\-])/g, '$1');
}
for (const kind of ['radar', 'weekly']) test(`${kind} all five notifications show summary, counts, date and warnings without article details`, () => {
  const content = kind === 'radar' ? buildRadarNotificationContent(papers, { runId: 'radar-summary', audit: { profile: 'radar', runId: 'radar-summary', generatedAt: '2026-10-02T00:00:00Z', candidateCount: 8, candidateGrades: { A: 1, B: 2, C: 3, D: 2 }, overview: 'SUMMARY_CANARY', warnings: ['WARNING_CANARY'] } }) : buildWeeklyNotificationContent({ finishedAt: '2026-10-02T00:00:00Z', counts: { created: 20, grades: { A: 0, B: 3, C: 17, D: 0 } }, warnings: ['WARNING_CANARY'], notificationStatus: 'incomplete' }, { overview: 'SUMMARY_CANARY', literatureItems: papers });
  content.secret = 'SECRET_CANARY'; content.credentials = { apiKey: 'SECRET_CANARY' };
  const before = structuredClone(content);
  for (const channel of CHANNEL_IDS) {
    const payload = render(content, channel); const text = visible(channel, payload);
    for (const marker of ['PaperEcho', '2026-10-02', '分级', '本轮', 'SUMMARY_CANARY', 'WARNING_CANARY']) assert.ok(text.includes(marker), `${channel}: ${marker}`);
    assert.doesNotMatch(JSON.stringify(payload), /ARTICLE_CANARY|TRANSLATION_CANARY|REASON_CANARY|DOI_CANARY|SECRET_CANARY|级文献|项未展开/);
    if (kind === 'weekly') assert.match(text, /通知尚未完成/);
  }
  assert.deepEqual(content, before);
  assert.equal(content.items[0].title, 'ARTICLE_CANARY');
});
test('canonical owner projects honest Radar counts and Weekly zero/missing counts', () => {
  const radar = buildRadarNotificationContent(papers);
  assert.equal(radar.summaryView.totalLabel, '本封即时推荐'); // Radar does not perform Zotero writeback.
  assert.equal(radar.summaryView.total, 1);
  assert.deepEqual(radar.summaryView.grades, { A: null, B: null, C: null, D: null });
  const zero = buildWeeklyNotificationContent({ counts: { created: 0, grades: { A: 0, B: 0, C: 0, D: 0 } } });
  for (const channel of CHANNEL_IDS) { const payload = render(zero, channel); assert.match(visible(channel, payload), /0 篇/); assert.doesNotMatch(JSON.stringify(payload), /undefined|null|ARTICLE/); }
  assert.equal(buildWeeklyNotificationContent({}).summaryView.total, null);
});
test('HTML and Markdown escape overview punctuation; native post/text treat it literally', () => {
  const value = '<script>& * _ [x](url) # heading\n> quote';
  const content = buildWeeklyNotificationContent({ counts: { created: 1 }, warnings: ['<@all>'] }, { overview: value });
  for (const html of [renderWeeklyReport(content).html, renderChannelNotification('wechat', content).messages[0].content]) { assert.doesNotMatch(html, /<script>|<@all>/); assert.match(html, /&lt;script&gt;&amp;/); }
  const markdown = renderChannelNotification('wecom', content).markdown.content;
  assert.match(markdown, /\\\* \\_ \\\[x\\\]/); assert.doesNotMatch(markdown, /<script>|<@all>|\n> quote/);
  assert.match(renderChannelNotification('qq', content).markdown.content, /&lt;script&gt;&amp;/);
  assert.ok(renderChannelNotification('feishu', content).content.post.zh_cn.content.flat().some(node => node.text.includes(value)));
});
test('long Unicode overview keeps warning and stays within every channel budget', () => {
  for (const value of ['👩🏽‍🔬', 'e\u0301', '<>&*_[]']) {
    const content = buildWeeklyNotificationContent({ counts: { created: 20 }, warnings: ['IMPORTANT_WARNING'] }, { overview: value.repeat(10000) });
    const qq = renderChannelNotification('qq', content); assert.ok(Buffer.byteLength(qq.markdown.content) <= 5000); assert.match(visibleSummary(qq.markdown.content), /IMPORTANT_WARNING/);
    const wx = renderChannelNotification('wechat', content); for (const part of wx.messages) { assert.equal(part.contentType, 2); assert.ok(Buffer.byteLength(part.content) <= 8000); } assert.match(wx.messages.map(part => part.content).join(''), /IMPORTANT_WARNING/);
    const feishu = renderChannelNotification('feishu', content); assert.ok(Buffer.byteLength(JSON.stringify(feishu)) < 16384);
    const wecom = renderChannelNotification('wecom', content); assert.ok(Buffer.byteLength(wecom.markdown.content) <= 1800); assert.match(visible('wecom', wecom), /IMPORTANT_WARNING/);
    for (const channel of CHANNEL_IDS) assert.doesNotMatch(JSON.stringify(render(content, channel)), /\\ud[89ab][0-9a-f]{2}(?!\\ud[cdef])/i);
  }
});
test('WxPusher HTML and WeCom Markdown are forwarded with exact provider types, no extra caller fields', async () => {
  const content = buildWeeklyNotificationContent({ counts: { created: 1 } }, { overview: 'Safe summary' });
  const requests = [];
  const wx = createWxpusherTransport({ appToken: 'AT_generated', uid: 'UID_generated' }, { fetchImpl: async (_, input) => { requests.push(JSON.parse(input.body)); return { status: 200, json: async () => ({ code: 1000, success: true, data: [{ uid: 'UID_generated', code: 1000, sendRecordId: 1 }] }) }; } });
  const part = renderChannelNotification('wechat', content).messages[0]; assert.equal((await wx({ ...part, secret: 'DO_NOT_FORWARD' })).accepted, true); assert.equal(requests[0].contentType, 2); assert.equal(requests[0].content, part.content);
  const wecom = createWecomTransport({ webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=generated-key' }, { fetchImpl: async (_, input) => { requests.push(JSON.parse(input.body)); return { status: 200, json: async () => ({ errcode: 0 }) }; } });
  const payload = renderChannelNotification('wecom', content); assert.equal((await wecom({ ...payload, secret: 'DO_NOT_FORWARD' })).accepted, true); assert.deepEqual(requests[1], payload); assert.doesNotMatch(JSON.stringify(requests), /DO_NOT_FORWARD/);
});

for (const status of ['partial', 'failed', 'incomplete']) test(status + ' workflow keeps actual attention and notification/recovery alerts in all channels', () => {
  const content = buildWeeklyNotificationContent({ status, counts: { created: 1 }, notificationStatus: 'unknown', recoveryState: 'pending', attention: { humanReviewCount: 2, pendingRuleCount: 3 }, warnings: ['Workflow warning'] }, { overview: 'Partial summary' });
  for (const channel of CHANNEL_IDS) {
    const text = visible(channel, render(content, channel));
    for (const value of [status === 'partial' ? '部分完成' : '未完成', '人工确认', '待确认', 'Workflow warning', '通知结果尚不确定', '恢复尚未完成']) assert.ok(text.includes(value), channel + ': ' + value);
  }
});
test('Radar zero and absent Weekly counts remain honest in every channel', () => {
  for (const channel of CHANNEL_IDS) {
    assert.match(visible(channel, render(buildRadarNotificationContent([]), channel)), /0 篇/);
    const missing = visible(channel, render(buildWeeklyNotificationContent({}), channel));
    assert.doesNotMatch(missing, /本次新增|A 0|undefined|null|项未展开/);
  }
});
