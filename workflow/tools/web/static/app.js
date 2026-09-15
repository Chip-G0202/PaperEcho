'use strict';
const main = document.querySelector('#content');
const notice = document.querySelector('#notice');
let csrf = '';
let page = 'home';
let feedbackView = 'papers';
let researchDraft = '';
let researchRequestId = crypto.randomUUID();
let settingsGroup = 'common';
let reviewSection = 'normal';
let activeReview = null;
let homeView = 'overview';
const demoMode = { weekly: false, feedback: false };
let demoFeedbackItems = null;
const decisionReceipts = new Map();
const pageNames = { home: '概览 · Overview', weekly: '文献 · Literature', feedback: '反馈 · Feedback', settings: '设置 · Settings', system: '系统 · System' };
const errorMessages = { SETTING_VALUE_INVALID: '请检查字段格式或允许范围，原设置未改变。', SEARCH_KEYWORD_OWNER_REQUIRED: '请使用检索词分组修改检索式。', CREDENTIAL_VALUE_INVALID: '请输入有效单行凭据（最多 4096 字符）；请勿同时包含两种引号。', CREDENTIAL_EXTERNALLY_MANAGED: '该凭据由外部环境管理，请在原入口修改。', CREDENTIAL_WRITE_FAILED: '凭据未保存，请检查本地配置权限后重试。', CREDENTIAL_ENV_FORMAT_UNSUPPORTED: '凭据文件格式无法安全编辑，原文件未改变。', WEEKLY_CHANGED_RELOAD: '当前文献已更新，请刷新页面后重试。' };
// Keep the existing API/canonical values; the stored learning action is unchanged.
const feedbackLabels = { highly_relevant: '升级', relevant: '不变', maybe: '降级', irrelevant: '排除', do_not_recommend_similar: '排除（原强负反馈）' };
const feedbackActions = ['highly_relevant', 'relevant', 'maybe', 'irrelevant'];
const manualGrades = ['A', 'B', 'C', 'D'];
const statusLabels = { pending: '待确认', candidate: '候选', accepted: '已接受', revised: '已修改接受', rejected: '已拒绝', superseded: '已被替代', expired: '已过期' };
const riskLabels = { low: '低', medium: '中', high: '高' };
const settingGroups = [
  ['common', '常用设置', ['General', 'Sources', 'Search', 'RSS']],
  ['review', '模型与审阅', ['Models', 'Ranking / Review']],
  ['automation', '自动化', ['Radar', 'Weekly', 'Integrity']],
  ['connections', '连接与通知', ['Zotero', 'Notifications', 'Credentials']],
];
const demoPapers = [
  { id: 'demo-1', title: 'Longitudinal immune signatures associated with early vascular remodeling', translatedTitle: '与早期血管重塑相关的纵向免疫特征', authors: ['演示作者甲', '演示作者乙'], finalGrade: 'A', ruleGrade: 'A', semanticGrade: 'A', source: 'PubMed / PMC', journal: 'Demo Translational Medicine', year: '2026', recommendationReason: '纵向设计与机制指标同时匹配当前研究方向。', abstract: '示例摘要：连续随访免疫信号与早期血管变化，用于演示长标题、摘要和推荐依据的排版。', zotero: 'unknown', feedbackAllowed: true, feedback: null, needsReview: false },
  { id: 'demo-2', title: 'Multi-omic profiling reveals context-dependent inflammatory trajectories in aging cohorts', translatedTitle: '多组学分析揭示老龄队列中情境依赖的炎症轨迹', authors: ['演示作者丙'], finalGrade: 'A', ruleGrade: 'B', semanticGrade: 'A', source: 'RSS 订阅', journal: 'Demo Systems Biology', year: '2026', recommendationReason: '多组学与队列证据互补，具备较高的课题迁移价值。', zotero: 'unknown', feedbackAllowed: true, feedback: null, needsReview: false },
  { id: 'demo-3', title: 'A pragmatic framework for evaluating reproducibility in biomarker studies', translatedTitle: '生物标志物研究可重复性评价的实用框架', authors: ['演示作者丁'], finalGrade: 'B', ruleGrade: 'B', semanticGrade: 'B', source: 'PubMed / PMC', journal: 'Demo Methods', year: '2025', recommendationReason: '方法学相关，但与核心疾病问题的直接关联较弱。', zotero: 'unknown', feedbackAllowed: true, feedback: null, needsReview: false },
  { id: 'demo-4', title: 'Environmental exposure patterns and cardiometabolic resilience across adulthood', translatedTitle: '成年期环境暴露模式与心代谢韧性', authors: ['演示作者戊'], finalGrade: 'B', ruleGrade: 'A', semanticGrade: 'B', source: 'RSS 订阅', journal: 'Demo Population Health', year: '2026', recommendationReason: '暴露因素相关，适合作为专题背景与比较证据。', zotero: 'unknown', feedbackAllowed: true, feedback: null, needsReview: true, reviewReason: '规则系统给出 A，语义复审认为与核心终点距离较远，最终采用 B。' },
  { id: 'demo-5', title: 'Short-term dietary variation and exploratory metabolite associations', translatedTitle: '短期饮食变化与探索性代谢物关联', authors: ['演示作者己'], finalGrade: 'C', ruleGrade: 'B', semanticGrade: 'C', source: 'PubMed / PMC', journal: 'Demo Nutrition Research', year: '2025', recommendationReason: '属于领域相关探索，研究周期与证据强度有限。', zotero: 'unknown', feedbackAllowed: true, feedback: null, needsReview: true, reviewReason: '语义复审下调至 C，保留人工确认入口。' },
  { id: 'demo-6', title: 'Community implementation notes for a digital prevention program', translatedTitle: '数字化预防项目的社区实施记录', authors: ['演示作者庚'], finalGrade: 'C', ruleGrade: 'C', semanticGrade: 'D', source: 'RSS 订阅', journal: 'Demo Implementation Science', year: '2024', recommendationReason: '可补充实施背景，但不直接回答当前核心问题。', zotero: 'unknown', feedbackAllowed: true, feedback: null, needsReview: true, reviewReason: '语义等级为 D；安全策略阻止自动排除，等待人工确认。' },
];
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action) { const node = el('button', text); node.type = 'button'; node.addEventListener('click', async () => {
  node.disabled = true; node.setAttribute('aria-busy', 'true'); notice.dataset.kind = 'success';
  const scope = node.closest('.setting, article, .research-form, .settings-subgroup, .settings-section');
  const previousNotice = notice.textContent;
  scope?.querySelectorAll('.field-error,.save-state').forEach((entry) => entry.remove());
  scope?.querySelectorAll('[aria-invalid]').forEach((entry) => { entry.removeAttribute('aria-invalid'); entry.removeAttribute('aria-describedby'); });
  try { await action(); if (scope?.isConnected && notice.textContent && notice.textContent !== previousNotice) { const state = el('p', notice.textContent, 'save-state meta'); state.setAttribute('role', 'status'); scope.append(state); } } catch (error) {
    notice.dataset.kind = 'error'; notice.textContent = error.message;
    if (scope) { const message = el('p', error.message, 'field-error'); message.id = `error-${crypto.randomUUID()}`; message.setAttribute('role', 'alert'); scope.append(message); scope.querySelectorAll('input,select,textarea').forEach((entry) => { entry.setAttribute('aria-invalid', 'true'); entry.setAttribute('aria-describedby', message.id); }); }
  } finally { node.disabled = false; node.removeAttribute('aria-busy'); }
}); return node; }
function select(values, selected) { const node = el('select'); for (const [value, label] of values) { const option = el('option', label); option.value = value; node.append(option); } node.value = selected || ''; return node; }
function label(text, input) { const node = el('label', text); input.id ||= `field-${crypto.randomUUID()}`; input.setAttribute('aria-label', text); node.htmlFor = input.id; node.append(input); return node; }
function demoBanner(text, exit) { const bar = el('section', undefined, 'demo-banner'); bar.setAttribute('aria-label', '示例模式'); const copy = el('div'); copy.append(el('strong', '示例模式'), el('span', text)); const close = button('退出示例', exit); bar.append(copy, close); return bar; }
function pageIntro(title, text) { const intro = el('header', undefined, 'page-intro page-header'); intro.append(el('h2', title), el('p', text, 'lead')); return intro; }
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(value) }).catch(() => { throw new Error('无法连接本地服务，请检查服务是否仍在运行。'); });
  const result = await response.json().catch(() => { throw new Error('服务响应暂不可用，请刷新页面后重试。'); });
  if (!response.ok) throw new Error(errorMessages[result.error] || '操作未完成。请检查输入或刷新页面后重试；安全限制仍然有效。');
  return result;
}
// Presentation-only queue: source grades/order are never mutated. Saving is
// serialized; failed or uncertain requests reuse their id until acknowledged.
function createReviewQueue(items, done, eligible = () => true) {
  const first = items.findIndex((item) => !done(item) && eligible(item));
  const state = { items, index: Math.max(0, first), busy: false, back: [], requests: new Map() };
  state.move = (direction) => {
    if (state.busy) return;
    if (direction < 0 && state.back.length) state.index = state.back.pop();
    else { const next = Math.max(0, Math.min(items.length - 1, state.index + direction)); if (next !== state.index) { if (direction > 0) state.back.push(state.index); state.index = next; } }
  };
  state.submit = async (action, save, apply) => {
    const item = items[state.index];
    if (state.busy || !item || !eligible(item)) return null;
    state.busy = true;
    const key = `${state.index}:${action}`;
    if (!state.requests.has(key)) state.requests.set(key, crypto.randomUUID());
    try {
      const result = await save(item, state.requests.get(key));
      apply(item, result); state.requests.delete(key);
      const next = items.findIndex((entry, i) => i > state.index && !done(entry) && eligible(entry));
      const wrapped = next >= 0 ? next : items.findIndex((entry) => !done(entry) && eligible(entry));
      if (wrapped >= 0 && wrapped !== state.index) { state.back.push(state.index); state.index = wrapped; }
      return { item, result };
    } finally { state.busy = false; }
  };
  return state;
}
function shortcutAction(event, mode) {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (event.target?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="dialog"],dialog,[data-editor]')) return null;
  if (event.key === 'ArrowUp') return 'previous';
  if (event.key === 'ArrowDown') return 'next';
  return (mode === 'rules' ? { 1: 'accepted', 2: 'rejected', 3: 'edit' } : mode === 'manual' ? { 1: 'A', 2: 'B', 3: 'C', 4: 'D' } : { 1: 'highly_relevant', 2: 'relevant', 3: 'maybe', 4: 'irrelevant' })[event.key] || null;
}
async function loadWeekly() {
  const data = await api('/api/weekly?offset=0&limit=200');
  while (data.items.length < data.total) {
    const next = await api(`/api/weekly?offset=${data.items.length}&limit=200`);
    if (next.runId !== data.runId || next.total !== data.total || !next.items.length) throw new Error('文献已更新，请重新读取。');
    data.items.push(...next.items);
  }
  if (new Set(data.items.map((item) => item.id)).size !== data.items.length) throw new Error('文献读取不完整，请重新读取。');
  return data;
}
function displayGrade(item) { return item.finalGrade ?? item.grade; }
function displayablePapers(items) { return items.filter((item) => ['A', 'B', 'C'].includes(displayGrade(item))); }
function gradeCounts(items) { return items.reduce((counts, item) => { const grade = displayGrade(item); if (Object.hasOwn(counts, grade)) counts[grade] += 1; return counts; }, { A: 0, B: 0, C: 0 }); }
function gradeBadge(value) {
  const text = { A: 'A级 · 高优先', B: 'B级 · 中优先', C: 'C级 · 低优先' }[value] || '最终等级 · 未提供';
  return el('span', text, `badge grade-${['A', 'B', 'C'].includes(value) ? value : 'unknown'}`);
}
function paperHeading(card, item, { showGrade = true } = {}) {
  card.append(el('h3', item.title || '原始标题未提供', 'paper-title'));
  if (item.translatedTitle && item.translatedTitle !== item.title) card.append(el('p', item.translatedTitle, 'translated-title'));
  card.append(el('p', [item.journal, item.year, item.source].filter(Boolean).join(' · '), 'meta'));
  if (showGrade) { const badges = el('div', undefined, 'badge-row'); badges.append(gradeBadge(displayGrade(item))); card.append(badges); }
  if (item.recommendationReason) card.append(el('p', `推荐理由：${item.recommendationReason}`, 'recommendation-reason'));
}
function gradeEvidence(item) {
  const grades = el('dl', undefined, 'grade-evidence grade-chain');
  for (const [name, grade, tone] of [['规则评级', item.ruleGrade, 'rule'], ['语义评级', item.semanticGrade, 'semantic'], ['最终评级', item.finalGrade ?? item.grade, 'final']]) {
    const group = el('div', undefined, `grade-step grade-step-${tone}`);
    group.append(el('dt', name), el('dd', grade || '未提供', `grade-value grade-value-${tone}`)); grades.append(group);
  }
  return grades;
}
async function home() {
  if (homeView === 'radar-demo') { radarDemo(); return; }
  if (homeView === 'weekly-demo') { weeklyDemo(); return; }
  const status = await api('/api/status'); const weeklyData = await loadWeekly(); const visibleWeekly = displayablePapers(weeklyData.items); const grades = gradeCounts(visibleWeekly);
  main.append(pageIntro('研究工作空间', '从最近的文献开始，让每次反馈帮助下一次推荐。'));
  const grid = el('div', undefined, 'grid page-summary');
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '暂无记录';
  for (const [name, value] of [['最近 Weekly', date(status.lastWeekly)], ['最近 Radar', date(status.lastRadar)], ['本次文献数量', visibleWeekly.length], ['待确认规则建议', status.pendingSuggestions ?? '暂无统计']]) {
    const card = el('section', undefined, 'card'); card.append(el('h3', name), el('p', String(value), 'metric')); grid.append(card);
  }
  main.append(grid, el('p', `A级 ${grades.A} · B级 ${grades.B} · C级 ${grades.C} · 待处理反馈 ${visibleWeekly.filter((item) => !item.feedback).length}`, 'overview-summary'));
  const strip = el('div', undefined, 'summary-strip page-summary'); strip.append(el('p', `最近运行：${status.lastRun?.status === 'completed' ? '已完成' : status.lastRun?.status === 'failed' ? '未完成，请检查运行报告' : '暂无可靠状态'}`), el('p', `需人工复核：${status.needsReview ?? '暂无统计'}`)); main.append(strip);
  if (status.integrity) main.append(el('p', `完整性提醒：新撤稿 ${status.integrity.newlyConfirmedRetractions ?? 0} · 更正 ${status.integrity.newCorrections ?? 0} · 关注声明 ${status.integrity.newExpressionsOfConcern ?? 0}`, 'meta'));
  if (status.nextScheduledRun) main.append(el('p', `下一次运行：${date(status.nextScheduledRun)}`, 'meta'));
  const actions = el('div', undefined, 'actions quick-links page-toolbar'); const review = button('开始文献审阅', () => navigate('feedback/papers')); review.className = 'primary'; actions.append(review, button('提交研究方向反馈', () => navigate('feedback/research'))); main.append(actions);
  const previews = el('section', undefined, 'experience-grid page-content');
  for (const [title, text, route] of [['Daily Radar 示例', '查看当日发现、紧急队列与来源分布。', 'home/radar-demo'], ['Weekly 示例', '查看一周候选、写回与完整性摘要。', 'home/weekly-demo']]) { const card = el('article', undefined, 'experience-card'); card.append(el('p', '只读演示', 'eyebrow'), el('h3', title), el('p', text, 'meta'), button('查看示例', () => navigate(route))); previews.append(card); }
  main.append(previews);
}
function radarDemo() {
  main.append(pageIntro('Daily Radar · 今日速览', '把当天值得立即查看的信号放在一页内。以下均为演示内容。'), demoBanner('仅展示界面结构，不读取或改变真实 Radar、调度与运行状态。', () => navigate('home')));
  const metrics = el('div', undefined, 'grid metric-grid page-summary');
  for (const [name, value, note] of [['今日发现', '18', '筛选前 42 条'], ['紧急关注', '2', '撤稿/关键更新信号'], ['去重后', '31', '合并 11 条重复记录'], ['进入候选', '12', 'A 3 · B 5 · C 4']]) { const card = el('section', undefined, 'card'); card.append(el('h3', name), el('p', value, 'metric'), el('p', note, 'meta')); metrics.append(card); }
  const distribution = el('section', undefined, 'card source-distribution page-content'); distribution.append(el('h3', '来源分布'));
  for (const [name, value] of [['PubMed / PMC', 68], ['RSS 订阅', 32]]) { const row = el('div', undefined, 'source-row'); const track = el('span', undefined, 'source-track'); const fill = el('span', undefined, 'source-fill'); fill.style.width = `${value}%`; track.append(fill); row.append(el('span', name), track, el('strong', `${value}%`)); distribution.append(row); }
  main.append(metrics, distribution, el('h3', '紧急队列'));
  for (const item of demoPapers.slice(0, 2)) { const card = el('article', undefined, 'radar-item'); paperHeading(card, item); card.append(el('p', item.id === 'demo-1' ? '信号：出现与核心队列直接相关的早期机制证据。' : '信号：多组学结果可能改变本周的优先阅读顺序。', 'radar-signal')); main.append(card); }
}
function weeklyDemo() {
  main.append(pageIntro('Weekly · 本周研究回声', '快速确认本周新增了什么、流向哪里，以及哪些环节值得留意。'), demoBanner('仅用于体验周报结构，不代表系统已运行，也不会写入真实报告。', () => navigate('home')));
  const counts = gradeCounts(demoPapers); const hero = el('section', undefined, 'weekly-hero page-summary'); hero.append(el('p', '本周候选', 'eyebrow'), el('strong', String(demoPapers.length)), el('p', `A级 ${counts.A} · B级 ${counts.B} · C级 ${counts.C}`)); main.append(hero);
  const flow = el('div', undefined, 'weekly-flow page-content');
  for (const [title, value, note, tone] of [['合并与去重', '42 → 31', '11 条重复记录已合并', 'success'], ['Zotero 写回', '6 条', '演示：全部进入日期与等级集合', 'success'], ['完整性检查', '1 条提醒', '演示：需要人工查看来源更新', 'warning']]) { const card = el('section', undefined, 'card'); card.append(el('span', tone === 'warning' ? '需留意' : '已完成', `badge ${tone}`), el('h3', title), el('p', value, 'metric'), el('p', note, 'meta')); flow.append(card); }
  const outcome = el('section', undefined, 'weekly-outcome page-content'); outcome.append(el('h3', '本周处理结果'), el('p', '6 篇进入阅读队列，3 篇建议优先精读，1 条完整性提醒等待人工核对。'), el('p', '示例数据不会生成 XLSX、DOCX、Zotero 写入或调度记录。', 'meta')); main.append(flow, outcome);
}
function empty(title, text) { const box = el('section', undefined, 'empty-state'); box.append(el('h3', title), el('p', text)); main.append(box); }
async function system() {
  const status = await api('/api/status'); main.append(pageIntro('系统与数据状态', '这里展示已有运行证据，不主动连接外部服务或显示敏感路径。'));
  const list = el('dl', undefined, 'status-list');
  for (const [name, value] of [['版本', 'PaperEcho v2.4'], ['本地服务', '已响应 · 仅本机访问'], ['运行数据', '使用启动时解析的当前工作区；路径不在网页展示'], ['检索来源', status.sources.join('、') || '未配置'], ['Zotero', status.zotero === 'unknown' ? '暂无可靠记录' : '已有历史写入记录；非实时连接检测'], ['下次运行', status.nextScheduledRun || '暂无可靠调度信息'], ['兼容入口', 'XLSX / DOCX 仍受支持；不进行双向反馈同步']]) list.append(el('dt', name), el('dd', value));
  main.append(list);
}
async function feedback() {
  const intro = { papers: ['文献等级审阅', '判断最终等级是否准确；反馈会作为后续工作流的人工纠正信号。'], research: ['研究方向反馈', '告诉 PaperEcho 最近推荐结果哪里与你的研究需求不一致。'], suggestions: ['规则建议审阅', '核对由研究反馈生成的建议；安全校验始终生效。'] }[feedbackView];
  main.append(pageIntro(...intro));
  const nav = el('nav', undefined, 'subnav page-toolbar'); nav.setAttribute('aria-label', '反馈类型');
  for (const [key, text] of [['papers', '文献等级'], ['research', '研究方向'], ['suggestions', '规则建议']]) { const item = button(text, () => navigate(`feedback/${key}`)); item.setAttribute('aria-current', feedbackView === key ? 'page' : 'false'); nav.append(item); }
  if (feedbackView === 'papers') await paperReview(false, nav);
  else { main.append(nav); await (feedbackView === 'research' ? research(false) : suggestions(false)); }
}
async function weekly() {
  const data = demoMode.weekly ? { runId: 'demo', total: demoPapers.length, items: structuredClone(demoPapers), demo: true } : await loadWeekly();
  main.append(pageIntro('本次文献汇总', '紧凑浏览当前运行结果；仅显示 A、B、C 级文献。'));
  if (data.demo) main.append(demoBanner('这些文献是前端演示条目，不来自真实周报，也不会进入反馈或运行状态。', () => { demoMode.weekly = false; render(); }));
  else { const actions = el('div', undefined, 'actions page-toolbar'); actions.append(button('体验示例文献', () => { demoMode.weekly = true; render(); })); main.append(actions); }
  const visibleItems = displayablePapers(data.items);
  if (!visibleItems.length) { empty('暂时没有可查看的文献', '当前实例尚无可用的 A、B、C 级文献。你可以先体验示例内容。'); return; }
  const counts = gradeCounts(visibleItems); const filters = el('nav', undefined, 'grade-filters page-toolbar'); filters.setAttribute('aria-label', '按最终等级筛选');
  main.append(el('p', `本次共 ${visibleItems.length} 篇 · A级 ${counts.A} · B级 ${counts.B} · C级 ${counts.C}`, 'summary-strip page-summary'), filters);
  const list = el('section', undefined, 'document-list page-content document-column'); main.append(list); let selected = 'all'; let start = 0;
  const draw = () => {
    filters.replaceChildren(); list.replaceChildren();
    for (const [grade, count] of [['all', visibleItems.length], ...Object.entries(counts)]) {
      const name = grade === 'all' ? '全部' : `${grade}级`;
      const choice = button(`${name} ${count}`, () => { selected = grade; start = 0; draw(); }); choice.setAttribute('aria-pressed', String(selected === grade)); filters.append(choice);
    }
    const items = visibleItems.filter((item) => selected === 'all' || displayGrade(item) === selected);
    for (const item of items.slice(start, start + 50)) { const card = el('article', undefined, 'literature-item paper-card'); paperHeading(card, item); list.append(card); }
    if (!items.length) list.append(el('p', '该等级暂无文献。', 'empty-state'));
    const pages = el('div', undefined, 'actions');
    const previous = button('上一页', () => { start = Math.max(0, start - 50); draw(); }); previous.disabled = start === 0;
    const next = button('下一页', () => { start += 50; draw(); }); next.disabled = start + 50 >= items.length;
    pages.append(previous, el('span', `${items.length ? start + 1 : 0}–${Math.min(start + 50, items.length)} / ${items.length}`), next); list.append(pages);
  }; draw();
}
function reviewNavigation(workspace, queue, draw, unit = '篇') {
  const controls = el('div', undefined, 'actions review-navigation');
  const previous = button(`上一${unit} ↑`, () => { queue.move(-1); draw(true); }); previous.disabled = queue.busy || (!queue.back.length && queue.index === 0);
  const next = button(`下一${unit} ↓`, () => { queue.move(1); draw(true); }); next.disabled = queue.busy || queue.index >= queue.items.length - 1;
  controls.append(previous, el('span', `${queue.index + 1} / ${queue.items.length}`, 'meta'), next); workspace.append(controls);
}
function bindReview(workspace, mode, queue, draw, choose, isEditing = () => false) {
  activeReview = { workspace, queue };
  workspace.addEventListener('keydown', (event) => {
    if (queue.busy || isEditing()) return;
    const action = shortcutAction(event, mode); if (!action) return;
    event.preventDefault();
    if (action === 'previous' || action === 'next') { queue.move(action === 'previous' ? -1 : 1); draw(true); }
    else choose(action);
  });
}
async function paperReview(showIntro = true, sectionNav = null) {
  if (demoMode.feedback && !demoFeedbackItems) demoFeedbackItems = structuredClone(demoPapers);
  const data = demoMode.feedback ? { runId: 'demo', total: demoFeedbackItems.length, items: demoFeedbackItems, demo: true } : await loadWeekly();
  if (showIntro) main.append(pageIntro('文献等级审阅', '判断最终等级是否准确；反馈会作为后续工作流的人工纠正信号。'));
  if (data.demo) main.append(demoBanner('按钮和快捷键均可体验，选择只保留在当前页面会话，不会提交真实反馈。', () => { demoMode.feedback = false; reviewSection = 'normal'; render(); }));
  else { const actions = el('div', undefined, 'actions page-toolbar'); actions.append(button('体验示例审阅', () => { demoMode.feedback = true; demoFeedbackItems = structuredClone(demoPapers); reviewSection = 'normal'; render(); })); main.append(actions); }
  if (sectionNav) main.append(sectionNav);
  const tabs = el('nav', undefined, 'subnav page-toolbar'); tabs.setAttribute('aria-label', '文献审阅队列'); main.append(tabs);
  const workspace = el('section', undefined, 'review-workspace page-content document-column'); workspace.tabIndex = -1; workspace.setAttribute('aria-label', '文献审阅工作区'); main.append(workspace);
  // needsReview comes exclusively from the shared Weekly exporter owner.
  const visibleItems = displayablePapers(data.items);
  const groups = { normal: visibleItems.filter((item) => !item.needsReview), manual: visibleItems.filter((item) => item.needsReview) };
  const queues = Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, createReviewQueue(items, (item) => Boolean(key === 'manual' ? item.manualGrade : item.feedback), (item) => item.feedbackAllowed)]));
  let queue = queues[reviewSection]; let message = ''; let messageKind = 'success';
  const draw = (focus = false) => {
    queue = queues[reviewSection]; tabs.replaceChildren(); workspace.replaceChildren();
    for (const [key, title] of [['normal', '常规文献'], ['manual', '需人工复核']]) { const tab = button(`${title} ${groups[key].length}`, () => { if (queue.busy) return; reviewSection = key; message = ''; draw(true); }); tab.disabled = queue.busy; tab.setAttribute('aria-current', reviewSection === key ? 'page' : 'false'); tabs.append(tab); }
    activeReview = { workspace, queue };
    if (!queue.items.length) { workspace.append(el('p', '此队列暂无文献。', 'empty-state')); return; }
    const processed = queue.items.filter((item) => reviewSection === 'manual' ? item.manualGrade : item.feedback).length;
    workspace.append(el('p', `已处理 ${processed} / 共 ${queue.items.length} · 待处理 ${queue.items.length - processed}`, 'queue-progress'));
    if (message) { const receipt = el('p', message, `queue-receipt ${messageKind}`); receipt.setAttribute('role', 'status'); workspace.append(receipt); }
    if (processed === queue.items.length) workspace.append(el('p', '本队列已完成。可用上 / 下一篇回看并修改已记录反馈。', 'completion'));
    const item = queue.items[queue.index]; const card = el('article', undefined, 'focused-card paper-card'); paperHeading(card, item, { showGrade: false });
    card.append(gradeEvidence(item));
    const selectedValue = reviewSection === 'manual' ? item.manualGrade : item.feedback;
    card.append(el('span', selectedValue ? reviewSection === 'manual' ? `已人工评级：${selectedValue}` : `已反馈：${feedbackLabels[selectedValue] || '已记录'}` : reviewSection === 'manual' ? '待人工评级' : '待反馈', `feedback-state ${selectedValue ? 'selected' : ''}`));
    if (reviewSection === 'manual') card.append(el('p', '系统评级保持为只读证据；请选择你确认的正确等级。', 'meta'));
    const actions = el('div', undefined, 'actions feedback-actions');
    const availableActions = reviewSection === 'manual' ? manualGrades : feedbackActions;
    for (const [i, value] of availableActions.entries()) {
      const labelText = reviewSection === 'manual' ? value : feedbackLabels[value];
      const action = button(`${labelText} ${i + 1}`, () => choose(value));
      const boundaryDisabled = reviewSection === 'normal' && value === 'highly_relevant' && displayGrade(item) === 'A';
      action.dataset.action = value; action.setAttribute('aria-label', reviewSection === 'manual' ? `人工评级 ${value}` : labelText); action.setAttribute('aria-pressed', String(reviewSection === 'manual' ? item.manualGrade === value : item.feedback === value || value === 'irrelevant' && item.feedback === 'do_not_recommend_similar')); action.disabled = queue.busy || !item.feedbackAllowed || boundaryDisabled;
      if (reviewSection === 'normal' && value === 'irrelevant' || reviewSection === 'manual' && value === 'D') action.className = 'danger';
      if (boundaryDisabled) action.title = 'A级已是最高展示等级';
      actions.append(action);
    }
    card.append(el('h4', reviewSection === 'manual' ? '人工评级' : '最终评级是否正确？'), actions);
    if (reviewSection === 'normal' && displayGrade(item) === 'A') card.append(el('p', 'A级已是最高展示等级，“升级”不可用；仍可选择不变、降级或排除。', 'boundary-hint'));
    if (reviewSection === 'normal' && displayGrade(item) === 'C') card.append(el('p', 'C级仍可选择降级或排除：降级表示当前等级偏高，排除表示不应进入有效推荐；两种反馈会分别记录。', 'boundary-hint'));
    if (!item.feedbackAllowed) card.append(el('p', '缺少可靠文献标识，无法安全记录反馈；可跳过此篇。', 'warning'));
    const shortcut = reviewSection === 'manual' ? '你也可以使用键盘直接评级：1 A · 2 B · 3 C · 4 D，↑ / ↓ 可切换上一篇和下一篇。正在输入文字时，快捷键会自动暂停。' : '你也可以使用键盘快速审阅：1 升级 · 2 不变 · 3 降级 · 4 排除，↑ / ↓ 可切换上一篇和下一篇。正在输入文字时，快捷键会自动暂停。';
    workspace.append(card, el('p', shortcut, 'shortcut-hint'));
    reviewNavigation(workspace, queue, draw);
    if (focus) workspace.focus();
  };
  const choose = async (value) => {
    if (queue.busy) return;
    const currentGrade = displayGrade(queue.items[queue.index]);
    if (reviewSection === 'normal' && value === 'highly_relevant' && currentGrade === 'A') return;
    const pending = queue.submit(value,
      (item, requestId) => data.demo ? Promise.resolve({ revision: 1, demo: true, requestId }) : api('/api/feedback', { runId: data.runId, paperId: item.id, ...(reviewSection === 'manual' ? { manualGrade: value } : { value }), reason: '', requestId }),
      (item) => { if (reviewSection === 'manual') item.manualGrade = value; else item.feedback = value; });
    draw();
    try { const saved = await pending; if (saved) { const labelText = reviewSection === 'manual' ? `人工评级 ${value}` : feedbackLabels[value]; message = data.demo ? `示例选择：${labelText} · 未写入真实数据。` : `已记录：${labelText} · ${saved.item.title.slice(0, 90)}。`; messageKind = 'success'; } }
    catch (error) { message = error.message + ' 当前文献未前进，请重试。'; messageKind = 'error'; }
    draw(true);
  };
  // Read the active queue on every key press so switching queues cannot retain
  // an old queue's key handler or submit into a hidden queue.
  workspace.addEventListener('keydown', (event) => {
    if (queue.busy) return; const action = shortcutAction(event, reviewSection === 'manual' ? 'manual' : 'papers'); if (!action) return; event.preventDefault();
    if (action === 'previous' || action === 'next') { queue.move(action === 'previous' ? -1 : 1); message = ''; draw(true); } else choose(action);
  }); draw();
}
async function research(showIntro = true) {
  if (showIntro) main.append(pageIntro('研究方向反馈', '告诉 PaperEcho 最近推荐结果哪里与你的研究需求不一致。'));
  const form = el('section', undefined, 'research-form page-content document-column');
  const input = el('textarea'); input.maxLength = 20000; input.rows = 8; input.value = researchDraft; input.placeholder = '例如：推荐范围偏宽，希望更多关注具有机制验证的纵向研究，减少纯描述性研究。';
  const receipt = el('p', '', 'receipt'); receipt.setAttribute('role', 'status');
  input.addEventListener('input', () => { researchDraft = input.value; researchRequestId = crypto.randomUUID(); });
  const submit = button('提交研究反馈', async () => {
    if (!input.value.trim()) throw new Error('请先描述你的研究需求或推荐质量反馈。');
    input.disabled = true; receipt.textContent = '正在提交与处理，请稍候…';
    try {
      const result = await api('/api/research', { text: input.value, requestId: researchRequestId });
      receipt.textContent = `已接收 · ${result.status === 'processed' ? '处理完成' : '暂未完成处理，输入已保留'} · 产生 ${result.suggestions} 条待确认建议。${result.warnings.length ? '存在处理提醒，请检查模型配置后重试。' : ''}`;
      viewRules.hidden = false;
      if (result.status === 'processed') { input.value = ''; researchDraft = ''; researchRequestId = crypto.randomUUID(); }
    } catch (error) { receipt.textContent = '提交未完成，输入已保留。'; throw error; } finally { input.disabled = false; }
  }); submit.className = 'primary';
  form.append(label('你的评价', input), el('p', '生成的建议会先进入人工确认，不会直接修改正式规则。', 'meta'), submit, receipt); const viewRules = button('查看规则建议', () => navigate('feedback/suggestions')); viewRules.hidden = true; form.append(viewRules); main.append(form);
}
async function suggestions(showIntro = true) {
  if (showIntro) main.append(pageIntro('规则建议审阅', '点击即提交人工决策；接受不等于正式应用，安全校验始终生效。'));
  const rows = await api('/api/suggestions');
  if (!rows.length) { empty('目前没有规则建议', '可以先提交研究方向反馈，生成的建议会显示在这里。'); return; }
  const idOf = (item) => item.id || item.suggestion_id;
  const pending = (item) => ['pending', 'candidate'].includes(item.status);
  const queue = createReviewQueue(rows, (item) => !pending(item) || decisionReceipts.has(idOf(item)), pending);
  let editing = false; let draft = ''; let message = ''; let messageKind = 'success';
  const workspace = el('section', undefined, 'review-workspace page-content document-column'); workspace.tabIndex = -1; workspace.setAttribute('aria-label', '规则建议审阅工作区'); main.append(workspace);
  const draw = (focus = false) => {
    workspace.replaceChildren();
    const item = rows[queue.index]; const id = idOf(item); const receipt = decisionReceipts.get(id);
    workspace.append(el('p', `共 ${rows.length} 条 · 待确认 ${rows.filter(pending).length} · 本轮已提交决策 ${rows.filter((entry) => decisionReceipts.has(idOf(entry))).length} 条`, 'queue-progress'));
    if (message) { const state = el('p', message, `queue-receipt ${messageKind}`); state.setAttribute('role', 'status'); workspace.append(state); }
    const card = el('article', undefined, 'focused-card rule-card');
    const badges = el('div', undefined, 'badge-row'); badges.append(el('span', statusLabels[item.status] || '状态未提供', 'badge'), el('span', `风险：${riskLabels[item.risk_level] || '未知'}`, item.risk_level === 'high' ? 'badge warning' : 'badge'));
    card.append(badges, el('h3', item.rule_text || item.suggested_rule || '待确认变更'), el('p', `目标：${({ 'screening_standards.md': '长期筛选标准', 'pubmed_pmc_search.json': 'PubMed 检索条件', 'openalex_search.json': 'OpenAlex 检索条件' })[item.target] || '待核对配置'}`), el('p', `建议理由：${item.rationale === 'Proposed from screening_standards.docx evaluation area.' ? '根据研究方向评价提出。' : item.rationale || '未提供'}`));
    const details = el('details'); details.append(el('summary', '查看依据与技术详情'), el('p', item.evidence_text_excerpt || (item.evidence_titles || []).join('；') || '没有附加证据。'), el('p', `编号：${id} · 目标：${item.target || 'screening_standards.md'} · 变更类型：${item.change_type || 'add_rule'}`, 'meta')); card.append(details);
    if (receipt?.application_status === 'requires_manual_action') {
      const manual = el('section', undefined, 'manual-action'); manual.append(el('strong', '本次已接受 · 尚未正式应用'), el('p', '正式状态仍为待处理；接受操作不能解除安全限制。'), el('p', `原因：${receipt.explanation}`), el('p', `下一步：${receipt.next_action}`)); card.append(manual);
    } else if (item.risk_level === 'high') card.append(el('p', '高风险变更可能需要人工处理；网页接受不会解除安全限制。下一步：核对目标、依据及范围后选择接受或拒绝。', 'manual-action'));
    else card.append(el('p', pending(item) ? '下一步：核对建议及依据，选择接受、拒绝或修改后接受。' : '该决策已记录；无需重复处理。', 'meta'));
    const actions = el('div', undefined, 'actions feedback-actions');
    for (const [action, text] of [['accepted', '接受 1'], ['rejected', '拒绝 2'], ['edit', '修改后接受 3']]) {
      const control = button(text, () => choose(action)); control.disabled = queue.busy || !pending(item) || editing; control.setAttribute('aria-pressed', String((receipt?.requested_decision || item.status) === (action === 'edit' ? 'revised' : action))); actions.append(control);
    }
    card.append(actions);
    if (editing) {
      const editor = el('section'); editor.dataset.editor = 'true';
      const input = el('textarea'); input.maxLength = 4000; input.value = draft; input.addEventListener('input', () => { draft = input.value; }); input.disabled = queue.busy;
      const submit = button('提交修改并接受', () => choose('revised')); const cancel = button('取消修改', () => { editing = false; draw(true); }); submit.disabled = cancel.disabled = queue.busy;
      editor.append(label('修改建议内容', input), submit, cancel); card.append(editor);
    }
    workspace.append(card, el('p', '工作区快捷键：1 接受 · 2 拒绝 · 3 修改 · ↑ 上一条 · ↓ 下一条。编辑时全部停用。', 'shortcut-hint'));
    if (!editing) reviewNavigation(workspace, queue, draw, '条');
    if (focus) { if (editing) workspace.querySelector('textarea')?.focus(); else workspace.focus(); }
  };
  const choose = async (action) => {
    const item = rows[queue.index]; if (queue.busy || !pending(item)) return;
    if (action === 'edit') { editing = true; draft = item.rule_text || item.suggested_rule || ''; draw(true); return; }
    if (action === 'revised' && !draft.trim()) { message = '请填写修改后的建议内容。'; messageKind = 'error'; draw(true); return; }
    const work = queue.submit(action + (action === 'revised' ? ':' + draft : ''),
      (entry) => api('/api/decision', { id: idOf(entry), decision: action, revisedRule: action === 'revised' ? draft : '', humanApproval: true }),
      (entry, result) => { entry.status = result.status; decisionReceipts.set(idOf(entry), { ...result, requested_decision: action }); });
    draw();
    try {
      const saved = await work;
      if (saved) {
        editing = false;
        messageKind = saved.result.application_status === 'requires_manual_action' ? 'warning' : 'success';
        message = messageKind === 'warning'
          ? `本次已接受 · 尚未正式应用：${saved.item.rule_text || saved.item.suggested_rule || idOf(saved.item)}（目标：${saved.result.target || saved.item.target}，风险：${riskLabels[saved.result.risk || saved.item.risk_level] || '未知'}）。原因：${saved.result.explanation} 下一步：${saved.result.next_action}`
          : `已记录：${statusLabels[action]}。`;
      }
    } catch (error) { message = error.message + ' 当前建议未前进，请重试。'; messageKind = 'error'; }
    draw(true);
  };
  bindReview(workspace, 'rules', queue, draw, choose, () => editing); draw();
}
function rssEditor(setting, container) {
  let entries = structuredClone(setting.value || []);
  const list = el('div');
  const draw = () => {
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const row = el('div', undefined, 'rss-row'); const name = el('input'); name.value = entry.name; const url = el('input'); url.type = 'url'; url.value = entry.url; const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = entry.enabled;
      name.oninput = () => { entry.name = name.value; }; url.oninput = () => { entry.url = url.value; }; enabled.onchange = () => { entry.enabled = enabled.checked; };
      row.append(label('名称', name), label('RSS URL', url), label('启用', enabled), button('删除该订阅', () => { entries.splice(index, 1); draw(); })); list.append(row);
    });
  };
  draw(); container.append(list, button('添加 RSS', () => { entries.push({ name: '', url: '', enabled: false }); draw(); }));
  return () => structuredClone(entries);
}
const settingGroupNames = { General: '运行方式', Models: '模型与 AI', Sources: '检索来源', Search: '检索周期', RSS: 'RSS 订阅', 'Ranking / Review': '评审体验', Radar: 'Daily Radar', Weekly: 'Weekly 周报', Integrity: '文献完整性', Zotero: 'Zotero', Notifications: '邮件通知', Credentials: '凭据' };
function visibleSetting(setting) {
  if (setting.id === 'sources.domain') return false;
  if (setting.id === 'review.batch') return false;
  if (setting.category === 'Search') return ['pubmed.days', 'openalex.days'].includes(setting.id);
  return setting.category !== 'Advanced';
}
function settingControl(setting) {
  let input;
  if (setting.id === 'sources.override') {
    input = el('fieldset', undefined, 'setting-options source-options'); input.append(el('legend', setting.description));
    const labels = { rss: 'RSS 订阅', pubmed_pmc: 'PubMed / PMC', openalex: 'OpenAlex', semantic_scholar: 'Semantic Scholar' };
    for (const value of setting.validation.values) { const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = value; checkbox.checked = (setting.value || []).includes(value); input.append(label(labels[value] || value, checkbox)); }
    Object.defineProperty(input, 'value', { get: () => [...input.querySelectorAll('input')].filter((entry) => entry.checked).map((entry) => entry.value) });
  } else if (setting.type === 'enum' && setting.validation.values.length <= 5) {
    input = el('fieldset', undefined, 'setting-options'); input.append(el('legend', setting.description)); const name = `option-${crypto.randomUUID()}`;
    for (const value of setting.validation.values) { const radio = el('input'); radio.type = 'radio'; radio.name = name; radio.value = value; radio.checked = value === setting.value; const text = ({ local: '本地', desktop: '桌面', web: '网页', disabled: '停用', enabled: '启用', strict: '严格', warn: '提醒', off: '关闭', on: '开启', auto: '自动', standard: '标准运行', complete: '完整运行', radar: '每日速览' })[value] || value; input.append(label(text, radio)); }
    Object.defineProperty(input, 'value', { get: () => input.querySelector('input:checked')?.value });
  } else if (setting.type === 'enum') input = select(setting.validation.values.map((value) => [value, value]), setting.value);
  else if (setting.type === 'boolean') { input = el('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = setting.value === true; }
  else { input = el('input'); input.type = ['integer', 'number'].includes(setting.type) ? 'number' : setting.type === 'email' ? 'email' : setting.type === 'url' ? 'url' : 'text'; input.value = Array.isArray(setting.value) ? setting.value.join(', ') : setting.value ?? ''; if (setting.validation.min !== undefined) input.min = setting.validation.min; if (setting.validation.max !== undefined) input.max = setting.validation.max; if (setting.type === 'number') input.step = 'any'; }
  return input;
}
function settingValue(setting, input) {
  if (setting.id === 'sources.override') return input.value;
  if (setting.type === 'boolean') return input.checked;
  if (['integer', 'number'].includes(setting.type)) return Number(input.value);
  return input.value;
}
async function settings() {
  main.append(pageIntro('工作空间设置', '这里只保留日常最常用的选项；检索词、检索式和底层参数继续由原配置维护。'));
  const data = await api('/api/settings');
  const groups = settingGroups.flatMap((entry) => entry[2]);
  const layout = el('div', undefined, 'settings-layout page-content'); const nav = el('nav', undefined, 'settings-nav'); nav.setAttribute('aria-label', '设置大类'); const body = el('div', undefined, 'settings-body'); layout.append(nav, body); main.append(layout);
  const switchGroup = (key) => { settingsGroup = key; nav.querySelectorAll('button').forEach((item) => item.setAttribute('aria-current', item.dataset.group === key ? 'page' : 'false')); body.querySelectorAll('[data-settings-group]').forEach((section) => { section.hidden = section.dataset.settingsGroup !== key; }); };
  for (const [key, title] of settingGroups) { const item = button(title, () => switchGroup(key)); item.dataset.group = key; item.setAttribute('aria-current', key === settingsGroup ? 'page' : 'false'); nav.append(item); }
  const appendSettingsControls = (container, entries, saveName, saveLabel = '保存本组') => {
    const saves = []; let unavailable = 0;
    for (const entry of entries) {
      const setting = { ...entry, description: entry.description.replace(/translation/g, '标题翻译').replace(/preference/g, '偏好学习').replace(/required/g, '必要').replace(/optional/g, '补充').replace(/negative/g, '排除').replace(/owner/g, '配置服务').replace(/workflow/g, '工作流') };
      if (setting.id === 'sources.override') setting.description = '选择启用的来源';
      if (setting.id === 'pubmed.days') setting.description = 'PubMed / PMC 检索天数';
      if (setting.id === 'openalex.days') setting.description = 'OpenAlex 检索天数';
      const row = el('div', undefined, 'setting');
      if (!setting.available) { unavailable += 1; continue; }
      if (setting.readOnly) { row.append(el('p', `${setting.description}：${setting.value}（只读）`)); container.append(row); continue; }
      if (setting.type === 'rss') { const read = rssEditor(setting, row); saves.push({ setting, read, input: row }); container.append(row); continue; }
      const input = settingControl(setting);
      if (input.className.includes('setting-options')) row.append(input); else row.append(label(setting.description, input));
      if (setting.validation.min !== undefined || setting.validation.max !== undefined) row.append(el('small', `允许范围：${setting.validation.min ?? '不限'}–${setting.validation.max ?? '不限'}`));
      saves.push({ setting, input, read: () => settingValue(setting, input) }); container.append(row);
    }
    if (unavailable) container.append(el('p', '部分选项尚未配置，已从日常界面收起。', 'meta'));
    if (!saves.length) return;
    const actions = el('div', undefined, 'actions group-save section-actions'); const save = button(saveLabel, async () => {
      const values = saves.map((entry) => { if (entry.input.checkValidity?.() === false) throw new Error('请按字段要求输入有效值，原设置未改变。'); return [entry.setting.id, entry.read()]; });
      let saved = 0;
      try { for (const [id, value] of values) { await api('/api/settings', { id, value }); saved += 1; } }
      catch (error) { if (saved) throw new Error(`已保存 ${saved} / ${values.length} 项；其余项目未完成。${error.message}`); throw error; }
      notice.textContent = `“${saveName}”已保存，下次运行生效。`;
    }); save.className = 'primary'; actions.append(save); container.append(actions);
  };
  for (const group of groups) {
    const owner = settingGroups.find((entry) => entry[2].includes(group))[0];
    const section = el('section', undefined, 'settings-section section'); section.dataset.settingsGroup = owner; section.hidden = owner !== settingsGroup; section.append(el('h3', settingGroupNames[group], 'section-header'));
    const entries = data.filter((entry) => entry.category === group && visibleSetting(entry));
    if (group === 'Models') {
      section.append(el('p', '两类模型功能分别保存；等级复审和文献综述复用偏好学习模型。', 'meta'));
      for (const [prefix, title, text] of [['translation.', '标题翻译', '用于生成中文标题。'], ['preference.', '偏好学习', '用于研究偏好学习、等级复审与文献综述。']]) {
        const subgroup = el('section', undefined, 'settings-subgroup'); subgroup.append(el('h4', title), el('p', text, 'meta'));
        appendSettingsControls(subgroup, entries.filter((entry) => entry.id.startsWith(prefix)), title, `保存${title}`); section.append(subgroup);
      }
    } else {
      appendSettingsControls(section, entries, settingGroupNames[group]);
    }
    if (group === 'Credentials') {
      section.append(el('p', '凭据是敏感操作，仍需逐项明确替换或清除；原值永不回显。', 'meta'));
      for (const item of await api('/api/credentials')) {
        const row = el('div', undefined, 'setting');
        row.append(el('p', `${({ TITLE_TRANSLATION_API_KEY: '标题翻译 API 密钥', PREFERENCE_LEARNING_API_KEY: '偏好学习 API 密钥', EASYSCHOLAR_SECRET_KEY: '期刊指标密钥', SMTP_PASS: '邮件 SMTP 密码', ZOTERO_API_KEY: 'Zotero API 密钥' })[item.id] || '凭据'}：${item.configured ? '已配置' : '未配置'}`));
        if (item.writable) {
          const input = el('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.maxLength = 4096;
          row.append(label('新凭据（不会回显原值）', input), button('替换', async () => {
            const value = input.value; input.value = '';
            await api('/api/credentials', { id: item.id, action: 'replace', value });
            notice.textContent = `凭据已替换。${item.reload}`; await render();
          }), button('清除', async () => {
            if (!confirm(`清除 ${item.id}？依赖该凭据的功能可能暂不可用。`)) return;
            input.value = ''; await api('/api/credentials', { id: item.id, action: 'clear' });
            notice.textContent = `凭据已清除。${item.reload}`; await render();
          }));
        } else row.append(el('p', item.reason, 'muted'));
        section.append(row);
      }
      section.append(el('p', '已配置不代表连接成功。暂无可复用的安全连接测试入口；连接测试尚未开放。', 'muted'));
    }
    body.append(section);
  }
}
async function render() {
  activeReview = null; main.setAttribute('aria-busy', 'true'); main.replaceChildren(el('p', '正在读取当前工作空间…', 'loading'));
  document.querySelector('#page-title').textContent = pageNames[page];
  document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = true; node.setAttribute('aria-current', node.dataset.page === page ? 'page' : 'false'); });
  try { await ({ home, weekly, feedback, settings, system })[page](); }
  catch { notice.dataset.kind = 'error'; notice.textContent = '无法读取当前页面，请检查本地服务后重试。'; empty('页面暂不可用', '没有更改你的数据。'); main.append(button('重新读取', render)); }
  finally { main.querySelector('.loading')?.remove(); main.setAttribute('aria-busy', 'false'); document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = false; }); }
}
function navigate(route) { if (main.getAttribute('aria-busy') === 'true' || activeReview?.queue.busy) return; location.hash = route; }
function route() {
  if (location.hash === '#content' && main.getAttribute('aria-busy') === 'false') { main.focus(); return; }
  const [next, view] = location.hash.slice(1).split('/'); page = Object.hasOwn(pageNames, next) ? next : 'home'; feedbackView = ['papers', 'research', 'suggestions'].includes(view) ? view : 'papers'; homeView = page === 'home' && ['radar-demo', 'weekly-demo'].includes(view) ? view : 'overview';
  notice.textContent = ''; document.querySelector('#sidebar').dataset.open = 'false'; document.querySelector('#menu-toggle').setAttribute('aria-expanded', 'false');
  return render().then(() => (activeReview?.workspace || main).focus());
}
document.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.page)));
document.querySelector('#menu-toggle').addEventListener('click', () => { const sidebar = document.querySelector('#sidebar'); const open = sidebar.dataset.open !== 'true'; sidebar.dataset.open = String(open); document.querySelector('#menu-toggle').setAttribute('aria-expanded', String(open)); });
window.addEventListener('hashchange', route);
api('/api/session').then((session) => { csrf = session.token; return route(); }).catch(() => { main.replaceChildren(); empty('无法连接本地服务', '请确认 Control Center 正在运行，然后刷新页面。'); main.setAttribute('aria-busy', 'false'); });
