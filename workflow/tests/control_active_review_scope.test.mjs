import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeedbackService } from '../tools/lib/control_feedback_service.mjs';
import { ReviewQueryService } from '../tools/lib/control_review_query_service.mjs';
import { finalizePendingPaperReview, pendingPaperReviewPath, readPendingPaperReview } from '../tools/lib/pending_paper_review.mjs';

const paper = (index) => ({ title: `Synthetic mechanism review paper ${index}`, doi: `10.1234/scope-${index}`, grade: 'C', rule_grade: 'C', llm_review_grade: 'D', needs_human_review: true });
async function fixture(t) {
  const base = fileURLToPath(new URL('./.control-test-tmp/', import.meta.url));
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const reviewRoot = path.join(root, 'review_results', '文献评价');
  const feedback = new FeedbackService({ reviewRoot });
  const query = new ReviewQueryService({ root, reviewRoot, feedback, rules: { list: async () => [] } });
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
  const run = async (id, startedAt, items, { profile = 'standard', pipeline = id, report = {}, weekly = false } = {}) => {
    const manifest = { schemaVersion: 1, runId: id, pipelineMode: 'desktop', startedAt, status: 'completed', artifacts: [{ kind: 'pipeline', rootKey: 'research', path: `pipeline/${pipeline}` }, ...(weekly ? [{ kind: 'weekly_export' }] : [])] };
    await write(path.join(query.runRoot, id, 'run_group.json'), manifest);
    const dir = path.join(query.researchRoot, 'pipeline', pipeline);
    await write(path.join(dir, 'run_report.json'), { run_id: id, started_at: startedAt, profile, ...report });
    if (items !== null) await write(path.join(dir, 'triaged_items.json'), items);
    return manifest;
  };
  return { root, reviewRoot, feedback, query, run, write };
}

test('142 historical unresolved records: current two are active, canonical decisions clear both without rewriting history', async (t) => {
  const app = await fixture(t);
  const historical = Array.from({ length: 142 }, (_, i) => paper(i));
  await finalizePendingPaperReview({ reviewRoot: app.reviewRoot, items: historical });
  const stored = await fs.readFile(pendingPaperReviewPath(app.reviewRoot), 'utf8');
  await app.run('held-current', '2026-10-01T05:00:00Z', historical.slice(0, 2));
  const page = await app.query.weekly();
  assert.equal(page.runId, 'held-current');
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((item) => item.manualReviewPending && item.pendingReview));
  assert.equal((await app.query.pendingSummary()).manual, 2);
  for (const item of page.items) {
    const resolved = await app.query.resolvePaper(page.runId, item.id);
    await app.feedback.submit({ kind: 'manual_grade', paper: resolved, manualGrade: 'D', requestId: item.id });
    assert.equal((await app.query.resolvePaper(page.runId, item.id)).doi, resolved.doi);
  }
  assert.equal((await app.query.pendingSummary()).manual, 0);
  assert.equal((await app.query.weekly()).total, 0);
  assert.equal(await fs.readFile(pendingPaperReviewPath(app.reviewRoot), 'utf8'), stored);
  assert.equal((await readPendingPaperReview(app.reviewRoot)).records.length, 142);
});

test('current artifacts admit re-seen identities once and release consensus, double D, absent and invalid items', async (t) => {
  const app = await fixture(t);
  const historical = Array.from({ length: 5 }, (_, i) => paper(i));
  await finalizePendingPaperReview({ reviewRoot: app.reviewRoot, items: historical });
  const items = [historical[0], { ...historical[0] }, { ...historical[1], rule_grade: '', grade: 'B', original_grade: 'C', llm_review_grade: 'B', needs_human_review: false }, { ...historical[2], rule_grade: '', grade: 'D', original_grade: 'C', llm_review_grade: 'D' }, { ...historical[3], needs_human_review: false, manual_review_state: 'manual_abc' }, { title: 'No reliable identifier', needs_human_review: true }];
  await app.run('current', '2026-10-01T05:00:00Z', items);
  const page = await app.query.weekly();
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].doi, historical[0].doi);
  assert.equal((await app.query.pendingSummary()).manual, 1);
  await app.run('empty-current', '2026-10-02T05:00:00Z', []);
  assert.equal((await app.query.pendingSummary()).manual, 0);
  await assert.rejects(app.query.resolvePaper(page.runId, page.items[0].id), /WEEKLY_CHANGED_RELOAD/);
  assert.equal((await readPendingPaperReview(app.reviewRoot)).records.length, 5);
});

test('newer Weekly evidence outranks older held artifacts; Radar does not produce a manual review batch', async (t) => {
  const app = await fixture(t);
  await app.run('older-held', '2026-09-30T05:00:00Z', [paper(0)]);
  const weeklyRun = await app.run('weekly-newer', '2026-10-01T05:00:00Z', null, { weekly: true });
  app.query.latestWeeklyData = async () => ({ run: weeklyRun, report: {}, items: [paper(1), { ...paper(1) }] });
  await app.run('radar-newest', '2026-10-02T05:00:00Z', [paper(2)], { profile: 'radar' });
  const data = await app.query.reviewData();
  assert.equal(data.reviewScope.run.runId, 'weekly-newer');
  assert.equal(data.reviewScope.type, 'weekly');
  assert.equal((await app.query.pendingSummary()).manual, 1);
  const initial = await app.query.weekly();
  assert.equal(initial.items.filter((item) => item.manualReviewPending).length, 1);
  await app.feedback.submit({ kind: 'manual_grade', paper: paper(1), manualGrade: 'B', requestId: 'weekly-b' });
  const decided = await app.query.weekly();
  assert.equal(decided.items[0].id, initial.items[0].id); // Ordinary Feedback identity remains stable.
  assert.equal((await app.query.pendingSummary()).manual, 0);
});

test('a historical auto D record can be re-seen with current pending evidence', async (t) => {
  const app = await fixture(t);
  const old = { ...paper(0), grade: 'D', rule_grade: 'D', llm_review_grade: 'D' };
  await finalizePendingPaperReview({ reviewRoot: app.reviewRoot, items: [old] });
  assert.equal((await readPendingPaperReview(app.reviewRoot)).records[0].status, 'auto_d');
  await app.run('re-seen', '2026-10-01T05:00:00Z', [{ ...paper(0), manual_review_state: 'pending' }]);
  assert.equal((await app.query.pendingSummary()).manual, 1);
  assert.equal((await readPendingPaperReview(app.reviewRoot)).records[0].status, 'auto_d');
});

test('reused pipeline must not assign stale or skipped Stage1 artifacts to another run', async (t) => {
  for (const report of [{ run_id: 'older' }, { skipped: true }, { run_id: '', started_at: '2026-09-30T05:00:00Z' }]) {
    const app = await fixture(t);
    await app.run('older', '2026-09-30T05:00:00Z', [paper(0)], { pipeline: 'same-day' });
    await app.run('newer', '2026-10-01T05:00:00Z', [paper(0)], { pipeline: 'same-day', report });
    assert.equal(await app.query.currentReviewScope(null), null);
    assert.equal((await app.query.pendingSummary()).manual, 0);
  }
});
