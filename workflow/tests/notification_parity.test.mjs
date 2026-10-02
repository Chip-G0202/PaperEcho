import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRadarNotificationContent, buildWeeklyNotificationContent } from '../tools/stage5/notification_content.mjs';
import { formatRadarReport } from '../tools/stage5/radar_report.mjs';
import { renderWeeklyReport } from '../tools/stage5/report_summary.mjs';
import { renderQqNotification } from '../tools/notification/qq_renderer.mjs';
import { assertNotificationParity } from './helpers/notification_parity.mjs';

export const parityPapers = ['C', 'A', 'B', 'D'].map((grade, index) => ({ id: `paper-${index}`, title: `Canonical English ${index}`, translatedTitle: `中文文献${index}`, final_grade: grade, grade: 'D', journal: `Journal ${index}`, year: '2026', source_type: 'RSS', semantic_reason: `Existing reason ${index}` }));
export function parityContent(kind, papers = parityPapers) {
  return kind === 'radar' ? buildRadarNotificationContent(papers, { runId: 'parity-radar', audit: { generatedAt: '2026-09-30T00:00:00Z', candidateCount: 8 } }) : buildWeeklyNotificationContent({ runId: 'parity-weekly', pipelineMode: 'desktop', startedAt: '2026-09-23T00:00:00Z', finishedAt: '2026-09-30T00:00:00Z', counts: { created: 3, grades: { A: 1, B: 1, C: 1, D: 0 } } }, { literatureItems: papers, overview: 'Shared weekly summary' });
}
for (const kind of ['radar', 'weekly']) test(`${kind} Email/QQ show the same summary and preserve internal paper order`, () => {
  const content = parityContent(kind); const before = structuredClone(content);
  assert.deepEqual(content.items.map(item => item.id), ['paper-0', 'paper-1', 'paper-2']);
  assert.deepEqual(content.items.map(item => item.grade), ['C', 'A', 'B']);
  const email = (kind === 'radar' ? formatRadarReport : renderWeeklyReport)(content);
  const qq = renderQqNotification(content);
  assertNotificationParity(content, email.text); assertNotificationParity(content, qq.content);
  for (const message of [email.text, qq.content]) { assert.ok(!message.includes('Canonical English 3')); if (kind === 'weekly') assert.ok(message.includes('Shared weekly summary')); else assert.ok(message.includes('本轮候选：8')); }
  assert.deepEqual(content, before);
});
test('QQ summary does not expand the internal paper list', () => {
  const items = Array.from({ length: 12 }, (_, index) => ({ ...parityPapers[index % 3], id: `bounded-${index}`, title: `Bounded English ${index}`, translatedTitle: `中${index}`.repeat(100), semantic_reason: `Reason ${index}` }));
  const content = parityContent('radar', items); assertNotificationParity(content, renderQqNotification(content).content);
  assert.equal(content.items.length, 12);
});
test('content owns exclusions and supplies deterministic identities with absent provider IDs', () => {
  const items = [{ title: 'Fallback title', final_grade: 'A' }, { title: 'Excluded', final_grade: 'A', excluded: true }];
  const a = parityContent('radar', items); const b = parityContent('radar', items);
  assert.equal(a.items.length, 1); assert.equal(a.items[0].id, b.items[0].id); assert.match(a.items[0].id, /^[a-f0-9]{64}$/);
});
