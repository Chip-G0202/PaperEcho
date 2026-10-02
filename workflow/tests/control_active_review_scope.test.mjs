import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FeedbackService, feedbackIdentity } from '../tools/lib/control_feedback_service.mjs';
import { ReviewQueryService } from '../tools/lib/control_review_query_service.mjs';
import { finalizePendingPaperReview, pendingPaperReviewPath, readPendingPaperReview } from '../tools/lib/pending_paper_review.mjs';
import { buildStage4StandaloneExportSource, buildFinalExportPayload, buildProspectiveStage4ExportSource, buildFinalReviewMembership } from '../tools/stage4/finalize_exports_support.mjs';
import { getWeeklyReviewEvidence, exportAllResearchOsXlsxWithNodeFallback } from '../tools/stage4/spreadsheet_adapter.mjs';
import { readXlsxSheets } from '../tools/lib/review_workbook_reader.mjs';
import { prepareStage4ExportSource } from '../tools/stage4/export_source_step.mjs';

const paper = (index) => ({ title: `Synthetic mechanism review paper ${index}`, doi: `10.1234/scope-${index}`, grade: 'C', rule_grade: 'C', llm_review_grade: 'C', needs_human_review: true });
const finalEligible = (item) => ({ ...item, pre_llm_skip_writeback: false, review_consensus_required: false });
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
  await app.run('held-current', '2026-10-01T05:00:00Z', historical.slice(0, 2).map(finalEligible));
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
  const items = [finalEligible(historical[0]), finalEligible(historical[0]), { ...historical[1], rule_grade: '', grade: 'B', original_grade: 'C', llm_review_grade: 'B', needs_human_review: false }, { ...historical[2], rule_grade: '', grade: 'D', original_grade: 'C', llm_review_grade: 'D' }, { ...historical[3], needs_human_review: false, manual_review_state: 'manual_abc' }, { title: 'No reliable identifier', grade: 'C', needs_human_review: true }];
  await app.run('current', '2026-10-01T05:00:00Z', items);
  const page = await app.query.weekly();
  assert.equal(page.items.length, 2);
  assert.equal(page.items[0].doi, historical[0].doi);
  assert.equal((await app.query.pendingSummary()).manual, 2);
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
  const initial = await app.query.weekly({limit:200});
  assert.equal(initial.items.filter((item) => item.manualReviewPending).length, 1);
  await app.feedback.submit({ kind: 'manual_grade', paper: paper(1), manualGrade: 'B', requestId: 'weekly-b' });
  const decided = await app.query.weekly();
  assert.equal(decided.items[0].id, initial.items[0].id); // Ordinary Feedback identity remains stable.
  assert.equal((await app.query.pendingSummary()).manual, 0);
});

