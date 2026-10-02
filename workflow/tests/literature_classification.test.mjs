import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyLiterature } from '../tools/stage1/semantic_grade_synthesis.mjs';
import { buildFinalReviewMembership, buildProspectiveStage4ExportSource } from '../tools/stage4/finalize_exports_support.mjs';
import { reviewGradesWithLlm, applyReviewToItems } from '../tools/stage1/llm_grade_reviewer.mjs';

const item = (rule, semantic, extra = {}) => ({rule_grade:rule, semantic_grade:semantic, grade:rule, final_grade:rule, semantic_stage_status:'completed', ...extra});
test('approved classification truth table treats D as an exclusion boundary', () => {
  const cases = [
    ['A','A','A','feedback','consensus'], ['B','B','B','feedback','consensus'], ['C','C','C','feedback','consensus'],
    ['A','B','B','feedback','adjacent_adjustment'], ['B','A','A','feedback','adjacent_adjustment'],
    ['B','C','C','feedback','adjacent_adjustment'], ['C','B','B','feedback','adjacent_adjustment'],
    ['D','C','C','feedback','soft_rescue'], ['D','B','D','manual','exclusion_conflict'], ['D','A','D','manual','exclusion_conflict'],
    ['A','D','A','manual','exclusion_conflict'], ['B','D','B','manual','exclusion_conflict'], ['C','D','C','manual','exclusion_conflict'],
    ['A','C','A','manual','large_grade_gap'], ['C','A','C','manual','large_grade_gap'], ['D','D','D','excluded','double_d'],
  ];
  for (const [rule, semantic, final, bucket, reason] of cases) {
    const result = classifyLiterature(item(rule, semantic));
    assert.deepEqual([result.finalGrade,result.reviewBucket,result.classificationReason], [final,bucket,reason], `${rule}→${semantic}`);
  }
});
test('explicit requests and formal low-confidence conflicts override automatic transitions', () => {
  for (const flag of [{needs_human_review:true},{review_required:true},{llm_review:{llm_review_grade:'D',needs_human_review:true}}]) {
    assert.equal(classifyLiterature(item('D','D',flag)).reviewBucket,'manual');
  }
  assert.equal(classifyLiterature(item('B','A',{llm_review:{llm_review_grade:'A',confidence:'low'}})).reviewBucket,'manual');
  assert.equal(classifyLiterature(item('B','B',{llm_review:{llm_review_grade:'B',confidence:'low'}})).reviewBucket,'feedback');
  const requested={grade:'D',review_required:true};
  applyReviewToItems([{id:'explicit',rule_grade:'D',_item:requested}],[{id:'explicit',llm_review_grade:'C',confidence:'high',needs_human_review:false}]);
  assert.equal(requested.final_grade,'D');
  assert.equal(requested.needs_human_review,true);
});
test('isolated missing is manual; failed or unverified stage is blocked, never a mass manual batch', () => {
  for (const rule of ['A','B','C','D']) {
    assert.equal(classifyLiterature(item(rule,'')).classificationReason,'semantic_unavailable');
    assert.equal(classifyLiterature(item(rule,'')).reviewBucket,'manual');
  }
  const failed=Array.from({length:120},()=>item('B','',{semantic_stage_status:'failed',needs_human_review:true}));
  assert.equal(buildFinalReviewMembership(failed).manual.length,0);
  assert.equal(buildFinalReviewMembership(failed).feedback.length,0);
  assert.equal(classifyLiterature(item('B','',{semantic_stage_status:undefined})).reviewBucket,null);
});
test('canonical manual replay wins and legacy queue inference cannot manufacture requests', () => {
  assert.equal(classifyLiterature(item('D','A',{manual_confirmed_grade:'B',manual_review_state:'manual_abc',needs_human_review:true})).finalGrade,'B');
  assert.equal(classifyLiterature(item('C','D',{manual_confirmed_grade:'D',manual_review_state:'manual_d'})).reviewBucket,'excluded');
  const inferred=item('D','C',{review_consensus_required:true,manual_review_state:'pending',needs_human_review:true,llm_review:{llm_review_grade:'C',confidence:'high',needs_human_review:false}});
  assert.equal(classifyLiterature(inferred).reviewBucket,'feedback');
});
test('display labels cannot veto rescue; final boundary and disjoint buckets remain separate', () => {
  const source=[item('D','C',{'推荐等级':'D无关'}),item('D','A'),item('D','B'),item('D','D')];
  const membership=buildFinalReviewMembership(source);
  assert.equal(membership.feedback.length,1);
  assert.equal(membership.manual.length,2);
  assert.equal(membership.excluded.length,1);
  for (const bucket of ['feedback','manual','excluded']) for (const other of ['feedback','manual','excluded']) {
    if(bucket!==other)assert.ok(membership[bucket].every(i=>!membership[other].includes(i)));
  }
  const held=item('D','C',{pre_llm_skip_writeback:true});
  assert.equal(classifyLiterature(held).reviewBucket,'feedback');
  assert.equal(buildProspectiveStage4ExportSource([held,item('D','A',{pre_llm_skip_writeback:true})]).length,0);
});

test('provider stage failure stays retryable; successful stage omission is isolated manual evidence', async () => {
  const runtime={apiKeyConfigured:true,model:'fixture',endpoint:'mock://fixture',max_retries:0,timeout_ms:1000};
  const config={cache_enabled:false,batch_size:5};
  const failed=Array.from({length:5},(_,i)=>({id:`failed-${i}`,title:`Synthetic failure ${i}`,grade:'B',rule_grade:'B'}));
  const failure=await reviewGradesWithLlm({items:failed,runtime,config,llmClient:async()=>{throw new Error('synthetic provider failure');}});
  assert.equal(failure.ok,false);
  assert.equal(failure.blocker,'llm_grade_review_partial_failure');
  assert.equal(failure.items_needing_human_review,0);
  assert.equal(buildProspectiveStage4ExportSource(failed).length,0);
  const isolated=[0,1].map(i=>({id:`single-${i}`,title:`Synthetic isolated ${i}`,grade:'B',rule_grade:'B'}));
  const success=await reviewGradesWithLlm({items:isolated,runtime,config,llmClient:async input=>({items:[{id:input.items[0].id,llm_review_grade:'B',confidence:'high',needs_human_review:false}]})});
  assert.equal(success.ok,true);
  assert.equal(classifyLiterature(isolated[0]).reviewBucket,'feedback');
  assert.equal(classifyLiterature(isolated[1]).classificationReason,'semantic_unavailable');
});
