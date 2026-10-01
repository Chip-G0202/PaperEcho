import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyReviewToItems } from '../tools/stage1/llm_grade_reviewer.mjs';
import { isManualReviewEligible } from '../tools/stage1/semantic_grade_synthesis.mjs';
import { finalizePendingPaperReview, readPendingPaperReview, pendingPaperReviewPath } from '../tools/lib/pending_paper_review.mjs';
import { isWritebackEligibleItem } from '../tools/lib/pipeline_stage_support.mjs';
import { isActiveManualReview } from '../tools/lib/control_review_query_service.mjs';
import { getWeeklyReviewEvidence } from '../tools/stage4/spreadsheet_adapter.mjs';

async function fixture(t) {
  const base = fileURLToPath(new URL('./.pending-paper-test-tmp/', import.meta.url));
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'eligibility-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
function reviewed(rule, semantic, index, { requested = false, confidence = 'high', failed = false } = {}) {
  const item = { title: `Synthetic grade transition study ${index}`, doi: `10.1234/transition-${index}`, grade: rule };
  applyReviewToItems([{ id: 'fixture', rule_grade: rule, _item: item }], semantic ? [{ id: 'fixture', llm_review_grade: semantic, confidence, reason: 'Synthetic evidence', needs_human_review: requested }] : [], { failedReviewItemIds: new Set(failed ? ['fixture'] : []) });
  return item;
}

test('grade owner transition contract survives pending persistence and writeback preparation', async (t) => {
  const root = await fixture(t);
  const transitions = [
    ['A','A','A',false], ['B','B','B',false], ['C','C','C',false], ['D','D','D',false],
    ['A','B','B',false], ['B','A','A',false], ['B','C','C',false], ['C','B','B',false], ['D','C','C',false],
    ['C','D','C',true], ['A','C','A',true], ['C','A','C',true], ['B','D','B',true], ['D','B','D',true], ['A','D','A',true], ['D','A','D',true],
    ['B','','B',false], ['B','','B',true,{failed:true}],
    ['B','B','B',true,{requested:true}], ['B','A','B',true,{confidence:'low'}], ['D','D','D',false,{requested:true}],
  ];
  for (const [index, [rule, semantic, final, manual, options]] of transitions.entries()) {
    const item = reviewed(rule, semantic, index, options);
    assert.equal(item.final_grade, final, `${rule}->${semantic}: final`);
    assert.equal(isManualReviewEligible(item), manual, `${rule}->${semantic}: eligibility`);
    await finalizePendingPaperReview({ reviewRoot: root, items: [item] });
    assert.equal(item.final_grade, final);
    assert.equal(item.needs_human_review, manual);
    assert.equal(isActiveManualReview(item), manual);
    assert.equal(getWeeklyReviewEvidence(item).needsReview, manual);
    assert.equal(isWritebackEligibleItem(item), final !== 'D' && !manual);
  }
  const retry = reviewed('B', 'A', 'retry');
  applyReviewToItems([{id:'retry',rule_grade:'B',_item:retry}], [], {failedReviewItemIds:new Set(['retry'])});
  assert.equal(retry.grade, 'B');
  assert.equal(retry.final_grade, 'B');
  assert.equal(isManualReviewEligible(retry), true);
});

test('explicit upstream review overrides automatic adoption; legacy evidence alone does not', async (t) => {
  const root = await fixture(t);
  for (const [index, flag] of [{ needs_human_review:true }, { review_required:true }, { reviewRequired:true }, { semantic_review:{review_required:true} }].entries()) {
    const item = { title: `Explicit same-grade review study ${index}`, doi:`10.1234/explicit-${index}`, rule_grade:'C', llm_review_grade:'C', grade:'C', final_grade:'C', ...flag };
    await finalizePendingPaperReview({ reviewRoot:root, items:[item] });
    assert.equal(isActiveManualReview(item), true);
    assert.equal(isWritebackEligibleItem(item), false);
  }
  for (const flag of [{semantic_mismatch:true}, {semantic_rescue:true}]) {
    const item = { rule_grade:'B', llm_review_grade:'A', grade:'A', final_grade:'A', ...flag };
    assert.equal(isManualReviewEligible(item), false);
    assert.equal(getWeeklyReviewEvidence(item).needsReview, false);
    assert.equal(getWeeklyReviewEvidence(item).legacyReviewEvidence, true);
  }
});

test('old queue-inferred holds recover upstream policy without deleting historical records', async (t) => {
  const root = await fixture(t);
  const original = reviewed('C','D',0);
  await finalizePendingPaperReview({reviewRoot:root,items:[original]});
  const history = await fs.readFile(pendingPaperReviewPath(root),'utf8');
  const automatic = { ...reviewed('C','B',0), pending_review_id:original.pending_review_id, pending_review_state:'pending', manual_review_state:'pending', review_consensus_required:true, needs_human_review:true, pre_llm_skip_writeback:true };
  assert.equal(isManualReviewEligible(automatic), false);
  assert.equal(isActiveManualReview(automatic), false);
  await finalizePendingPaperReview({reviewRoot:root,items:[automatic]});
  assert.equal(automatic.final_grade,'B');
  assert.equal(isWritebackEligibleItem(automatic),true);
  assert.equal(await fs.readFile(pendingPaperReviewPath(root),'utf8'),history);
  assert.equal((await readPendingPaperReview(root)).records.length,1);
  const risky = { ...reviewed('C','D',1), manual_review_state:'pending', review_consensus_required:true };
  assert.equal(isActiveManualReview(risky),true);
  delete risky.llm_review; // Older artifacts can retain the grade owner's reason instead.
  assert.equal(isActiveManualReview(risky),true);
  const pendingOnly = { ...reviewed('B','',2), semantic_source:'', needs_human_review:true, manual_review_state:'pending', review_consensus_required:true };
  assert.equal(isManualReviewEligible(pendingOnly),false);
});
