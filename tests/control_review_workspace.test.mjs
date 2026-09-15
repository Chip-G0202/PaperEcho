import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FeedbackService, PAPER_FEEDBACK, readCanonicalFeedback } from '../workflow/tools/lib/control_feedback_service.mjs';
import { ReviewQueryService } from '../workflow/tools/lib/control_review_query_service.mjs';
import { getWeeklyReviewEvidence } from '../workflow/tools/stage4/spreadsheet_adapter.mjs';

const script = await fs.readFile(new URL('../workflow/tools/web/static/app.js', import.meta.url), 'utf8');
// Minimal DOM test double for event wiring, not layout or browser conformance.
// Real browser verification remains required for keyboard focus and rendering.
class Element {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.className = ''; this.value = ''; this.ownText = ''; this.style = {}; }
  set textContent(value) { this.ownText = String(value); this.children = []; }
  get textContent() { return this.ownText + this.children.map((node) => node.textContent).join(' '); }
  append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children.forEach((node) => { node.parentElement = null; }); this.ownText = ''; this.children = []; this.append(...nodes); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  removeAttribute(name) { delete this.attrs[name]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  matches(selector) {
    return selector.split(',').some((part) => {
      part = part.trim();
      if (part.startsWith('.')) return this.className.split(' ').includes(part.slice(1));
      if (part === '[contenteditable]:not([contenteditable="false"])') return this.attrs.contenteditable !== undefined && this.attrs.contenteditable !== 'false';
      const attr = part.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
      if (attr) { const value = attr[1].startsWith('data-') ? this.dataset[attr[1].slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] : this.attrs[attr[1]]; return value !== undefined && (attr[2] === undefined || value === attr[2]); }
      if (part === 'input:checked') return this.tagName === 'INPUT' && this.checked;
      return this.tagName.toLowerCase() === part;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = null; }
  focus() { this.focused = true; }
  checkValidity() { return true; }
  get isConnected() { return Boolean(this.parentElement); }
  async click() { if (!this.disabled) await this.listeners.click?.({ target: this }); }
}
function ui() {
  const main = new Element('main'); const notice = new Element('p');
  const nodes = { '#content': main, '#notice': notice, '#page-title': new Element('h1'), '#menu-toggle': new Element('button') };
  const context = vm.createContext({ document: { querySelector: (key) => nodes[key], querySelectorAll: () => [], createElement: (tag) => new Element(tag) }, window: { addEventListener() {} }, fetch: () => new Promise(() => {}), crypto: { randomUUID }, URL, structuredClone, location: { hash: '' } });
  vm.runInContext(script + '\nglobalThis.testing = { createReviewQueue, shortcutAction, gradeCounts, loadWeekly, home, weekly, paperReview, research, suggestions, settings, settingGroups, demoMode, demoPapers, setApi: (value) => { api = value; } };', context);
  return { ...context.testing, main, notice };
}
const papers = (count = 100) => Array.from({ length: count }, (_, i) => ({ id: String(i), title: `English ${i} — ${'long title '.repeat(i === 0 ? 80 : 1)}`, translatedTitle: `中文副标题 ${i}`, authors: ['测试作者'], finalGrade: ['A', 'B', 'C'][i % 3], ruleGrade: 'B', semanticGrade: 'A', needsReview: i === count - 1, reviewReason: i === count - 1 ? '既有等级复审依据' : '', source: 'PubMed', journal: 'Journal', year: '2026', doi: i ? '' : '10.1234/test', pmid: String(1000 + i), zotero: 'not_used_local', feedbackAllowed: true, feedback: null }));
const byText = (root, text) => root.querySelectorAll('button').find((node) => node.textContent === text);
const work = (root) => root.querySelector('.review-workspace');
const currentTitle = (root) => root.querySelector('article')?.querySelector('h3')?.textContent;
async function key(workspace, value, target = workspace, extra = {}) {
  const event = { key: value, target, preventDefault() { this.defaultPrevented = true; }, ...extra };
  workspace.listeners.keydown(event); await new Promise((resolve) => setImmediate(resolve)); return event;
}
test('Weekly view model reuses exporter grade precedence and every legacy manual-review alias', async () => {
  const source = papers(10).map((item, i) => ({ ...item, title: `paper-${i}`, rule_grade: 'B专题相关', final_grade: 'C领域相关', llm_review_grade: 'A', semantic_grade: 'D', semantic_reason: '原有依据', doi: `10.1234/${i}` }));
  const flags = [{ needs_human_review: true }, { needsHumanReview: true }, { review_required: true }, { reviewRequired: true }, { semantic_review: { needs_human_review: true } }, { semantic_review: { review_required: true } }, { semantic_mismatch: true }, { semantic_rescue: true }];
  source.forEach((item, i) => Object.assign(item, flags[i] || {}));
  const before = JSON.stringify(source); const query = new ReviewQueryService({ root: process.cwd(), feedback: { current: async () => [] }, rules: {} });
  query.latestWeeklyData = async () => ({ run: { runId: 'fixture' }, items: source });
  const data = await query.weekly();
  assert.deepEqual(data.items.map((item) => item.needsReview), source.map((item) => getWeeklyReviewEvidence(item).needsReview));
  assert.equal(data.items.filter((item) => item.needsReview).length, 8);
  assert.equal(data.items[0].ruleGrade, 'B'); assert.equal(data.items[0].semanticGrade, 'A'); assert.equal(data.items[0].finalGrade, 'C'); assert.equal(data.items[0].grade, 'C');
  assert.equal(data.items[0].reviewReason, '原有依据'); assert.equal(JSON.stringify(source), before);
});
test('Literature shows only compact A/B/C cards and filters without feedback actions', async () => {
  const app = ui(); const items = papers(101); items[100].finalGrade = 'D';
  items[0].abstract = '不应显示的摘要'; items[0].reviewReason = '不应显示的复审依据';
  app.setApi(async () => ({ total: items.length, runId: 'fixture', items })); await app.weekly();
  assert.equal(app.main.querySelectorAll('article').length, 50);
  assert.match(app.main.textContent, /本次共 100 篇/);
  assert.match(app.main.textContent, /A级 34 · B级 33 · C级 33/);
  assert.doesNotMatch(app.main.textContent, /去反馈|前往论文反馈|保存反馈|升级 1|D级|不应显示的摘要|不应显示的复审依据|作者：|Zotero：/);
  assert.ok(app.main.textContent.indexOf(items[0].title) < app.main.textContent.indexOf(items[0].translatedTitle));
  assert.match(app.main.querySelector('section').className, /document-column/);
  await byText(app.main, 'A级 34').click(); assert.equal(app.main.querySelectorAll('article').length, 34);
});
test('Weekly pagination fetches beyond 200; a changed run fails closed', async () => {
  const app = ui(); const items = papers(1000); const requests = [];
  app.setApi(async (url) => { requests.push(url); const offset = Number(new URL(url, 'http://local').searchParams.get('offset')); return { runId: 'fixture', total: 1000, items: items.slice(offset, offset + 200) }; });
  assert.equal((await app.loadWeekly()).items.length, 1000); assert.equal(requests.length, 5);
  app.setApi(async (url) => ({ runId: url.includes('offset=0&') ? 'first' : 'changed', total: 1000, items: items.slice(0, 200) }));
  await assert.rejects(app.loadWeekly(), /文献已更新/);
});
test('single paper card: immediate click saves existing values, advances, revisit changes with history', async (t) => {
  const base = new URL('./runs/control-review/', import.meta.url); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(fileURLToPath(base), 'feedback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new FeedbackService({ reviewRoot: root }); const items = papers(); items[0].finalGrade = 'B'; const before = items.map((item) => [item.ruleGrade, item.semanticGrade, item.finalGrade]);
  const app = ui(); const calls = [];
  app.setApi(async (url, payload) => { if (!payload) return { runId: 'fixture', total: items.length, items }; calls.push(payload); return service.submit({ kind: 'paper_feedback', paper: items.find((item) => item.id === payload.paperId), ...payload }); });
  await app.paperReview(); assert.equal(app.main.querySelectorAll('article').length, 1); assert.doesNotMatch(app.main.textContent, /保存反馈/);
  await byText(app.main, '升级 1').click(); assert.equal(calls[0].value, 'highly_relevant'); assert.equal(currentTitle(app.main), items[1].title);
  await key(work(app.main), 'ArrowUp'); assert.equal(currentTitle(app.main), items[0].title); assert.equal(byText(app.main, '升级 1').getAttribute('aria-pressed'), 'true');
  // Await the click handler's save promise before inspecting the on-disk audit.
  await byText(app.main, '降级 3').click(); assert.equal(calls[1].value, 'maybe');
  const state = await readCanonicalFeedback(root); assert.deepEqual(state.history.map((entry) => entry.feedback), ['upgrade', 'downgrade']); assert.deepEqual(state.history.map((entry) => entry.revision), [1, 2]);
  assert.deepEqual(items.map((item) => [item.ruleGrade, item.semanticGrade, item.finalGrade]), before);
  assert.equal(PAPER_FEEDBACK.relevant, 'keep'); assert.equal(PAPER_FEEDBACK.irrelevant, 'drop');
  await byText(app.main, '需人工复核 1').click(); assert.match(app.main.textContent, /规则评级.*语义评级.*最终评级/); assert.equal(currentTitle(app.main), items[99].title);
  assert.equal(byText(app.main, 'A 1').disabled, false); assert.equal(byText(app.main, 'D 4').disabled, false); assert.doesNotMatch(app.main.textContent, /最终评级是否正确？|升级 1/);
});
test('save failure keeps card and selection, bounded concurrent submissions, retry reuses request id', async () => {
  const app = ui(); const items = papers(3); const calls = []; let reject;
  app.setApi(async (url, payload) => { if (!payload) return { runId: 'fixture', total: 3, items }; calls.push(payload); if (calls.length === 1) return new Promise((_, fail) => { reject = fail; }); return { revision: 1 }; });
  await app.paperReview(); const click = byText(app.main, '不变 2').click();
  await key(work(app.main), '4'); await key(work(app.main), 'ArrowDown'); assert.equal(calls.length, 1); assert.equal(currentTitle(app.main), items[0].title);
  reject(new Error('保存失败')); await click;
  assert.equal(currentTitle(app.main), items[0].title); assert.equal(items[0].feedback, null); assert.match(app.main.textContent, /当前文献未前进/);
  await byText(app.main, '不变 2').click(); assert.equal(calls[1].requestId, calls[0].requestId); assert.equal(currentTitle(app.main), items[1].title);
});
test('keyboard 1/2/3/4 and arrows operate only in workspace; input/editor/combinations suppressed', async () => {
  const app = ui(); const items = papers(8); items.forEach((item) => { item.finalGrade = 'B'; }); const calls = [];
  app.setApi(async (url, payload) => { if (!payload) return { runId: 'fixture', total: 8, items }; calls.push(payload); return { revision: calls.length }; });
  await app.paperReview();
  for (const tag of ['input', 'textarea', 'select', 'div', 'section']) {
    const input = new Element(tag); if (tag === 'div') input.setAttribute('contenteditable', 'true'); if (tag === 'section') input.setAttribute('role', 'dialog');
    const event = await key(work(app.main), '1', input); assert.equal(event.defaultPrevented, undefined);
  }
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { repeat: true }, { isComposing: true }]) await key(work(app.main), '1', work(app.main), extra);
  assert.equal(calls.length, 0);
  for (const value of ['1', '2', '3', '4']) await key(work(app.main), value);
  assert.deepEqual(calls.map((entry) => entry.value), ['highly_relevant', 'relevant', 'maybe', 'irrelevant']);
  await key(work(app.main), 'ArrowUp'); assert.equal(currentTitle(app.main), items[3].title);
  await key(work(app.main), 'ArrowDown'); assert.equal(currentTitle(app.main), items[4].title);
});
test('manual review saves direct A/B/C/D grades, advances on success and preserves history', async (t) => {
  const base = new URL('./runs/control-review/', import.meta.url); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(fileURLToPath(base), 'manual-grade-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new FeedbackService({ reviewRoot: root }); const items = papers(3);
  items.forEach((item, index) => { item.needsReview = true; item.finalGrade = ['B', 'C', 'A'][index]; });
  const before = items.map((item) => [item.ruleGrade, item.semanticGrade, item.finalGrade]);
  const calls = []; const app = ui();
  app.setApi(async (url, payload) => {
    if (!payload) return { runId: 'manual-run', total: items.length, items };
    calls.push(payload); const paper = items.find((item) => item.id === payload.paperId);
    return service.submit({ kind: 'manual_grade', paper, manualGrade: payload.manualGrade, requestId: payload.requestId });
  });
  await app.paperReview(); await byText(app.main, '需人工复核 3').click();
  assert.match(app.main.querySelector('.grade-step-final').textContent, /最终评级.*B/);
  assert.equal(app.shortcutAction({ key: '1' }, 'manual'), 'A'); assert.equal(app.shortcutAction({ key: '4' }, 'manual'), 'D');
  await byText(app.main, 'A 1').click(); assert.equal(calls[0].manualGrade, 'A'); assert.equal(currentTitle(app.main), items[1].title);
  await byText(app.main, 'D 4').click(); assert.equal(calls[1].manualGrade, 'D'); assert.equal(currentTitle(app.main), items[2].title);
  await key(work(app.main), 'ArrowUp'); assert.equal(currentTitle(app.main), items[1].title); assert.equal(byText(app.main, 'D 4').getAttribute('aria-pressed'), 'true');
  await byText(app.main, 'B 2').click();
  const state = await readCanonicalFeedback(root);
  assert.deepEqual(state.history.map((entry) => entry.manual_grade), ['A', 'D', 'B']);
  assert.deepEqual(state.history.map((entry) => entry.feedback), ['upgrade', 'drop', 'upgrade']);
  assert.deepEqual(items.map((item) => [item.ruleGrade, item.semanticGrade, item.finalGrade]), before);
});
test('manual review failure stays on the paper and editor focus suppresses direct-grade shortcuts', async () => {
  const app = ui(); const items = papers(2); items.forEach((item) => { item.needsReview = true; }); const calls = [];
  app.setApi(async (url, payload) => { if (!payload) return { runId: 'manual-fail', total: 2, items }; calls.push(payload); throw new Error('保存失败'); });
  await app.paperReview(); await byText(app.main, '需人工复核 2').click(); const title = currentTitle(app.main);
  const textarea = new Element('textarea'); const event = await key(work(app.main), '2', textarea); assert.equal(event.defaultPrevented, undefined); assert.equal(calls.length, 0);
  await byText(app.main, 'C 3').click(); assert.equal(currentTitle(app.main), title); assert.equal(items[0].manualGrade, undefined); assert.match(app.main.textContent, /当前文献未前进/);
});
test('rule focused queue has no confirm; high risk receipt visible, edit mode suppresses shortcuts', async () => {
  const app = ui(); const rows = [{ id: 'high', status: 'pending', risk_level: 'high', target: 'pubmed_pmc_search.json', rule_text: '高风险检索建议' }, { id: 'low', status: 'pending', risk_level: 'low', rule_text: '机制研究' }]; const calls = [];
  app.setApi(async (url, payload) => { if (!payload) return rows; calls.push(payload); return payload.id === 'high' ? { status: 'pending', application_status: 'requires_manual_action', explanation: '安全门禁未通过', next_action: '人工核对范围' } : { status: payload.decision }; });
  await app.suggestions(); assert.equal(app.main.querySelectorAll('article').length, 1);
  await byText(app.main, '接受 1').click(); assert.equal(calls[0].humanApproval, true); assert.equal(rows[0].status, 'pending'); assert.match(app.main.textContent, /尚未正式应用.*安全门禁未通过.*人工核对范围/); assert.equal(currentTitle(app.main), rows[1].rule_text);
  await key(work(app.main), 'ArrowUp'); assert.match(app.main.textContent, /正式状态仍为待处理/);
  await key(work(app.main), 'ArrowDown'); await key(work(app.main), '3');
  assert.ok(work(app.main).querySelector('textarea'));
  await key(work(app.main), '1'); await key(work(app.main), 'ArrowUp'); assert.equal(calls.length, 1); assert.equal(currentTitle(app.main), rows[1].rule_text);
  await byText(app.main, '提交修改并接受').click(); assert.equal(calls[1].decision, 'revised'); assert.equal(rows[1].status, 'revised');
  await key(work(app.main), 'ArrowUp'); await byText(app.main, '拒绝 2').click(); assert.equal(calls.at(-1).decision, 'rejected');
});
test('Settings has four navigation groups, preserved inputs, radios/toggles, blank credentials', async () => {
  const app = ui(); app.setApi(async (url) => url === '/api/credentials' ? [{ id: 'SMTP_PASS', configured: true, writable: true }] : [{ category: 'General', available: true, id: 'mode', description: '运行模式', type: 'enum', value: 'local', validation: { values: ['local', 'desktop'] } }, { category: 'Sources', available: true, id: 'source', description: '启用来源', type: 'boolean', value: true, validation: {} }]);
  await app.settings(); assert.equal(app.main.querySelector('.settings-nav').children.length, 4); assert.equal(app.main.querySelectorAll('select').length, 0);
  assert.equal(app.main.querySelectorAll('input').filter((node) => node.type === 'radio').length, 2);
  assert.equal(app.main.querySelectorAll('input').find((node) => node.type === 'password').value, ''); assert.match(app.main.textContent, /连接测试尚未开放/);
  await byText(app.main, '连接与通知').click(); assert.equal(byText(app.main, '连接与通知').getAttribute('aria-current'), 'page');
});
test('demo fixtures render Literature and both Feedback queues without calling mutation APIs', async () => {
  const app = ui(); const calls = []; app.setApi(async (url, value) => { calls.push([url, value]); return { runId: 'real-empty', total: 0, items: [] }; });
  app.demoMode.weekly = true; await app.weekly();
  assert.match(app.main.textContent, /示例模式/); assert.match(app.main.textContent, /推荐理由/);
  assert.equal(app.main.querySelectorAll('article').length, 6); assert.match(app.main.textContent, /A级 2 · B级 2 · C级 2/);
  app.main.replaceChildren(); app.demoMode.feedback = true; await app.paperReview();
  assert.match(app.main.textContent, /常规文献 3/); assert.match(app.main.textContent, /需人工复核 3/);
  assert.equal(byText(app.main, '升级 1').disabled, true);
  await byText(app.main, '不变 2').click();
  await byText(app.main, '需人工复核 3').click();
  assert.match(app.main.textContent, /规则评级.*语义评级.*最终评级/);
  assert.ok(byText(app.main, 'A 1')); assert.ok(byText(app.main, 'D 4')); assert.doesNotMatch(app.main.textContent, /升级 1/);
  assert.equal(calls.some(([url, value]) => url === '/api/feedback' && value), false);
  assert.match(app.main.textContent, /不会提交真实反馈|未写入真实数据/);
});
test('Settings hides research and query editors, uses source checkboxes and one save per section', async () => {
  const app = ui(); const calls = []; const settings = [
    { category: 'Sources', available: true, id: 'sources.domain', description: '研究领域', type: 'enum', value: 'biomedical', validation: { values: ['biomedical', 'unknown'] } },
    { category: 'Sources', available: true, id: 'sources.override', description: '显式检索源', type: 'list', value: ['rss', 'pubmed_pmc'], validation: { values: ['rss', 'pubmed_pmc', 'openalex'] } },
    { category: 'Search', available: true, id: 'pubmed.required', description: 'required 检索词', type: 'keywords', value: ['immune'], validation: {} },
    { category: 'Search', available: true, id: 'pubmed.query', description: 'pubmed 检索式', type: 'string', value: 'immune', validation: {} },
    { category: 'Search', available: true, id: 'pubmed.days', description: '检索天数', type: 'integer', value: 10, validation: { min: 1, max: 366 } },
    { category: 'Models', available: true, id: 'translation.model', description: 'translation 模型名称', type: 'string', value: 'demo-model', validation: { maxLength: 200 } },
    { category: 'Models', available: true, id: 'translation.endpoint', description: 'translation API 地址', type: 'url', value: 'https://example.test', validation: {} },
    { category: 'Models', available: true, id: 'translation.temperature', description: '采样温度', type: 'number', value: 0.2, validation: { min: 0, max: 2 } },
    { category: 'Ranking / Review', available: true, id: 'review.batch', description: '复审批大小', type: 'integer', value: 20, validation: { min: 1, max: 200 } },
  ];
  app.setApi(async (url, value) => { if (url === '/api/credentials') return []; if (!value) return settings; calls.push(value); return { saved: true }; });
  await app.settings(); assert.doesNotMatch(app.main.textContent, /研究领域|required 检索词|pubmed 检索式/);
  const sourceSection = app.main.querySelectorAll('.settings-section').find((node) => /检索来源/.test(node.textContent));
  assert.equal(sourceSection.querySelectorAll('input').filter((node) => node.type === 'checkbox').length, 3);
  assert.equal(sourceSection.querySelectorAll('button').filter((node) => node.textContent === '保存本组').length, 1);
  const sourceOptions = sourceSection.querySelector('.source-options');
  assert.equal(sourceOptions.querySelectorAll('label').every((node) => node.htmlFor === node.querySelector('input').id), true);
  assert.match(sourceSection.querySelector('.group-save').className, /section-actions/);
  const modelSection = app.main.querySelectorAll('.settings-section').find((node) => /模型与 AI/.test(node.textContent));
  assert.match(modelSection.textContent, /标题翻译 模型名称.*标题翻译 API 地址/);
  assert.match(modelSection.textContent, /标题翻译.*偏好学习/);
  assert.doesNotMatch(app.main.textContent, /复审批大小|人工复核批量大小/);
  await byText(modelSection, '保存标题翻译').click(); assert.deepEqual(calls.map((entry) => entry.id), ['translation.model', 'translation.endpoint', 'translation.temperature']);
  assert.match(app.notice.textContent, /“标题翻译”已保存/);
});
test('Feedback hides final D items and keeps A/B/C action positions and boundaries stable', async () => {
  const app = ui(); const items = papers(4); const calls = [];
  items[0].finalGrade = 'A'; items[1].finalGrade = 'C'; items[2].finalGrade = 'D'; items[3].finalGrade = 'B';
  items.forEach((item) => { item.needsReview = false; });
  app.setApi(async (url, payload) => { if (!payload) return { runId: 'fixture', total: items.length, items }; calls.push(payload); return { revision: calls.length }; });
  await app.paperReview();
  assert.match(app.main.textContent, /常规文献 3/); assert.doesNotMatch(app.main.textContent, new RegExp(items[2].title));
  assert.equal(byText(app.main, '升级 1').disabled, true); assert.equal(byText(app.main, '排除 4').disabled, false);
  await key(work(app.main), '1'); assert.equal(calls.length, 0);
  await byText(app.main, '下一篇 ↓').click();
  for (const text of ['升级 1', '不变 2', '降级 3', '排除 4']) assert.equal(byText(app.main, text).disabled, false);
  await key(work(app.main), '3'); assert.equal(calls[0].value, 'maybe');
  await key(work(app.main), 'ArrowUp'); await key(work(app.main), '4'); assert.equal(calls[1].value, 'irrelevant');
  assert.match(work(app.main).className, /document-column/);
});
test('C downgrade and drop remain distinct canonical history revisions', async (t) => {
  const base = new URL('./runs/control-review/', import.meta.url); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(fileURLToPath(base), 'feedback-c-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const service = new FeedbackService({ reviewRoot: root }); const items = papers(2); items[0].finalGrade = 'C'; items[1].finalGrade = 'B'; items.forEach((item) => { item.needsReview = false; });
  const app = ui(); app.setApi(async (url, payload) => !payload ? { runId: 'fixture-c', total: items.length, items } : service.submit({ kind: 'paper_feedback', paper: items.find((item) => item.id === payload.paperId), ...payload }));
  await app.paperReview(); await byText(app.main, '降级 3').click(); await byText(app.main, '上一篇 ↑').click(); await byText(app.main, '排除 4').click();
  const state = await readCanonicalFeedback(root);
  assert.deepEqual(state.history.map((entry) => entry.feedback), ['downgrade', 'drop']);
  assert.deepEqual(state.history.map((entry) => entry.revision), [1, 2]);
});
test('Research Feedback shares the document content column', async () => {
  const app = ui(); await app.research(); const form = app.main.querySelector('.research-form');
  assert.match(form.className, /page-content/); assert.match(form.className, /document-column/); assert.ok(form.querySelector('textarea'));
});
test('zero results, missing identifier, completed queue and neutral selection stay usable', async () => {
  const app = ui(); app.setApi(async () => ({ runId: null, total: 0, items: [] })); await app.paperReview(); assert.match(app.main.textContent, /此队列暂无文献/);
  app.main.replaceChildren(); const items = papers(2); items[0].feedbackAllowed = false; items[1].needsReview = false; items[1].feedback = 'relevant';
  app.setApi(async () => ({ runId: 'fixture', total: 2, items })); await app.paperReview(); assert.equal(byText(app.main, '升级 1').disabled, true);
  await byText(app.main, '下一篇 ↓').click(); assert.equal(byText(app.main, '不变 2').getAttribute('aria-pressed'), 'true'); assert.equal(byText(app.main, '升级 1').disabled, false);
});
