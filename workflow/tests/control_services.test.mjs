import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { FeedbackService, readCanonicalFeedback, canonicalFeedbackPath, canonicalFeedbackActionRows, manualGradeFeedback } from '../tools/lib/control_feedback_service.mjs';
import { importLegacyWorkbook } from '../tools/lib/control_legacy_feedback_adapter.mjs';
import { ConfigService } from '../tools/lib/control_config_service.mjs';
import { getTranslationConfig } from '../tools/lib/title_translation_support.mjs';
import { getPreferenceLearningConfig } from '../tools/lib/preference_learning_support.mjs';
import { RuleSuggestionService } from '../tools/lib/control_rule_suggestion_service.mjs';
import { generateRuleSuggestionsFromFeedback } from '../tools/lib/screening_standards_rule_suggestions.mjs';
import { SecretService } from '../tools/lib/control_credentials_service.mjs';
import { processResearchEvaluation, processManualStandardEvaluation } from '../tools/stage1/manual_standard_evaluation.mjs';
import { syncScreeningStandardsDocx, processUserSuggestionDecisions } from '../tools/stage1/screening_standards_docx.mjs';
import { ruleSuggestionsLogPath } from '../tools/lib/screening_standards_paths.mjs';
import { writeUnifiedPendingRuleSuggestions } from '../tools/lib/unified_pending_rule_suggestions.mjs';

