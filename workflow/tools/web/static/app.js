'use strict';
const main = document.querySelector('#content');
const notice = document.querySelector('#notice');
let csrf = '';
let page = 'home';
let feedbackView = 'papers';
let researchDraft = '';
let researchRequestId = crypto.randomUUID();
let settingsGroup = 'research';
let reviewSection = 'normal';
let activeReview = null;
const decisionReceipts = new Map();
const pageNames = { home: '概览 · Overview', weekly: '文献 · Literature', feedback: '反馈 · Feedback', settings: '设置 · Settings', system: '系统 · System' };
const reasonLabels = ['不符合主题', '暴露因素不符', '研究人群不符', '模型不符', '方法不符', '文献类型不符', '范围过宽', '关联过弱', '其他'];
const errorMessages = { SETTING_VALUE_INVALID: '请检查字段格式或允许范围，原设置未改变。', SEARCH_KEYWORD_OWNER_REQUIRED: '请使用检索词分组修改检索式。', CREDENTIAL_VALUE_INVALID: '请输入有效单行凭据（最多 4096 字符）；请勿同时包含两种引号。', CREDENTIAL_EXTERNALLY_MANAGED: '该凭据由外部环境管理，请在原入口修改。', CREDENTIAL_WRITE_FAILED: '凭据未保存，请检查本地配置权限后重试。', CREDENTIAL_ENV_FORMAT_UNSUPPORTED: '凭据文件格式无法安全编辑，原文件未改变。', WEEKLY_CHANGED_RELOAD: '当前文献已更新，请刷新页面后重试。' };
// Keep the existing API/canonical values; the stored learning action is unchanged.
const feedbackLabels = { highly_relevant: '升级', relevant: '不变', maybe: '降级', irrelevant: '排除', do_not_recommend_similar: '排除（原强负反馈）' };
const feedbackActions = ['highly_relevant', 'relevant', 'maybe', 'irrelevant'];
const statusLabels = { pending: '待确认', candidate: '候选', accepted: '已接受', revised: '已修改接受', rejected: '已拒绝', superseded: '已被替代', expired: '已过期' };
const riskLabels = { low: '低', medium: '中', high: '高' };
const settingGroups = [
  ['research', '研究与检索', ['Sources', 'Search', 'RSS']],
  ['review', '评审与学习', ['Models', 'Ranking / Review', 'Radar', 'Weekly', 'Integrity']],
  ['connections', '连接与通知', ['Zotero', 'Notifications', 'Credentials']],
  ['workspace', '工作区与高级', ['General', 'Advanced']],
];
const reasons = ['', 'topic_mismatch', 'exposure_mismatch', 'population_mismatch', 'model_mismatch', 'method_mismatch', 'publication_type_mismatch', 'too_broad', 'too_peripheral', 'other'];
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action) { const node = el('button', text); node.type = 'button'; node.addEventListener('click', async () => {
  node.disabled = true; node.setAttribute('aria-busy', 'true'); notice.dataset.kind = 'success';
  const scope = node.closest('.setting, article, .research-form');
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
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(value) }).catch(() => { throw new Error('无法连接本地服务，请检查服务是否仍在运行。'); });
  const result = await response.json().catch(() => { throw new Error('服务响应暂不可用，请刷新页面后重试。'); });
  if (!response.ok) throw new Error(errorMessages[result.error] || '操作未完成。请检查输入或刷新页面后重试；安全限制仍然有效。');
  return result;
}
function link(text, raw) { const node = el('a', text); try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return el('span', text); node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; } catch { return el('span', text); } return node; }
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
  return (mode === 'rules' ? { 1: 'accepted', 2: 'rejected', 3: 'edit' } : { 1: 'highly_relevant', 2: 'relevant', 3: 'maybe', 4: 'irrelevant' })[event.key] || null;
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
function gradeCounts(items) { return items.reduce((counts, item) => { const grade = item.finalGrade ?? item.grade; counts[grade || 'unknown'] = (counts[grade || 'unknown'] || 0) + 1; return counts; }, { A: 0, B: 0, C: 0 }); }
function gradeBadge(value) {
  const text = { A: 'A级 · 高优先', B: 'B级 · 中优先', C: 'C级 · 低优先', D: 'D级 · 排除等级' }[value] || '最终等级 · 未提供';
  return el('span', text, `badge grade-${['A', 'B', 'C', 'D'].includes(value) ? value : 'unknown'}`);
}
function paperHeading(card, item) {
  card.append(el('h3', item.title || '原始标题未提供', 'paper-title'));
  if (item.translatedTitle && item.translatedTitle !== item.title) card.append(el('p', item.translatedTitle, 'translated-title'));
  card.append(el('p', [item.journal, item.year, item.source].filter(Boolean).join(' · '), 'meta'));
  const badges = el('div', undefined, 'badge-row'); badges.append(gradeBadge(item.finalGrade ?? item.grade));
  if (item.integrity) badges.append(el('span', `完整性状态：${({ correction: '更正', retracted: '已撤稿', clear: '未发现警报', unknown: '未知' })[item.integrity] || item.integrity}`, 'badge warning'));
  card.append(badges);
}
function paperDetails(card, item) {
  card.append(el('p', `作者：${item.authors.join('、') || '未提供'}`, 'meta'));
  if (item.abstract) card.append(el('h4', '摘要'), el('p', item.abstract));
  const links = el('div', undefined, 'paper-links');
  if (item.doi) links.append(link(`DOI：${item.doi}`, `https://doi.org/${encodeURIComponent(item.doi)}`));
  if (item.pmid) links.append(link(`PMID：${item.pmid}`, `https://pubmed.ncbi.nlm.nih.gov/${encodeURIComponent(item.pmid)}/`));
  card.append(links, el('p', `Zotero：${item.zotero === 'admitted' ? '已收录' : item.zotero === 'not_used_local' ? '本地模式，不使用 Zotero' : '暂无可靠状态'}`, 'meta'));
  if (item.reviewReason) card.append(el('h4', '等级复审依据'), el('p', item.reviewReason));
}
async function home() {
  const status = await api('/api/status'); const weeklyData = await loadWeekly(); const grades = gradeCounts(weeklyData.items);
  main.append(el('h2', '研究工作空间'), el('p', '从最近的文献开始，让每次反馈帮助下一次推荐。', 'lead'));
  const grid = el('div', undefined, 'grid');
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '暂无记录';
  for (const [name, value] of [['最近 Weekly', date(status.lastWeekly)], ['最近 Radar', date(status.lastRadar)], ['本次文献数量', weeklyData.total], ['待确认规则建议', status.pendingSuggestions ?? '暂无统计']]) {
    const card = el('section', undefined, 'card'); card.append(el('h3', name), el('p', String(value), 'metric')); grid.append(card);
  }
  main.append(grid, el('p', `A级 ${grades.A} · B级 ${grades.B} · C级 ${grades.C} · 待处理反馈 ${weeklyData.items.filter((item) => !item.feedback).length}`, 'overview-summary'));
  const strip = el('div', undefined, 'summary-strip'); strip.append(el('p', `最近运行：${status.lastRun?.status === 'completed' ? '已完成' : status.lastRun?.status === 'failed' ? '未完成，请检查运行报告' : '暂无可靠状态'}`), el('p', `需人工复核：${status.needsReview ?? '暂无统计'}`)); main.append(strip);
  if (status.integrity) main.append(el('p', `完整性提醒：新撤稿 ${status.integrity.newlyConfirmedRetractions ?? 0} · 更正 ${status.integrity.newCorrections ?? 0} · 关注声明 ${status.integrity.newExpressionsOfConcern ?? 0}`, 'meta'));
  if (status.nextScheduledRun) main.append(el('p', `下一次运行：${date(status.nextScheduledRun)}`, 'meta'));
  const actions = el('div', undefined, 'actions quick-links'); const review = button('开始文献审阅', () => navigate('feedback/papers')); review.className = 'primary'; actions.append(review, button('提交研究方向反馈', () => navigate('feedback/research'))); main.append(actions);
}
function empty(title, text) { const box = el('section', undefined, 'empty-state'); box.append(el('h3', title), el('p', text)); main.append(box); }
async function system() {
  const status = await api('/api/status'); main.append(el('h2', '系统与数据状态'), el('p', '这里展示已有运行证据，不主动连接外部服务或显示敏感路径。', 'lead'));
  const list = el('dl', undefined, 'status-list');
  for (const [name, value] of [['版本', 'PaperEcho v2.4'], ['本地服务', '已响应 · 仅本机访问'], ['运行数据', '使用启动时解析的当前工作区；路径不在网页展示'], ['检索来源', status.sources.join('、') || '未配置'], ['Zotero', status.zotero === 'unknown' ? '暂无可靠记录' : '已有历史写入记录；非实时连接检测'], ['下次运行', status.nextScheduledRun || '暂无可靠调度信息'], ['兼容入口', 'XLSX / DOCX 仍受支持；不进行双向反馈同步']]) list.append(el('dt', name), el('dd', value));
  main.append(list);
}
async function feedback() {
  const nav = el('nav', undefined, 'subnav'); nav.setAttribute('aria-label', '反馈类型');
  for (const [key, text] of [['papers', '文献等级'], ['research', '研究方向'], ['suggestions', '规则建议']]) { const item = button(text, () => navigate(`feedback/${key}`)); item.setAttribute('aria-current', feedbackView === key ? 'page' : 'false'); nav.append(item); }
  main.append(nav); await (feedbackView === 'papers' ? paperReview() : feedbackView === 'research' ? research() : suggestions());
}
async function weekly() {
  const data = await loadWeekly();
  main.append(el('h2', '本次文献汇总'), el('p', '只读浏览当前运行结果；等级和依据均保留系统原始判断。', 'lead'));
  if (!data.total) { empty('暂时没有可查看的文献', '当前实例尚无可用周报或本地文献结果。完成原有工作流后可重新读取。'); return; }
  const counts = gradeCounts(data.items); const filters = el('nav', undefined, 'grade-filters'); filters.setAttribute('aria-label', '按最终等级筛选');
  main.append(el('p', `本次共 ${data.total} 篇 · A级 ${counts.A} · B级 ${counts.B} · C级 ${counts.C}`, 'summary-strip'), filters);
  const list = el('section'); main.append(list); let selected = 'all'; let start = 0;
  const draw = () => {
    filters.replaceChildren(); list.replaceChildren();
    for (const [grade, count] of [['all', data.total], ...Object.entries(counts)]) {
      const name = grade === 'all' ? '全部' : grade === 'unknown' ? '等级未提供' : `${grade}级`;
      const choice = button(`${name} ${count}`, () => { selected = grade; start = 0; draw(); }); choice.setAttribute('aria-pressed', String(selected === grade)); filters.append(choice);
    }
    const items = data.items.filter((item) => selected === 'all' || ((item.finalGrade ?? item.grade) || 'unknown') === selected);
    for (const item of items.slice(start, start + 50)) { const card = el('article', undefined, 'literature-item'); paperHeading(card, item); paperDetails(card, item); list.append(card); }
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
async function paperReview() {
  const data = await loadWeekly(); main.append(el('h2', '文献等级审阅'), el('p', '最终等级是否正确？反馈作为人工纠正信号记录，保留本次系统等级；后续学习及条目处理仍由原工作流执行。', 'lead'));
  const tabs = el('nav', undefined, 'subnav'); tabs.setAttribute('aria-label', '文献审阅队列'); main.append(tabs);
  const workspace = el('section', undefined, 'review-workspace'); workspace.tabIndex = -1; workspace.setAttribute('aria-label', '文献审阅工作区'); main.append(workspace);
  // needsReview comes exclusively from the shared Weekly exporter owner.
  const groups = { normal: data.items.filter((item) => !item.needsReview), manual: data.items.filter((item) => item.needsReview) };
  const queues = Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, createReviewQueue(items, (item) => Boolean(item.feedback), (item) => item.feedbackAllowed)]));
  let queue = queues[reviewSection]; let message = ''; let messageKind = 'success'; const reasonDrafts = new Map();
  const draw = (focus = false) => {
    queue = queues[reviewSection]; tabs.replaceChildren(); workspace.replaceChildren();
    for (const [key, title] of [['normal', '常规文献'], ['manual', '需人工复核']]) { const tab = button(`${title} ${groups[key].length}`, () => { if (queue.busy) return; reviewSection = key; message = ''; draw(true); }); tab.disabled = queue.busy; tab.setAttribute('aria-current', reviewSection === key ? 'page' : 'false'); tabs.append(tab); }
    activeReview = { workspace, queue };
    if (!queue.items.length) { workspace.append(el('p', '此队列暂无文献。', 'empty-state')); return; }
    const processed = queue.items.filter((item) => item.feedback).length;
    workspace.append(el('p', `已处理 ${processed} / 共 ${queue.items.length} · 待处理 ${queue.items.length - processed}`, 'queue-progress'));
    if (message) { const receipt = el('p', message, `queue-receipt ${messageKind}`); receipt.setAttribute('role', 'status'); workspace.append(receipt); }
    if (processed === queue.items.length) workspace.append(el('p', '本队列已完成。可用上 / 下一篇回看并修改已记录反馈。', 'completion'));
    const item = queue.items[queue.index]; const card = el('article', undefined, 'focused-card'); paperHeading(card, item);
    card.append(el('p', item.feedback ? `当前反馈：${feedbackLabels[item.feedback] || '已记录'}` : '当前反馈：待处理', 'feedback-state'));
    if (reviewSection === 'manual') {
      const grades = el('dl', undefined, 'grade-evidence');
      for (const [name, grade] of [['规则等级', item.ruleGrade], ['语义等级', item.semanticGrade], ['最终等级', item.finalGrade ?? item.grade]]) grades.append(el('dt', name), el('dd', grade || '未提供'));
      card.append(grades, el('p', '以上为只读系统证据；你的反馈仅评价最终等级。', 'meta'));
    }
    if (item.reviewReason) card.append(el('p', `等级复审依据：${item.reviewReason.length > 160 ? item.reviewReason.slice(0, 160) + '…' : item.reviewReason}`, 'review-reason'));
    const details = el('details'); const summary = el('summary', '展开详细信息'); details.append(summary); paperDetails(details, item); details.addEventListener('toggle', () => { summary.textContent = details.open ? '收起详细信息' : '展开详细信息'; }); card.append(details);
    const optional = el('details'); optional.append(el('summary', '补充原因（可选）'));
    const reason = select(reasons.map((entry, i) => [entry, i ? reasonLabels[i - 1] : '不补充原因']), reasonDrafts.get(item.id) || ''); reason.addEventListener('change', () => reasonDrafts.set(item.id, reason.value)); optional.append(label('反馈原因', reason)); card.append(optional);
    const actions = el('div', undefined, 'actions feedback-actions');
    for (const [i, value] of feedbackActions.entries()) {
      const action = button(`${feedbackLabels[value]} ${i + 1}`, () => choose(value, reason.value));
      action.dataset.action = value; action.setAttribute('aria-label', feedbackLabels[value]); action.setAttribute('aria-pressed', String(item.feedback === value || value === 'irrelevant' && item.feedback === 'do_not_recommend_similar')); action.disabled = queue.busy || !item.feedbackAllowed; actions.append(action);
    }
    card.append(el('h4', '最终等级是否正确？'), actions);
    if (!item.feedbackAllowed) card.append(el('p', '缺少可靠文献标识，无法安全记录反馈；可跳过此篇。', 'warning'));
    workspace.append(card, el('p', '工作区快捷键：1 升级 · 2 不变 · 3 降级 · 4 排除 · ↑ 上一篇 · ↓ 下一篇。输入时停用。', 'shortcut-hint'));
    reviewNavigation(workspace, queue, draw);
    if (focus) workspace.focus();
  };
  const choose = async (value, reason) => {
    if (queue.busy) return;
    reason ??= workspace.querySelector('select')?.value || '';
    const pending = queue.submit(value + ':' + reason,
      (item, requestId) => api('/api/feedback', { runId: data.runId, paperId: item.id, value, reason, requestId }),
      (item) => { item.feedback = value; });
    draw();
    try { const saved = await pending; if (saved) { message = `已记录：${feedbackLabels[value]} · ${saved.item.title.slice(0, 90)}。`; messageKind = 'success'; } }
    catch (error) { message = error.message + ' 当前文献未前进，请重试。'; messageKind = 'error'; }
    draw(true);
  };
  // Read the active queue on every key press so switching queues cannot retain
  // an old queue's key handler or submit into a hidden queue.
  workspace.addEventListener('keydown', (event) => {
    if (queue.busy) return; const action = shortcutAction(event, 'papers'); if (!action) return; event.preventDefault();
    if (action === 'previous' || action === 'next') { queue.move(action === 'previous' ? -1 : 1); message = ''; draw(true); } else choose(action);
  }); draw();
}
async function research() {
  main.append(el('h2', '研究方向反馈'), el('p', '告诉 PaperEcho 最近推荐结果哪里与你的研究需求不一致。', 'lead'));
  const form = el('section', undefined, 'research-form');
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
async function suggestions() {
  main.append(el('h2', '规则建议审阅'), el('p', '点击即提交人工决策；接受不等于正式应用，安全校验始终生效。', 'lead'));
  const rows = await api('/api/suggestions');
  if (!rows.length) { empty('目前没有规则建议', '可以先提交研究方向反馈，生成的建议会显示在这里。'); return; }
  const idOf = (item) => item.id || item.suggestion_id;
  const pending = (item) => ['pending', 'candidate'].includes(item.status);
  const queue = createReviewQueue(rows, (item) => !pending(item) || decisionReceipts.has(idOf(item)), pending);
  let editing = false; let draft = ''; let message = ''; let messageKind = 'success';
  const workspace = el('section', undefined, 'review-workspace'); workspace.tabIndex = -1; workspace.setAttribute('aria-label', '规则建议审阅工作区'); main.append(workspace);
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
  draw(); container.append(list, button('添加 RSS', () => { entries.push({ name: '', url: '', enabled: false }); draw(); }), button('保存订阅列表', async () => { await api('/api/settings', { id: setting.id, value: entries }); notice.textContent = 'RSS 已保存，下次运行生效。'; }));
}
async function settings() {
  main.append(el('h2', '工作空间设置'), el('p', '按研究需求调整常用设置。每项独立校验与保存，下次工作流运行生效。', 'lead'));
  const data = await api('/api/settings');
  const groups = ['General', 'Models', 'Sources', 'Search', 'RSS', 'Ranking / Review', 'Radar', 'Weekly', 'Integrity', 'Zotero', 'Notifications', 'Credentials', 'Advanced'];
  const groupNames = ['常规', '模型', '检索来源', '检索条件', 'RSS 订阅', '排序与复审', '每日 Radar', 'Weekly 周报', '文献完整性', 'Zotero', '邮件通知', '凭据', '高级选项'];
  const layout = el('div', undefined, 'settings-layout'); const nav = el('nav', undefined, 'settings-nav'); nav.setAttribute('aria-label', '设置大类'); const body = el('div', undefined, 'settings-body'); layout.append(nav, body); main.append(layout);
  const switchGroup = (key) => { settingsGroup = key; nav.querySelectorAll('button').forEach((item) => item.setAttribute('aria-current', item.dataset.group === key ? 'page' : 'false')); body.querySelectorAll('[data-settings-group]').forEach((section) => { section.hidden = section.dataset.settingsGroup !== key; }); };
  for (const [key, title] of settingGroups) { const item = button(title, () => switchGroup(key)); item.dataset.group = key; item.setAttribute('aria-current', key === settingsGroup ? 'page' : 'false'); nav.append(item); }
  for (const group of groups) {
    const owner = settingGroups.find((entry) => entry[2].includes(group))[0];
    const section = el('section', undefined, 'settings-section'); section.dataset.settingsGroup = owner; section.hidden = owner !== settingsGroup; section.append(el('h3', groupNames[groups.indexOf(group)]));
    if (group === 'Models') section.append(el('p', '标题翻译独立配置；等级复审和文献综述复用偏好学习模型。', 'meta'));
    for (const entry of data.filter((entry) => entry.category === group)) {
      const setting = { ...entry, description: entry.description.replace(/required/g, '必要').replace(/optional/g, '补充').replace(/negative/g, '排除').replace(/owner/g, '配置服务').replace(/workflow/g, '工作流') };
      const row = el('div', undefined, 'setting');
      if (!setting.available) { row.append(el('p', `${setting.description}：当前配置尚未初始化`)); section.append(row); continue; }
      if (setting.readOnly) { row.append(el('p', `${setting.description}：${setting.value}（只读）`)); section.append(row); continue; }
      if (setting.type === 'rss') { rssEditor(setting, row); section.append(row); continue; }
      let input;
      if (setting.type === 'enum' && setting.validation.values.length <= 5) {
        input = el('fieldset', undefined, 'setting-options'); input.append(el('legend', setting.description)); const name = `option-${crypto.randomUUID()}`;
        for (const value of setting.validation.values) { const radio = el('input'); radio.type = 'radio'; radio.name = name; radio.value = value; radio.checked = value === setting.value; const text = ({ local: '本地', desktop: '桌面', web: '网页', disabled: '停用', enabled: '启用', strict: '严格', warn: '提醒', off: '关闭', on: '开启', auto: '自动', biomedical: '生物医学', non_biomedical_stem: '非生物医学理工', education_social_science: '教育与社会科学', mixed_biomedical_technical: '生物医学与技术交叉', unknown: '尚未指定', standard: '标准运行', complete: '完整运行', radar: '每日速览' })[value] || value; input.append(label(text, radio)); }
        Object.defineProperty(input, 'value', { get: () => input.querySelector('input:checked')?.value });
      }
      else if (setting.type === 'enum') input = select(setting.validation.values.map((value) => [value, value]), setting.value);
      else if (setting.type === 'boolean') { input = el('input'); input.type = 'checkbox'; input.setAttribute('role', 'switch'); input.checked = setting.value === true; }
      else { input = el('input'); input.type = ['integer', 'number'].includes(setting.type) ? 'number' : setting.type === 'email' ? 'email' : setting.type === 'url' ? 'url' : 'text'; input.value = Array.isArray(setting.value) ? setting.value.map((entry) => Array.isArray(entry) ? entry.join(' | ') : entry).join(', ') : setting.value ?? ''; if (setting.validation.min !== undefined) input.min = setting.validation.min; if (setting.validation.max !== undefined) input.max = setting.validation.max; if (setting.type === 'number') input.step = 'any'; }
      if (input.className === 'setting-options') row.append(input); else row.append(label(setting.description, input));
      if (setting.validation.min !== undefined || setting.validation.max !== undefined) row.append(el('small', `允许范围：${setting.validation.min ?? '不限'}–${setting.validation.max ?? '不限'}`));
      if (['list', 'keywords'].includes(setting.type)) row.append(el('small', '逗号分隔；必要检索词的同义词组内用 | 分隔。'));
      row.append(button('保存', async () => {
        let value = setting.type === 'boolean' ? input.checked : ['integer', 'number'].includes(setting.type) ? Number(input.value) : input.value;
        if (['list', 'keywords'].includes(setting.type)) value = input.value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => setting.id === 'pubmed.required' && entry.includes('|') ? entry.split('|').map((term) => term.trim()) : entry);
        if (!input.checkValidity()) throw new Error('请按字段要求输入有效值，原设置未改变。');
        await api('/api/settings', { id: setting.id, value }); notice.textContent = '设置已保存，下次运行生效。';
      })); section.append(row);
    }
    if (group === 'Credentials') {
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
  const [next, view] = location.hash.slice(1).split('/'); page = Object.hasOwn(pageNames, next) ? next : 'home'; feedbackView = ['papers', 'research', 'suggestions'].includes(view) ? view : 'papers';
  notice.textContent = ''; document.querySelector('#sidebar').dataset.open = 'false'; document.querySelector('#menu-toggle').setAttribute('aria-expanded', 'false');
  return render().then(() => (activeReview?.workspace || main).focus());
}
document.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.page)));
document.querySelector('#menu-toggle').addEventListener('click', () => { const sidebar = document.querySelector('#sidebar'); const open = sidebar.dataset.open !== 'true'; sidebar.dataset.open = String(open); document.querySelector('#menu-toggle').setAttribute('aria-expanded', String(open)); });
window.addEventListener('hashchange', route);
api('/api/session').then((session) => { csrf = session.token; return route(); }).catch(() => { main.replaceChildren(); empty('无法连接本地服务', '请确认 Control Center 正在运行，然后刷新页面。'); main.setAttribute('aria-busy', 'false'); });
