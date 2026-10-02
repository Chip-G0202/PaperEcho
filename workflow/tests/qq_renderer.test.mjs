import test from 'node:test';
import { visibleSummary } from './helpers/notification_parity.mjs';
import assert from 'node:assert/strict';
import { renderQqNotification, QQ_TEXT_BUDGET_BYTES } from '../tools/notification/qq_renderer.mjs';
import { buildRadarNotificationContent, buildWeeklyNotificationContent, buildTestNotificationContent } from '../tools/stage5/notification_content.mjs';
import { createQqTransport } from '../tools/notification/qq_transport.mjs';

test('QQ Radar shows a clear summary hierarchy and leaves input unchanged', () => {
  const content = buildRadarNotificationContent([
    { title: 'B title', final_grade: 'B' }, { title: 'English title', translatedTitle: '中文标题 🧪', journal: 'Journal', year: 2026, final_grade: 'A', grade_reason: '推荐理由' },
  ], { runId: 'fixture', audit: { generatedAt: '2026-09-30T12:00:00Z', candidateCount: 10 } });
  const before = structuredClone(content);
  const result = renderQqNotification(content);
  assert.equal(result.msg_type, 2);
  for (const text of ['PaperEcho · Daily Radar', '2026-09-30', '本轮候选：10', '**本轮推荐**\n2 篇', '**分级**', 'A 1 ｜ B 1 ｜ C 0 ｜ D 0']) assert.ok(visibleSummary(result.markdown.content).includes(text), text);
  assert.doesNotMatch(result.markdown.content, /B title|English title|中文标题|推荐理由/);
  assert.deepEqual(content, before);
  assert.deepEqual(renderQqNotification(content), result);
});

test('QQ Weekly uses shared summary and key results without HTML', () => {
  const content = buildWeeklyNotificationContent({ runId: 'fixture', finishedAt: '2026-09-30T12:00:00Z', counts: { created: 2, grades: { A: 1, B: 1 } }, attention: { humanReviewCount: 1 }, integrity: { newlyConfirmedRetractions: 1 } }, { overview: '本周研究重点' });
  const result = renderQqNotification(content);
  for (const text of ['PaperEcho · 周报', '2026-09-30', '**本次新增**\n2 篇', 'A 1', '**本轮概况**\n本周研究重点', '新确认撤稿', '人工确认']) assert.ok(visibleSummary(result.markdown.content).includes(text), text);
  assert.equal(result.markdown.content.includes('<html'), false);
});

for (const title of ['长'.repeat(10000), '😀'.repeat(10000), '👩🏽‍🔬'.repeat(10000), 'e\u0301'.repeat(10000)]) test(`QQ deterministic budget preserves Unicode (${title.slice(0, 10)})`, () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ title: title + i, translatedTitle: title, final_grade: i === 0 ? 'A' : 'B', grade_reason: title }));
  const content = buildRadarNotificationContent(items, { audit: { generatedAt: '2026-09-30', overview: title, warnings: ['Important alert'] } });
  const result = renderQqNotification(content);
  assert.ok(Buffer.byteLength(result.markdown.content, 'utf8') <= QQ_TEXT_BUDGET_BYTES);
  assert.equal(/\p{Surrogate}/u.test(result.markdown.content), false);
  assert.equal(result.markdown.content.includes('\ufffd'), false);
  assert.match(result.markdown.content, /Important alert/);
  assert.match(result.markdown.content, /A 1 ｜ B 99/);
  assert.doesNotMatch(result.markdown.content, /项未展开|\[A\]/);
  assert.deepEqual(renderQqNotification(content), result);
});

test('QQ Test content is generic and invalid event is rejected', () => {
  const result = renderQqNotification(buildTestNotificationContent({ generatedAt: '2026-09-30T12:00:00Z' }));
  assert.match(result.markdown.content, /通知测试/);
  assert.match(result.markdown.content, /仅用于验证平台 API 是否接受消息/);
  assert.throws(() => renderQqNotification({ eventType: 'unknown' }), /UNSUPPORTED/);
});

test('QQ adapter enforces authorized UTF-8 product budget before HTTP', async () => {
  let calls = 0;
  const send = createQqTransport({ appId: 'fixture', clientSecret: 'fake', targetType: 'user', targetId: 'fixture' }, { fetchImpl: async () => {
    calls++;
    return { status: 200, json: async () => calls % 2 ? { access_token: 'fake-token', expires_in: 7200 } : { id: 'fake-message', timestamp: '2026-09-30T12:00:00Z' } };
  } });
  const boundary = '中'.repeat(1666) + 'ab';
  assert.equal(Buffer.byteLength(boundary, 'utf8'), 5000);
  assert.equal((await send({ msg_type: 2, markdown: { content: boundary } })).accepted, true);
  assert.equal((await send({ msg_type: 2, markdown: { content: boundary + 'c' } })).category, 'qq_invalid_payload');
  assert.equal((await send({ msg_type: 2, markdown: { content: '\ud800' } })).category, 'qq_invalid_payload');
  assert.equal(calls, 2);
});

test('QQ escapes Markdown and HTML in the final bounded summary', () => {
  const content = buildWeeklyNotificationContent({ counts: { created: 0 }, warnings: ['WARNING'] }, { overview: '<>&*_[]()#`~'.repeat(10000) });
  const payload = renderQqNotification(content);
  assert.deepEqual(Object.keys(payload), ['msg_type', 'markdown']);
  assert.deepEqual(Object.keys(payload.markdown), ['content']);
  assert.match(payload.markdown.content, /&lt;&gt;&amp;\\\*\\_/);
  assert.match(payload.markdown.content, /WARNING/);
  assert.ok(Buffer.byteLength(payload.markdown.content) <= 5000);
  assert.doesNotMatch(payload.markdown.content, /<|>|undefined/);
});
