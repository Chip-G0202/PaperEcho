'use strict';
const main = document.querySelector('#content');
const notice = document.querySelector('#notice');
let csrf = '';
let page = 'home';
let offset = 0;
let feedbackView = 'papers';
let researchDraft = '';
let researchRequestId = crypto.randomUUID();
let settingsGroup = 'General';
const decisionReceipts = new Map();
const pageNames = { home: 'Overview · 概览', weekly: 'Literature · 文献', feedback: 'Feedback · 反馈', settings: 'Settings · 设置', system: 'System · 系统' };
const reasonLabels = ['不符合主题', '暴露因素不符', '研究人群不符', '模型不符', '方法不符', '文献类型不符', '范围过宽', '关联过弱', '其他'];
const errorMessages = { SETTING_VALUE_INVALID: '请检查字段格式或允许范围，原设置未改变。', SEARCH_KEYWORD_OWNER_REQUIRED: '请使用检索词分组修改检索式。', CREDENTIAL_VALUE_INVALID: '请输入有效单行凭据（最多 4096 字符）；请勿同时包含两种引号。', CREDENTIAL_EXTERNALLY_MANAGED: '该凭据由外部环境管理，请在原入口修改。', CREDENTIAL_WRITE_FAILED: '凭据未保存，请检查本地配置权限后重试。', CREDENTIAL_ENV_FORMAT_UNSUPPORTED: '凭据文件格式无法安全编辑，原文件未改变。', WEEKLY_CHANGED_RELOAD: '当前文献已更新，请刷新页面后重试。' };
const feedbackLabels = { highly_relevant: 'Highly Relevant · 高度相关', relevant: 'Relevant · 相关', maybe: 'Maybe · 待定', irrelevant: 'Irrelevant · 无关', do_not_recommend_similar: 'Do not recommend similar · 不推荐类似文献' };
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
async function home() {
  const status = await api('/api/status');
  main.append(el('h2', '研究工作空间'), el('p', '从最近的文献开始，让每次反馈帮助下一次推荐。', 'lead'));
  const grid = el('div', undefined, 'grid');
  const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }) : '暂无记录';
  for (const [name, value] of [['最近 Weekly', date(status.lastWeekly)], ['最近 Radar', date(status.lastRadar)], ['本期新写入', status.counts?.created ?? '暂无统计'], ['待确认规则建议', status.pendingSuggestions ?? '暂无统计']]) {
    const card = el('section', undefined, 'card'); card.append(el('h3', name), el('p', String(value), 'metric')); grid.append(card);
  }
  main.append(grid);
  const strip = el('div', undefined, 'summary-strip'); strip.append(el('p', `最近运行：${status.lastRun?.status === 'completed' ? '已完成' : status.lastRun?.status === 'failed' ? '未完成，请检查运行报告' : '暂无可靠状态'}`), el('p', `需人工复核：${status.needsReview ?? '暂无统计'}`)); main.append(strip);
  if (status.integrity) main.append(el('p', `完整性提醒：新撤稿 ${status.integrity.newlyConfirmedRetractions ?? 0} · 更正 ${status.integrity.newCorrections ?? 0} · 关注声明 ${status.integrity.newExpressionsOfConcern ?? 0}`, 'meta'));
  if (status.nextScheduledRun) main.append(el('p', `下一次运行：${date(status.nextScheduledRun)}`, 'meta'));
  const actions = el('div', undefined, 'actions quick-links'); const review = button('开始论文反馈', () => navigate('feedback/papers')); review.className = 'primary'; actions.append(review, button('提交研究方向反馈', () => navigate('feedback/research'))); main.append(actions);
}
function empty(title, text) { const box = el('section', undefined, 'empty-state'); box.append(el('h3', title), el('p', text)); main.append(box); }
async function system() {
  const status = await api('/api/status'); main.append(el('h2', '系统与数据状态'), el('p', '这里展示已有运行证据，不主动连接外部服务或显示敏感路径。', 'lead'));
  const list = el('dl', undefined, 'status-list');
  for (const [name, value] of [['版本', 'PaperEcho v2.4'], ['本地服务', '已响应 · 仅本机访问'], ['运行数据', '使用启动时解析的当前实例 roots；路径不在网页展示'], ['检索来源', status.sources.join('、') || '未配置'], ['Zotero', status.zotero === 'unknown' ? '暂无可靠记录' : '已有历史写入记录；非实时连接检测'], ['下次运行', status.nextScheduledRun || '暂无可靠调度信息'], ['兼容入口', 'XLSX / DOCX 仍受支持；不进行双向反馈同步']]) list.append(el('dt', name), el('dd', value));
  main.append(list);
}
async function feedback() {
  const nav = el('nav', undefined, 'subnav'); nav.setAttribute('aria-label', '反馈类型');
  for (const [key, text] of [['papers', 'Paper Feedback · 论文'], ['research', 'Research Feedback · 研究方向'], ['suggestions', 'Rule Suggestions · 规则建议']]) { const item = button(text, () => navigate(`feedback/${key}`)); item.setAttribute('aria-current', feedbackView === key ? 'page' : 'false'); nav.append(item); }
  main.append(nav); await (feedbackView === 'papers' ? weekly(true) : feedbackView === 'research' ? research() : suggestions());
}
async function weekly(review = false) {
  const data = await api(`/api/weekly?offset=${offset}&limit=50`);
  main.append(el('h2', review ? '论文反馈' : '最近 Weekly 文献'), el('p', review ? '阅读、判断、反馈。强负反馈只作为学习证据，不会直接生成永久排除规则。' : '浏览当前实例的文献与已有状态。需要评价推荐质量时，前往 Feedback。', 'lead'));
  if (!data.total) { empty('暂时没有可查看的文献', '当前实例尚无可用 Weekly / Local review。请完成一次原有 workflow 后刷新此页面。'); return; }
  main.append(el('p', `共 ${data.total} 篇 · 本页 ${data.items.filter((item) => item.feedback).length}/${data.items.length} 篇已反馈`, 'meta'));
  for (const item of data.items) {
    const card = el('article', undefined, review ? 'paper-feedback' : 'literature-item');
    card.append(el('h3', item.translatedTitle || item.title));
    if (item.translatedTitle) card.append(el('p', item.title, 'meta'));
    card.append(el('p', [item.authors.join(', '), item.journal, item.year].filter(Boolean).join(' · '), 'meta'));
    const meta = el('div', undefined, 'badge-row'); meta.append(el('span', `Grade ${item.grade || '未知'}`, 'badge'), el('span', item.source || '来源未提供', 'badge'));
    if (item.zotero && item.zotero !== 'not_used_local') meta.append(el('span', 'Zotero · 已收录', 'badge'));
    if (item.integrity) meta.append(el('span', `完整性 · ${item.integrity}`, 'badge warning'));
    if (item.needsReview) meta.append(el('span', '需人工复核', 'badge warning'));
    meta.append(el('span', item.feedback ? `已反馈 · ${feedbackLabels[item.feedback] || '已记录'}` : '待反馈', item.feedback ? 'badge success' : 'badge'));
    card.append(meta);
    const links = el('div', undefined, 'paper-links');
    if (item.doi) links.append(link(`DOI: ${item.doi}`, `https://doi.org/${encodeURIComponent(item.doi)}`));
    if (item.pmid) links.append(el('p', `PMID: ${item.pmid}`)); card.append(links);
    if (!review) { card.append(button('前往论文反馈', () => navigate('feedback/papers'))); main.append(card); continue; }
    const choice = select([['', '选择反馈'], ...Object.entries(feedbackLabels)], item.feedback);
    const reason = select(reasons.map((entry, index) => [entry, index ? reasonLabels[index - 1] : '不补充原因']), '');
    const details = el('details'); details.append(el('summary', '补充原因（可选）'), label('反馈原因', reason));
    const controls = el('div', undefined, 'feedback-controls'); controls.append(label('你认为这篇文献如何？', choice));
    const requestId = crypto.randomUUID();
    const save = button('保存反馈', async () => { if (!choice.value) throw new Error('请先选择论文反馈。'); await api('/api/feedback', { runId: data.runId, paperId: item.id, value: choice.value, reason: reason.value, requestId }); notice.textContent = '论文反馈已保存。可以继续查看下一篇。'; await render(); }); save.className = 'primary';
    save.disabled = !item.feedbackAllowed;
    controls.append(save); card.append(controls, details);
    if (!item.feedbackAllowed) card.append(el('p', '缺少可靠 identity，暂不能提交反馈。', 'muted'));
    main.append(card);
  }
  const pages = el('div', undefined, 'actions');
  const previous = button('上一页', async () => { offset = Math.max(0, offset - 50); await render(); }); previous.disabled = offset === 0;
  const next = button('下一页', async () => { offset += 50; await render(); }); next.disabled = offset + 50 >= data.total;
  pages.append(previous, el('span', `${Math.min(offset + 1, data.total)}–${Math.min(offset + 50, data.total)}`), next); main.append(pages);
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
      if (result.status === 'processed') { input.value = ''; researchDraft = ''; researchRequestId = crypto.randomUUID(); }
    } catch (error) { receipt.textContent = '提交未完成，输入已保留。'; throw error; } finally { input.disabled = false; }
  }); submit.className = 'primary';
  form.append(label('你的评价', input), el('p', '生成的建议会先进入人工确认，不会直接修改正式规则。', 'meta'), submit, receipt); main.append(form);
}
async function suggestions() {
  main.append(el('h2', '待确认规则建议'));
  const rows = await api('/api/suggestions');
  main.append(el('p', '逐条核对建议及依据。接受仅代表提交决策，正式应用仍需通过安全校验。', 'lead'));
  if (!rows.length) { empty('目前没有规则建议', '可以先提交研究方向反馈，生成的建议会显示在这里。'); return; }
  for (const item of rows) {
    const card = el('article'); const id = item.id || item.suggestion_id;
    const badges = el('div', undefined, 'badge-row'); badges.append(el('span', `状态 · ${item.status}`, 'badge'), el('span', `风险 · ${item.risk_level || '未知'}`, item.risk_level === 'high' ? 'badge warning' : 'badge'));
    card.append(badges, el('h3', item.rule_text || item.suggested_rule || '待确认变更'), el('p', `${id} · ${item.target || 'screening_standards.md'} · ${item.change_type || 'add_rule'}`, 'meta'), el('p', `建议理由：${item.rationale || '未提供'}`));
    const evidence = el('details'); evidence.append(el('summary', '查看依据'), el('p', item.evidence_text_excerpt || (item.evidence_titles || []).join('；') || '没有附加证据。', 'meta')); card.append(evidence);
    const savedReceipt = decisionReceipts.get(id);
    if (savedReceipt?.application_status === 'requires_manual_action' && ['pending', 'candidate'].includes(item.status)) {
      const manual = el('section', undefined, 'manual-action'); manual.append(el('strong', '已提交接受决策 · 未应用 / 需人工处理'), el('p', savedReceipt.explanation), el('p', savedReceipt.next_action)); card.append(manual);
    } else if (item.risk_level === 'high') card.append(el('p', '高风险变更：可能需要人工处理；网页确认不会解除安全限制。', 'manual-action'));
    if (['pending', 'candidate'].includes(item.status)) {
      const revised = el('textarea'); revised.maxLength = 4000;
      const actions = el('div', undefined, 'actions');
      for (const [decision, text] of [['accepted', 'Accept · 接受'], ['rejected', 'Reject · 拒绝'], ['revised', 'Revise then accept · 修改后接受']]) actions.append(button(text, async () => {
        if (!confirm(`确认${text}？正式变更仍需通过服务安全校验。`)) return;
        const result = await api('/api/decision', { id, decision, revisedRule: revised.value, humanApproval: true });
        decisionReceipts.set(id, result); notice.dataset.kind = result.application_status === 'requires_manual_action' ? 'warning' : 'success';
        notice.textContent = result.application_status === 'requires_manual_action'
          ? `未应用 · 需人工处理 · ${result.target} · 风险：${result.risk}。${result.explanation}${result.next_action}`
          : '决策已保存。';
        await render();
      }));
      const revision = el('details'); revision.append(el('summary', '修订建议内容'), label('修订内容（仅修改后接受时使用）', revised)); card.append(revision, actions);
    }
    main.append(card);
  }
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
  main.append(el('h2', '工作空间设置'), el('p', '按研究需求调整常用设置。每项独立校验与保存，下次 workflow 运行生效。', 'lead'));
  const data = await api('/api/settings');
  const groups = ['General', 'Models', 'Sources', 'Search', 'RSS', 'Ranking / Review', 'Radar', 'Weekly', 'Integrity', 'Zotero', 'Notifications', 'Credentials', 'Advanced'];
  const groupNames = ['常规', '模型', '检索来源', '检索条件', 'RSS 订阅', '排序与复审', '每日 Radar', 'Weekly 周报', '文献完整性', 'Zotero', '邮件通知', '凭据', '高级选项'];
  const picker = select(groups.map((group, i) => [group, `${group} · ${groupNames[i]}`]), settingsGroup); const pickerLabel = label('设置分类', picker); pickerLabel.className = 'settings-picker'; main.append(pickerLabel);
  picker.addEventListener('change', () => { settingsGroup = picker.value; main.querySelectorAll('[data-settings-group]').forEach((section) => { section.hidden = section.dataset.settingsGroup !== picker.value; }); });
  for (const group of groups) {
    const section = el('fieldset'); section.dataset.settingsGroup = group; section.hidden = group !== picker.value; section.append(el('legend', `${group} · ${groupNames[groups.indexOf(group)]}`));
    if (group === 'Models') section.append(el('p', '标题翻译独立配置；等级复审和文献综述复用偏好学习模型。', 'meta'));
    for (const setting of data.filter((entry) => entry.category === group)) {
      const row = el('div', undefined, 'setting');
      if (!setting.available) { row.append(el('p', `${setting.description}：当前 owner 配置尚未初始化`)); section.append(row); continue; }
      if (setting.readOnly) { row.append(el('p', `${setting.description}：${setting.value}（只读）`)); section.append(row); continue; }
      if (setting.type === 'rss') { rssEditor(setting, row); section.append(row); continue; }
      let input;
      if (setting.type === 'enum') input = select(setting.validation.values.map((value) => [value, value]), setting.value);
      else if (setting.type === 'boolean') { input = el('input'); input.type = 'checkbox'; input.checked = setting.value === true; }
      else { input = el('input'); input.type = ['integer', 'number'].includes(setting.type) ? 'number' : setting.type === 'email' ? 'email' : setting.type === 'url' ? 'url' : 'text'; input.value = Array.isArray(setting.value) ? setting.value.map((entry) => Array.isArray(entry) ? entry.join(' | ') : entry).join(', ') : setting.value ?? ''; if (setting.validation.min !== undefined) input.min = setting.validation.min; if (setting.validation.max !== undefined) input.max = setting.validation.max; if (setting.type === 'number') input.step = 'any'; }
      row.append(label(setting.description, input));
      if (setting.validation.min !== undefined || setting.validation.max !== undefined) row.append(el('small', `允许范围：${setting.validation.min ?? '不限'}–${setting.validation.max ?? '不限'}`));
      if (['list', 'keywords'].includes(setting.type)) row.append(el('small', '逗号分隔；required 同义词组内用 | 分隔。'));
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
        row.append(el('p', `${item.id}: ${item.configured ? 'Configured' : 'Not configured'}`));
        if (item.writable) {
          const input = el('input'); input.type = 'password'; input.autocomplete = 'new-password'; input.maxLength = 4096;
          row.append(label('新凭据（不会回显原值）', input), button('Replace · 替换', async () => {
            const value = input.value; input.value = '';
            await api('/api/credentials', { id: item.id, action: 'replace', value });
            notice.textContent = `凭据已替换。${item.reload}`; await render();
          }), button('Clear · 清除', async () => {
            if (!confirm(`清除 ${item.id}？依赖该凭据的功能可能暂不可用。`)) return;
            input.value = ''; await api('/api/credentials', { id: item.id, action: 'clear' });
            notice.textContent = `凭据已清除。${item.reload}`; await render();
          }));
        } else row.append(el('p', item.reason, 'muted'));
        section.append(row);
      }
      section.append(el('p', 'Configured 仅表示已配置，不代表连接成功。暂无可复用的安全连接测试入口；Test 未开放。', 'muted'));
    }
    main.append(section);
  }
}
async function render() {
  main.setAttribute('aria-busy', 'true'); main.replaceChildren(el('p', '正在读取当前工作空间…', 'loading'));
  document.querySelector('#page-title').textContent = pageNames[page];
  document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = true; node.setAttribute('aria-current', node.dataset.page === page ? 'page' : 'false'); });
  try { await ({ home, weekly, feedback, settings, system })[page](); }
  catch { notice.dataset.kind = 'error'; notice.textContent = '无法读取当前页面，请检查本地服务后重试。'; empty('页面暂不可用', '没有更改你的数据。'); main.append(button('重新读取', render)); }
  finally { main.querySelector('.loading')?.remove(); main.setAttribute('aria-busy', 'false'); document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = false; }); }
}
function navigate(route) { if (main.getAttribute('aria-busy') === 'true') return; location.hash = route; }
function route() {
  if (location.hash === '#content' && main.getAttribute('aria-busy') === 'false') { main.focus(); return; }
  const [next, view] = location.hash.slice(1).split('/'); page = Object.hasOwn(pageNames, next) ? next : 'home'; feedbackView = ['papers', 'research', 'suggestions'].includes(view) ? view : 'papers'; offset = 0;
  notice.textContent = ''; document.querySelector('#sidebar').dataset.open = 'false'; document.querySelector('#menu-toggle').setAttribute('aria-expanded', 'false');
  return render().then(() => main.focus());
}
document.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => navigate(node.dataset.page)));
document.querySelector('#menu-toggle').addEventListener('click', () => { const sidebar = document.querySelector('#sidebar'); const open = sidebar.dataset.open !== 'true'; sidebar.dataset.open = String(open); document.querySelector('#menu-toggle').setAttribute('aria-expanded', String(open)); });
window.addEventListener('hashchange', route);
api('/api/session').then((session) => { csrf = session.token; return route(); }).catch(() => { main.replaceChildren(); empty('无法连接本地服务', '请确认 Control Center 正在运行，然后刷新页面。'); main.setAttribute('aria-busy', 'false'); });
