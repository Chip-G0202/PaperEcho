/* Browser-only data adapter. No real credentials, storage, network or native calls. */
function installPaperEchoPreview(seed) {
  const sharedId = 'PAPERECHO_MODEL_API_KEY';
  const values = {
    'runtime.mode': 'desktop', 'general.profile': 'standard', 'translation.enabled': true,
    'preference.enabled': false, 'review.master': false, 'review.enabled': false,
    'translation.endpoint': 'https://preview.invalid/v1/chat/completions', 'preference.endpoint': 'https://preview.invalid/v1/chat/completions',
    'translation.model': 'gpt-5.1', 'preference.model': 'gpt-5.1', 'ai.provider': 'openai', 'ai.thinking': true, 'ai.model': 'gpt-5.1', 'ai.endpoint': 'https://preview.invalid/v1',
    'runtime.projectRoot': '/模拟工作空间', 'local.input': '/模拟输入', 'local.output': '/模拟结果',
    'desktop.zoteroExe': '/模拟路径/Zotero', 'web.userId': '123456', 'radar.enabled': true,
    'weekly.interval': 7, 'rss.sources': [{ name: '[模拟] 研究动态', url: 'https://preview.invalid/feed', enabled: true, publicationTitle: '模拟期刊' }],
  };
  const defaults = row => row.type === 'boolean' ? false : ['list', 'sources'].includes(row.type) ? [] : ['integer', 'number'].includes(row.type) ? row.validation?.min ?? 1 : row.type === 'enum' ? row.validation?.values?.[0] || '' : '';
  const settings = seed.registry.map(({ file, key, ...row }) => ({ ...row, value: values[row.id] ?? defaults(row), available: true, ownerPresent: true }));
  let modelState = 'missing'; let failureMode = '';
  const fault = document.createElement('select'); fault.setAttribute('aria-label', '模拟保存与诊断状态');
  for (const [value, title] of [['', '模拟：正常保存与诊断'], ['save', '模拟：保存失败'], ['doctor', '模拟：诊断结果未知']]) { const option = document.createElement('option'); option.value = value; option.textContent = title; fault.append(option); }
  fault.onchange = () => { failureMode = fault.value; };
  const papers = ['A', 'B', 'C', 'B'].map((grade, i) => ({ id: `preview-${i}`, title: `[模拟文献 ${i + 1}] Research topic for interface review`, translatedTitle: `模拟文献 ${i + 1}：仅供版式与交互审查，不是真实研究`, journal: '模拟期刊', year: '2026', source: '模拟 RSS', grade, finalGrade: grade, feedbackAllowed: true, manualReviewPending: i === 3, needsReview: i === 3, reviewScopeBucket: i === 3 ? 'manual' : 'feedback', pendingReview: i === 3, summary: '此条目不代表真实文献、实验结论或数据。', ruleGrade: grade, semanticGrade: i === 3 ? 'A' : grade }));
  const rules = [{ id: 'preview-rule', target: 'screening_standards.md', rule_text: '[模拟] 优先关注与当前研究问题直接相关的机制证据。', rationale: '用于审查规则卡片与展开布局，不影响实际筛选标准。', status: 'pending', risk_level: 'low', can_apply: true, evidence_titles: ['[模拟] 界面审查示例'] }];
  const banner = document.createElement('aside'); banner.id = 'preview-banner'; banner.setAttribute('aria-label', '模拟预览控制');
  const intro = document.createElement('strong'); intro.textContent = `UI 预览 · v${seed.version} · ${seed.sourceCommit.slice(0, 8)}｜全部为模拟数据，保存仅更新本页内存。`;
  const activity = document.createElement('span'); activity.setAttribute('role', 'status'); activity.textContent = '禁止输入真实密钥；原生操作、联网调用及文件导出不可用。';
  const scenario = document.createElement('select'); scenario.setAttribute('aria-label', '模拟模型配置场景');
  for (const [value, text] of [['missing', '模拟：Key 缺失'], ['configured', '模拟：Key 已配置'], ['conflict', '模拟：旧 Key 不同（采用学习 Key）'], ['incompatible', '模拟：Key 与服务不匹配']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; scenario.append(option); }
  // Owned entirely by the mock adapter: never shipped as application code.
  const runOutcome = document.createElement('select'); runOutcome.setAttribute('aria-label', '模拟运行结果');
  for (const [value, text] of [['success', '运行演示：成功'], ['failed', '运行演示：失败']]) { const option = document.createElement('option'); option.value = value; option.textContent = text; runOutcome.append(option); }
  // Research-brief branch, ordered from Stage1 and Stage0 calls; not progress events.
  const runStages = [
    ['feedback_learning', '处理上次反馈与学习', '按自适应学习配置处理上次反馈。', 'preference.enabled'],
    ['retrieval', '获取文献', '按已选来源获取候选文献。'],
    ['dedupe', '候选文献去重', '按标识与标准化标题合并重复候选。'],
    ['rule_based_triage', '规则筛选与初步评级', '规则筛选同时给出初步等级，并非两个独立阶段。'],
    ['journal_quality_gate', '期刊过滤', '本示例未启用期刊质量过滤。', 'preview.journal'],
    ['pre_llm_dedupe', '文献库去重', '在 AI 复审前排除已有条目。'],
    ['llm_grade_review', 'AI 等级复审', '按复审配置与候选范围执行。', 'review.enabled'],
    ['manual_title_translation', '人工复核标题补译', '仅有待复核条目且翻译开启时执行；本示例无待补译条目。', 'preview.manualTitles'],
    ['rule_suggestions', '整理规则建议', '按本次反馈整理筛选规则建议。'],
    ['feedback_item_actions', '处理反馈条目', '按反馈执行条目动作并准备写回候选。'],
    ['literature_integrity', '撤稿与更正检测', '按完整性检测配置执行。', 'integrity.enabled'],
    ['stage2_writeback', '按配置写回 Zotero', '通过后端就绪检查后写回入选文献。'],
    ['stage3_translation', '标题翻译与补翻', '写回成功后，按翻译配置补充中文标题。', 'translation.enabled'],
    ['stage4_exports', '生成运行结果与简报', '写回与翻译阶段完成后导出本次结果。'],
  ];
  const runListeners = new Set(); let runTimer;
  const makeStages = () => runStages.map(([id, name, description, setting]) => ({ id, name, description, elapsed: 0, status: 'pending', skip: Boolean(setting && !settings.find(row => row.id === setting)?.value) }));
  let run = { status: 'idle', startedAt: null, endedAt: null, elapsed: 0, current: -1, stages: makeStages(), products: [], error: null };
  const runSnapshot = () => structuredClone(run);
  const publishRun = () => runListeners.forEach(listener => listener(runSnapshot()));
  window.paperEchoWorkflowPreview = Object.freeze({
    kind: 'PAPERECHO_MEMORY_RUN_PREVIEW', snapshot: runSnapshot,
    subscribe(listener) { runListeners.add(listener); return () => runListeners.delete(listener); },
    start() {
      if (run.status === 'running') return;
      const outcome = runOutcome.value;
      run = { status: 'running', startedAt: new Date().toISOString(), endedAt: null, elapsed: 0, current: -1, stages: makeStages(), products: [], error: null };
      const advance = () => {
        while (++run.current < run.stages.length) {
          const stage = run.stages[run.current];
          if (stage.skip) { stage.status = 'skipped'; continue; }
          stage.status = 'running'; return;
        }
        run.current = run.stages.length - 1; run.status = 'success';
        run.products = [{ name: '周报.xlsx', path: '/模拟工作空间/预览演示/周报.xlsx' }];
      };
      advance(); runOutcome.disabled = true; publishRun();
      runTimer = setInterval(() => {
        run.elapsed++;
        const stage = run.stages[run.current]; stage.elapsed++;
        if (stage.elapsed >= 2) {
          if (outcome === 'failed' && stage.id === 'stage3_translation') {
            stage.status = 'failed'; run.status = 'failed'; run.error = '模拟连接失败：标题翻译未完成。没有发送真实 API 请求。';
          } else { stage.status = 'completed'; advance(); }
        }
        if (run.status !== 'running') { run.endedAt = new Date().toISOString(); clearInterval(runTimer); runOutcome.disabled = false; }
        publishRun();
      }, 1000);
    },
  });
  const reset = document.createElement('button'); reset.textContent = '重置模拟数据'; reset.onclick = () => location.reload();
  const wizard = document.createElement('button'); wizard.textContent = '首次配置向导'; wizard.onclick = () => { location.hash = '#setup'; };
  banner.append(intro, scenario, fault, runOutcome, wizard, reset, activity); document.body.prepend(banner);
  const style = document.createElement('style'); style.textContent = '#preview-banner{padding:12px 20px;background:#fff4d6;border-bottom:1px solid #dec897;display:flex;gap:10px;align-items:center;flex-wrap:wrap;position:sticky;top:0;z-index:1000;font-size:13px}#preview-banner strong{flex:1 1 400px}#preview-banner span{flex-basis:100%;color:#6d5c36}#preview-banner button,#preview-banner select{font-size:13px;padding:5px 10px}#preview-banner select{width:auto;max-width:100%;height:auto;display:inline-block;min-width:0}.ai-service [data-mock-key]{min-height:30px!important;margin:6px 0 0;font-size:12px!important;padding:4px 10px!important}.sidebar{top:var(--preview-banner-height,112px);height:calc(100vh - var(--preview-banner-height,112px))}'; document.head.append(style);
  new ResizeObserver(() => document.documentElement.style.setProperty('--preview-banner-height', banner.getBoundingClientRect().height + 'px')).observe(banner);
  // The same real renderer is used, but secret inputs are read-only before paint.
  const protectSecrets = () => { for (const input of document.querySelectorAll('input[type=password],.credential-setting input')) { input.readOnly = true; input.placeholder = '预览不接收密钥，请用上方场景切换'; input.autocomplete = 'off'; } };
  new MutationObserver(() => { protectSecrets(); const row = document.querySelector('[data-credential="PAPERECHO_MODEL_API_KEY"]'); if (row && !row.querySelector('[data-mock-key]')) { const mock = document.createElement('button'); mock.dataset.mockKey = ''; mock.textContent = '使用模拟 Key（仅浏览器内存）'; mock.onclick = async () => { if (failureMode === 'save') { activity.textContent = '模拟保存失败，原状态保留。'; return; } if (setting('translation.endpoint') !== setting('preference.endpoint')) { activity.textContent = '服务地址不同，请先保存 AI 服务地址。'; return; } modelState = 'configured'; scenario.value = 'configured'; row.dispatchEvent(new Event('paperecho:preview-key-saved', { bubbles: true })); window.dispatchEvent(new Event('paperecho:preview-configuration-saved')); activity.textContent = '模拟 Key 已配置，已触发配置诊断重查；未接收或保存真实密钥。'; }; row.append(mock); } }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (link && /^https?:/.test(link.href)) { event.preventDefault(); activity.textContent = '模拟预览：未打开外部链接。'; }
  });
  scenario.onchange = () => { modelState = scenario.value; const put = (id, value) => { const row = settings.find(s => s.id === id); if (row) row.value = value; }; put('ai.enabled', false); put('translation.model', 'gpt-5.1'); put('preference.model', 'gpt-5.1'); put('translation.temperature', 0.3); put('preference.temperature', modelState === 'conflict' ? 0.7 : 0.3); put('preference.endpoint', modelState === 'incompatible' ? 'https://other-preview.invalid/v1/chat/completions' : setting('translation.endpoint')); activity.textContent = '已切换模拟配置场景；没有读取或修改真实 Key。'; window.dispatchEvent(new HashChangeEvent('hashchange')); };
  window.paperEchoLoginStartup = Object.freeze({ status: async () => ({ available: false, error: 'LOGIN_STARTUP_UNAVAILABLE' }), set: async () => ({ available: false, error: 'LOGIN_STARTUP_UNAVAILABLE' }) });
  window.paperEchoFirstRun = Object.freeze({ status: async () => ({ available: false }), choose: async () => ({ available: false, error: 'STARTUP_SELECTION_UNAVAILABLE' }) });
  const setting = id => settings.find(row => row.id === id)?.value;
  const credentials = () => seed.secretNames.map(id => ({ id, configured: id === sharedId && ['configured', 'conflict'].includes(modelState), storageClass: id === sharedId && ['configured', 'conflict'].includes(modelState) ? 'local-managed' : 'unconfigured', writable: true, testAvailable: false, compatible: setting('translation.endpoint') === setting('preference.endpoint'), conflict: modelState === 'conflict', effectiveConfigured: ['configured', 'conflict'].includes(modelState), reason: '模拟预览：不接收或保存真实密钥。' }));
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href), route = url.pathname;
    if (!route.startsWith('/api/')) return response({ error: 'PREVIEW_NETWORK_DISABLED' }, 403);
    // Do not parse credential bodies, even in a preview.
    if (options.method === 'POST' && route === '/api/credentials') return response({ error: 'CREDENTIAL_EXTERNALLY_MANAGED' }, 403);
    const body = options.body ? JSON.parse(options.body) : {};
    if (options.method === 'POST') {
      activity.textContent = '模拟交互：仅更新浏览器内存，未保存真实配置、调用 AI 或提交业务操作。';
      if (route === '/api/ai/test') return response({ status: 'preview', preview: true });
      if (route === '/api/settings') { if (failureMode === 'save') return response({ error: 'SETTING_VALUE_INVALID' }, 400); for (const update of body.updates || [body]) { const row = settings.find(s => s.id === update.id); if (row) { row.value = update.value; if (row.id === 'weekly.interval') row.enabled = true; } } if (setting('ai.enabled')) for (const name of ['translation', 'preference']) for (const key of ['endpoint', 'model', 'temperature', 'timeout', 'top_p', 'stream', 'thinking', 'max_retries']) { const row = settings.find(s => s.id === name + '.' + key); if (row) row.value = setting('ai.' + (key === 'timeout' ? 'timeout_ms' : key)); } return response({ results: body.updates || [body], preview: true, scheduling: { state: 'unknown', code: 'SCHEDULER_PREVIEW_ONLY' } }); }
      if (route === '/api/feedback') { const item = papers.find(p => p.id === body.paperId); if (item) { if (body.manualGrade) item.manualGrade = body.manualGrade; else item.feedback = body.value; } return response({ status: 'recorded', preview: true }); }
      if (route === '/api/research') return response({ status: 'pending', saved: true, preview: true });
      if (route === '/api/decision') { const item = rules.find(r => r.id === body.id); if (item) item.status = body.decision; return response({ status: body.decision, application_status: 'requires_manual_action', preview: true }); }
      return response({ error: 'PREVIEW_NATIVE_ACTION_UNAVAILABLE' }, 400);
    }
    switch (route) {
      case '/api/session': return response({ token: 'preview-not-a-real-session' });
      case '/api/version': return response({ version: seed.version });
      case '/api/settings': return response(settings);
      case '/api/credentials': return response(credentials());
      case '/api/setup': return response({ needsSetup: false, persisted: true, canRun: true, mode: setting('runtime.mode'), roots: { layout: 'installed', userDataRoot: '/模拟工作空间', cacheRoot: '/模拟缓存', activeMode: setting('runtime.mode') }, requiredMissing: [], optionalMissing: [], readiness: [] });
      case '/api/status': return response({ lastWeekly: '2026-11-01T07:00:00Z', lastRadar: '2026-11-01T06:00:00Z', pendingSuggestions: rules.filter(r => r.status === 'pending').length, lastRun: { status: 'completed' }, needsReview: 1 });
      case '/api/schedule-status': return response({ registration: { state: 'unknown', code: 'SCHEDULER_PREVIEW_ONLY' }, status: 'before_slot', scheduledTime: '15:00', weekly: { lastSuccessfulPlannedSlot: '2026-11-01T07:00:00Z', nextDuePlannedSlot: '2026-11-08T07:00:00Z' }, today: { selectedFlow: 'radar', plannedSlot: '2026-11-01T07:00:00Z' }, currentRun: null });
      case '/api/weekly': return response({ runId: 'preview-weekly', total: papers.length, items: papers });
      case '/api/pending-summary': return response({ normal: papers.filter(p => !p.pendingReview && !p.feedback).length, manual: papers.filter(p => p.pendingReview && !p.manualGrade).length, rules: rules.filter(r => r.status === 'pending').length });
      case '/api/suggestions': return response(rules.filter(r => r.status === 'pending'));
      case '/api/notifications': return response({ channels: ['email', 'qq', 'wechat', 'feishu', 'wecom'].map(id => ({ id, enabled: setting(id + '.enabled'), readiness: 'incomplete', lastDelivery: { status: 'none' }, credentials: id === 'email' ? ['SMTP_PASS'] : [] })) });
      case '/api/doctor/configuration':
      case '/api/doctor': {
        if (failureMode === 'doctor') return response({ error: 'PREVIEW_UNKNOWN' }, 503);
        const configurationIssues = ['translation', 'preference'].filter(name => setting(name + '.enabled') && (name === 'translation' || setting('review.master')) && (!['configured', 'conflict'].includes(modelState) || !setting(name + '.endpoint') || !setting(name + '.model'))).map(name => ({ checkId: 'model.' + name, status: 'WARN', summary: `${name === 'translation' ? '智能翻译' : '自适应学习'}配置不完整（模拟）`, settingTarget: 'ai.key', actionableHint: '请前往AI 功能配置补充共享 API Key。预览请使用模拟 Key 按钮。' }));
        return response({ status: configurationIssues.length ? 'WARN' : 'PASS', canRun: true, checks: [{ checkId: 'runtime.roots', status: 'PASS', summary: '模拟健康项，应由真实 UI 自动隐藏' }], configurationIssues });
      }
      default: return response({ error: 'PREVIEW_API_UNAVAILABLE' }, 404);
    }
  };
}
