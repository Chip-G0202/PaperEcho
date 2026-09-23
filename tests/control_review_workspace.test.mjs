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
  addEventListener(name, fn) {
    const previous = this.listeners[name];
    this.listeners[name] = previous ? async (...args) => { await previous(...args); return fn(...args); } : fn;
  }
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
  async click() {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && this.type === 'checkbox') { this.checked = !this.checked; await this.listeners.change?.({ target: this }); }
    await this.listeners.click?.({ target: this });
  }
  async press(key) { if (key === ' ' || key === 'Space') await this.click(); }
}
function ui() {
  const main = new Element('main'); const notice = new Element('p'); const body = new Element('body');
  const nodes = { '#content': main, '#notice': notice, '#page-title': new Element('h1'), '#menu-toggle': new Element('button') };
  const context = vm.createContext({ document: { body, activeElement: null, querySelector: (key) => nodes[key] || body.querySelector(key), querySelectorAll: (key) => body.querySelectorAll(key), createElement: (tag) => new Element(tag) }, window: { addEventListener() {} }, fetch: () => new Promise(() => {}), crypto: { randomUUID }, URL, structuredClone, location: { hash: '' }, confirm: () => true });
  vm.runInContext(script + '\nglobalThis.testing = { createReviewQueue, shortcutAction, gradeCounts, pendingPaperCounts, completionPlan, showCompletionModal, loadWeekly, loadPendingSummary, home, weekly, paperReview, research, suggestions, settings, settingGroups, settingViews, parseRoute, setApi: (value) => { api = value; } };', context);
  return { ...context.testing, main, notice, body, location: context.location };
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
  query.rules = { list: async () => [{ status: 'pending' }, { status: 'candidate' }, { status: 'accepted' }] };
  assert.deepEqual({ ...(await query.pendingSummary()) }, { normal: 2, manual: 8, rules: 2 });
});
test('Literature shows only compact A/B/C cards and filters without feedback actions', async () => {
  const app = ui(); const items = papers(101); items[100].finalGrade = 'D';
  items[0].abstract = '不应显示的摘要'; items[0].reviewReason = '不应显示的复审依据';
  app.setApi(async () => ({ total: items.length, runId: 'fixture', items })); await app.weekly();
  assert.equal(app.main.querySelectorAll('article').length, 50);
  assert.match(app.main.textContent, /本次运行.*共 100 篇/);
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
  app.main.replaceChildren(); await app.paperReview(true, 'manual'); assert.match(app.main.textContent, /规则评级.*语义评级.*最终评级/); assert.equal(currentTitle(app.main), items[99].title);
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
  assert.equal(app.shortcutAction({ key: 'End', code: 'Numpad1' }, 'papers'), 'highly_relevant');
  assert.equal(app.shortcutAction({ key: 'ArrowDown', code: 'Numpad2' }, 'manual'), 'B');
  assert.equal(app.shortcutAction({ key: 'PageDown', code: 'Numpad3' }, 'rules'), 'edit');
  assert.equal(app.shortcutAction({ key: '4', code: 'Digit4' }, 'papers'), 'irrelevant');
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
  await app.paperReview(true, 'manual');
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
  await app.paperReview(true, 'manual'); const title = currentTitle(app.main);
  const textarea = new Element('textarea'); const event = await key(work(app.main), '2', textarea); assert.equal(event.defaultPrevented, undefined); assert.equal(calls.length, 0);
  await byText(app.main, 'C 3').click(); assert.equal(currentTitle(app.main), title); assert.equal(items[0].manualGrade, undefined); assert.match(app.main.textContent, /当前文献未前进/);
});
test('rule focused queue retries an old unapplied receipt; successful accept applies and editor suppresses shortcuts', async () => {
  const app = ui(); const rows = [{ id: 'high', status: 'pending', risk_level: 'high', target: 'pubmed_pmc_search.json', rule_text: '添加必含检索词：机制', can_apply: true, decision_receipt: { application_status: 'requires_manual_action' } }, { id: 'low', status: 'pending', risk_level: 'low', rule_text: '机制研究', can_apply: true }]; const calls = [];
  app.setApi(async (url, payload) => { if (!payload) return rows; calls.push(payload); return { status: payload.decision, application_status: 'applied' }; });
  await app.suggestions(); assert.equal(app.main.querySelectorAll('article').length, 1);
  await byText(app.main, '接受 1').click(); assert.equal(calls[0].humanApproval, true); assert.equal(rows[0].status, 'accepted'); assert.match(app.main.textContent, /已写入正式规则/); assert.equal(currentTitle(app.main), rows[1].rule_text);
  await key(work(app.main), 'ArrowUp'); assert.match(app.main.textContent, /已处理/);
  await key(work(app.main), 'ArrowDown'); await key(work(app.main), '3');
  assert.ok(work(app.main).querySelector('textarea'));
  await key(work(app.main), '1'); await key(work(app.main), 'ArrowUp'); assert.equal(calls.length, 1); assert.equal(currentTitle(app.main), rows[1].rule_text);
  await byText(app.main, '提交修改并接受').click(); assert.equal(calls[1].decision, 'revised'); assert.equal(rows[1].status, 'revised');
  await key(work(app.main), 'ArrowUp'); assert.equal(rows[0].status, 'accepted');
});
test('route parser restores L1/L2/L3 state and Settings keeps credentials write-only', async () => {
  const app = ui(); app.setApi(async (url) => url === '/api/credentials' ? [{ id: 'SMTP_PASS', configured: true, writable: true }] : [{ category: 'General', available: true, id: 'mode', description: '运行模式', type: 'enum', value: 'local', validation: { values: ['local', 'desktop'] } }, { category: 'Sources', available: true, id: 'source', description: '启用来源', type: 'boolean', value: true, validation: {} }]);
  assert.deepEqual({ ...app.parseRoute('#feedback/rating/manual') }, { page: 'feedback', feedbackView: 'rating', reviewSection: 'manual', settingsGroup: 'common', settingsView: 'databases' });
  assert.equal(app.parseRoute('#feedback/suggestions').feedbackView, 'rules'); assert.equal(app.parseRoute('#settings/models/preference').settingsView, 'preference');
  assert.equal(app.parseRoute('#settings/runtime/path').settingsGroup, 'runtime');
  await app.settings('connections', 'credentials');
  assert.equal(app.main.querySelectorAll('input').find((node) => node.type === 'password').value, ''); assert.match(app.main.textContent, /连接测试尚未开放/);
});
test('runtime path presents three exclusive modes and only the selected owner fields', async () => {
  const app = ui(); const calls = []; const settings = [
    { category: 'Runtime', available: true, id: 'runtime.mode', description: '运行路径', type: 'enum', value: 'desktop', validation: { values: ['local', 'desktop', 'web'] } },
    { category: 'Runtime', available: true, id: 'runtime.projectRoot', description: '项目根目录', type: 'string', value: 'C:\\Research', validation: {} },
    { category: 'Runtime', available: true, id: 'local.input', description: '本地输入目录', type: 'string', value: 'input', validation: {} },
    { category: 'Runtime', available: true, id: 'local.output', description: '本地输出目录', type: 'string', value: 'output', validation: {} },
    { category: 'Runtime', available: true, id: 'local.feedback', description: '本地反馈目录', type: 'string', value: 'feedback', validation: {} },
    { category: 'Runtime', available: true, id: 'desktop.zoteroExe', description: 'Zotero Desktop 程序路径', type: 'string', value: 'zotero.exe', validation: {} },
    { category: 'Runtime', available: true, id: 'web.userId', description: 'Zotero User ID', type: 'string', value: '123', validation: {} },
    { category: 'Advanced', available: true, id: 'web.apiBase', description: 'Zotero Web API 地址（测试/开发覆盖）', type: 'url', value: 'https://api.zotero.org', validation: {} },
  ];
  app.setApi(async (url, value) => { if (url === '/api/credentials' && !value) return [{ id: 'ZOTERO_API_KEY', configured: true, writable: true }]; if (!value) return settings; calls.push([url, value]); return { saved: true }; });
  await app.settings('runtime', 'path'); const section = app.main.querySelector('.runtime-settings');
  assert.equal(section.querySelector('.runtime-path-options').querySelectorAll('input').length, 3);
  assert.match(section.textContent, /本地运行.*不使用 Zotero.*Zotero Desktop.*不需要 Zotero Web API Key.*Zotero Web.*需要具有个人文库写权限的 API Key/);
  assert.match(section.textContent, /当前运行路径：Zotero Desktop/);
  const panels = Object.fromEntries(section.querySelectorAll('.runtime-path-panel').map((entry) => [entry.dataset.path, entry]));
  assert.equal(panels.desktop.hidden, false); assert.match(panels.desktop.textContent, /无需额外必填配置.*Zotero Desktop 程序路径/);
  assert.doesNotMatch(panels.desktop.textContent, /项目根目录|API Key|User ID|本地输入目录/);
  const choices = section.querySelector('.runtime-path-options').querySelectorAll('input');
  choices.forEach((input) => { input.checked = input.value === 'web'; }); choices.find((input) => input.value === 'web').listeners.change();
  const webDraft = panels.web.querySelectorAll('input').find((input) => /User ID/.test(input.getAttribute('aria-label'))); webDraft.value = '7654321';
  choices.forEach((input) => { input.checked = input.value === 'desktop'; }); choices.find((input) => input.value === 'desktop').listeners.change();
  choices.forEach((input) => { input.checked = input.value === 'web'; }); choices.find((input) => input.value === 'web').listeners.change();
  assert.equal(webDraft.value, '7654321'); assert.match(section.textContent, /正在配置：Zotero Web（尚未保存）/);
  assert.match(panels.web.textContent, /Zotero Web 配置.*api\.zotero\.org.*API v3.*基础配置：完整.*运行前检测尚未执行.*Zotero User ID.*个人文库.*写入权限.*API Key/); assert.doesNotMatch(panels.web.textContent, /群组文库|Group ID|API 地址（测试|Zotero Desktop 程序路径|本地反馈目录|已连接/);
  assert.match(section.querySelector('.runtime-shared-panel').textContent, /PaperEcho 本地工作区.*不是 Zotero Web API 配置.*项目根目录/);
  choices.forEach((input) => { input.checked = input.value === 'local'; }); choices.find((input) => input.value === 'local').listeners.change();
  assert.match(panels.local.textContent, /本地输入目录.*本地输出目录.*本地反馈目录/); assert.doesNotMatch(panels.local.textContent, /项目根目录|Zotero/);
  panels.local.querySelectorAll('input').find((input) => /本地输入目录/.test(input.getAttribute('aria-label'))).value = 'fixture.jsonl';
  panels.local.querySelectorAll('input').find((input) => /本地输出目录/.test(input.getAttribute('aria-label'))).value = 'fixture-output';
  await byText(section, '保存运行路径').click(); assert.equal(JSON.stringify(calls[0][1].updates), JSON.stringify([{ id: 'runtime.mode', value: 'local' }, { id: 'local.input', value: 'fixture.jsonl' }, { id: 'local.output', value: 'fixture-output' }]));
  calls.length = 0;
  choices.forEach((input) => { input.checked = input.value === 'desktop'; }); choices.find((input) => input.value === 'desktop').listeners.change();
  await byText(section, '保存运行路径').click(); assert.equal(JSON.stringify(calls[0][1].updates), JSON.stringify([{ id: 'runtime.mode', value: 'desktop' }]));
  assert.match(section.textContent, /当前运行路径：Zotero Desktop.*无需额外必填配置/);
  calls.length = 0; choices.forEach((input) => { input.checked = input.value === 'web'; }); choices.find((input) => input.value === 'web').listeners.change();
  await byText(section, '保存 Zotero Web 配置').click(); assert.equal(JSON.stringify(calls[0][1].updates), JSON.stringify([{ id: 'runtime.mode', value: 'web' }, { id: 'web.userId', value: '7654321' }])); assert.match(app.notice.textContent, /Zotero Web 配置已保存/);
  const secret = 'fixture-zotero-secret'; await byText(panels.web, '替换 API Key').click(); const secretInput = panels.web.querySelectorAll('input').find((input) => input.type === 'password'); secretInput.value = secret; await byText(panels.web, '保存 API Key').click();
  assert.equal(calls.at(-1)[0], '/api/credentials'); assert.equal(app.main.textContent.includes(secret), false); assert.match(panels.web.textContent, /Zotero Web API Key：已配置/);
  await byText(panels.web, '清除').click(); assert.equal(calls.at(-1)[1].action, 'clear'); assert.match(panels.web.textContent, /Zotero Web API Key：未配置/); assert.ok(byText(panels.web, '配置 API Key'));
  assert.doesNotMatch(app.main.textContent, /示例|演示/);
});
test('completion plans route to remaining queues and end only when all work is done', () => {
  const app = ui();
  const cases = [
    ['normal', { normal: 0, manual: 0, rules: 0 }, []],
    ['normal', { normal: 0, manual: 2, rules: 0 }, ['feedback/rating/manual']],
    ['normal', { normal: 0, manual: 0, rules: 3 }, ['feedback/rules']],
    ['normal', { normal: 0, manual: 2, rules: 3 }, ['feedback/rating/manual', 'feedback/rules']],
    ['manual', { normal: 0, manual: 0, rules: 0 }, []],
    ['manual', { normal: 3, manual: 0, rules: 0 }, ['feedback/rating/normal']],
    ['manual', { normal: 0, manual: 0, rules: 2 }, ['feedback/rules']],
    ['manual', { normal: 3, manual: 0, rules: 2 }, ['feedback/rating/normal', 'feedback/rules']],
    ['rules', { normal: 0, manual: 0, rules: 0 }, []],
    ['rules', { normal: 1, manual: 0, rules: 0 }, ['feedback/rating/normal']],
    ['rules', { normal: 0, manual: 2, rules: 0 }, ['feedback/rating/manual']],
    ['rules', { normal: 1, manual: 2, rules: 0 }, ['feedback/rating/normal', 'feedback/rating/manual']],
  ];
  for (const [kind, counts, routes] of cases) {
    const plan = app.completionPlan(kind, counts); assert.equal(JSON.stringify(plan.actions.map((item) => item.route)), JSON.stringify(routes));
    const text = [plan.title, plan.body, ...plan.remaining, ...plan.actions.map((item) => item.label)].join(' '); assert.doesNotMatch(text, /(?:常规文献|人工复核|规则建议)[^。]*\b0\b/);
    app.showCompletionModal(plan); const modal = app.body.querySelector('.completion-backdrop'); const buttons = modal.querySelectorAll('button').map((item) => item.textContent);
    assert.equal(JSON.stringify(buttons), JSON.stringify([...plan.actions.map((item) => item.label), routes.length ? '稍后处理' : '完成']));
  }
  assert.equal(app.completionPlan('normal', { normal: 0, manual: 0, rules: 3 }).title, '文献评级已完成');
  app.showCompletionModal(app.completionPlan('normal', { normal: 0, manual: 1, rules: 1 })); app.showCompletionModal(app.completionPlan('normal', { normal: 0, manual: 1, rules: 1 }));
  assert.equal(app.body.querySelectorAll('.completion-backdrop').length, 1); assert.match(app.body.textContent, /1 篇文献需要人工复核.*1 条规则建议等待处理.*前往人工复核.*前往规则建议.*稍后处理/);
});
test('delivery pages contain no demo entry points or bundled demo data', async () => {
  assert.doesNotMatch(script, /demoMode|demoPapers|demoRuleSuggestions|radar-demo|weekly-demo|体验示例|查看[^'\n]*示例|示例模式|演示内容/);
  const app = ui(); app.setApi(async (url) => {
    if (url === '/api/status') return {};
    if (url === '/api/schedule-status') return { status: 'before_slot', scheduledTime: '15:00', today: { plannedSlot: '2026-09-23T07:00:00.000Z', selectedFlow: 'radar' }, weekly: { lastSuccessfulPlannedSlot: '2026-09-21T07:00:00.000Z', nextDuePlannedSlot: '2026-09-28T07:00:00.000Z' } };
    if (url === '/api/settings' || url === '/api/credentials' || url === '/api/suggestions') return [];
    return { runId: 'real-empty', total: 0, items: [] };
  });
  for (const renderPage of [app.home, app.weekly, app.paperReview, app.suggestions]) {
    app.main.replaceChildren(); await renderPage(); assert.doesNotMatch(app.main.textContent, /示例|演示/);
  }
  assert.equal(Object.hasOwn(app.parseRoute('#home/radar-demo'), 'homeView'), false);
});

test('Overview condenses scheduled status and keeps every actionable exception visible', async () => {
  const app = ui();
  const slot = '2026-09-23T07:00:00.000Z';
  const baseline = { lastSuccessfulPlannedSlot: '2026-09-21T07:00:00.000Z', nextDuePlannedSlot: '2026-09-28T07:00:00.000Z' };
  const normal = { status: 'ready', scheduledTime: '15:00', today: { plannedSlot: slot, selectedFlow: 'radar' }, weekly: baseline, currentRun: null };
  const cases = [
    [normal, /今日任务.*Daily Radar.*今天 15:00 · 北京时间.*下次周报/],
    [{ ...normal, today: { ...normal.today, selectedFlow: 'weekly' } }, /今日任务.*周报.*今天 15:00/],
    [{ ...normal, status: 'before_slot' }, /尚未到时间/],
    [{ ...normal, weekly: { lastSuccessfulPlannedSlot: null, nextDuePlannedSlot: slot } }, /尚未建立周报周期.*首次计划任务将生成周报.*首次周报/],
    [{ ...normal, status: 'unsupported', runtimePath: 'local' }, /本地运行路径不支持定时任务.*前往运行路径/],
    [{ ...normal, status: 'invalid', reason: 'SCHEDULE_STATE_INVALID:missing_weekly_success' }, /计划状态异常.*计划记录格式或内容不一致.*查看运行状态/],
    [{ ...normal, status: 'recovery_required', currentRun: { flow: 'radar', state: 'recovery_required', business: 'not_completed' } }, /需要恢复上次运行.*查看运行状态/],
    [{ ...normal, status: 'recovery_required', currentRun: { flow: 'weekly', state: 'recovery_required', business: 'not_completed' } }, /周报未完成，等待恢复.*周期尚未推进/],
    [{ ...normal, status: 'recovery_required', currentRun: { flow: 'weekly', state: 'recovery_required', business: 'completed' }, notification: 'pending' }, /周报已完成，通知待恢复.*周报主体已成功/],
    [{ ...normal, currentRun: { flow: 'weekly', state: 'completed', business: 'completed' }, notification: 'pending' }, /周报已完成，通知待恢复.*周报主体已成功/],
    [{ ...normal, status: 'radar_disabled' }, /Daily Radar 未启用.*今日任务无法运行.*前往 Radar 设置/],
  ];
  app.setApi(async (url) => url === '/api/status' ? {} : url === '/api/schedule-status' ? app.scheduleFixture : { runId: null, total: 0, items: [] });
  for (const [schedule, expected] of cases) {
    app.scheduleFixture = schedule; app.main.replaceChildren(); await app.home();
    assert.match(app.main.textContent, expected);
    assert.doesNotMatch(app.main.textContent, /Weekly 周报|外部 Agent|运行机制|查看每日计划/);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(app.settingViews.automation.map(([key, title]) => [key, title]))), [['radar', 'Daily Radar'], ['weekly', '周报']]);
  assert.equal(app.parseRoute('#settings/automation/plan').page, 'home');
});
test('Settings separates databases and RSS, colocates review toggles and preserves real values', async () => {
  const app = ui(); const calls = []; const settings = [
    { category: 'Sources', available: true, id: 'sources.domain', description: '研究领域', type: 'enum', value: 'biomedical', validation: { values: ['biomedical', 'unknown'] } },
    { category: 'Sources', available: true, id: 'sources.override', description: '显式检索源', type: 'list', value: ['rss', 'pubmed_pmc'], validation: { values: ['rss', 'pubmed_pmc', 'openalex', 'semantic_scholar'] } },
    { category: 'Search', available: true, id: 'pubmed.required', description: 'required 检索词', type: 'keywords', value: ['immune'], validation: {} },
    { category: 'Search', available: true, id: 'pubmed.query', description: 'pubmed 检索式', type: 'string', value: 'immune', validation: {} },
    { category: 'Search', available: true, id: 'pubmed.days', description: '检索天数', type: 'integer', value: 10, validation: { min: 1, max: 366 } },
    { category: 'Models', available: true, id: 'translation.enabled', description: '启用标题翻译', type: 'boolean', value: true, validation: {} },
    { category: 'Models', available: true, id: 'translation.model', description: 'translation 模型名称', type: 'string', value: 'demo-model', validation: { maxLength: 200 } },
    { category: 'Models', available: true, id: 'translation.endpoint', description: 'translation API 地址', type: 'url', value: 'https://example.test', validation: {} },
    { category: 'Models', available: true, id: 'translation.temperature', description: '采样温度', type: 'number', value: 0.2, validation: { min: 0, max: 2 } },
    { category: 'Models', available: true, id: 'preference.enabled', description: '启用偏好学习', type: 'boolean', value: false, validation: {} },
    { category: 'Models', available: true, id: 'preference.model', description: 'preference 模型名称', type: 'string', value: 'preference-model', validation: { maxLength: 200 } },
    { category: 'Models', available: true, id: 'preference.endpoint', description: 'preference API 地址', type: 'url', value: 'https://example.test/preference', validation: {} },
    { category: 'Models', available: true, id: 'preference.temperature', description: 'preference 温度', type: 'number', value: 0.1, validation: { min: 0, max: 2 } },
    { category: 'Ranking / Review', available: true, id: 'review.enabled', description: '启用等级复审', type: 'boolean', value: false, validation: {} },
    { category: 'Ranking / Review', available: true, id: 'feedback.enabled', description: '启用反馈学习', type: 'boolean', value: false, validation: {} },
    { category: 'Ranking / Review', available: true, id: 'review.batch', description: '复审批大小', type: 'integer', value: 20, validation: { min: 1, max: 200 } },
    { category: 'RSS', available: true, id: 'rss.sources', description: 'RSS 来源列表', type: 'rss', value: [{ name: 'Journal', url: 'https://example.test/feed.xml', enabled: true }], validation: {} },
    { category: 'Advanced', available: true, id: 'translation.timeout', description: '请求超时（毫秒）', type: 'integer', value: 30000, validation: { min: 1000, max: 600000 }, advanced: true },
  ];
  app.setApi(async (url, value) => { if (url === '/api/credentials') return [{ id: 'TITLE_TRANSLATION_API_KEY', configured: false, writable: true }, { id: 'PREFERENCE_LEARNING_API_KEY', configured: true, writable: true }]; if (!value) return settings; calls.push(value); return { saved: true }; });
  await app.settings(); assert.doesNotMatch(app.main.textContent, /研究领域|required 检索词|pubmed 检索式/);
  assert.ok(byText(app.main, '文献数据库')); assert.ok(byText(app.main, 'RSS 订阅')); assert.ok(byText(app.main, '检索周期'));
  const sourceSection = app.main.querySelectorAll('.settings-section').find((node) => /文献数据库/.test(node.textContent));
  assert.equal(sourceSection.querySelectorAll('input').filter((node) => node.type === 'checkbox').length, 3);
  assert.doesNotMatch(sourceSection.textContent, /RSS 订阅/);
  assert.equal(sourceSection.querySelectorAll('button').filter((node) => node.textContent === '保存本组').length, 1);
  const sourceOptions = sourceSection.querySelector('.source-options');
  assert.equal(sourceOptions.querySelectorAll('label').every((node) => node.htmlFor === node.querySelector('input').id), true);
  assert.match(sourceSection.querySelector('.group-save').className, /section-actions/);
  await byText(sourceSection, '保存本组').click(); assert.equal(JSON.stringify(calls[0].updates), JSON.stringify([{ id: 'sources.override', value: ['rss', 'pubmed_pmc'] }]));
  calls.length = 0; app.main.replaceChildren(); await app.settings('common', 'rss');
  const rssSections = app.main.querySelectorAll('.settings-section'); assert.match(app.main.textContent, /RSS 订阅状态.*RSS 期刊订阅/);
  assert.equal(rssSections[0].querySelectorAll('input').filter((node) => node.type === 'checkbox').length, 1); assert.match(rssSections[0].textContent, /启用 RSS 期刊订阅/);
  assert.equal(rssSections[1].querySelectorAll('.rss-row').length, 1);
  app.main.replaceChildren(); await app.settings('review', 'translation');
  assert.ok(byText(app.main, '标题翻译')); assert.ok(byText(app.main, '偏好学习'));
  const modelSection = app.main.querySelector('.settings-section');
  assert.match(modelSection.textContent, /开启后使用配置的模型生成中文标题.*标题翻译 模型名称.*标题翻译 API 地址.*当前配置状态.*API 密钥/);
  assert.doesNotMatch(modelSection.textContent, /偏好学习 模型名称/);
  assert.equal(modelSection.querySelectorAll('.feature-toggle').length, 1); assert.equal(modelSection.querySelectorAll('input').find((input) => input.type !== 'checkbox').value, ''); assert.match(modelSection.textContent, /当前：demo-model/);
  const translationToggle = modelSection.querySelector('.feature-toggle').querySelector('input'); const translationRows = modelSection.querySelectorAll('.feature-dependent'); assert.equal(translationToggle.disabled, undefined); await translationToggle.click(); assert.equal(translationRows.every((row) => row.hidden), true); await translationToggle.click(); assert.equal(translationRows.every((row) => !row.hidden), true); await translationToggle.press('Space'); assert.equal(translationRows.every((row) => row.hidden), true); await translationToggle.press('Space'); assert.equal(translationRows.every((row) => !row.hidden), true); assert.match(modelSection.textContent, /当前：demo-model/);
  await byText(modelSection, '保存标题翻译').click(); assert.equal(JSON.stringify(calls[0].updates), JSON.stringify([{ id: 'translation.enabled', value: true }]));
  assert.match(app.notice.textContent, /“标题翻译”已保存/);
  calls.length = 0; app.main.replaceChildren(); await app.settings('review', 'preference');
  const preferenceSection = app.main.querySelector('.settings-section'); const toggles = preferenceSection.querySelectorAll('.feature-toggle').map((row) => row.querySelector('input'));
  const preferenceRows = preferenceSection.querySelectorAll('.feature-dependent'); const preferenceFields = preferenceRows.map((row) => row.querySelector('input')).filter((input) => input && input.type !== 'password');
  assert.equal(toggles.length, 1); assert.match(preferenceSection.textContent, /启用智能评审与偏好学习/); assert.doesNotMatch(preferenceSection.textContent, /启用等级复审|启用偏好学习[^）]/);
  assert.equal(preferenceRows.every((row) => row.hidden), true); assert.equal(preferenceFields.every((input) => input.disabled), true); assert.equal(preferenceFields[0].value, '');
  assert.equal(toggles[0].disabled, undefined); await toggles[0].click(); assert.equal(preferenceRows.every((row) => !row.hidden), true); assert.equal(preferenceFields.every((input) => !input.disabled), true); await toggles[0].press('Space'); assert.equal(preferenceRows.every((row) => row.hidden), true); await toggles[0].press('Space'); assert.equal(preferenceRows.every((row) => !row.hidden), true);
  await byText(preferenceSection, '保存偏好学习').click(); assert.equal(JSON.stringify(calls[0].updates), JSON.stringify([{ id: 'review.master', value: true }, { id: 'review.enabled', value: true }, { id: 'preference.enabled', value: true }]));
  assert.doesNotMatch(app.main.textContent, /评级设置|请求超时/);
});
test('model capability toggles remain in the real DOM when registry entries are incomplete', async () => {
  const app = ui(); app.setApi(async (url) => url === '/api/credentials' ? [] : []);
  await app.settings('review', 'translation');
  const translation = app.main.querySelectorAll('input').find((input) => input.getAttribute('aria-label') === '启用标题翻译');
  assert.ok(translation); assert.notEqual(translation.disabled, true); await translation.click(); assert.equal(translation.checked, false);
  app.main.replaceChildren(); await app.settings('review', 'preference');
  const preference = app.main.querySelectorAll('input').find((input) => input.getAttribute('aria-label') === '启用智能评审与偏好学习');
  assert.ok(preference); assert.notEqual(preference.disabled, true); await preference.press('Space'); assert.equal(preference.checked, true);
});
test('email toggle owns its configuration panel and preserves fields while off', async () => {
  const app = ui(); const settings = [
    { category: 'Notifications', available: true, id: 'email.enabled', description: '发送报告邮件', type: 'boolean', value: false, validation: {} },
    { category: 'Notifications', available: true, id: 'email.recipient', description: '收件人', type: 'email', value: 'old@example.test', validation: {} },
    { category: 'Notifications', available: true, id: 'smtp.host', description: 'SMTP 主机', type: 'string', value: 'smtp.example.test', validation: {} },
    { category: 'Notifications', available: true, id: 'smtp.user', description: 'SMTP 用户名', type: 'string', value: 'old@example.test', validation: {} },
    { category: 'Notifications', available: true, id: 'notification.failure', description: '运行失败时通知', type: 'boolean', value: true, validation: {} },
  ];
  app.setApi(async (url) => url === '/api/credentials' ? [{ id: 'SMTP_PASS', configured: true, writable: true }] : settings);
  await app.settings('connections', 'notifications'); const sections = app.main.querySelectorAll('.settings-section'); const email = sections[0];
  assert.match(email.textContent, /报告邮件.*发送报告邮件.*SMTP 主机.*邮件参数已配置/);
  assert.equal(email.querySelectorAll('.feature-dependent').every((row) => row.hidden), true);
  const toggle = email.querySelector('.feature-toggle').querySelector('input'); await toggle.click();
  assert.equal(email.querySelectorAll('.feature-dependent').every((row) => !row.hidden), true); assert.match(sections[1].textContent, /运行提醒/);
});
test('automation switch saves through its owner and updates visible state', async () => {
  const app = ui(); const calls = []; const settings = [{ category: 'Radar', available: true, id: 'radar.enabled', description: '启用 Daily Radar', type: 'boolean', value: false, validation: {} }];
  app.setApi(async (url, value) => { if (url === '/api/credentials') return []; if (!value) return settings; calls.push(value); return { saved: true }; });
  await app.settings('automation', 'radar'); assert.match(app.main.textContent, /非周报日运行.*当前已关闭/);
  const toggle = app.main.querySelectorAll('input').find((input) => input.type === 'checkbox'); toggle.checked = true; await byText(app.main, '保存本组').click();
  assert.equal(calls[0].updates[0].id, 'radar.enabled'); assert.match(app.main.textContent, /当前已开启/);
});
test('Settings uses real state and exposes no demo controls', async () => {
  const app = ui(); const calls = []; const settings = [
    { category: 'Models', available: true, id: 'translation.enabled', description: '启用标题翻译', type: 'boolean', value: true, validation: {} },
    { category: 'Models', available: true, id: 'translation.model', description: 'translation 模型名称', type: 'string', value: 'real-model', validation: {} },
    { category: 'Models', available: true, id: 'translation.endpoint', description: 'translation API 地址', type: 'url', value: 'https://real.example.test/v1', validation: {} },
    { category: 'Models', available: true, id: 'translation.temperature', description: '采样温度', type: 'number', value: 0.2, validation: { min: 0, max: 2 } },
    { category: 'Advanced', available: true, id: 'translation.timeout', description: '请求超时（毫秒）', type: 'integer', value: 60000, validation: { min: 1000, max: 600000 }, advanced: true },
  ];
  app.setApi(async (url, value) => { if (value) calls.push([url, value]); return url === '/api/credentials' ? [] : settings; });
  await app.settings('review', 'translation');
  const inputs = app.main.querySelector('.settings-section').querySelectorAll('input'); const replacements = inputs.filter((input) => input.type !== 'checkbox'); assert.deepEqual(replacements.map((input) => input.value), ['', '', '']);
  assert.match(replacements[0].placeholder, /deepseek-flash/); assert.match(replacements[1].placeholder, /api\.example\.com/); assert.match(replacements[2].placeholder, /0\.1/);
  assert.match(app.main.textContent, /当前：real-model/); assert.doesNotMatch(app.main.textContent, /示例|演示/);
  assert.doesNotMatch(script, /体验设置示例|查看运行路径示例|renderAdvancedSettingsDemo|advanced-demo/); assert.equal(calls.length, 0);
});
test('Feedback hides final D items and keeps A/B/C action positions and boundaries stable', async () => {
  const app = ui(); const items = papers(4); const calls = [];
  items[0].finalGrade = 'A'; items[1].finalGrade = 'C'; items[2].finalGrade = 'D'; items[3].finalGrade = 'B';
  items.forEach((item) => { item.needsReview = false; });
  app.setApi(async (url, payload) => { if (!payload) return { runId: 'fixture', total: items.length, items }; calls.push(payload); return { revision: calls.length }; });
  await app.paperReview();
  assert.ok(byText(app.main, '常规文献')); assert.match(app.main.textContent, /待处理 3/); assert.doesNotMatch(app.main.textContent, new RegExp(items[2].title));
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
