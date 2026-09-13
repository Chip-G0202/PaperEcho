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
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.className = ''; this.value = ''; this.ownText = ''; }
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
  vm.runInContext(script + '\nglobalThis.testing = { createReviewQueue, shortcutAction, gradeCounts, loadWeekly, weekly, paperReview, suggestions, settings, settingGroups, setApi: (value) => { api = value; } };', context);
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
test('Literature counts all final grades, filters without feedback actions, English before Chinese', async () => {
  const app = ui(); const items = papers(101); items[100].finalGrade = 'D';
  app.setApi(async () => ({ total: items.length, runId: 'fixture', items })); await app.weekly();
  assert.equal(app.main.querySelectorAll('article').length, 50);
  assert.match(app.main.textContent, /A级 34 · B级 33 · C级 33/);
  assert.doesNotMatch(app.main.textContent, /去反馈|前往论文反馈|保存反馈|升级 1/);
  assert.ok(app.main.textContent.indexOf(items[0].title) < app.main.textContent.indexOf(items[0].translatedTitle));
  await byText(app.main, 'A级 34').click(); assert.equal(app.main.querySelectorAll('article').length, 34);
  await byText(app.main, 'D级 1').click(); assert.equal(app.main.querySelectorAll('article').length, 1); assert.match(app.main.textContent, /D级 · 排除等级/);
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
  const service = new FeedbackService({ reviewRoot: root }); const items = papers(); const before = items.map((item) => [item.ruleGrade, item.semanticGrade, item.finalGrade]);
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
  await byText(app.main, '需人工复核 1').click(); assert.match(app.main.textContent, /规则等级.*语义等级.*最终等级/); assert.equal(currentTitle(app.main), items[99].title);
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
  const app = ui(); const items = papers(8); const calls = [];
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
test('zero results, missing identifier, completed queue and neutral selection stay usable', async () => {
  const app = ui(); app.setApi(async () => ({ runId: null, total: 0, items: [] })); await app.paperReview(); assert.match(app.main.textContent, /此队列暂无文献/);
  app.main.replaceChildren(); const items = papers(2); items[0].feedbackAllowed = false; items[1].needsReview = false; items[1].feedback = 'relevant';
  app.setApi(async () => ({ runId: 'fixture', total: 2, items })); await app.paperReview(); assert.equal(byText(app.main, '升级 1').disabled, true);
  await byText(app.main, '下一篇 ↓').click(); assert.equal(byText(app.main, '不变 2').getAttribute('aria-pressed'), 'true'); assert.equal(byText(app.main, '升级 1').disabled, false);
});
