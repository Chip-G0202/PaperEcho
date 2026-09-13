'use strict';
const main = document.querySelector('#content');
const notice = document.querySelector('#notice');
let csrf = '';
let page = 'home';
let offset = 0;
const feedbackLabels = { highly_relevant: 'Highly Relevant · 高度相关', relevant: 'Relevant · 相关', maybe: 'Maybe · 待定', irrelevant: 'Irrelevant · 无关', do_not_recommend_similar: 'Do not recommend similar · 不推荐类似文献' };
const reasons = ['', 'topic_mismatch', 'exposure_mismatch', 'population_mismatch', 'model_mismatch', 'method_mismatch', 'publication_type_mismatch', 'too_broad', 'too_peripheral', 'other'];
function el(tag, text, className) { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; }
function button(text, action) { const node = el('button', text); node.type = 'button'; node.addEventListener('click', async () => { node.disabled = true; try { await action(); } catch (error) { notice.textContent = error.message; } finally { node.disabled = false; } }); return node; }
function select(values, selected) { const node = el('select'); for (const [value, label] of values) { const option = el('option', label); option.value = value; node.append(option); } node.value = selected || ''; return node; }
function label(text, input) { const node = el('label', text); node.append(input); return node; }
async function api(url, value) {
  const response = await fetch(url, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(value) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function link(text, raw) { const node = el('a', text); try { const url = new URL(raw); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return el('span', text); node.href = url.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; } catch { return el('span', text); } return node; }
async function home() {
  const status = await api('/api/status');
  main.append(el('h2', '最近运行'));
  const grid = el('div', undefined, 'grid');
  for (const [name, value] of [['Last Weekly', status.lastWeekly], ['Last Radar', status.lastRadar], ['最近结果', status.lastRun ? `${status.lastRun.at} · ${status.lastRun.status}` : null], ['下一计划运行', status.nextScheduledRun]]) {
    const card = el('section', undefined, 'card'); card.append(el('h3', name), el('p', value || '记录不足 / 未知')); grid.append(card);
  }
  main.append(grid, el('p', `Zotero：${status.zotero === 'unknown' ? '尚无状态记录' : '最近写入记录可用（非实时连接探测）'}`), el('p', `检索源：${status.sources.join('、') || '未配置'}`));
  main.append(el('p', `新写入：${status.counts?.created ?? '未知'} · 需复核：${status.needsReview ?? '未知'} · 待确认建议：${status.pendingSuggestions}`));
  if (status.integrity) main.append(el('p', `Integrity：新撤稿 ${status.integrity.newlyConfirmedRetractions} · 更正 ${status.integrity.newCorrections} · 关注声明 ${status.integrity.newExpressionsOfConcern}`));
}
async function weekly() {
  const data = await api(`/api/weekly?offset=${offset}&limit=50`);
  main.append(el('h2', 'Weekly 文献'), el('p', `共 ${data.total} 篇 · ${data.runId || '暂无可用 Weekly'}`));
  for (const item of data.items) {
    const card = el('article');
    card.append(el('h3', item.translatedTitle || item.title));
    if (item.translatedTitle) card.append(el('p', item.title, 'meta'));
    card.append(el('p', [item.authors.join(', '), item.journal, item.year].filter(Boolean).join(' · '), 'meta'));
    const meta = el('p', `${item.source} · Grade ${item.grade} · Zotero: ${item.zotero} · Integrity: ${item.integrity || '未知'}${item.needsReview ? ' · 需人工复核' : ''}`, 'meta');
    card.append(meta);
    if (item.doi) card.append(link(`DOI: ${item.doi}`, `https://doi.org/${encodeURIComponent(item.doi)}`));
    if (item.pmid) card.append(el('p', `PMID: ${item.pmid}`));
    const choice = select([['', '选择反馈'], ...Object.entries(feedbackLabels)], item.feedback);
    const reason = select(reasons.map((entry) => [entry, entry || '原因（可选）']), '');
    card.append(label('论文反馈', choice), label('原因', reason));
    const requestId = crypto.randomUUID();
    const save = button('保存反馈', async () => { await api('/api/feedback', { runId: data.runId, paperId: item.id, value: choice.value, reason: reason.value, requestId }); notice.textContent = '反馈已保存；不会直接修改永久规则。'; await render(); });
    save.disabled = !item.feedbackAllowed;
    card.append(save);
    if (!item.feedbackAllowed) card.append(el('p', '缺少可靠 identity，暂不能提交反馈。', 'muted'));
    main.append(card);
  }
  const pages = el('div', undefined, 'actions');
  const previous = button('上一页', async () => { offset = Math.max(0, offset - 50); await render(); }); previous.disabled = offset === 0;
  const next = button('下一页', async () => { offset += 50; await render(); }); next.disabled = offset + 50 >= data.total;
  pages.append(previous, el('span', `${Math.min(offset + 1, data.total)}–${Math.min(offset + 50, data.total)}`), next); main.append(pages);
}
async function research() {
  main.append(el('h2', '研究方向反馈'), el('p', '描述推荐过宽或过窄、希望增加的研究方向、需要调整的检索重点。处理结果先进入待确认建议。'));
  const input = el('textarea'); input.maxLength = 20000; input.rows = 8;
  const receipt = el('p'); let requestId = crypto.randomUUID();
  input.addEventListener('input', () => { requestId = crypto.randomUUID(); });
  main.append(label('你的评价', input), button('提交研究评价', async () => {
    const result = await api('/api/research', { text: input.value, requestId });
    receipt.textContent = `状态：${result.status} · 新增建议：${result.suggestions} · ${result.warnings.join('、')}`;
    if (result.status === 'processed') { input.value = ''; requestId = crypto.randomUUID(); }
  }), receipt);
}
async function suggestions() {
  main.append(el('h2', '待确认规则建议'));
  const rows = await api('/api/suggestions');
  if (!rows.length) main.append(el('p', '暂无待确认建议。'));
  for (const item of rows) {
    const card = el('article'); const id = item.id || item.suggestion_id;
    card.append(el('h3', id), el('p', `${item.target || 'screening_standards.md'} · ${item.change_type || 'add_rule'} · ${item.risk_level || '未知风险'} · ${item.status}`), el('p', item.rule_text || item.suggested_rule), el('p', item.rationale || '无附加理由'), el('p', item.evidence_text_excerpt || (item.evidence_titles || []).join('；')));
    if (['pending', 'candidate'].includes(item.status)) {
      const revised = el('textarea'); revised.maxLength = 4000;
      const actions = el('div', undefined, 'actions');
      for (const [decision, text] of [['accepted', 'Accept · 接受'], ['rejected', 'Reject · 拒绝'], ['revised', 'Revise then accept · 修改后接受']]) actions.append(button(text, async () => {
        if (!confirm(`确认${text}？正式变更仍需通过服务安全校验。`)) return;
        const result = await api('/api/decision', { id, decision, revisedRule: revised.value, humanApproval: true });
        notice.textContent = result.application_status === 'requires_manual_action'
          ? `未应用 · 需人工处理 · ${result.target} · 风险：${result.risk}。${result.explanation}${result.next_action}`
          : '决策已保存。';
        await render();
      }));
      card.append(label('修订内容（仅修改后接受时使用）', revised), actions);
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
  main.append(el('h2', 'Settings'), el('p', '修改经过校验后保存到原有配置 owner，下次 workflow 运行生效。等级复审与 literature overview 复用 preference learning 的模型配置。'));
  const data = await api('/api/settings');
  const groups = ['General', 'Models', 'Sources', 'Search', 'RSS', 'Ranking / Review', 'Radar', 'Weekly', 'Integrity', 'Zotero', 'Notifications', 'Credentials', 'Advanced'];
  for (const group of groups) {
    const section = el('fieldset'); section.append(el('legend', group));
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
      if (['list', 'keywords'].includes(setting.type)) row.append(el('small', '逗号分隔；required 同义词组内用 | 分隔。'));
      row.append(button('保存', async () => {
        let value = setting.type === 'boolean' ? input.checked : ['integer', 'number'].includes(setting.type) ? Number(input.value) : input.value;
        if (['list', 'keywords'].includes(setting.type)) value = input.value.split(',').map((entry) => entry.trim()).filter(Boolean).map((entry) => setting.id === 'pubmed.required' && entry.includes('|') ? entry.split('|').map((term) => term.trim()) : entry);
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
  main.setAttribute('aria-busy', 'true'); main.replaceChildren();
  document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = true; node.setAttribute('aria-current', node.dataset.page === page ? 'page' : 'false'); });
  try { await ({ home, weekly, research, suggestions, settings })[page](); } catch (error) { notice.textContent = error.message; } finally { main.setAttribute('aria-busy', 'false'); document.querySelectorAll('[data-page]').forEach((node) => { node.disabled = false; }); }
}
document.querySelectorAll('[data-page]').forEach((node) => node.addEventListener('click', () => { page = node.dataset.page; notice.textContent = ''; render(); }));
api('/api/session').then((session) => { csrf = session.token; return render(); }).catch(() => { notice.textContent = '无法连接本地服务。'; });
