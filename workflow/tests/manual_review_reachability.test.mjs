import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFinalExportPayload, buildFinalReviewMembership, buildProspectiveStage4ExportSource } from '../tools/stage4/finalize_exports_support.mjs';
import { isWritebackEligibleItem } from '../tools/lib/pipeline_stage_support.mjs';
import { buildLocalStage4ExportSource } from '../tools/stage4/export_source_step.mjs';
const paper = (rule, semantic, index, extra = {}) => ({ title: `Synthetic review boundary ${index}`, doi: `10.1234/reach-${index}`, rule_grade: rule, llm_review_grade: semantic, grade: rule, final_grade: rule, semantic_stage_status: 'completed', pre_llm_skip_writeback: true, ...extra });

test('held classification Manual reaches export independently of automatic admission', () => {
  const candidates = [paper('D','B',0),paper('D','A',1),paper('B','D',2),paper('A','C',3),paper('C','A',4),paper('B','',5),paper('D','C',6,{review_required:true})];
  assert.ok(candidates.every(item => !isWritebackEligibleItem(item)));
  const payload = buildFinalExportPayload({allAbcItems: [], manualCandidates: candidates});
  assert.deepEqual(payload.triaged.map(i=>i.doi),candidates.map(i=>i.doi));
  const membership = buildFinalReviewMembership(payload.triaged);
  assert.equal(membership.manual.length,7);
  assert.equal(membership.feedback.length,0);
  assert.ok(payload.triaged.every(i=>i['写回状态']==='未写回'));
  assert.deepEqual(buildProspectiveStage4ExportSource(candidates).map(i=>i.doi),candidates.map(i=>i.doi));
});

test('reachability preserves real safety filters and canonical decisions without mutating evidence', () => {
  const valid = paper('D','B',0);
  const candidates = [valid,{...valid},paper('D','B',1,{pre_llm_zotero_existing_duplicate:true}),paper('D','A',2,{title:''}),paper('B','D',3,{doi:''}),paper('D','D',4),paper('B','',5,{semantic_stage_status:'failed'}),paper('D','A',6)];
  const before = JSON.stringify(candidates);
  const reviewContext = {current:[{kind:'manual_grade',identity:'doi:10.1234/reach-6',keys:['doi:10.1234/reach-6'],manual_grade:'C'}]};
  const payload = buildFinalExportPayload({allAbcItems: [],manualCandidates:candidates,reviewContext});
  assert.deepEqual(payload.triaged.map(i=>i.doi),[valid.doi]);
  assert.equal(JSON.stringify(candidates),before);
  assert.equal(buildFinalExportPayload({allAbcItems:[],manualCandidates:[valid],reviewContext:{semanticStageStatus:'failed'}}).triaged.length,0);
});

test('Feedback still requires normal admission; all buckets remain disjoint', () => {
  const rescue=paper('D','C',0,{grade:'C',final_grade:'C',pre_llm_skip_writeback:false});
  const duplicate=paper('D','C',1,{grade:'C',final_grade:'C',pre_llm_zotero_existing_duplicate:true});
  const manual=paper('D','A',2);
  const payload=buildFinalExportPayload({allAbcItems:[rescue],manualCandidates:[rescue,duplicate,manual,paper('D','D',3)]});
  const membership=buildFinalReviewMembership(payload.triaged);
  assert.deepEqual(membership.feedback.map(i=>i.doi),[rescue.doi]);
  assert.deepEqual(membership.manual.map(i=>i.doi),[manual.doi]);
  assert.ok(membership.feedback.every(i=>!membership.manual.includes(i)));
});

test('Local uses the same Manual reachability and current-run boundary', () => {
  const papers=[paper('D','A',0,{last_run_id:'current'}),paper('D','B',1,{last_run_id:'historical'}),paper('B','D',2,{last_run_id:'historical'}),paper('D','D',3,{last_run_id:'current'})];
  const result=buildLocalStage4ExportSource({papers,runId:'current'});
  assert.deepEqual(result.finalPayload.triaged.map(i=>i.doi),[papers[0].doi]);
  assert.equal(buildLocalStage4ExportSource({papers,runId:'current',runReport:{steps:{semantic_grading:{ok:false,skipped:false,failed_batch_count:1}}}}).finalPayload.triaged.length,0);
});
