import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchEvaluationService } from '../workflow/tools/lib/research_evaluation_service.mjs';
import { consolidateResearchSuggestions, generateUnifiedPendingRuleSuggestions, normalizePendingRuleSuggestionCandidate } from '../workflow/tools/lib/unified_pending_rule_suggestions.mjs';
import { RuleSuggestionService } from '../workflow/tools/lib/control_rule_suggestion_service.mjs';
import { createRunRecoveryCoordinator, resumeRunFromLedger } from '../workflow/tools/recovery/run_recovery.mjs';
import { runZoteroLiteratureFilter } from '../workflow/tools/stage0/main.mjs';

const now = new Date('2026-10-15T07:00:00Z');
const output = () => ({ rules_added: [], rules_deleted: [], rules_changed: [], keywords_added: { required: [], optional: ['longitudinal', 'mechanism'], negative: [] }, keywords_removed: [], negative_keywords_added: [], unmapped_feedback: [] });
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
async function fixture(t, extra = {}) {
  const base = fileURLToPath(new URL('./runs/', import.meta.url)); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'research-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const researchRoot = path.join(root, 'review_results'); const reviewRoot = path.join(researchRoot, '文献评价');
  await fs.mkdir(path.join(root, 'config'), { recursive: true }); await fs.mkdir(reviewRoot, { recursive: true });
  const standard = path.join(reviewRoot, 'screening_standards.md'); const config = path.join(root, 'config/pubmed_pmc_search.json');
  await fs.writeFile(standard, '# 标准\n\n## 优先关注\n\n* 保留现有正式规则\n');
  await fs.writeFile(config, JSON.stringify({ keyword_groups: { required: ['baseline'], optional: [], negative: [] } }));
  let calls = 0;
  const service = new ResearchEvaluationService({ root, reviewRoot, env: {}, clock: () => now, llmClient: async (...args) => { calls++; return extra.llmClient ? extra.llmClient(...args) : output(); }, hook: extra.hook });
  const coordinator = async (runId = 'run-1', profile = 'standard') => createRunRecoveryCoordinator({ runRoot: path.join(reviewRoot, 'runs'), runId, mode: 'web', profile, launcherId: 'fixture', configHash: 'a'.repeat(64), inputHash: 'b'.repeat(64), artifactPath: path.join(reviewRoot, 'runs', runId, 'input_artifact.json') });
  const log = async () => { try { return (await read(path.join(reviewRoot, 'standards_rule_suggestions_log.json'))).suggestions; } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  return { root, researchRoot, reviewRoot, standard, config, service, coordinator, calls: () => calls, log };
}
async function verifyBusiness(store) {
  const skipped = store.ledger.profile === 'radar';
  await store.setStage('stage1', 'verified');
  for (const name of ['stage2_writeback', 'stage3_translation', 'stage4_exports']) await store.setStage(name, skipped ? 'skipped' : 'verified');
}
const keyword = (term, extra = {}) => ({ target: 'pubmed_pmc_search.json', change_type: 'add_keyword', rule_text: `添加可选检索词：${term}`, risk_level: 'high', ...extra });

test('research submit is durable/idempotent and legacy processed events never generate again', async t => {
  const f = await fixture(t); const input = { requestId: 'event-1', text: '优先关注机制验证' };
  assert.equal((await f.service.submit(input)).status, 'pending');
  const before = await fs.readFile(f.service.eventPath(input.requestId), 'utf8');
  assert.equal((await f.service.submit(input)).duplicate, true);
  assert.equal(await fs.readFile(f.service.eventPath(input.requestId), 'utf8'), before);
  await assert.rejects(f.service.submit({ ...input, text: '另一条反馈' }), /CONFLICT/);
  assert.equal(f.calls(), 0); assert.deepEqual(await f.log(), []);
  await fs.writeFile(f.service.eventPath(input.requestId), JSON.stringify({ ...JSON.parse(before), status: 'processed' }));
  const { store } = await f.coordinator(); assert.equal((await f.service.prepare({ store })).status, 'empty'); assert.equal(f.calls(), 0);
  await assert.rejects(f.service.prepare({ store: null }), /CLAIM_REQUIRED/);
});

test('structured keyword changes consolidate only within identical source/strategy/risk boundaries', () => {
  const candidates = [keyword('one'), keyword('two'), keyword('one'), keyword('other', { data_source: 'openalex' }), keyword('low', { risk_level: 'low' }), keyword('different', { strategy_id: 'other' }), keyword('boundary', { application_boundary: 'other' })];
  const grouped = consolidateResearchSuggestions(candidates); assert.equal(grouped.length, 5);
  assert.deepEqual(grouped[0].search_change.additions.optional, ['one', 'two']);
  const normalized = normalizePendingRuleSuggestionCandidate(grouped[0]);
  const paraphrase = normalizePendingRuleSuggestionCandidate({ ...grouped[0], rule_text: '合并调整同一策略的研究检索词', search_change: { ...grouped[0].search_change, additions: { required: [], optional: ['TWO', 'one'], negative: [] } } });
  assert.equal(normalized.hard_duplicate_key, paraphrase.hard_duplicate_key);
  const distinctRisk = generateUnifiedPendingRuleSuggestions({ manualEvaluationCandidates: [
    { rule_text: '优先关注机制研究', change_type: 'add_rule', risk_level: 'low' },
    { rule_text: '优先关注机制研究', change_type: 'add_rule', risk_level: 'high' },
  ] });
  assert.equal(distinctRisk.added_count, 2);
});

test('existing active/terminal search suggestions retain decisions and merge new feedback evidence', () => {
  const original = normalizePendingRuleSuggestionCandidate(keyword('mechanism', { feedback_event_ids: ['old'] }));
  for (const status of ['pending', 'candidate', 'accepted', 'revised', 'rejected', 'superseded', 'expired']) {
    const incoming = consolidateResearchSuggestions([keyword('mechanism')])[0];
    const result = generateUnifiedPendingRuleSuggestions({ existingSuggestionsLog: { suggestions: [{ ...original, status }] }, manualEvaluationCandidates: [{ ...incoming, rule_text: '调整机制相关检索策略', feedback_event_ids: ['new'] }] });
    assert.equal(result.added_count, 0); assert.equal(result.log.suggestions[0].status, status);
    assert.deepEqual(result.log.suggestions[0].feedback_event_ids, ['old', 'new']);
  }
});

for (const profile of ['radar', 'standard']) test(`${profile}: hidden preparation publishes only after verified business, independent of notification`, async t => {
  const f = await fixture(t); const { store } = await f.coordinator('run-1', profile);
  const standard = await fs.readFile(f.standard, 'utf8'); const config = await fs.readFile(f.config, 'utf8');
  await f.service.submit({ requestId: 'first', text: '增加机制与纵向研究检索词' });
  await f.service.submit({ requestId: 'same', text: '增加机制与纵向研究检索词' });
  await f.service.prepare({ store }); assert.equal(f.calls(), 1); assert.deepEqual(await f.log(), []);
  assert.equal((await f.service.publish({ store })).status, 'held');
  await f.service.submit({ requestId: 'later', text: '运行期间提交的新方向' });
  await verifyBusiness(store); await store.setStage('stage5_notification', 'failed');
  await f.service.publish({ store }); const [suggestion] = await f.log();
  assert.equal((await f.log()).length, 1); assert.equal(suggestion.status, 'pending');
  assert.deepEqual(suggestion.feedback_event_ids, ['first', 'same']);
  assert.equal((await read(f.service.eventPath('later'))).status, 'pending');
  assert.equal(await fs.readFile(f.standard, 'utf8'), standard); assert.equal(await fs.readFile(f.config, 'utf8'), config);
  const rules = new RuleSuggestionService({ root: f.root, reviewRoot: f.reviewRoot, env: {} });
  await rules.decide({ id: suggestion.id, decision: 'accepted', humanApproval: true });
  assert.deepEqual((await read(f.config)).keyword_groups.optional, ['longitudinal', 'mechanism']);
  assert.equal((await rules.decide({ id: suggestion.id, decision: 'accepted', humanApproval: true })).duplicate, true);
});

test('generation failure retains pending feedback and does not repeat LLM in the same run', async t => {
  const f = await fixture(t, { llmClient: async () => { throw new Error('synthetic unavailable'); } }); const { store } = await f.coordinator();
  await f.service.submit({ requestId: 'failed', text: '需要更多机制研究' });
  assert.equal((await f.service.prepare({ store })).status, 'failed'); await f.service.prepare({ store });
  assert.equal(f.calls(), 1); assert.equal((await read(f.service.eventPath('failed'))).status, 'pending');
  await verifyBusiness(store); assert.equal((await f.service.publish({ store })).status, 'pending'); assert.deepEqual(await f.log(), []);
});

for (const point of ['after_publish', 'before_consume']) test(`recovery after ${point} neither regenerates nor duplicates publication`, async t => {
  let injected = false; const f = await fixture(t, { hook: async name => { if (name === point && !injected) { injected = true; throw new Error('injected interruption'); } } });
  const { store } = await f.coordinator(); await f.service.submit({ requestId: 'resume', text: '需要机制与纵向证据' });
  await f.service.prepare({ store }); await f.service.prepare({ store }); assert.equal(f.calls(), 1);
  await verifyBusiness(store); await assert.rejects(f.service.publish({ store }), /interruption/);
  assert.equal((await f.log()).length, 1);
  const recovered = await f.coordinator('run-2');
  await f.service.prepare({ store: recovered.store }); assert.equal(f.calls(), 1);
  await verifyBusiness(recovered.store); await f.service.publish({ store: recovered.store }); await f.service.publish({ store: recovered.store });
  assert.equal((await f.log()).length, 1); assert.equal((await read(f.service.eventPath('resume'))).status, 'consumed');
});

test('prepared artifact reused after business failure and unknown in-flight generation fails closed', async t => {
  const f = await fixture(t); const { store } = await f.coordinator(); await f.service.submit({ requestId: 'held', text: '优先机制研究' });
  await f.service.prepare({ store }); const next = await f.coordinator('run-2'); await f.service.prepare({ store: next.store }); assert.equal(f.calls(), 1);
  const batch = await read(f.service.batchPath('run-1')); batch.status = 'preparing'; await fs.writeFile(f.service.batchPath('run-1'), JSON.stringify(batch));
  await f.service.prepare({ store }); assert.equal(f.calls(), 1);
  await verifyBusiness(next.store); assert.equal((await f.service.publish({ store: next.store })).status, 'pending'); assert.deepEqual(await f.log(), []);
});

test('conflicting additions/removals survive preparation and cannot be silently applied', async t => {
  const f = await fixture(t); const item = consolidateResearchSuggestions([keyword('mechanism'), { ...keyword('mechanism'), change_type: 'remove_keyword', rule_text: '移除检索词：mechanism' }])[0];
  const entry = normalizePendingRuleSuggestionCandidate(item); await fs.writeFile(path.join(f.reviewRoot, 'standards_rule_suggestions_log.json'), JSON.stringify({ suggestions: [entry] }));
  const rules = new RuleSuggestionService({ root: f.root, reviewRoot: f.reviewRoot, env: {} }); const before = await fs.readFile(f.config, 'utf8');
  await assert.rejects(rules.decide({ id: entry.id, decision: 'accepted', humanApproval: true }), /SEARCH_CHANGE_CONFLICT/);
  assert.equal(await fs.readFile(f.config, 'utf8'), before); assert.equal((await rules.list())[0].status, 'pending');
  await rules.decide({ id: entry.id, decision: 'revised', revisedRule: '添加可选检索词：longitudinal', humanApproval: true });
  assert.deepEqual((await read(f.config)).keyword_groups.optional, ['longitudinal']);
});

test('formal resume invokes publication before notification and after reconciliation without LLM', async t => {
  const f = await fixture(t); const coordinator = await f.coordinator(); const { store } = coordinator;
  await coordinator.persistArtifact([]); await f.service.submit({ requestId: 'resume-formal', text: '需要机制研究' }); await f.service.prepare({ store });
  let publishes = 0;
  const result = await resumeRunFromLedger({ runRoot: path.join(f.reviewRoot, 'runs'), runId: 'run-1', mode: 'web', profile: 'standard', configHash: 'a'.repeat(64),
    onBusinessVerified: async ({ store: recovered }) => { publishes++; return f.service.publish({ store: recovered }); },
    buildReconcilers: async ({ store: recovered }) => { await verifyBusiness(recovered); return {}; },
  });
  assert.equal(publishes, 2); assert.equal(f.calls(), 1); assert.equal(result.researchFeedback.status, 'published'); assert.equal((await f.log()).length, 1);
});

test('Radar Stage0 prepares after schedule claim and publishes before failed notification', async t => {
  const f = await fixture(t); const coordinator = await f.coordinator('radar-run', 'radar'); await f.service.submit({ requestId: 'radar', text: '更多机制研究' });
  const auditPath = path.join(f.root, 'radar_audit.json'); await fs.writeFile(auditPath, '{}'); const order = [];
  const service = { safely: async (method, store) => { order.push(method); return f.service.safely(method, store); } };
  const report = await runZoteroLiteratureFilter({ config: { platform: 'win32', repoRoot: f.root, projectRoot: f.root, researchRoot: f.researchRoot, reviewRoot: f.reviewRoot, pipelineDir: path.join(f.researchRoot, 'pipeline/fixture'), now },
    recoveryCoordinator: coordinator, researchEvaluationService: service, runId: 'radar-run', triggerMode: 'scheduled', runMode: { isManualOrForce: false }, clock: () => now, env: { PAPERECHO_RUN_PROFILE: 'radar' }, argv: [],
    scheduleDecisionClaimer: async ({ runId }) => { order.push('claim'); return { decision: 'radar', businessRunId: runId }; },
    readJson: async () => ({}), writeJson: async () => {}, writeReport: async () => {}, statArtifact: async file => ({ exists: file === auditPath, mtimeMs: now.getTime() }),
    runStage: async stage => { assert.equal(stage.name, 'stage1'); order.push('stage1'); assert.deepEqual(await f.log(), []); return { exitCode: 0, data: { triagedAll: [], radar: { auditPath, audit: { candidateCount: 0, zoteroWriteCount: 0, xlsxWriteCount: 0 }, urgentItems: [] } } }; },
    radarStage5Runner: async () => { order.push('notification'); assert.equal((await f.log()).length, 1); return { status: 'failed' }; },
  });
  assert.deepEqual(order, ['claim', 'prepare', 'stage1', 'publish', 'notification']); assert.equal(report.artifacts.research_feedback_publication.status, 'published');
});

for (const success of [true, false]) test(`Weekly Stage0 publishes only after fresh verified Stage4 (${success})`, async t => {
  const f = await fixture(t); const coordinator = await f.coordinator(); await f.service.submit({ requestId: 'weekly', text: '增加机制与纵向研究' });
  const outputPath = path.join(f.root, 'weekly.xlsx'); await fs.writeFile(outputPath, 'synthetic export');
  const audit = { stage4_export_status: success ? 'success' : 'failed', actual_output_path: outputPath };
  const report = await runZoteroLiteratureFilter({ config: { platform: 'win32', repoRoot: f.root, projectRoot: f.root, researchRoot: f.researchRoot, reviewRoot: f.reviewRoot, pipelineDir: path.join(f.researchRoot, 'pipeline/fixture'), now },
    recoveryCoordinator: coordinator, researchEvaluationService: f.service, runId: 'run-1', triggerMode: 'manual', runMode: { isManualOrForce: true }, clock: () => now, env: {}, argv: [], ensureStartupReady: async () => ({ ok: true }),
    readJson: async file => file.endsWith('writeback_ready_items.json') ? [] : file.endsWith('desktop_daily_review_source.json') ? { triaged: [] } : file.endsWith('zotero_writeback_summary.json') ? { writeback_items: [] } : file.endsWith('run_report.json') ? { steps: { stage4_export_audit: audit } } : {},
    statArtifact: async () => ({ exists: true, mtimeMs: now.getTime() }), writeJson: async () => {}, writeReport: async () => {},
    runStage: async stage => {
      assert.deepEqual(await f.log(), []);
      if (stage.name === 'stage2_writeback') await coordinator.store.setStage('stage2_writeback', 'verified');
      if (stage.name === 'stage3_translation') await coordinator.store.setStage('stage3_translation', 'verified');
      return { exitCode: 0, data: stage.name === 'stage4_exports' ? { runSummary: { counts: {}, artifacts: [] }, literatureItems: [] } : {} };
    },
    stage5Runner: async () => { assert.equal((await f.log()).length, 1); return { status: 'failed' }; },
  });
  assert.equal((await f.log()).length, Number(success)); assert.equal(f.calls(), 1);
  assert.equal((await read(f.service.eventPath('weekly'))).status, success ? 'consumed' : 'prepared');
  assert.equal(report.artifacts.research_feedback_publication?.status, success ? 'published' : undefined);
});
