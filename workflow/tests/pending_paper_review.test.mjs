import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeedbackService } from '../tools/lib/control_feedback_service.mjs';
import { isWritebackEligibleItem } from '../tools/lib/pipeline_stage_support.mjs';
import {
  attachPendingPaperReview, finalizePendingPaperReview, listPendingPaperReview,
  preparePendingPaperReview, readPendingPaperReview,
} from '../tools/lib/pending_paper_review.mjs';

const base = fileURLToPath(new URL('./.pending-paper-test-tmp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const paper = (doi, rule, semantic, title = `Clinical mechanism study of ${doi}`) => ({
  doi, title, grade: rule, rule_grade: rule, llm_review_grade: semantic, final_grade: rule,
});

test('double D is excluded without review; every disagreement and missing semantic is held', async (t) => {
  const root = await fixture(t);
  const items = [
    paper('10.1234/dd', 'D', 'D'), paper('10.1234/dc', 'D', 'C'),
    paper('10.1234/cd', 'C', 'D'), paper('10.1234/ab', 'A', 'B'),
    paper('10.1234/no-semantic', 'B', ''), paper('10.1234/bb', 'B', 'B'),
  ];
  const result = await finalizePendingPaperReview({ reviewRoot: root, items });
  assert.deepEqual([result.pending, result.autoD], [4, 1]);
  assert.equal(items[0].needs_human_review, false);
  assert.equal(isWritebackEligibleItem(items[0]), false);
  for (const item of items.slice(1, 5)) {
    assert.equal(item.needs_human_review, true);
    assert.equal(isWritebackEligibleItem(item), false);
  }
  assert.equal(isWritebackEligibleItem(items[5]), true);
  const current = await new FeedbackService({ reviewRoot: root }).current();
  assert.equal((await listPendingPaperReview({ reviewRoot: root, current })).length, 4);
  assert.equal((await readPendingPaperReview(root)).records.length, 5);
});

test('pending review survives a later run, and manual A/B/C is replayed before writeback', async (t) => {
  const root = await fixture(t);
  const first = paper('10.1234/revisit', 'D', 'C');
  await finalizePendingPaperReview({ reviewRoot: root, items: [first] });
  const feedback = new FeedbackService({ reviewRoot: root });
  await feedback.submit({ kind: 'manual_grade', paper: first, manualGrade: 'B', requestId: 'approve-b' });
  assert.equal((await listPendingPaperReview({ reviewRoot: root, current: await feedback.current() })).length, 0);
  const preparation = await preparePendingPaperReview({ reviewRoot: root, candidates: [] });
  assert.equal(preparation.injectedCount, 1);
  const next = preparation.input.map((item) => ({ ...item, grade: 'D', rule_grade: 'D', final_grade: 'D', llm_review_grade: 'D' }));
  attachPendingPaperReview(next, preparation);
  await finalizePendingPaperReview({ reviewRoot: root, items: next });
  assert.equal(next[0].manual_confirmed_grade, 'B');
  assert.equal(next[0].final_grade, 'B');
  assert.equal(isWritebackEligibleItem(next[0]), true);
  assert.equal((await preparePendingPaperReview({ reviewRoot: root, candidates: [{ ...first }] })).injectedCount, 0);
});

test('manual D remains excluded; repeat sightings reuse one queue record', async (t) => {
  const root = await fixture(t);
  const item = paper('10.1234/manual-d', 'B', 'D');
  await finalizePendingPaperReview({ reviewRoot: root, items: [item] });
  await finalizePendingPaperReview({ reviewRoot: root, items: [paper(item.doi, 'B', 'D')] });
  assert.equal((await readPendingPaperReview(root)).records.length, 1);
  const feedback = new FeedbackService({ reviewRoot: root });
  await feedback.submit({ kind: 'manual_grade', paper: item, manualGrade: 'D', requestId: 'approve-d' });
  const preparation = await preparePendingPaperReview({ reviewRoot: root, candidates: [paper(item.doi, 'B', 'D')] });
  const next = preparation.input;
  attachPendingPaperReview(next, preparation);
  await finalizePendingPaperReview({ reviewRoot: root, items: next });
  assert.equal(next[0].final_grade, 'D');
  assert.equal(isWritebackEligibleItem(next[0]), false);
  assert.equal((await listPendingPaperReview({ reviewRoot: root, current: await feedback.current() })).length, 0);
});

test('title-only held paper uses queue identity; conflicting strong identities fail closed', async (t) => {
  const root = await fixture(t);
  const first = paper('', 'C', 'D', 'Distinct clinical mechanism study of rare disease');
  await finalizePendingPaperReview({ reviewRoot: root, items: [first] });
  assert.match(first.pending_review_id, /^[0-9a-f-]{36}$/);
  const feedback = new FeedbackService({ reviewRoot: root });
  await feedback.submit({ kind: 'manual_grade', paper: first, manualGrade: 'A', requestId: 'title-only' });
  const normalizedVariant = first.title.replace('clinical mechanism', 'clinical—mechanism');
  const prepared = await preparePendingPaperReview({ reviewRoot: root, candidates: [paper('', 'C', 'D', normalizedVariant)] });
  assert.equal(prepared.injectedCount, 0);
  attachPendingPaperReview(prepared.input, prepared);
  await finalizePendingPaperReview({ reviewRoot: root, items: prepared.input });
  assert.equal(isWritebackEligibleItem(prepared.input[0]), true);

  const second = paper('10.1234/original', 'C', 'D', 'Another exact clinical mechanism study of disease');
  await finalizePendingPaperReview({ reviewRoot: root, items: [second] });
  await assert.rejects(preparePendingPaperReview({ reviewRoot: root,
    candidates: [paper('10.1234/different', 'C', 'D', second.title)] }), /IDENTITY_CONFLICT/);
});