test('a historical auto D record can be re-seen with current pending evidence', async (t) => {
  const app = await fixture(t);
  const old = { ...paper(0), grade: 'D', rule_grade: 'D', llm_review_grade: 'D', needs_human_review:false };
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

test('completed export and Control Center share qualified held Manual identities and canonical decisions', async (t) => {
  const app = await fixture(t);
  const holds = Array.from({ length: 62 }, (_, i) => paper(i));
  await finalizePendingPaperReview({ reviewRoot: app.reviewRoot, items: holds });
  holds.forEach((item,index)=>{ if(index<2)Object.assign(item,{rule_grade:'D',llm_review_grade:index?'B':'A',grade:'D',final_grade:'D'});else item.pre_llm_zotero_existing_duplicate=true; });
  const pendingBefore = await fs.readFile(pendingPaperReviewPath(app.reviewRoot), 'utf8');
  const final = Array.from({ length: 49 }, (_, i) => ({ ...paper(100 + i), needs_human_review: i < 2 }));
  const run = await app.run('completed', '2026-10-01T05:00:00Z', [...holds, ...final], { weekly: true, report: { steps: { med_weekly_synthesis: { completed: true } } } });
  const pipeline = app.query.pipeline(run);
  const writeback = { writeback_items: final.map((item, i) => ({ ...item, itemKey: `KEY${i}` })) };
  await app.write(path.join(pipeline, 'desktop_daily_review_source.json'), { triaged: final });
  await app.write(path.join(pipeline, 'zotero_writeback_summary.json'), writeback);
  const exportedSource = buildStage4StandaloneExportSource({ desktopSource: { triaged: final }, writebackSummary: writeback });
  const finalPayload = buildFinalExportPayload({ allAbcItems: exportedSource.allAbcItems, writebackSummary: writeback, manualCandidates: holds });
  const manual = finalPayload.triaged.filter(item => getWeeklyReviewEvidence(item).needsReview);
  const expected = manual.map(feedbackIdentity);
  assert.deepEqual((await app.query.reviewData()).scopeItems.filter(item => getWeeklyReviewEvidence(item).needsReview).map(feedbackIdentity), expected);
  const sourcePath = path.join(pipeline, 'workbook_source.json');
  await app.write(sourcePath, finalPayload);
  const exported = await exportAllResearchOsXlsxWithNodeFallback({ sourcePath, reviewRootDir: app.reviewRoot, reviewWeekDir: app.reviewRoot, reviewDayDir: app.reviewRoot, dateStr: '2026-10-01', weekLabel: '26.10', dayLabel: '10.01' });
  const rows = readXlsxSheets(exported.outputs.every_other_day_report).get('需人工复核').slice(1);
  // Workbook titles map back to the same stable identities; count alone is insufficient.
  assert.deepEqual(rows.map(row => feedbackIdentity(finalPayload.triaged.find(item => item.title === row[0]))), expected);
  assert.equal((await app.query.pendingSummary()).manual, 4);
  assert.equal((await app.query.status()).needsReview, 4);
  const initial = await app.query.weekly({limit:200});
  assert.deepEqual(initial.items.filter(item => item.manualReviewPending).map(item => item.doi), manual.map(item => item.doi));
  for (const [index, item] of initial.items.filter(item => item.manualReviewPending).entries()) {
    await app.feedback.submit({ kind: 'manual_grade', paper: await app.query.resolvePaper(initial.runId, item.id), manualGrade: 'B', requestId: item.id });
    assert.equal((await app.query.pendingSummary()).manual, 3 - index);
    assert.equal((await app.query.status()).needsReview, 3 - index);
    assert.equal((await app.query.weekly({limit:200})).items.filter(item => item.manualReviewPending).length, 3 - index);
    assert.equal((await app.query.resolvePaper(initial.runId, item.id)).doi, item.doi);
  }
  assert.equal((await app.query.weekly()).items.length, 49); // Ordinary Feedback membership is unchanged.
  assert.equal(await fs.readFile(pendingPaperReviewPath(app.reviewRoot), 'utf8'), pendingBefore);
});

test('unfinished workflow admits current decidable holds independently of automatic eligibility without rewriting history', async (t) => {
  const app = await fixture(t);
  const historical = Array.from({ length: 142 }, (_, i) => paper(i));
  await finalizePendingPaperReview({ reviewRoot: app.reviewRoot, items: historical });
  const items = [
    ...historical.slice(0, 60),
    ...historical.slice(60, 62).map(finalEligible),
    { ...paper(200), grade: 'D', final_grade: 'D' },
    { ...paper(201), llm_review_grade: 'D' },
    { ...paper(202), pre_llm_zotero_existing_duplicate: true, pre_llm_skip_writeback: true },
    { ...paper(203), review_consensus_required: true, llm_review_grade: 'B' },
    { title: 'Missing feedback identity', grade: 'C', rule_grade: 'C', llm_review_grade: 'C', needs_human_review: true },
  ];
  const inputBefore = JSON.stringify(items);
  const run = await app.run('unfinished', '2026-10-01T05:00:00Z', items);
  const pipeline = app.query.pipeline(run);
  const pendingBefore = await fs.readFile(pendingPaperReviewPath(app.reviewRoot), 'utf8');
  const artifactBefore = await fs.readFile(path.join(pipeline, 'triaged_items.json'), 'utf8');
  const expected = [...historical.slice(60,62),...historical.slice(0,60),items[62],items[63],items[65]].map(item => item.doi);
  const data = await app.query.reviewData();
  assert.equal(data.reviewScope.type, 'prospective_stage4');
  assert.deepEqual(data.scopeItems.map(item => item.doi), expected);
  assert.deepEqual((await app.query.weekly({limit:200})).items.map(item => item.doi), expected);
  assert.equal((await app.query.pendingSummary()).manual, 65);
  assert.equal((await app.query.status()).needsReview, 65);
  const prospective = buildProspectiveStage4ExportSource(items);
  assert.deepEqual(prospective.filter(item => item.doi).map(item => item.doi), expected);
  assert.equal(JSON.stringify(items), inputBefore);
  assert.equal(await fs.readFile(pendingPaperReviewPath(app.reviewRoot), 'utf8'), pendingBefore);
  assert.equal(await fs.readFile(path.join(pipeline, 'triaged_items.json'), 'utf8'), artifactBefore);
  assert.equal((await readPendingPaperReview(app.reviewRoot)).records.length, 142);
  assert.deepEqual((await fs.readdir(pipeline)).sort(), ['run_report.json', 'triaged_items.json']);
});

test('completed Stage4 requires normal writeback evidence while current held Manual stays reachable', async (t) => {
  const app = await fixture(t);
  const run = await app.run('stage4', '2026-10-01T05:00:00Z', [paper(0)], { report: { steps: { stage4_export_audit: { stage4_export_status: 'success' } } } });
  const pipeline = app.query.pipeline(run);
  const finalD = { ...paper(2), final_grade: 'D' };
  await app.write(path.join(pipeline, 'desktop_daily_review_source.json'), { triaged: [paper(1), finalD] });
  await app.write(path.join(pipeline, 'zotero_writeback_summary.json'), { writeback_items: [{ ...paper(1), itemKey: 'KEY1' }, { ...finalD, itemKey: 'KEY2' }] });
  const page = await app.query.weekly();
  assert.deepEqual(page.items.map(item => item.doi), [paper(1).doi,paper(0).doi]);
  assert.equal(page.items[0].zotero, 'admitted');
  assert.equal((await app.query.pendingSummary()).manual, 2);
  await app.write(path.join(pipeline, 'zotero_writeback_summary.json'), { writeback_items: [] });
  assert.equal((await app.query.pendingSummary()).manual, 1);
  assert.equal((await app.query.weekly()).total, 1);
});

test('historical 7/20 projection mismatch shares identities, preserves rescue and canonical history after reload', async (t) => {
  const app=await fixture(t);
  const normal=Array.from({length:20},(_,i)=>({...paper(300+i),rule_grade:i<13?'D':'C',llm_review_grade:'C',grade:'C',final_grade:'C',needs_human_review:false,'推荐等级':i<13?'D无关':'C领域相关'}));
  const manual={...paper(400),final_grade:'C'};
  const excluded={...paper(401),rule_grade:'D',llm_review_grade:'D',grade:'D',final_grade:'D',needs_human_review:false};
  const holds=['A','B'].map((g,i)=>({...paper(500+i),rule_grade:'D',llm_review_grade:g,grade:'D',final_grade:'D',pre_llm_skip_writeback:true}));
  await finalizePendingPaperReview({reviewRoot:app.reviewRoot,items:holds});
  const pendingBefore=await fs.readFile(pendingPaperReviewPath(app.reviewRoot),'utf8');
  const source=[...normal,manual,excluded];
  assert.equal(normal.filter(i=>i['推荐等级']!=='D无关').length,7); // Legacy XLSX veto.
  assert.equal(normal.filter(i=>['A','B','C'].includes(i.final_grade)).length,20); // Legacy UI.
  const run=await app.run('parity','2026-10-01T05:00:00Z',[...source,...holds],{weekly:true,report:{steps:{med_weekly_synthesis:{completed:true}}}});
  const pipeline=app.query.pipeline(run);
  const writeback={writeback_items:source.map((i,n)=>({...i,itemKey:`PARITY${n}`}))};
  await app.write(path.join(pipeline,'desktop_daily_review_source.json'),{triaged:source});
  await app.write(path.join(pipeline,'zotero_writeback_summary.json'),writeback);
  const filtered=buildStage4StandaloneExportSource({desktopSource:{triaged:source},writebackSummary:writeback});
  const payload=buildFinalExportPayload({allAbcItems:filtered.allAbcItems,writebackSummary:writeback,manualCandidates:holds});
  const membership=buildFinalReviewMembership(payload.triaged);
  const identitySet=items=>items.map(i=>feedbackIdentity(i).filter(key=>!key.startsWith('review:')).sort().join('|')).sort();
  const before=await app.query.weekly();
  assert.deepEqual(identitySet(before.items.filter(i=>i.reviewBucket==='feedback')),identitySet(membership.feedback));
  assert.deepEqual(identitySet(before.items.filter(i=>i.reviewBucket==='manual')),identitySet(membership.manual));
  assert.deepEqual(identitySet(membership.feedback),identitySet(normal));
  assert.deepEqual(identitySet(membership.manual),identitySet([manual,...holds]));
  assert.ok(before.items.every(i=>i.doi!==excluded.doi));
  assert.ok(before.items.filter(i=>holds.some(h=>h.doi===i.doi)).every(i=>i.pendingReview&&i.zotero==='not_written'));
  const sourcePath=path.join(pipeline,'workbook_source.json');
  await app.write(sourcePath,payload);
  const exported=await exportAllResearchOsXlsxWithNodeFallback({sourcePath,reviewRootDir:app.reviewRoot,reviewWeekDir:app.reviewRoot,reviewDayDir:app.reviewRoot,dateStr:'2026-10-01',weekLabel:'26.10',dayLabel:'10.01'});
  const sheets=readXlsxSheets(exported.outputs.every_other_day_report);
  for(const[sheet,bucket]of [['每日反馈','feedback'],['需人工复核','manual']]) {
    const projected=sheets.get(sheet).slice(1).filter(row=>row.some(Boolean)).map(row=>payload.triaged.find(i=>i.title===row[0]));
    assert.ok(projected.every(Boolean));
    assert.deepEqual(identitySet(projected),identitySet(membership[bucket]));
  }
  for(const entry of before.items.filter(i=>i.reviewBucket==='feedback').slice(0,2)) {
    await app.feedback.submit({kind:'paper_feedback',paper:await app.query.resolvePaper(before.runId,entry.id),value:'relevant',requestId:entry.id});
    assert.equal((await app.query.resolvePaper(before.runId,entry.id)).doi,entry.doi); // Session revision.
  }
  const state=await app.feedback.current();
  assert.equal(state.length,2);
  assert.equal((await app.query.pendingSummary()).normal,membership.feedback.length-2);
  assert.equal((await app.query.weekly()).items.filter(i=>i.reviewBucket==='feedback'&&!i.feedback).length,membership.feedback.length-2);
  assert.equal((await app.query.pendingSummary()).manual,3);
  assert.equal(await fs.readFile(pendingPaperReviewPath(app.reviewRoot),'utf8'),pendingBefore);
});

test('formal Stage4 source preparation carries current held Manual into the same Workbook and service projection', async (t) => {
  const app=await fixture(t);
  const items=['A','B'].map((g,i)=>({...paper(700+i),rule_grade:'D',llm_review_grade:g,grade:'D',final_grade:'D'}));
  await finalizePendingPaperReview({reviewRoot:app.reviewRoot,items});
  const run=await app.run('prepared','2026-10-01T05:00:00Z',items,{weekly:true,report:{steps:{llm_grade_review:{ok:true,skipped:false,failed_batch_count:0},med_weekly_synthesis:{completed:true}},counts:{},failures:[]}});
  const pipeline=app.query.pipeline(run), sourcePath=path.join(pipeline,'desktop_daily_review_source.json');
  const paths={pipelineDir:pipeline,reviewRoot:app.reviewRoot,reviewDayDir:app.reviewRoot,sourcePath,runReportPath:path.join(pipeline,'run_report.json'),writebackReadyPath:path.join(pipeline,'writeback_ready_items.json'),backfillPath:path.join(pipeline,'abc_translation_backfill.json'),writebackSummaryPath:path.join(pipeline,'zotero_writeback_summary.json'),preferenceAuditPath:path.join(pipeline,'preference_learning_audit.json')};
  await app.write(paths.writebackReadyPath,[]);await app.write(paths.backfillPath,{updated_items:[]});await app.write(paths.writebackSummaryPath,{writeback_items:[]});await app.write(sourcePath,{triaged:[]});
  const pendingBefore=await fs.readFile(pendingPaperReviewPath(app.reviewRoot),'utf8');
  const artifactBefore=await fs.readFile(path.join(pipeline,'triaged_items.json'),'utf8');
  const prepared=await prepareStage4ExportSource({dateStr:'2026-10-01',paths,runtime:{translationCachePath:path.join(pipeline,'translation_cache.json')}});
  assert.deepEqual(prepared.finalPayload.triaged.map(i=>i.doi),items.map(i=>i.doi));
  const exported=await exportAllResearchOsXlsxWithNodeFallback({sourcePath,reviewRootDir:app.reviewRoot,reviewWeekDir:app.reviewRoot,reviewDayDir:app.reviewRoot,dateStr:'2026-10-01',weekLabel:'26.10',dayLabel:'10.01'});
  const rows=readXlsxSheets(exported.outputs.every_other_day_report).get('需人工复核').slice(1);
  assert.deepEqual(rows.map(row=>items.find(i=>i.title===row[0]).doi),(await app.query.weekly()).items.filter(i=>i.manualReviewPending).map(i=>i.doi));
  assert.equal(await fs.readFile(pendingPaperReviewPath(app.reviewRoot),'utf8'),pendingBefore);
  assert.equal(await fs.readFile(path.join(pipeline,'triaged_items.json'),'utf8'),artifactBefore);
});

test('completed and unfinished whole semantic failures never expose mass Manual', async (t) => {
  for(const completed of [true,false]) {
    const app=await fixture(t), items=Array.from({length:120},(_,i)=>paper(800+i));
    const run=await app.run('failed','2026-10-01T05:00:00Z',items,{weekly:completed,report:{steps:{semantic_grading:{ok:false,skipped:false,failed_batch_count:1},med_weekly_synthesis:{completed}}}});
    const pipeline=app.query.pipeline(run);
    await app.write(path.join(pipeline,'desktop_daily_review_source.json'),{triaged:items});
    await app.write(path.join(pipeline,'zotero_writeback_summary.json'),{writeback_items:items.map((i,n)=>({...i,itemKey:`FAILED${n}`}))});
    assert.equal((await app.query.weekly()).total,0);
    assert.equal((await app.query.pendingSummary()).manual,0);
  }
});
