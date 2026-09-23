'use strict';
const main = document.querySelector('#content');
const notice = document.querySelector('#notice');
let csrf = '';
let page = 'home';
let feedbackView = 'rating';
let researchDraft = '';
let researchRequestId = crypto.randomUUID();
let settingsGroup = 'common';
let settingsView = 'sources';
let reviewSection = 'normal';
let activeReview = null;
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
  ['runtime', '运行路径', ['Runtime']],
  ['automation', '自动化', ['Radar', 'Weekly', 'Integrity']],
  ['connections', '连接与通知', ['Zotero', 'Notifications', 'Credentials']],
];
const settingViews = {
  common: [['databases', '文献数据库', ['Sources']], ['rss', 'RSS 订阅', ['Sources', 'RSS']], ['period', '检索周期', ['General', 'Search']]],
  review: [['translation', '标题翻译', ['Models']], ['preference', '偏好学习', ['Models', 'Ranking / Review']]],
  runtime: [['path', '运行路径', ['Runtime']]],
  automation: [['plan', '每日计划', []], ['radar', 'Daily Radar', ['Radar']], ['weekly', 'Weekly 周报', ['Weekly', 'Integrity']]],
  connections: [['notifications', '通知', ['Notifications']], ['credentials', '凭据', ['Credentials']]],
};
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
function pageIntro(title, text) { const intro = el('header', undefined, 'page-intro page-header'); intro.append(el('h2', title), el('p', text, 'lead')); return intro; }
function tertiaryNav(label, entries, current, routePrefix) {
  const nav = el('nav', undefined, 'tertiary-nav page-toolbar'); nav.setAttribute('aria-label', label);
  for (const [key, text] of entries) { const item = button(text, () => navigate(`${routePrefix}/${key}`)); item.setAttribute('aria-current', current === key ? 'page' : 'false'); nav.append(item); }
  return nav;
}
function contextCard(title, rows) {
  const card = el('aside', undefined, 'context-card'); card.append(el('h3', title));
  for (const row of rows.filter(Boolean)) card.append(el('p', row));
  return card;
}
const planTime = (value) => value ? `${new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))} 中国标准时间` : '尚未建立';
const flowName = (flow) => flow === 'weekly' ? 'Weekly 周报' : flow === 'radar' ? 'Daily Radar' : '待确认';
function planMessage(plan) {
  if (plan.status === 'unsupported') return ['每日计划运行暂不支持本地运行路径', '请切换至 Zotero Desktop 或 Zotero Web。', 'settings/runtime/path'];
  if (plan.status === 'invalid') return ['计划状态异常', 'PaperEcho 已停止自动选择流程，以避免重复运行或错误写入。', plan.reason === 'SCHEDULE_WEEKLY_MODE_INVALID' ? 'settings/automation/weekly' : 'system'];
  if (plan.currentRun?.state === 'unconfirmed') return ['上次运行结果尚未确认', 'PaperEcho 已暂停开启新的写入流程。', 'system'];
  if (plan.currentRun?.state === 'recovery_required') return ['需要恢复上次运行', '后续触发将优先处理同一次运行；请查看最近运行结果。', 'system'];
  if (plan.status === 'radar_disabled') return ['Radar 未启用', '今日计划运行会明确停止，不会自动改跑 Weekly。', 'settings/automation/radar'];
  if (!plan.weekly.lastSuccessfulPlannedSlot && !plan.currentRun) return ['尚未建立周报周期', '首次计划运行将在下一个合法计划时隙执行 Weekly，并建立七天周期基线。', null];
  if (plan.status === 'before_slot') return ['尚未到达计划时隙', '计划将在北京时间 15:00 到达；页面不代表外部 Agent 已触发。', null];
  if (plan.currentRun?.state === 'completed') return ['本次计划流程已完成', '这里显示 PaperEcho 的运行结果，不表示外部 Agent 的任务状态。', null];
  return ['今日计划已就绪', '如果外部 Agent 在计划时隙调用 PaperEcho，将按当前周期选择流程。', null];
}
function planCard(plan, compact = false) {
  const [headline, explanation, route] = planMessage(plan);
  const card = el('section', undefined, `card daily-plan${['invalid', 'recovery_required'].includes(plan.status) ? ' daily-plan-warning' : ''}`);
  card.append(el('h3', '每日计划'), el('p', headline, 'plan-headline'), el('p', explanation, 'meta'));
  if (plan.status === 'invalid') {
    const cause = plan.reason === 'SCHEDULE_WEEKLY_MODE_INVALID' ? '周报运行配置不兼容'
      : plan.reason === 'SCHEDULE_INTERVAL_UNSUPPORTED' ? '周报周期配置不受支持'
        : plan.reason === 'SCHEDULE_STATE_UNREADABLE' ? '计划记录暂无法读取'
          : plan.reason?.startsWith('SCHEDULE_DAY_DECISION_') ? '当日计划记录异常' : '计划记录格式或内容不一致';
    card.append(el('p', `原因：${cause}。`, 'meta'));
  }
  if (plan.status !== 'unsupported' && plan.status !== 'invalid') {
    const value = plan.status === 'before_slot' ? `尚未到时隙 · 预计 ${flowName(plan.today.selectedFlow)}` : flowName(plan.today.selectedFlow);
    card.append(el('p', `今日计划：${value}`, 'plan-flow'), el('p', `计划时隙：${planTime(plan.today.plannedSlot)}`, 'meta'));
    if (plan.weekly.nextDuePlannedSlot) card.append(el('p', `下一 Weekly 到期：${planTime(plan.weekly.nextDuePlannedSlot)}`, 'meta'));
  }
  if (!compact) {
    if (route) card.append(button(route === 'settings/runtime/path' ? '前往运行路径' : route === 'settings/automation/radar' ? '前往 Radar 设置' : route === 'settings/automation/weekly' ? '前往 Weekly 设置' : '查看运行状态', () => navigate(route)));
  } else card.append(button('查看每日计划', () => navigate('settings/automation/plan')));
  return card;
}
async function dailyPlan(body) {
  const plan = await api('/api/schedule-status');
  body.append(planCard(plan));
  if (plan.status === 'unsupported') return;
  const grid = el('div', undefined, 'grid plan-summary');
  for (const [title, value] of [['计划时隙', planTime(plan.today.plannedSlot)], ['上次成功周报时隙', planTime(plan.weekly.lastSuccessfulPlannedSlot)], ['下一次 Weekly 到期', planTime(plan.weekly.nextDuePlannedSlot)], ['当前运行路径', ({ desktop: 'Zotero Desktop', web: 'Zotero Web', local: 'Local' })[plan.runtimePath] || '待确认']]) {
    const item = el('section', undefined, 'card'); item.append(el('h3', title), el('p', value, 'plan-value')); grid.append(item);
  }
  body.append(grid);
  if (plan.currentRun) {
    const run = el('section', undefined, 'settings-section plan-run');
    run.append(el('h3', '当前流程状态'), el('p', `计划流程：${flowName(plan.currentRun.flow)}`));
    const state = { running: '运行中', completed: '已完成', recovery_required: '等待恢复', unconfirmed: '结果尚未确认' }[plan.currentRun.state] || '待确认';
    run.append(el('p', `运行状态：${state}`));
    if (plan.currentRun.flow === 'weekly') {
      run.append(el('p', `周报业务：${plan.currentRun.business === 'completed' ? '已完成' : plan.currentRun.business === 'running' ? '运行中' : '尚未完成'}`));
      if (plan.currentRun.business === 'completed' && plan.notification === 'pending') run.append(el('p', '通知状态：待恢复。周报主体已成功，不会重新执行检索、入库或导出；通知按现有收据机制恢复。', 'plan-alert'));
      if (plan.currentRun.business === 'not_completed') run.append(el('p', '周报周期尚未推进；下次计划触发仍将优先处理 Weekly。', 'plan-alert'));
    }
    body.append(run);
  }
  const context = contextCard('运行机制', ['触发方式：外部 Agent。Agent 只负责按时唤醒 PaperEcho，实际执行哪条流程由 PaperEcho 决定。', 'Weekly 以成功周报的计划时隙为周期基线；Daily Radar 不推进 Weekly 周期，也不补跑历史 Radar。', 'Control Center 无需保持打开。']);
  body.append(context);
}
function keyboardHelp(title, rows, note = '在输入框中输入文字时，快捷键会自动暂停。') {
  const card = el('aside', undefined, 'context-card keyboard-help'); card.append(el('h3', title));
  const list = el('dl');
  for (const [key, description] of rows) { const item = el('div'); const term = el('dt'); term.append(el('kbd', key)); item.append(term, el('dd', description)); list.append(item); }
  card.append(list, el('p', note, 'keyboard-note')); return card;
}
function workspaceColumns(content, rail) {
  const layout = el('div', undefined, 'workspace-grid page-content'); const mainColumn = el('div', undefined, 'workspace-main'); mainColumn.append(...content); layout.append(mainColumn);
  if (rail) { const context = el('aside', undefined, 'context-rail'); context.setAttribute('aria-label', '页面辅助信息'); context.append(...rail); layout.append(context); }
  return layout;
}
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
  const key = /^Numpad[1-4]$/.test(event.code || '') ? event.code.slice(-1) : event.key;
  if (key === 'ArrowUp') return 'previous';
  if (key === 'ArrowDown') return 'next';
  return (mode === 'rules' ? { 1: 'accepted', 2: 'rejected', 3: 'edit' } : mode === 'manual' ? { 1: 'A', 2: 'B', 3: 'C', 4: 'D' } : { 1: 'highly_relevant', 2: 'relevant', 3: 'maybe', 4: 'irrelevant' })[key] || null;
}
function pendingPaperCounts(items = []) {
  const visible = displayablePapers(items);
  return {
    normal: visible.filter((item) => !item.needsReview && item.feedbackAllowed && !item.feedback).length,
    manual: visible.filter((item) => item.needsReview && item.feedbackAllowed && !item.manualGrade).length,
  };
}
const pendingRuleCount = (rows = []) => rows.filter((entry) => ['pending', 'candidate'].includes(entry.status) && !entry.decision_receipt).length;
async function loadPendingSummary() { return api('/api/pending-summary'); }
function completionPlan(kind, counts = { normal: 0, manual: 0, rules: 0 }) {
  const values = { normal: Number(counts.normal || 0), manual: Number(counts.manual || 0), rules: Number(counts.rules || 0) };
  const pending = [
    { key: 'normal', text: `${values.normal} 篇文献等待常规评级`, label: '前往常规评级', route: 'feedback/rating/normal' },
    { key: 'manual', text: `${values.manual} 篇文献需要人工复核`, label: '前往人工复核', route: 'feedback/rating/manual' },
    { key: 'rules', text: `${values.rules} 条规则建议等待处理`, label: '前往规则建议', route: 'feedback/rules' },
  ].filter((entry) => values[entry.key] > 0);
  if (!values.normal && !values.manual && !values.rules) return { title: '全部人工处理已完成', body: '本次文献评级与规则建议均已处理完成。', remaining: [], actions: [] };
  const title = kind === 'normal' ? (!values.manual && values.rules ? '文献评级已完成' : '常规评级已完成') : kind === 'manual' ? '人工复核已完成' : '规则建议已处理';
  return {
    title,
    body: pending.length > 1 ? '还有：' : `还有 ${pending[0].text}。`,
    remaining: pending.length > 1 ? pending.map((entry) => entry.text) : [],
    actions: pending.map(({ label, route }) => ({ label, route })),
  };
}
function showCompletionModal(plan) {
  document.querySelector('.completion-backdrop')?.remove();
  const previous = document.activeElement;
  const backdrop = el('div', undefined, 'completion-backdrop');
  const dialog = el('section', undefined, 'completion-dialog'); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); dialog.setAttribute('aria-labelledby', 'completion-title');
  const title = el('h2', plan.title); title.id = 'completion-title'; dialog.append(title, el('p', plan.body));
  if (plan.remaining?.length) { const list = el('ul', undefined, 'completion-summary'); for (const item of plan.remaining) list.append(el('li', item)); dialog.append(list); }
  const actions = el('div', undefined, 'completion-actions');
  const close = () => { backdrop.remove(); previous?.focus?.(); };
  for (const action of plan.actions) { const control = button(action.label, () => { close(); navigate(action.route); }); control.className = 'primary'; actions.append(control); }
  actions.append(button(plan.actions.length ? '稍后处理' : '完成', close)); dialog.append(actions); backdrop.append(dialog); document.body.append(backdrop);
  const focusable = () => [...dialog.querySelectorAll('button:not([disabled])')];
  backdrop.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const nodes = focusable(); if (!nodes.length) return; const first = nodes[0]; const last = nodes.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  focusable()[0]?.focus?.();
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
  const [status, schedule, weeklyData] = await Promise.all([api('/api/status'), api('/api/schedule-status'), loadWeekly()]); const visibleWeekly = displayablePapers(weeklyData.items); const grades = gradeCounts(visibleWeekly);
  main.append(pageIntro('研究工作空间', '从最近的文献开始，让每次反馈帮助下一次推荐。'));
  main.append(planCard(schedule, true));
  const grid = el('div', undefined, 'grid page-summary');
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '暂无记录';
  for (const [name, value] of [['最近 Weekly', date(status.lastWeekly)], ['最近 Radar', date(status.lastRadar)], ['本次文献数量', visibleWeekly.length], ['待确认规则建议', status.pendingSuggestions ?? '暂无统计']]) {
    const card = el('section', undefined, 'card'); card.append(el('h3', name), el('p', String(value), 'metric')); grid.append(card);
  }
  main.append(grid, el('p', `A级 ${grades.A} · B级 ${grades.B} · C级 ${grades.C} · 待处理反馈 ${visibleWeekly.filter((item) => !item.feedback).length}`, 'overview-summary'));
  const strip = el('div', undefined, 'summary-strip page-summary'); strip.append(el('p', `最近运行：${status.lastRun?.status === 'completed' ? '已完成' : status.lastRun?.status === 'failed' ? '未完成，请检查运行报告' : '暂无可靠状态'}`), el('p', `需人工复核：${status.needsReview ?? '暂无统计'}`)); main.append(strip);
  if (status.integrity) main.append(el('p', `完整性提醒：新撤稿 ${status.integrity.newlyConfirmedRetractions ?? 0} · 更正 ${status.integrity.newCorrections ?? 0} · 关注声明 ${status.integrity.newExpressionsOfConcern ?? 0}`, 'meta'));
  const actions = el('div', undefined, 'actions quick-links page-toolbar'); const review = button('开始文献评级', () => navigate('feedback/rating/normal')); review.className = 'primary'; actions.append(review, button('提交研究方向反馈', () => navigate('feedback/research'))); main.append(actions);
}
function empty(title, text) { const box = el('section', undefined, 'empty-state'); box.append(el('h3', title), el('p', text)); main.append(box); }
async function system() {
  const status = await api('/api/status'); main.append(pageIntro('系统与数据状态', '这里展示已有运行证据，不主动连接外部服务或显示敏感路径。'));
  const list = el('dl', undefined, 'status-list');
  for (const [name, value] of [['版本', 'PaperEcho v2.4'], ['本地服务', '已响应 · 仅本机访问'], ['运行数据', '使用启动时解析的当前工作区；路径不在网页展示'], ['检索来源', status.sources.join('、') || '未配置'], ['Zotero', status.zotero === 'unknown' ? '暂无可靠记录' : '已有历史写入记录；非实时连接检测'], ['下次运行', status.nextScheduledRun || '暂无可靠调度信息'], ['兼容入口', 'XLSX / DOCX 仍受支持；不进行双向反馈同步']]) list.append(el('dt', name), el('dd', value));
  main.append(list);
}
async function feedback() {
  const intro = { rating: ['文献评级', '核对系统评级；常规文献使用相对纠正，人工复核直接选择正确等级。'], research: ['研究方向反馈', '告诉 PaperEcho 最近推荐结果哪里与你的研究需求不一致。'], rules: ['规则建议', '核对由研究反馈生成的建议；安全校验始终生效。'] }[feedbackView];
  main.append(pageIntro(...intro));
  if (feedbackView === 'rating') await paperReview(false);
  else await (feedbackView === 'research' ? research(false) : suggestions(false));
}
async function weekly() {
  const data = await loadWeekly();
  main.append(pageIntro('本次文献汇总', '紧凑浏览当前运行结果；仅显示 A、B、C 级文献。'));
  const visibleItems = displayablePapers(data.items);
  if (!visibleItems.length) { empty('暂时没有可查看的文献', '当前实例尚无可用的 A、B、C 级文献。'); return; }
  const counts = gradeCounts(visibleItems); const filters = el('nav', undefined, 'grade-filters page-toolbar'); filters.setAttribute('aria-label', '按最终等级筛选');
  const list = el('section', undefined, 'document-list page-content document-column');
  const sourceCounts = visibleItems.reduce((result, item) => { const source = item.source || '来源未标注'; result[source] = (result[source] || 0) + 1; return result; }, {});
  const summary = contextCard('本次运行', [`共 ${visibleItems.length} 篇`, `A级 ${counts.A} · B级 ${counts.B} · C级 ${counts.C}`, `来源：${Object.entries(sourceCounts).map(([name, count]) => `${name} ${count}`).join(' · ')}`]);
  main.append(workspaceColumns([filters, list], [summary])); let selected = 'all'; let start = 0;
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
  controls.setAttribute('aria-label', `${unit === '篇' ? '文献' : '建议'}浏览`);
  const previous = button(`上一${unit} ↑`, () => { queue.move(-1); draw(true); }); previous.disabled = queue.busy || (!queue.back.length && queue.index === 0);
  const next = button(`下一${unit} ↓`, () => { queue.move(1); draw(true); }); next.disabled = queue.busy || queue.index >= queue.items.length - 1;
  controls.append(previous, next); workspace.append(controls);
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
async function paperReview(showIntro = true, section = reviewSection) {
  reviewSection = ['normal', 'manual'].includes(section) ? section : 'normal';
  const data = await loadWeekly();
  if (showIntro) main.append(pageIntro('文献评级', '核对系统评级；常规文献使用相对纠正，人工复核直接选择正确等级。'));
  const tabs = el('nav', undefined, 'tertiary-nav page-toolbar'); tabs.setAttribute('aria-label', '文献评级任务');
  const workspace = el('section', undefined, 'review-workspace page-content document-column'); workspace.tabIndex = -1; workspace.setAttribute('aria-label', '文献审阅工作区');
  const context = el('div'); main.append(workspaceColumns([tabs, workspace], [context]));
  // needsReview comes exclusively from the shared Weekly exporter owner.
  const visibleItems = displayablePapers(data.items);
  const groups = { normal: visibleItems.filter((item) => !item.needsReview), manual: visibleItems.filter((item) => item.needsReview) };
  const queues = Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, createReviewQueue(items, (item) => Boolean(key === 'manual' ? item.manualGrade : item.feedback), (item) => item.feedbackAllowed)]));
  let queue = queues[reviewSection]; let message = ''; let messageKind = 'success';
  const draw = (focus = false) => {
    queue = queues[reviewSection]; tabs.replaceChildren(); workspace.replaceChildren();
    for (const [key, title] of [['normal', '常规文献'], ['manual', '人工复核']]) { const tab = button(title, () => navigate(`feedback/rating/${key}`)); tab.disabled = queue.busy; tab.setAttribute('aria-current', reviewSection === key ? 'page' : 'false'); tabs.append(tab); }
    activeReview = { workspace, queue };
    if (!queue.items.length) { workspace.append(el('p', '此队列暂无文献。', 'empty-state')); return; }
    const processed = queue.items.filter((item) => reviewSection === 'manual' ? item.manualGrade : item.feedback).length;
    const manual = reviewSection === 'manual';
    const shortcuts = manual
      ? [['1', '评为 A 级'], ['2', '评为 B 级'], ['3', '评为 C 级'], ['4', '评为 D 级'], ['↑', '返回上一篇'], ['↓', '前往下一篇']]
      : [['1', '升级当前文献'], ['2', '保持当前评级'], ['3', '降低当前评级'], ['4', '排除当前文献'], ['↑', '返回上一篇'], ['↓', '前往下一篇']];
    context.replaceChildren(
      contextCard(manual ? '人工复核' : '文献评级', [`已处理 ${processed} / ${queue.items.length}`, `待处理 ${queue.items.length - processed}`, manual ? '直接选择你确认的 A / B / C / D 等级。' : '用相对反馈校准当前文献的最终评级。']),
      keyboardHelp('数字键快速审阅', shortcuts, '可使用主键盘或小键盘数字键；在输入框中输入时快捷键会自动暂停。'),
    );
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
    workspace.append(card);
    reviewNavigation(workspace, queue, draw);
    if (focus) workspace.focus();
  };
  const choose = async (value) => {
    if (queue.busy) return;
    const pendingBefore = queue.items.filter((item) => item.feedbackAllowed && !(reviewSection === 'manual' ? item.manualGrade : item.feedback)).length;
    const currentGrade = displayGrade(queue.items[queue.index]);
    if (reviewSection === 'normal' && value === 'highly_relevant' && currentGrade === 'A') return;
    const pending = queue.submit(value,
      (item, requestId) => api('/api/feedback', { runId: data.runId, paperId: item.id, ...(reviewSection === 'manual' ? { manualGrade: value } : { value }), reason: '', requestId }),
      (item) => { if (reviewSection === 'manual') item.manualGrade = value; else item.feedback = value; });
    draw();
    let saved = null;
    try { saved = await pending; if (saved) { const labelText = reviewSection === 'manual' ? `人工评级 ${value}` : feedbackLabels[value]; message = `已记录：${labelText} · ${saved.item.title.slice(0, 90)}。`; messageKind = 'success'; } }
    catch (error) { message = error.message + ' 当前文献未前进，请重试。'; messageKind = 'error'; }
    draw(true);
    const pendingAfter = queue.items.filter((item) => item.feedbackAllowed && !(reviewSection === 'manual' ? item.manualGrade : item.feedback)).length;
    if (saved && pendingBefore > 0 && pendingAfter === 0) showCompletionModal(completionPlan(reviewSection, await loadPendingSummary()));
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
  form.append(label('你的评价', input), el('p', '生成的建议会先进入人工确认，不会直接修改正式规则。', 'meta'), submit, receipt); const viewRules = button('查看规则建议', () => navigate('feedback/rules')); viewRules.hidden = true; form.append(viewRules);
  main.append(workspaceColumns([form], [contextCard('提交后会发生什么', ['反馈会生成待确认建议，不直接修改正式规则。', '处理成功后可前往“规则建议”继续审阅。'])]));
}
async function suggestions(showIntro = true) {
  if (showIntro) main.append(pageIntro('规则建议审阅', '接受、拒绝或修改后提交，自动保存并继续下一条。'));
  const rows = await api('/api/suggestions');
  if (!rows.length) { empty('目前没有规则建议', '可以先提交研究方向反馈，生成的建议会显示在这里。'); return; }
  const idOf = (item) => item.id || item.suggestion_id;
  decisionReceipts.clear();
  for (const item of rows) if (item.decision_receipt) decisionReceipts.set(idOf(item), item.decision_receipt);
  const pending = (item) => ['pending', 'candidate'].includes(item.status);
  const ruleTitle = (item) => {
    const raw = item.rule_text || item.suggested_rule || '';
    const keyword = /^Add (required|optional|negative) search keyword: (.+)$/i.exec(raw);
    if (keyword) return `添加${({ required: '必含', optional: '可选', negative: '排除' })[keyword[1].toLowerCase()]}检索词：${keyword[2]}`;
    const negative = /^Add negative search keyword: (.+)$/i.exec(raw);
    if (negative) return `添加排除检索词：${negative[1]}`;
    const removed = /^Remove search keyword: (.+)$/i.exec(raw);
    if (removed) return `移除检索词：${removed[1]}`;
    return item.content_issue ? '这条旧建议内容不完整，请修改或拒绝。' : raw || '待确认变更';
  };
  const rationaleText = (item) => String(item.rationale || '').startsWith('Proposed ') ? '根据研究方向评价提出，待确认。' : item.rationale || '未提供';
  const queue = createReviewQueue(rows, (item) => !pending(item) || decisionReceipts.has(idOf(item)), pending);
  let editing = false; let draft = ''; let message = ''; let messageKind = 'success';
  const workspace = el('section', undefined, 'review-workspace page-content document-column'); workspace.tabIndex = -1; workspace.setAttribute('aria-label', '规则建议审阅工作区'); const context = el('div'); main.append(workspaceColumns([workspace], [context]));
  const draw = (focus = false) => {
    workspace.replaceChildren();
    const item = rows[queue.index]; const id = idOf(item); const receipt = decisionReceipts.get(id);
    context.replaceChildren(
      contextCard('建议概览', [`待确认 ${pendingRuleCount(rows)} 条`, `当前风险：${riskLabels[item.risk_level] || '待核对'}`, '你的选择会自动保存；生效情况可在详情查看。']),
      keyboardHelp('数字键快速处理', [['1', '接受当前建议'], ['2', '拒绝当前建议'], ['3', '修改当前建议'], ['↑', '返回上一条'], ['↓', '前往下一条']], '可使用主键盘或小键盘数字键；编辑建议时快捷键会自动暂停。'),
    );
    workspace.append(el('p', `共 ${rows.length} 条 · 待确认 ${pendingRuleCount(rows)} · 已记录选择 ${rows.filter((entry) => decisionReceipts.has(idOf(entry))).length} 条`, 'queue-progress'));
    if (message) { const state = el('p', message, `queue-receipt ${messageKind}`); state.setAttribute('role', 'status'); workspace.append(state); }
    const card = el('article', undefined, 'focused-card rule-card');
    const badges = el('div', undefined, 'badge-row'); badges.append(el('span', statusLabels[item.status] || '状态未提供', 'badge'), el('span', `风险：${riskLabels[item.risk_level] || '待核对'}`, item.risk_level === 'high' ? 'badge warning' : 'badge'));
    card.append(badges, el('h3', ruleTitle(item)), el('p', `目标：${({ 'screening_standards.md': '长期筛选标准', 'pubmed_pmc_search.json': 'PubMed 检索条件', 'openalex_search.json': 'OpenAlex 检索条件' })[item.target] || '待核对配置'}`), el('p', `建议理由：${rationaleText(item)}`));
    if (pending(item) && item.content_issue) card.append(el('p', '旧建议原文需要核对。请修改为清晰中文，或拒绝。', 'meta'));
    const details = el('details'); details.append(el('summary', '查看依据与技术详情'), el('p', item.evidence_text_excerpt || (item.evidence_titles || []).join('；') || '没有附加证据。'), el('p', `编号：${id} · 目标：${item.target || 'screening_standards.md'} · 变更类型：${item.change_type || 'add_rule'}`, 'meta')); card.append(details);
    if (receipt?.application_status === 'requires_manual_action') {
      card.append(el('p', '已记录，待应用。无需重复提交。', 'meta'));
      details.append(el('p', '这次选择已保存，正式规则尚未改变。'), el('p', receipt.explanation), el('p', receipt.next_action));
    } else card.append(el('p', pending(item) ? '选择后自动保存。' : '已记录。', 'meta'));
    const actions = el('div', undefined, 'actions feedback-actions');
    for (const [action, text] of [['accepted', '接受 1'], ['rejected', '拒绝 2'], ['edit', '修改后接受 3']]) {
      const control = button(text, () => choose(action)); control.disabled = queue.busy || !pending(item) || editing || (action === 'accepted' && Boolean(item.content_issue)); control.setAttribute('aria-pressed', String((receipt?.requested_decision || item.status) === (action === 'edit' ? 'revised' : action))); actions.append(control);
    }
    card.append(actions);
    if (editing) {
      const editor = el('section'); editor.dataset.editor = 'true';
      const input = el('textarea'); input.maxLength = 4000; input.value = draft; input.addEventListener('input', () => { draft = input.value; }); input.disabled = queue.busy;
      const submit = button('提交修改并接受', () => choose('revised')); const cancel = button('取消修改', () => { editing = false; draw(true); }); submit.disabled = cancel.disabled = queue.busy;
      editor.append(label('修改建议内容', input), submit, cancel); card.append(editor);
    }
    workspace.append(card);
    if (!editing) reviewNavigation(workspace, queue, draw, '条');
    if (focus) { if (editing) workspace.querySelector('textarea')?.focus(); else workspace.focus(); }
  };
  const choose = async (action) => {
    const item = rows[queue.index]; if (queue.busy || !pending(item)) return;
    if (action === 'accepted' && item.content_issue) { message = '这条建议内容异常，请修改为中文或拒绝。'; messageKind = 'error'; draw(true); return; }
    if (action === 'edit') { editing = true; draft = item.content_issue ? (ruleTitle(item).startsWith('这条旧建议') ? '' : ruleTitle(item)) : item.rule_text || item.suggested_rule || ''; draw(true); return; }
    if (action === 'revised' && !draft.trim()) { message = '请填写修改后的建议内容。'; messageKind = 'error'; draw(true); return; }
    const pendingBefore = rows.filter((entry) => pending(entry) && !decisionReceipts.has(idOf(entry))).length;
    const work = queue.submit(action + (action === 'revised' ? ':' + draft : ''),
      (entry) => api('/api/decision', { id: idOf(entry), decision: action, revisedRule: action === 'revised' ? draft : '', humanApproval: true }),
      (entry, result) => { entry.status = result.status; if (action === 'revised') entry.rule_text = draft; if (result.application_status === 'requires_manual_action') entry.decision_receipt = result; decisionReceipts.set(idOf(entry), { ...result, requested_decision: action }); });
    draw();
    let saved = null;
    try {
      saved = await work;
      if (saved) {
        editing = false;
        messageKind = 'success';
        message = saved.result.application_status === 'requires_manual_action'
          ? '已记录，待应用。'
          : action === 'rejected' ? '已记录：拒绝。' : '已记录，已生效。';
      }
    } catch (error) { message = error.message === 'SUGGESTION_CONTENT_INVALID' ? '建议内容需使用清晰中文，请修改后再提交。' : error.message + ' 当前建议未前进，请重试。'; messageKind = 'error'; }
    draw(true);
    const pendingAfter = rows.filter((entry) => pending(entry) && !decisionReceipts.has(idOf(entry))).length;
    if (saved && pendingBefore > 0 && pendingAfter === 0) showCompletionModal(completionPlan('rules', await loadPendingSummary()));
  };
  bindReview(workspace, 'rules', queue, draw, choose, () => editing); draw();
}
function rssEditor(setting, container) {
  let entries = structuredClone(setting.value || []);
  const list = el('div');
  const draw = () => {
    list.replaceChildren();
    entries.forEach((entry, index) => {
      const row = el('div', undefined, 'rss-row'); const name = el('input'); name.value = entry.name; name.placeholder = '例如：期刊或机构名称'; const url = el('input'); url.type = 'url'; url.value = entry.url; url.placeholder = '例如：https://example.com/feed.xml'; const enabled = el('input'); enabled.type = 'checkbox'; enabled.checked = entry.enabled;
      name.oninput = () => { entry.name = name.value; }; url.oninput = () => { entry.url = url.value; }; enabled.onchange = () => { entry.enabled = enabled.checked; };
      row.append(label('名称', name), label('RSS URL', url), label('启用', enabled), button('删除该订阅', () => { entries.splice(index, 1); draw(); })); list.append(row);
    });
  };
  draw(); container.append(list, button('添加 RSS', () => { entries.push({ name: '', url: '', enabled: false }); draw(); }));
  return () => structuredClone(entries);
}
const settingGroupNames = { General: '运行方式', Models: '模型与 AI', Sources: '文献数据库', Search: '检索周期', RSS: 'RSS 期刊订阅', 'Ranking / Review': '评审体验', Radar: 'Daily Radar', Weekly: 'Weekly 周报', Integrity: '撤稿与更正监测', Runtime: '运行路径', Notifications: '邮件与提醒', Credentials: '凭据' };
function visibleSetting(setting) {
  if (['sources.domain', 'review.master', 'review.batch', 'general.profile', 'weekly.email', 'feedback.enabled', 'zotero.user', 'zotero.batch'].includes(setting.id)) return false;
  if (setting.category === 'Search') return ['pubmed.days', 'openalex.days'].includes(setting.id);
  return setting.category !== 'Advanced';
}
function currentSettingText(setting) {
  if (setting.value === null || setting.value === undefined || setting.value === '') return '未配置';
  const prefix = setting.ownerPresent === false ? '默认值 · ' : '';
  if (setting.type === 'url') { try { return `${prefix || '已配置 · '}${new URL(setting.value).hostname}`; } catch { return prefix ? `${prefix}已提供` : '已配置'; } }
  if (['runtime.projectRoot', 'local.input', 'local.output', 'local.feedback', 'desktop.zoteroExe', 'translation.model', 'preference.model', 'web.userId'].includes(setting.id)) return `${prefix}${String(setting.value)}`;
  return `${prefix}${['number', 'integer'].includes(setting.type) ? String(setting.value) : '已配置'}`;
}
function settingControl(setting) {
  let input;
  if (setting.id === 'sources.override') {
    input = el('fieldset', undefined, 'setting-options source-options'); input.append(el('legend', setting.description));
    const labels = { rss: '启用 RSS 期刊订阅', pubmed_pmc: 'PubMed / PMC', openalex: 'OpenAlex', semantic_scholar: 'Semantic Scholar' };
    const shown = setting.optionScope === 'rss' ? ['rss'] : setting.validation.values.filter((value) => value !== 'rss');
    const preserved = (setting.value || []).filter((value) => !shown.includes(value));
    for (const value of shown) { const checkbox = el('input'); checkbox.type = 'checkbox'; checkbox.value = value; checkbox.checked = (setting.value || []).includes(value); input.append(label(labels[value] || value, checkbox)); }
    Object.defineProperty(input, 'value', { get: () => [...preserved, ...[...input.querySelectorAll('input')].filter((entry) => entry.checked).map((entry) => entry.value)] });
  } else if (setting.type === 'enum' && setting.validation.values.length <= 5) {
    input = el('fieldset', undefined, 'setting-options'); input.append(el('legend', setting.description)); const name = `option-${crypto.randomUUID()}`;
    for (const value of setting.validation.values) { const radio = el('input'); radio.type = 'radio'; radio.name = name; radio.value = value; radio.checked = value === setting.value; const text = ({ local: '本地', desktop: '桌面', web: '网页', disabled: '停用', enabled: '启用', strict: '严格', warn: '提醒', off: '关闭', on: '开启', auto: '自动', standard: '标准运行', complete: '完整运行', radar: '每日速览' })[value] || value; input.append(label(text, radio)); }
    Object.defineProperty(input, 'value', { get: () => input.querySelector('input:checked')?.value });
  } else if (setting.type === 'enum') input = select(setting.validation.values.map((value) => [value, value]), setting.value);
  else if (setting.type === 'boolean') { input = el('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = setting.value === true; }
  else { input = el('input'); input.type = ['integer', 'number'].includes(setting.type) ? 'number' : setting.type === 'email' ? 'email' : setting.type === 'url' ? 'url' : 'text'; input.value = ''; input.dataset.replacement = 'true'; input.placeholder = settingPlaceholder(setting); if (setting.validation.min !== undefined) input.min = setting.validation.min; if (setting.validation.max !== undefined) input.max = setting.validation.max; if (setting.type === 'number') input.step = 'any'; }
  return input;
}
function settingPlaceholder(setting) {
  const exact = {
    'translation.model': '例如：deepseek-flash', 'preference.model': '例如：deepseek-flash',
    'translation.endpoint': '例如：https://api.example.com/v1/chat/completions', 'preference.endpoint': '例如：https://api.example.com/v1/chat/completions',
    'email.recipient': '例如：name@example.com', 'smtp.host': '例如：smtp.example.com', 'smtp.port': '例如：465', 'smtp.user': '例如：name@example.com',
    'web.userId': '例如：1234567', 'zotero.batch': '例如：25', 'pubmed.days': '例如：10', 'openalex.days': '例如：10',
    'runtime.projectRoot': '例如：C:\\Research\\PaperEcho', 'local.input': '例如：input', 'local.output': '例如：output', 'local.feedback': '例如：feedback', 'desktop.zoteroExe': '例如：C:\\Program Files\\Zotero\\zotero.exe',
    'translation.temperature': '例如：0.1', 'preference.temperature': '例如：0.1', 'translation.timeout': '例如：30000', 'preference.timeout': '例如：30000',
    'review.batch': '例如：20', 'pubmed.limit': '例如：500', 'openalex.page_size': '例如：100', 'weekly.interval': '例如：7',
  };
  return exact[setting.id] || (['integer', 'number'].includes(setting.type) ? '请输入数值' : '请输入内容');
}
function settingValue(setting, input) {
  if (setting.id === 'sources.override') return input.value;
  if (setting.type === 'boolean') return input.checked;
  if (input.dataset.replacement === 'true' && !input.value.trim()) return undefined;
  if (['integer', 'number'].includes(setting.type)) return Number(input.value);
  return input.value;
}
function appendCredentialEditor(section, item, onStatusChange = () => {}) {
  if (!item) return null;
  const names = { TITLE_TRANSLATION_API_KEY: '标题翻译 API 密钥', PREFERENCE_LEARNING_API_KEY: '智能评审 API 密钥', EASYSCHOLAR_SECRET_KEY: '期刊指标密钥', SMTP_PASS: '邮件 SMTP 密码', ZOTERO_API_KEY: 'Zotero Web API Key' };
  const row = el('div', undefined, 'setting'); const status = el('p');
  let configure; let clear;
  const zoteroKey = item.id === 'ZOTERO_API_KEY';
  const configureLabel = () => zoteroKey ? (item.configured ? '替换 API Key' : '配置 API Key') : (item.configured ? '替换凭据' : '配置凭据');
  const sync = () => {
    status.textContent = `${names[item.id] || '凭据'}：${item.configured ? '已配置' : '未配置'}`;
    if (configure) configure.textContent = configureLabel();
    if (clear) clear.hidden = !item.configured;
  };
  sync(); row.append(status);
  if (item.writable) {
    const input = el('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.maxLength = 4096; input.placeholder = item.id === 'ZOTERO_API_KEY' ? '请输入 Zotero API Key' : '输入新值；原值不会回显';
    const editor = el('div', undefined, 'credential-editor'); editor.hidden = true;
    const save = button(zoteroKey ? '保存 API Key' : '保存凭据', async () => { const value = input.value; await api('/api/credentials', { id: item.id, action: 'replace', value }); input.value = ''; item.configured = true; editor.hidden = true; sync(); onStatusChange(); notice.textContent = `凭据已替换。${item.reload}`; });
    const cancel = button('取消', () => { input.value = ''; editor.hidden = true; });
    editor.append(label(item.id === 'ZOTERO_API_KEY' ? '新的 Zotero Web API Key' : '新的凭据', input), save, cancel);
    configure = button('', () => { editor.hidden = false; input.focus(); });
    clear = button(zoteroKey ? '清除' : '清除凭据', async () => { if (!confirm(`清除 ${item.id}？依赖该凭据的功能可能暂不可用。`)) return; await api('/api/credentials', { id: item.id, action: 'clear' }); input.value = ''; item.configured = false; editor.hidden = true; sync(); onStatusChange(); notice.textContent = `凭据已清除。${item.reload}`; });
    const actions = el('div', undefined, 'actions credential-actions'); actions.append(configure, clear); row.append(actions, editor); sync();
  } else row.append(el('p', item.reason, 'muted'));
  section.append(row); return row;
}
const runtimePaths = {
  local: { title: '本地运行', summary: '不使用 Zotero，直接使用 PaperEcho 本地研究目录。', fit: '适合希望以本地目录作为输入与输出的工作方式。', data: '从配置的 JSON / JSONL 文件或目录读取。', result: '写入配置的本地输出目录；反馈文件可选。', needs: '不需要 Zotero Desktop，也不需要 Zotero Web API 凭据。' },
  desktop: { title: 'Zotero Desktop', summary: '让 PaperEcho 与当前电脑上的 Zotero Desktop 配合工作。', fit: '适合已经安装 Zotero Desktop，并希望使用本机文献库的人。', data: '由既有 Desktop owner 连接本机 Zotero 工作流。', result: '按正式 Desktop owner 写入本机 Zotero 集合与本地报告。', needs: '需要 Zotero Desktop；不需要 Zotero Web API Key。' },
  web: { title: 'Zotero Web', summary: '通过 Zotero 官方 Web API v3 访问个人文库。', fit: '适合不依赖本机 Zotero Desktop，或需要远程访问个人文库的场景。', data: '提供数字 User ID 与写入凭据。', result: '由既有 Web backend owner 完成读取与写入。', needs: '不需要 Zotero Desktop；需要具有个人文库写权限的 API Key。' },
};
const runtimePathFields = {
  local: [{ id: 'local.input', required: true }, { id: 'local.output', required: true }, { id: 'local.feedback', required: false }],
  desktop: [{ id: 'desktop.zoteroExe', required: false }],
  web: [{ id: 'web.userId', required: true }],
};
function runtimePathOptions(selected, onChange) {
  const fieldset = el('fieldset', undefined, 'runtime-path-options'); fieldset.append(el('legend', '选择运行路径')); const name = `runtime-path-${crypto.randomUUID()}`;
  for (const [key, path] of Object.entries(runtimePaths)) {
    const input = el('input'); input.type = 'radio'; input.name = name; input.value = key; input.checked = selected === key; input.id = `runtime-${key}-${crypto.randomUUID()}`; input.setAttribute('aria-label', path.title); input.addEventListener('change', () => onChange(key));
    const copy = el('span', undefined, 'runtime-path-copy'); copy.append(el('strong', path.title), el('span', path.summary), el('small', path.fit), el('small', path.data), el('small', path.result), el('small', path.needs));
    const card = el('label', undefined, 'runtime-path-card'); card.htmlFor = input.id; card.append(input, copy); fieldset.append(card);
  }
  Object.defineProperty(fieldset, 'value', { get: () => fieldset.querySelector('input:checked')?.value });
  return fieldset;
}
async function settings(group = settingsGroup, view = settingsView) {
  settingsGroup = Object.hasOwn(settingViews, group) ? group : 'common'; settingsView = view;
  const planView = settingsGroup === 'automation' && settingsView === 'plan';
  main.append(pageIntro(planView ? '每日计划运行' : '工作空间设置', planView
    ? '外部 Agent 每天北京时间 15:00 唤醒 PaperEcho；PaperEcho 根据最近一次成功周报的计划时隙，选择 Daily Radar 或 Weekly。'
    : '这里只保留日常最常用的选项；检索词、检索式和底层参数继续由原配置维护。'));
  const data = await api('/api/settings');
  const credentials = await api('/api/credentials');
  const groupPath = { common: 'general', review: 'models', runtime: 'runtime', automation: 'automation', connections: 'connections' }[settingsGroup];
  const hasContent = ([key, , categories]) => ['translation', 'preference', 'path', 'plan'].includes(key) || (key === 'credentials' ? credentials.length > 0 : categories.some((category) => data.some((entry) => entry.category === category && visibleSetting(entry) && (category !== 'Models' || entry.id.startsWith(`${key}.`)))));
  const views = settingViews[settingsGroup].filter(hasContent);
  if (!views.some(([key]) => key === settingsView)) settingsView = views[0]?.[0] || settingViews[settingsGroup][0][0];
  if (views.length > 1) main.append(tertiaryNav('设置任务', views.map(([key, title]) => [key, title]), settingsView, `settings/${groupPath}`));
  const body = el('div', undefined, 'settings-body page-content'); main.append(body);
  if (settingsGroup === 'automation' && settingsView === 'plan') { await dailyPlan(body); return; }
  if (settingsGroup === 'automation' && settingsView === 'radar') { body.append(el('p', 'Daily Radar 在非 Weekly 到期日运行；Weekly 到期日不会额外运行 Radar。流程由每日计划自动选择。', 'meta'), button('查看每日计划', () => navigate('settings/automation/plan'))); }
  if (settingsGroup === 'automation' && settingsView === 'weekly') {
    body.append(el('p', 'Weekly 以最近一次成功周报的计划时隙计算七天周期，完成时间不会改变下一个周期日期。周报日由每日计划自动选择。', 'meta'), button('查看每日计划', () => navigate('settings/automation/plan')));
    const profile = data.find((entry) => entry.id === 'general.profile');
    if (profile?.value === 'radar') body.append(el('p', '当前旧运行配置仅指向 Radar，不适用于每日计划。', 'plan-alert'), button('修复为标准周报模式', async () => { await api('/api/settings', { id: 'general.profile', value: 'standard' }); notice.textContent = '周报执行模式已修复，下次运行生效。'; await settings(); }));
  }
  const appendSettingsControls = (container, entries, saveName, saveLabel = '保存本组', featureToggleIds = [], featureOptions = {}) => {
    const toggleIds = new Set(featureToggleIds); const saves = []; const dependentRows = []; const featureToggles = []; let unavailable = 0;
    const orderedEntries = toggleIds.size ? [...entries].sort((a, b) => Number(toggleIds.has(b.id)) - Number(toggleIds.has(a.id))) : entries;
    for (const entry of orderedEntries) {
      const setting = { ...entry, sourceEntry: entry, optionScope: settingsView, description: entry.description.replace(/translation/g, '标题翻译').replace(/preference/g, '偏好学习').replace(/required/g, '必要').replace(/optional/g, '补充').replace(/negative/g, '排除').replace(/owner/g, '配置服务').replace(/workflow/g, '工作流') };
      if (setting.id === 'sources.override') setting.description = settingsView === 'rss' ? 'RSS 订阅状态' : '选择 PaperEcho 用于检索论文的数据库来源';
      if (setting.id === 'pubmed.days') setting.description = 'PubMed / PMC 检索天数';
      if (setting.id === 'openalex.days') setting.description = 'OpenAlex 检索天数';
      const toggle = toggleIds.has(setting.id); const row = el('div', undefined, `setting${toggle ? ' feature-toggle' : toggleIds.size ? ' feature-dependent' : ''}`);
      if (!setting.available && !toggle) {
        unavailable += 1;
        continue;
      }
      if (setting.readOnly) { row.append(el('p', `${setting.description}：${setting.value}（只读）`)); container.append(row); continue; }
      if (setting.type === 'rss') { const read = rssEditor(setting, row); saves.push({ setting, read, input: row }); container.append(row); continue; }
      const input = settingControl(setting);
      if (setting.synthetic) { input.addEventListener('change', () => { setting.changed = true; }); }
      if (toggle) { featureToggles.push(input); input.id ||= `field-${crypto.randomUUID()}`; input.setAttribute('aria-label', setting.description); const switchLabel = el('label'); switchLabel.htmlFor = input.id; const switchCopy = el('span', undefined, 'feature-toggle-copy'); const stateText = el('small', setting.value === true ? '当前已开启' : '当前已关闭'); switchCopy.append(el('strong', setting.description), stateText); switchLabel.append(switchCopy, input); row.append(switchLabel); input.addEventListener('change', () => { stateText.textContent = `待保存：${input.checked ? '开启' : '关闭'}`; }); if (setting.mixed) row.append(el('p', '现有相关开关状态不一致；切换并保存后会同步。', 'meta')); setting.stateText = stateText; }
      else { if (toggleIds.size) dependentRows.push({ row, input }); if (input.className.includes('setting-options')) row.append(input); else if (setting.type === 'boolean') { const stateText = el('p', setting.value === true ? '当前已开启' : '当前已关闭', 'meta'); row.append(label(setting.description, input), stateText); setting.stateText = stateText; } else { const currentValue = el('p', `当前：${currentSettingText(setting)}`, 'setting-current'); row.append(currentValue, label(`${setting.description}（留空不变）`, input)); setting.currentValue = currentValue; } }
      if (setting.validation.min !== undefined || setting.validation.max !== undefined) row.append(el('small', `允许范围：${setting.validation.min ?? '不限'}–${setting.validation.max ?? '不限'}`));
      saves.push({ setting, input, read: () => settingValue(setting, input) }); container.append(row);
    }
    let syncFeatureStatus = () => {};
    if (toggleIds.size && featureOptions.statusText) {
      const row = el('div', undefined, 'feature-dependent capability-status'); const status = el('p'); syncFeatureStatus = () => { status.textContent = typeof featureOptions.statusText === 'function' ? featureOptions.statusText() : featureOptions.statusText; }; syncFeatureStatus(); row.append(el('strong', '当前配置状态'), status); container.append(row); dependentRows.push({ row });
    }
    for (const item of featureOptions.credentials || []) {
      const row = appendCredentialEditor(container, item, syncFeatureStatus); if (row) { row.className += ' feature-dependent'; dependentRows.push({ row }); }
    }
    if (featureToggles.length) {
      const detailsId = `feature-details-${crypto.randomUUID()}`;
      const syncFeatureState = () => {
        const expanded = featureToggles.some((input) => input.checked); container.dataset.featureCollapsed = String(!expanded);
        for (const input of featureToggles) { input.setAttribute('aria-controls', detailsId); input.setAttribute('aria-expanded', String(expanded)); }
        dependentRows.forEach(({ row, input }, index) => { if (index === 0) row.id ||= detailsId; row.hidden = !expanded; if (input) input.disabled = !expanded; });
      };
      for (const input of featureToggles) input.addEventListener('change', syncFeatureState); syncFeatureState();
    }
    if (unavailable) container.append(el('p', '当前配置未提供此组的部分常用字段；已有值仍由原配置维护。', 'meta'));
    if (!saves.length) return;
    const actions = el('div', undefined, 'actions group-save section-actions'); const save = button(saveLabel, async () => {
      const values = saves.flatMap((entry) => { if (entry.input.checkValidity?.() === false) throw new Error('请按字段要求输入有效值，原设置未改变。'); const value = entry.read(); if (value === undefined || entry.setting.synthetic && !entry.setting.changed) return []; return (entry.setting.writeIds || [entry.setting.id]).map((id) => [id, value]); });
      if (!values.length) { notice.textContent = '没有需要修改的设置。留空字段保持原值。'; return; }
      await api('/api/settings', { updates: values.map(([id, value]) => ({ id, value })) });
      for (const entry of saves) {
        const value = entry.read();
        if (toggleIds.has(entry.setting.id)) { entry.setting.value = entry.input.checked; entry.setting.sourceEntry.value = entry.input.checked; if (entry.setting.stateText) entry.setting.stateText.textContent = entry.input.checked ? '当前已开启' : '当前已关闭'; }
        else if (entry.setting.type === 'boolean') { entry.setting.value = entry.input.checked; entry.setting.sourceEntry.value = entry.input.checked; if (entry.setting.stateText) entry.setting.stateText.textContent = entry.input.checked ? '当前已开启' : '当前已关闭'; }
        else if (value !== undefined && entry.input.dataset?.replacement === 'true') { entry.setting.value = value; entry.setting.sourceEntry.value = value; entry.input.value = ''; if (entry.setting.currentValue) entry.setting.currentValue.textContent = `当前：${currentSettingText(entry.setting)}`; }
      }
      syncFeatureStatus();
      notice.textContent = `“${saveName}”已保存，下次运行生效。`;
    }); save.className = 'primary'; actions.append(save); container.append(actions);
  };
  const active = (views.find(([key]) => key === settingsView) || settingViews[settingsGroup][0]);
  if (settingsGroup === 'review') {
    const title = settingsView === 'translation' ? '标题翻译' : '偏好学习';
    const entries = settingsView === 'translation'
      ? (() => { const rows = data.filter((entry) => entry.category === 'Models' && entry.id.startsWith('translation.')); return rows.some((entry) => entry.id === 'translation.enabled') ? rows : [{ category: 'Models', available: true, ownerPresent: false, id: 'translation.enabled', description: '启用标题翻译', type: 'boolean', value: true, validation: {} }, ...rows]; })()
      : (() => { const master = data.find((entry) => entry.id === 'review.master'); const preference = data.find((entry) => entry.id === 'preference.enabled'); const review = data.find((entry) => entry.id === 'review.enabled'); const states = [master, preference, review].filter(Boolean).map((entry) => entry.value); const combined = { ...(preference || {}), category: 'Models', available: true, ownerPresent: Boolean(master?.ownerPresent && preference?.ownerPresent && review?.ownerPresent), id: 'review-learning.combined', description: '启用智能评审与偏好学习', type: 'boolean', validation: {}, value: states.length === 3 && states.every((value) => value === true), mixed: states.length > 1 && new Set(states).size > 1, synthetic: true, changed: false, writeIds: ['review.master', 'review.enabled', 'preference.enabled'] }; return [combined, ...data.filter((entry) => entry.id.startsWith('preference.') && entry.id !== 'preference.enabled' && visibleSetting(entry))]; })();
    const requiredIds = settingsView === 'translation' ? ['translation.model', 'translation.endpoint'] : ['preference.model', 'preference.endpoint'];
    const credentialId = settingsView === 'translation' ? 'TITLE_TRANSLATION_API_KEY' : 'PREFERENCE_LEARNING_API_KEY';
    const credential = credentials.find((entry) => entry.id === credentialId);
    const capabilityStatus = () => { const missing = requiredIds.filter((id) => !String(entries.find((entry) => entry.id === id)?.value || '').trim()).map((id) => id.endsWith('.model') ? '模型名称' : 'API 地址'); if (!credential?.configured) missing.push('API 密钥'); return missing.length ? `功能已开启时，还需要完成以下配置：${missing.join('、')}。` : '必要参数已配置；真实可用性仍由运行前检查确认。'; };
    const section = el('section', undefined, 'settings-section section');
    section.append(el('h3', settingsView === 'translation' ? '标题翻译' : '智能评审与偏好学习', 'section-header'), el('p', settingsView === 'translation' ? '开启后使用配置的模型生成中文标题；关闭不会清空已有配置。' : '一个开关同时控制等级复审与 LLM 偏好学习；关闭不会清空已有配置。', 'meta'));
    appendSettingsControls(section, entries, title, `保存${title}`, settingsView === 'translation' ? ['translation.enabled'] : ['review-learning.combined'], { statusText: capabilityStatus, credentials: credential ? [credential] : [] });
    body.append(section); return;
  }
  if (settingsGroup === 'runtime') {
    const section = el('section', undefined, 'settings-section runtime-settings'); section.append(el('h3', '选择运行路径', 'section-header'), el('p', '三种路径互斥；只显示当前路径需要的设置。固定启动入口仍会校验路径一致性。', 'meta'));
    const mode = data.find((entry) => entry.id === 'runtime.mode');
    if (!mode?.available) { section.append(el('p', '当前配置尚未提供运行路径字段。', 'empty-state')); body.append(section); return; }
    let selectedMode = mode.value || mode.effectiveValue;
    const current = el('p', `当前运行路径：${runtimePaths[mode.value || mode.effectiveValue]?.title || '未配置'}${mode.ownerPresent === false ? '（当前启动路径；统一配置尚未保存）' : ''}`, 'runtime-current');
    const options = runtimePathOptions(selectedMode, (value) => { selectedMode = value; current.textContent = `正在配置：${runtimePaths[value].title}（尚未保存）`; current.className = 'runtime-current unsaved'; sync(); }); section.append(options, current);
    const panels = {}; const records = []; const readinessFor = {}; let save;
    for (const pathName of Object.keys(runtimePathFields)) {
      const panel = el('div', undefined, 'runtime-path-panel'); panel.dataset.path = pathName;
      panel.append(el('h4', pathName === 'web' ? 'Zotero Web 配置' : `${runtimePaths[pathName].title} · 当前路径配置`));
      if (pathName === 'web') panel.append(el('p', 'Zotero 官方接口固定使用 https://api.zotero.org，并由 PaperEcho 通过 API v3 请求；无需手工填写 API 地址或版本。', 'meta'));
      const specs = runtimePathFields[pathName];
      const runtimeReadiness = () => { const missingRequired = specs.filter((spec) => spec.required && !String(data.find((item) => item.id === spec.id)?.value || '').trim()).map((spec) => data.find((item) => item.id === spec.id)?.description || spec.id); if (pathName === 'local') return missingRequired.length ? `尚未完成配置：缺少${missingRequired.join('、')}。` : '基础配置完整；路径可读写性将在运行前检查。'; if (pathName === 'desktop') return '无需额外必填配置；Zotero Desktop 与 CLI bridge 将在运行前检测。'; if (!credentials.find((item) => item.id === 'ZOTERO_API_KEY')?.configured) missingRequired.push('Zotero Web API Key'); return missingRequired.length ? `基础配置：不完整。缺少：${missingRequired.join('、')}。连接状态：运行前检测尚未执行。` : '基础配置：完整。连接状态：运行前检测尚未执行。'; };
      readinessFor[pathName] = runtimeReadiness;
      const readiness = el('p', runtimeReadiness(), 'runtime-readiness'); panel.append(readiness);
      for (const spec of specs) {
        const id = spec.id; const entry = data.find((item) => item.id === id);
        if (!entry?.available) continue;
        const input = settingControl(entry); const row = el('div', undefined, 'setting'); let currentValue = null;
        if (spec.required && !String(entry.value || '').trim()) input.required = true;
        currentValue = el('p', `当前：${currentSettingText(entry)}`, 'setting-current');
        row.append(currentValue, label(`${entry.description}${spec.required ? '（必填；留空保持现值）' : '（选填；留空不变）'}`, input));
        if (id === 'web.userId') row.append(el('small', 'Zotero 数字 User ID，不是用户名或邮箱。PaperEcho v2.4 的 Web 路径使用个人文库。'));
        panel.append(row); records.push({ pathName, entry, input, currentValue, required: spec.required, row });
      }
      if (pathName === 'web') {
        appendCredentialEditor(panel, credentials.find((item) => item.id === 'ZOTERO_API_KEY'), () => { readiness.textContent = runtimeReadiness(); });
        panel.append(el('p', 'PaperEcho 需要一个对个人 Zotero 文库具有写入权限的 API Key；权限由 Zotero 管理，不在此处手工填写。', 'meta'));
      }
      panels[pathName] = panel; section.append(panel);
    }
    const workspace = el('div', undefined, 'runtime-shared-panel'); workspace.append(el('h4', 'PaperEcho 本地工作区'), el('p', '这是 PaperEcho 用于保存运行状态、索引与报告的本地目录，不是 Zotero Web API 配置。留空时沿用当前运行根目录。', 'meta'));
    const projectEntry = data.find((item) => item.id === 'runtime.projectRoot');
    if (projectEntry?.available) { const input = settingControl(projectEntry); const currentValue = el('p', `当前：${currentSettingText(projectEntry)}`, 'setting-current'); const row = el('div', undefined, 'setting'); row.append(currentValue, label(`${projectEntry.description}（选填；留空不变）`, input)); workspace.append(row); records.push({ pathName: 'shared', entry: projectEntry, input, currentValue, required: false, row }); }
    section.append(workspace);
    function sync() { for (const [name, panel] of Object.entries(panels)) panel.hidden = name !== selectedMode; workspace.hidden = selectedMode === 'local'; if (save) save.textContent = selectedMode === 'web' ? '保存 Zotero Web 配置' : '保存运行路径'; }
    sync();
    const actions = el('div', undefined, 'actions group-save section-actions'); save = button('', async () => { const selected = options.value; if (!selected) throw new Error('请先选择一种运行路径。'); const selectedRecords = records.filter((entry) => entry.pathName === selected || entry.pathName === 'shared' && selected !== 'local'); const updates = [{ id: 'runtime.mode', value: selected }]; for (const record of selectedRecords) { const value = settingValue(record.entry, record.input); if (record.required && value === undefined && !String(record.entry.value || '').trim()) throw new Error(`请先填写${record.entry.description}，原设置未改变。`); if (record.input.checkValidity?.() === false) throw new Error('请按字段要求输入有效值，原设置未改变。'); if (value !== undefined) updates.push({ id: record.entry.id, value }); } await api('/api/settings', { updates }); mode.value = selected; mode.ownerPresent = true; current.textContent = `当前运行路径：${runtimePaths[selected].title}`; current.className = 'runtime-current'; for (const record of selectedRecords) { const value = settingValue(record.entry, record.input); record.entry.ownerPresent = true; if (value !== undefined) { record.entry.value = value; if (record.input.dataset?.replacement === 'true') record.input.value = ''; } if (record.currentValue) record.currentValue.textContent = `当前：${currentSettingText(record.entry)}`; } panels[selected].querySelector('.runtime-readiness').textContent = readinessFor[selected](); notice.textContent = selected === 'web' ? 'Zotero Web 配置已保存；下次运行生效。连接状态仍由运行前检测确认。' : '“运行路径”已保存，下次运行生效；连接与路径可用性仍由运行前检查确认。'; }); save.className = 'primary'; actions.append(save); section.append(actions); sync(); body.append(section); return;
  }
  if (settingsGroup === 'connections' && settingsView === 'notifications') {
    const emailEntries = data.filter((entry) => entry.category === 'Notifications' && (entry.id.startsWith('email.') || entry.id.startsWith('smtp.')));
    const credential = credentials.find((entry) => entry.id === 'SMTP_PASS');
    const emailStatus = () => { const missing = ['email.recipient', 'smtp.host', 'smtp.user'].filter((id) => !String(emailEntries.find((entry) => entry.id === id)?.value || '').trim()).map((id) => ({ 'email.recipient': '收件人', 'smtp.host': 'SMTP 主机', 'smtp.user': 'SMTP 用户名' })[id]); if (!credential?.configured) missing.push('SMTP 密码'); return missing.length ? `启用邮件后，还需要完成以下配置：${missing.join('、')}。` : '邮件参数已配置；真实投递能力仍由运行前检查确认。'; };
    const emailSection = el('section', undefined, 'settings-section section'); emailSection.append(el('h3', '报告邮件', 'section-header'), el('p', '启用后使用下方 SMTP 配置发送报告；关闭不会清空已有参数。', 'meta'));
    appendSettingsControls(emailSection, emailEntries, '报告邮件', '保存报告邮件', ['email.enabled'], { statusText: emailStatus, credentials: credential ? [credential] : [] }); body.append(emailSection);
    const reminderEntries = data.filter((entry) => entry.category === 'Notifications' && entry.id.startsWith('notification.'));
    if (reminderEntries.length) { const reminderSection = el('section', undefined, 'settings-section section'); reminderSection.append(el('h3', '运行提醒', 'section-header'), el('p', '失败与健康提醒沿用现有 Stage5 通知 owner，不在此处更改投递逻辑。', 'meta')); appendSettingsControls(reminderSection, reminderEntries, '运行提醒'); body.append(reminderSection); }
    return;
  }
  for (const group of active[2]) {
    const groupTitle = group === 'Sources' && settingsView === 'rss' ? 'RSS 订阅状态' : settingGroupNames[group];
    const section = el('section', undefined, 'settings-section section'); section.append(el('h3', groupTitle, 'section-header'));
    let entries = data.filter((entry) => entry.category === group && visibleSetting(entry));
    appendSettingsControls(section, entries, groupTitle);
    if (group === 'Radar') section.append(el('p', '每日计划负责选择流程；此处只控制 Daily Radar 能力是否启用。', 'meta'));
    if (group === 'Credentials') {
      section.append(el('p', '凭据是敏感操作，仍需逐项明确替换或清除；原值永不回显。', 'meta'));
      for (const item of credentials.filter((entry) => entry.id !== 'ZOTERO_API_KEY')) appendCredentialEditor(section, item);
      section.append(el('p', '已配置不代表连接成功。暂无可复用的安全连接测试入口；连接测试尚未开放。', 'muted'));
    }
    if (entries.length || group === 'Credentials') body.append(section);
  }
}
async function render() {
  activeReview = null; main.setAttribute('aria-busy', 'true'); main.replaceChildren(el('p', '正在读取当前工作空间…', 'loading'));
  document.querySelector('#page-title').textContent = pageNames[page];
  document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = true; node.setAttribute('aria-current', node.dataset.page === page ? 'page' : 'false'); });
  document.querySelectorAll('[data-nav-group]').forEach((group) => { group.querySelector('.secondary-nav').hidden = group.dataset.navGroup !== page; });
  document.querySelectorAll('[data-nav-route]').forEach((node) => {
    const [, section] = node.dataset.navRoute.split('/');
    const active = page === 'feedback' ? section === feedbackView : page === 'settings' ? section === ({ common: 'general', review: 'models', runtime: 'runtime', automation: 'automation', connections: 'connections' }[settingsGroup]) : false;
    node.setAttribute('aria-current', active ? 'page' : 'false');
  });
  try { await ({ home, weekly, feedback, settings, system })[page](); }
  catch { notice.dataset.kind = 'error'; notice.textContent = '无法读取当前页面，请检查本地服务后重试。'; empty('页面暂不可用', '没有更改你的数据。'); main.append(button('重新读取', render)); }
  finally { main.querySelector('.loading')?.remove(); main.setAttribute('aria-busy', 'false'); document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = false; }); }
}
function navigate(route) { if (main.getAttribute('aria-busy') === 'true' || activeReview?.queue.busy) return; location.hash = route; }
function parseRoute(hash) {
  const [next, section, task] = String(hash || '').replace(/^#/, '').split('/');
  const state = { page: Object.hasOwn(pageNames, next) ? next : 'home', feedbackView: 'rating', reviewSection: 'normal', settingsGroup: 'common', settingsView: 'databases' };
  if (state.page === 'feedback') {
    if (section === 'research') state.feedbackView = 'research';
    else if (['rules', 'suggestions'].includes(section)) state.feedbackView = 'rules';
    else { state.feedbackView = 'rating'; state.reviewSection = section === 'rating' && task === 'manual' ? 'manual' : 'normal'; }
  }
  if (state.page === 'settings') {
    const groups = { general: 'common', common: 'common', models: 'review', review: 'review', runtime: 'runtime', automation: 'automation', connections: 'connections' };
    state.settingsGroup = groups[section] || 'common';
    const fallback = { common: 'databases', review: 'translation', runtime: 'path', automation: 'plan', connections: 'notifications' }[state.settingsGroup];
    state.settingsView = settingViews[state.settingsGroup].some(([key]) => key === task) ? task : fallback;
  }
  return state;
}
function route() {
  if (location.hash === '#content' && main.getAttribute('aria-busy') === 'false') { main.focus(); return; }
  ({ page, feedbackView, reviewSection, settingsGroup, settingsView } = parseRoute(location.hash));
  notice.textContent = ''; document.querySelector('#sidebar').dataset.open = 'false'; document.querySelector('#menu-toggle').setAttribute('aria-expanded', 'false');
  return render().then(() => { window.scrollTo?.(0, 0); (activeReview?.workspace || main).focus({ preventScroll: true }); });
}
const defaultRoutes = { feedback: 'feedback/rating/normal', settings: 'settings/general/databases' };
document.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => navigate(defaultRoutes[node.dataset.page] || node.dataset.page)));
document.querySelectorAll('[data-nav-route]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.navRoute)));
document.querySelector('#menu-toggle').addEventListener('click', () => { const sidebar = document.querySelector('#sidebar'); const open = sidebar.dataset.open !== 'true'; sidebar.dataset.open = String(open); document.querySelector('#menu-toggle').setAttribute('aria-expanded', String(open)); });
window.addEventListener('hashchange', route);
api('/api/session').then((session) => { csrf = session.token; return route(); }).catch(() => { main.replaceChildren(); empty('无法连接本地服务', '请确认 Control Center 正在运行，然后刷新页面。'); main.setAttribute('aria-busy', 'false'); });