const base = fileURLToPath(new URL('./.control-test-tmp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'screening_standards.md'), '# 文献筛选标准\n\n## 优先关注\n\n* 基线规则\n\n## 相对降权\n');
  return root;
}
const paper = { doi: '10.1234/example', title: '中文 & 特殊字符 <script> — 文献' };

test('unsupported accept fails without recording success; reject remains available', async (t) => {
  const root = await fixture(t);
  const service = new RuleSuggestionService({ reviewRoot: root });
  const file = ruleSuggestionsLogPath(root);
  await fs.writeFile(file, JSON.stringify({ suggestions: [{ id: 'high', status: 'pending', target: 'pubmed_pmc_search.json', risk_level: 'high', rule_text: '删除检索词' }] }));
  const before = await fs.readFile(path.join(root, 'screening_standards.md'), 'utf8');
  const input = { id: 'high', decision: 'accepted', humanApproval: true };
  await assert.rejects(service.decideWithReceipt(input), /FORMAL_MUTATION_OWNER_UNVERIFIED/);
  const [item] = await new RuleSuggestionService({ reviewRoot: root }).list();
  assert.equal(item.status, 'pending'); assert.equal(item.decision_history, undefined);
  assert.equal(item.decision_receipt, undefined);
  assert.equal(await fs.readFile(path.join(root, 'screening_standards.md'), 'utf8'), before);
  await service.decideWithReceipt({ ...input, decision: 'rejected' });
  assert.equal((await service.list())[0].decision_receipt, undefined);
});

test('suggestion quality rejects placeholders and English prose, retains Chinese technical rules', async () => {
  const { generateUnifiedPendingRuleSuggestions } = await import('../tools/lib/unified_pending_rule_suggestions.mjs');
  const rules = ['优先关注example topic term 038相关研究', '优先关注\uFFFD研究', 'Prefer animal studies with strong mechanism evidence', '优先关注 EGFR 机制研究'];
  const result = generateUnifiedPendingRuleSuggestions({ legacySuggestions: rules.map((rule_text) => ({ rule_text })) });
  assert.equal(result.invalid_content_count, 3); assert.equal(result.added_count, 1);
  assert.equal(result.added[0].rule_text, rules[3]);
});
test('feedback rule proposals need repeated, non-conflicting evidence and use Chinese topic labels', () => {
  const drop = (title) => ({ feedback: 'drop', english_title: title });
  const upgrade = (title) => ({ feedback: 'upgrade', english_title: title });
  const generate = (feedbackSignals) => generateRuleSuggestionsFromFeedback({ feedbackSignals, generatedAt: '2026-09-22T00:00:00Z' }).suggestions;
  assert.equal(generate([drop('Cell line study')]).length, 0);
  assert.equal(generate([drop('Cell line study'), upgrade('Cell line comparison')]).length, 0);
  const repeated = generate([drop('Cell line study A'), drop('Cell line study B')]);
  assert.equal(repeated.length, 1);
  assert.match(repeated[0].suggested_rule, /降权体外细胞实验相关研究/);
  assert.doesNotMatch(repeated[0].suggested_rule, /example topic term|cell line/i);
});
test('malformed historical suggestion cannot be accepted but can be revised or rejected', async (t) => {
  const root = await fixture(t);
  const file = ruleSuggestionsLogPath(root);
  await fs.writeFile(file, JSON.stringify({ suggestions: [
    { id: 'bad', status: 'pending', target: 'screening_standards.md', rule_text: '优先关注example topic term 038相关研究' },
    { id: 'other', status: 'pending', target: 'screening_standards.md', rule_text: 'Prefer animal studies with strong evidence' },
  ] }));
  const service = new RuleSuggestionService({ reviewRoot: root });
  await assert.rejects(service.decideWithReceipt({ id: 'bad', decision: 'accepted', humanApproval: true }), /SUGGESTION_CONTENT_INVALID/);
  assert.equal((await service.list()).find((entry) => entry.id === 'bad').decision_receipt, undefined);
  await service.decide({ id: 'bad', decision: 'revised', revisedRule: '优先关注体外细胞实验研究', humanApproval: true });
  await service.decide({ id: 'other', decision: 'rejected', humanApproval: true });
  assert.match(await fs.readFile(path.join(root, 'screening_standards.md'), 'utf8'), /优先关注体外细胞实验研究/);
});
const input = (requestId, value = 'relevant') => ({ kind: 'paper_feedback', paper, requestId, value });
test('paper feedback history/current, duplicate, conflict, identity and atomic failure', async (t) => {
  const root = await fixture(t);
  const service = new FeedbackService({ reviewRoot: root });
  assert.equal((await service.submit(input('one'))).revision, 1);
  assert.equal((await service.submit(input('one'))).duplicate, true);
  await assert.rejects(service.submit(input('one', 'irrelevant')), /CONFLICT/);
  await service.submit(input('two', 'do_not_recommend_similar'));
  assert.equal((await service.current())[0].feedback, 'drop');
  assert.equal((await readCanonicalFeedback(root)).history.length, 2);
  const actionRows = canonicalFeedbackActionRows(await readCanonicalFeedback(root), root);
  assert.equal(actionRows.length, 1);
  assert.equal(actionRows[0].feedback, 'drop');
  assert.equal(actionRows[0].doi, '10.1234/example');
  assert.equal(actionRows[0].title_key, '');
  await assert.rejects(service.submit({ ...input('bad'), paper: { title: 'only title' } }), /IDENTITY/);
  const before = await fs.readFile(canonicalFeedbackPath(root), 'utf8');
  const failing = new FeedbackService({ reviewRoot: root, atomicOptions: { renameImpl: async () => { throw new Error('injected'); } } });
  await assert.rejects(failing.submit(input('fail')), /injected/);
  assert.equal(await fs.readFile(canonicalFeedbackPath(root), 'utf8'), before);
  assert.equal((await fs.readdir(root)).some((name) => name.endsWith('.tmp')), false);
  await assert.rejects(service.submitPaperBatch([input('batch'), { ...input('invalid'), paper: {} }]), /IDENTITY/);
  assert.equal(await fs.readFile(canonicalFeedbackPath(root), 'utf8'), before);
});
test('concurrent feedback submissions retain both revisions', async (t) => {
  const root = await fixture(t);
  const service = new FeedbackService({ reviewRoot: root });
  await Promise.all([service.submit(input('a')), service.submit(input('b', 'maybe'))]);
  assert.equal((await readCanonicalFeedback(root)).history.length, 2);
});
test('direct manual grade keeps system evidence and derives the legacy learning action', async (t) => {
  const root = await fixture(t);
  const service = new FeedbackService({ reviewRoot: root });
  const reviewed = { ...paper, final_grade: 'C', rule_grade: 'B', llm_review_grade: 'D' };
  await service.submit({ kind: 'manual_grade', paper: reviewed, manualGrade: 'A', requestId: 'manual-a' });
  await service.submit({ kind: 'manual_grade', paper: reviewed, manualGrade: 'D', requestId: 'manual-d' });
  const state = await readCanonicalFeedback(root);
  assert.deepEqual(state.history.map((entry) => entry.manual_grade), ['A', 'D']);
  assert.deepEqual(state.history.map((entry) => entry.original_final_grade), ['C', 'C']);
  assert.deepEqual(state.history.map((entry) => entry.feedback), ['upgrade', 'drop']);
  assert.deepEqual([reviewed.rule_grade, reviewed.llm_review_grade, reviewed.final_grade], ['B', 'D', 'C']);
  assert.equal(canonicalFeedbackActionRows(state, root)[0].feedback, 'drop');
  assert.equal(manualGradeFeedback('B', 'B'), 'keep');
  assert.equal(manualGradeFeedback('B', 'C'), 'downgrade');
  await assert.rejects(service.submit({ kind: 'manual_grade', paper: reviewed, manualGrade: 'E', requestId: 'manual-invalid' }), /MANUAL_GRADE_INVALID/);
});
test('legacy XLSX one-way import is idempotent and does not modify source', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'weekly.xlsx');
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('每日反馈');
  sheet.addRows([['DOI', '英文标题', '反馈'], [paper.doi, paper.title, 'upgrade']]);
  await book.xlsx.writeFile(file);
  const before = await fs.readFile(file);
  const service = new FeedbackService({ reviewRoot: root });
  assert.equal((await importLegacyWorkbook(file, service)).imported, 1);
  assert.equal((await importLegacyWorkbook(file, service)).duplicate, 1);
  assert.deepEqual(await fs.readFile(file), before);
  sheet.addRow(['', 'ambiguous title', 'drop']);
  await book.xlsx.writeFile(file);
  assert.equal((await importLegacyWorkbook(file, service)).imported, 0);
  assert.equal((await readCanonicalFeedback(root)).history.length, 1);
});
test('config valid round trip and invalid/verification failure preserve old values', async (t) => {
  const root = await fixture(t);
  const file = path.join(root, 'config', 'title_translation.config.json');
  await fs.writeFile(file, JSON.stringify({ model: 'old', temperature: 0 }));
  const reviewFile = path.join(root, 'config', 'review-workflow-rules.json');
  await fs.writeFile(reviewFile, JSON.stringify({ llm_review: { preference_learning_enabled: true } }));
  const service = new ConfigService({ root });
  assert.equal((await service.list()).find((entry) => entry.id === 'translation.enabled').value, true);
  await service.update('preference.enabled', false);
  assert.equal(JSON.parse(await fs.readFile(reviewFile)).llm_review.preference_learning_enabled, false);
  await service.update('translation.model', 'new');
  assert.equal(JSON.parse(await fs.readFile(file)).model, 'new');
  await service.updateMany([{ id: 'translation.enabled', value: false }, { id: 'review.enabled', value: true }]);
  assert.equal(JSON.parse(await fs.readFile(file)).enabled, false);
  assert.equal(JSON.parse(await fs.readFile(reviewFile)).llm_review.grade_review_enabled, true);
  await assert.rejects(service.update('translation.temperature', 9), /INVALID/);
  let calls = 0;
  const failing = new ConfigService({ root, verify: async () => { if (++calls === 2) throw new Error('verify'); } });
  await assert.rejects(failing.update('translation.model', 'bad'), /verify/);
  assert.equal(JSON.parse(await fs.readFile(file)).model, 'new');
  await assert.rejects(service.update('../outside', true), /UNKNOWN/);
  await assert.rejects(service.update('rss.sources', [{ name: 'bad', url: 'javascript:alert(1)', enabled: true }]), /INVALID/);
  await assert.rejects(service.updateMany([{ id: 'translation.model', value: 'one' }, { id: 'translation.model', value: 'two' }]), /BATCH_INVALID/);
});
test('missing model owners remain configurable and initialize atomically on first save', async (t) => {
  const root = await fixture(t); const service = new ConfigService({ root });
  const listed = await service.list();
  for (const id of ['translation.enabled', 'translation.model', 'review.enabled', 'preference.enabled', 'preference.model']) assert.equal(listed.find((entry) => entry.id === id).available, true);
  await service.update('translation.enabled', false);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'config', 'title_translation.config.json'), 'utf8')).enabled, false);
  await service.updateMany([{ id: 'review.master', value: true }, { id: 'review.enabled', value: true }, { id: 'preference.enabled', value: true }]);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'config', 'review-workflow-rules.json'), 'utf8')).llm_review, { enabled: true, grade_review_enabled: true, preference_learning_enabled: true });
});
test('v2.3 model config paths and review master switch use the same formal owners as the workflow', async (t) => {
  const root = await fixture(t);
  const translation = path.join(root, 'legacy-translation.json');
  const preference = path.join(root, 'legacy-preference.json');
  const review = path.join(root, 'config', 'review-workflow-rules.json');
  await fs.writeFile(translation, JSON.stringify({ model: 'legacy-translation', endpoint: 'https://translation.example/v1/chat/completions', temperature: 0.2 }));
  await fs.writeFile(preference, JSON.stringify({ model: 'legacy-preference', endpoint: 'https://preference.example/v1/chat/completions', temperature: 0.3 }));
  await fs.writeFile(review, JSON.stringify({ llm_review: { enabled: false, grade_review_enabled: true, preference_learning_enabled: true } }));
  const env = { TITLE_TRANSLATION_CONFIG_PATH: translation, PREFERENCE_LEARNING_CONFIG_PATH: preference };
  const service = new ConfigService({ root, env });
  const listed = await service.list();
  assert.equal(listed.find((entry) => entry.id === 'translation.model').value, 'legacy-translation');
  assert.equal(listed.find((entry) => entry.id === 'preference.model').value, 'legacy-preference');
  assert.equal(listed.find((entry) => entry.id === 'review.master').value, false);
  await service.updateMany([
    { id: 'translation.model', value: 'saved-translation' },
    { id: 'preference.model', value: 'saved-preference' },
    { id: 'review.master', value: true },
    { id: 'review.enabled', value: true },
    { id: 'preference.enabled', value: true },
  ]);
  assert.equal(getTranslationConfig({ env }).model, 'saved-translation');
  assert.equal(getPreferenceLearningConfig({ env }).model, 'saved-preference');
  const workflowRules = JSON.parse(await fs.readFile(review, 'utf8')).llm_review;
  assert.equal(workflowRules.enabled && workflowRules.grade_review_enabled && workflowRules.preference_learning_enabled, true);
  await assert.rejects(fs.access(path.join(root, 'config', 'title_translation.config.json')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(root, 'config', 'preference_learning.config.json')), { code: 'ENOENT' });
});
test('config batch rolls every owner back when post-write verification fails', async (t) => {
  const root = await fixture(t); const translation = path.join(root, 'config', 'title_translation.config.json'); const review = path.join(root, 'config', 'review-workflow-rules.json');
  await fs.writeFile(translation, JSON.stringify({ model: 'old' })); await fs.writeFile(review, JSON.stringify({ llm_review: { grade_review_enabled: false } }));
  let calls = 0; const service = new ConfigService({ root, verify: async () => { calls += 1; if (calls === 3) throw new Error('post-write'); } });
  await assert.rejects(service.updateMany([{ id: 'translation.model', value: 'new' }, { id: 'review.enabled', value: true }]), /post-write/);
  assert.equal(JSON.parse(await fs.readFile(translation)).model, 'old'); assert.equal(JSON.parse(await fs.readFile(review)).llm_review.grade_review_enabled, false);
});
test('runner settings remain available before first local config and initialize through the formal owner', async (t) => {
  const root = await fixture(t);
  const example = path.join(root, 'config', 'paperecho.config.example.json');
  await fs.writeFile(example, JSON.stringify({ schemaVersion: 2, mode: null, profile: 'standard', common: {}, desktop: { enabled: false }, web: { enabled: false, userId: null }, local: { enabled: false, input: null, outputRoot: null, feedback: null } }));
  const service = new ConfigService({ root, runtimeMode: 'desktop' });
  const mode = (await service.list()).find((entry) => entry.id === 'runtime.mode');
  assert.equal(mode.available, true); assert.equal(mode.ownerPresent, false); assert.equal(mode.effectiveValue, 'desktop');
  await service.updateMany([{ id: 'runtime.mode', value: 'local' }, { id: 'local.input', value: 'fixture.jsonl' }, { id: 'local.output', value: 'fixture-output' }]);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'config', 'paperecho.config.json'), 'utf8'));
  assert.equal(saved.mode, 'local'); assert.equal(saved.local.input, 'fixture.jsonl'); assert.equal(saved.local.outputRoot, 'fixture-output');
});
test('failed first runner settings write removes the newly initialized owner', async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'config', 'paperecho.config.example.json'), JSON.stringify({ schemaVersion: 2, mode: null, profile: 'standard', common: {}, desktop: {}, web: {}, local: {} }));
  let calls = 0; const service = new ConfigService({ root, verify: async () => { if (++calls === 2) throw new Error('post-write'); } });
  await assert.rejects(service.update('runtime.mode', 'desktop'), /post-write/);
  await assert.rejects(fs.access(path.join(root, 'config', 'paperecho.config.json')), { code: 'ENOENT' });
});
test('suggestion accept/reject/revise use formal owner; high-risk add applies and unverified targets fail closed', async (t) => {
  const root = await fixture(t);
  const suggestions = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, suggestion_id: id, status: 'pending', target: 'screening_standards.md', change_type: 'add_rule', rule_text: `优先关注 ${id}` }));
  suggestions[3].risk_level = 'high'; suggestions[3].decision_receipt = { requested_decision: 'accepted', application_status: 'requires_manual_action' };
  suggestions[4].target = 'review-workflow-rules.json';
  await fs.writeFile(ruleSuggestionsLogPath(root), JSON.stringify({ suggestions }));
  const service = new RuleSuggestionService({ reviewRoot: root });
  await assert.rejects(service.decide({ id: 'a', decision: 'accepted' }), /APPROVAL/);
  await service.decide({ id: 'a', decision: 'accepted', humanApproval: true });
  await service.decide({ id: 'b', decision: 'rejected', humanApproval: true });
  await service.decide({ id: 'c', decision: 'revised', revisedRule: '修订后的范围', humanApproval: true });
  assert.match(await fs.readFile(path.join(root, 'screening_standards.md'), 'utf8'), /修订后的范围/);
  await service.decide({ id: 'd', decision: 'accepted', humanApproval: true });
  assert.match(await fs.readFile(path.join(root, 'screening_standards.md'), 'utf8'), /优先关注 d/);
  assert.equal((await service.list()).find((entry) => entry.id === 'd').decision_receipt, undefined);
  await assert.rejects(service.decide({ id: 'e', decision: 'accepted', humanApproval: true }), /UNVERIFIED/);
  const blocked = new RuleSuggestionService({ reviewRoot: root, noFormalRuleApply: true });
  await assert.rejects(blocked.decide({ id: 'e', decision: 'accepted', humanApproval: true }), /NO_FORMAL/);
  const result = await processUserSuggestionDecisions({ suggestions_table: [['建议ID', '状态'], ['e', 'accept']] }, { reviewRoot: root });
  assert.equal(result.receipts[0].status, 'blocked');
  await writeUnifiedPendingRuleSuggestions(ruleSuggestionsLogPath(root), { suggestions });
  assert.equal((await service.list()).find((entry) => entry.id === 'a').status, 'accepted');
});
test('accepted deletion, revision and PubMed keyword changes update the formal owners', async (t) => {
  const root = await fixture(t);
  const md = path.join(root, 'screening_standards.md');
  await fs.writeFile(md, '# 标准\n\n## 优先关注\n\n* 旧规则\n* 保留规则\n\n## 相对降权\n');
  const pubmed = path.join(root, 'config', 'pubmed_pmc_search.json');
  await fs.writeFile(pubmed, JSON.stringify({ query: '(old OR base)', keyword_groups: { required: [['old', 'base']], optional: ['optional'], negative: [] }, days_back: 10 }));
  await fs.writeFile(ruleSuggestionsLogPath(root), JSON.stringify({ suggestions: [
    { id: 'delete', status: 'pending', target: 'screening_standards.md', change_type: 'delete_rule', risk_level: 'high', rule_text: '旧规则' },
    { id: 'revise', status: 'pending', target: 'screening_standards.md', change_type: 'revise_rule', rule_text: '将“保留规则”修改为“优先关注临床机制研究”' },
    { id: 'revise2', status: 'pending', target: 'screening_standards.md', change_type: 'revise_rule', rule_text: '将“优先关注临床机制研究”修改为“优先关注临床研究”' },
    { id: 'keyword', status: 'pending', target: 'pubmed_pmc_search.json', change_type: 'add_keyword', risk_level: 'high', rule_text: '添加必含检索词：新词' },
    { id: 'remove', status: 'pending', target: 'pubmed_pmc_search.json', change_type: 'remove_keyword', risk_level: 'high', rule_text: '移除检索词：optional' },
  ] }));
  const service = new RuleSuggestionService({ reviewRoot: root, pubmedConfigPath: pubmed });
  for (const id of ['delete', 'revise', 'keyword', 'remove']) {
    const receipt = await service.decide({ id, decision: 'accepted', humanApproval: true });
    assert.equal(receipt.application_status, 'applied'); assert.equal(receipt.formal_rules_modified, true);
  }
  assert.equal((await service.decide({ id: 'revise2', decision: 'revised', revisedRule: '优先关注临床转化研究', humanApproval: true })).application_status, 'applied');
  const text = await fs.readFile(md, 'utf8');
  assert.doesNotMatch(text, /旧规则|保留规则|优先关注临床机制研究/); assert.match(text, /优先关注临床转化研究/);
  const search = JSON.parse(await fs.readFile(pubmed, 'utf8'));
  assert.equal(search.days_back, 10);
  assert.deepEqual(search.keyword_groups.required, [['old', 'base'], ['新词']]);
  assert.deepEqual(search.keyword_groups.optional, []);
  assert.match(search.query, /新词/);
  assert.equal((await service.list()).filter((item) => item.status === 'accepted').length, 4);
  assert.equal((await service.list()).find((item) => item.id === 'revise2').status, 'revised');
});
test('ambiguous or custom search changes never mark suggestions accepted', async (t) => {
  const root = await fixture(t);
  const pubmed = path.join(root, 'config', 'pubmed_pmc_search.json');
  await fs.writeFile(pubmed, JSON.stringify({ query: 'custom query', keyword_groups: { required: [['old']], optional: [], negative: [] } }));
  await fs.writeFile(ruleSuggestionsLogPath(root), JSON.stringify({ suggestions: [
    { id: 'missing', status: 'pending', target: 'screening_standards.md', change_type: 'delete_rule', rule_text: '不存在的规则' },
    { id: 'custom', status: 'pending', target: 'pubmed_pmc_search.json', change_type: 'add_keyword', rule_text: '添加必含检索词：新词' },
  ] }));
  const service = new RuleSuggestionService({ reviewRoot: root, pubmedConfigPath: pubmed });
  const before = await fs.readFile(pubmed, 'utf8');
  await assert.rejects(service.decide({ id: 'missing', decision: 'accepted', humanApproval: true }), /EXACT_MATCH/);
  await assert.rejects(service.decide({ id: 'custom', decision: 'accepted', humanApproval: true }), /CUSTOM_UNVERIFIED/);
  assert.equal(await fs.readFile(pubmed, 'utf8'), before);
  assert.equal((await service.list()).filter((item) => item.status === 'pending').length, 2);
});
test('substring duplicate and atomic write failure cannot falsely accept a rule', async (t) => {
  const root = await fixture(t);
  const md = path.join(root, 'screening_standards.md');
  await fs.writeFile(md, '# 标准\n\n## 优先关注\n\n* 优先关注临床机制研究\n\n## 相对降权\n');
  await fs.writeFile(ruleSuggestionsLogPath(root), JSON.stringify({ suggestions: [
    { id: 'substring', status: 'pending', target: 'screening_standards.md', change_type: 'add_rule', rule_text: '优先关注临床机制' },
    { id: 'atomic', status: 'pending', target: 'screening_standards.md', change_type: 'add_rule', rule_text: '优先关注组学研究' },
  ] }));
  const before = await fs.readFile(md, 'utf8');
  const service = new RuleSuggestionService({ reviewRoot: root });
  await assert.rejects(service.decide({ id: 'substring', decision: 'accepted', humanApproval: true }), /FORMAL_RULE_APPLY_FAILED/);
  const failing = new RuleSuggestionService({ reviewRoot: root, atomicOptions: { renameImpl: async () => { throw new Error('injected'); } } });
  await assert.rejects(failing.decide({ id: 'atomic', decision: 'accepted', humanApproval: true }), /injected/);
  assert.equal(await fs.readFile(md, 'utf8'), before);
  assert.equal((await service.list()).filter((item) => item.status === 'pending').length, 2);
});
test('text and DOCX evaluation share proposal core, text never changes DOCX', async (t) => {
  const root = await fixture(t);
  const pubmedConfigPath = path.join(root, 'config', 'pubmed_pmc_search.json');
  await fs.writeFile(pubmedConfigPath, JSON.stringify({ keyword_groups: { required: ['test'], optional: [], negative: [] } }));
  const text = '希望增加机制研究';
  await syncScreeningStandardsDocx(root, { pubmedConfigPath, evaluationText: text });
  const docxPath = path.join(root, 'screening_standards.docx');
  const before = await fs.readFile(docxPath);
  const llmClient = async () => ({ rules_added: ['优先关注机制研究'], rules_deleted: [], rules_changed: [], keywords_added: { required: ['EGFR'], optional: [], negative: [] }, keywords_removed: [], negative_keywords_added: [], unmapped_feedback: [] });
  const options = { reviewRoot: root, pubmedConfigPath, llmClient };
  const direct = await processResearchEvaluation(text, options);
  assert.equal(direct.evaluation_processed, true);
  assert.equal(direct.applied, false);
  assert.deepEqual(await fs.readFile(docxPath), before);
  const legacy = await processManualStandardEvaluation(options);
  assert.equal(legacy.evaluation_text_hash, direct.evaluation_text_hash);
  assert.deepEqual(legacy.rules_added, direct.rules_added);
  assert.ok((await fs.readFile(ruleSuggestionsLogPath(root), 'utf8')).includes('添加必含检索词：EGFR'));
});
test('secret status never returns raw values and redaction removes supplied secrets', async () => {
  const service = new SecretService({ env: { SMTP_PASS: 'unique-test-secret' } });
  assert.equal(JSON.stringify(await service.list()).includes('unique-test-secret'), false);
  assert.equal(service.redact('failure unique-test-secret Bearer xyz'), 'failure [REDACTED] Bearer [REDACTED]');
  await assert.rejects(service.replace('SMTP_PASS', 'new'), /UNAVAILABLE/);
});
