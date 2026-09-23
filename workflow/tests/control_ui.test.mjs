import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import '../../tests/control_review_workspace.test.mjs';
const html = await fs.readFile(new URL('../tools/web/static/index.html', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../tools/web/static/styles.css', import.meta.url), 'utf8');
const app = await fs.readFile(new URL('../tools/web/static/app.js', import.meta.url), 'utf8');
const logo = await fs.readFile(new URL('../tools/web/static/paperecho-mark.svg', import.meta.url), 'utf8');
test('UI shell keeps five real routes, skip target, live status and collapsible navigation', () => {
  const routes = [...html.matchAll(/data-page="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(routes, ['home', 'weekly', 'feedback', 'settings', 'system']);
  assert.match(html, /href="#content"/); assert.match(html, /<main[^>]*id="content"[^>]*tabindex="-1"/);
  assert.match(html, /id="menu-toggle"[^>]*aria-controls="sidebar"[^>]*aria-expanded="false"/);
  assert.match(html, /id="notice"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.doesNotThrow(() => new vm.Script(app));
});
test('sidebar owns L1 and L2 navigation while workspace owns L3 tabs', () => {
  assert.match(html, /class="primary-nav"/); assert.match(html, /class="secondary-nav" aria-label="反馈导航"/); assert.match(html, /class="secondary-nav" aria-label="设置导航"/);
  for (const route of ['feedback/rating/normal', 'feedback/research', 'feedback/rules', 'settings/general/databases', 'settings/models/translation', 'settings/runtime/path', 'settings/automation/radar', 'settings/connections/notifications']) assert.match(html, new RegExp(`data-nav-route="${route}"`));
  assert.match(app, /function tertiaryNav/); assert.match(app, /feedback\/rating\/\$\{key\}/); assert.match(app, /function parseRoute/);
  assert.match(app, /\['databases', '文献数据库'/); assert.match(app, /\['rss', 'RSS 订阅'/); assert.match(app, /\['period', '检索周期'/);
  assert.match(app, /settingsView === 'rss' \? 'RSS 订阅状态'/);
  assert.doesNotMatch(app, /className = 'settings-nav'/);
});

test('Overview keeps read-only schedule facts while Automation has only actionable tabs', () => {
  assert.match(app, /automation: \[\['radar', 'Daily Radar'[^\n]*\['weekly', '周报'/);
  assert.doesNotMatch(app, /\['plan', '每日计划'|每日计划运行|Weekly 周报|运行机制|外部 Agent|Control Center 无需保持打开/);
  assert.match(app, /api\('\/api\/schedule-status'\)/);
  assert.match(app, /timeZone: 'Asia\/Shanghai'/);
  assert.match(app, /function taskCard\(plan\)/);
  assert.match(app, /今天 \$\{plan\.scheduledTime\} · 北京时间/);
  assert.match(app, /下次周报/);
  assert.match(app, /尚未建立周报周期/);
  assert.match(app, /Radar 未启用/);
  assert.match(app, /计划状态异常/);
  assert.match(app, /周报已完成，通知待恢复/);
  assert.match(app, /本地运行路径不支持定时任务/);
  assert.match(app, /非周报日运行/);
  assert.match(app, /每 7 天生成一次/);
  assert.match(app, /section === 'automation' && task === 'plan'/);
  assert.doesNotMatch(app, /Agent：运行中|自动任务已启用|下一次 Agent 运行/);
});
test('header and favicon reference the same canonical SVG mark', () => {
  assert.match(html, /rel="icon" href="\/paperecho-mark\.svg\?v=2\.4" type="image\/svg\+xml"/);
  assert.match(html, /<img class="brand-mark" src="\/paperecho-mark\.svg\?v=2\.4" width="44" height="44" alt="">/);
  assert.doesNotMatch(html, /id="header-mark-gradient"|<svg class="brand-mark"/);
  assert.match(logo, /linearGradient/); assert.match(logo, /#bdebd7/); assert.match(logo, /#17684f/);
  assert.match(logo, /x="4" y="26" width="8" height="12"/); assert.match(logo, /x="52" y="26" width="8" height="12"/);
  assert.match(logo, /x="16" y="18" width="8" height="28"/); assert.match(logo, /x="40" y="18" width="8" height="28"/);
  assert.doesNotMatch(html, /Replaceable vector placeholder/);
});
test('delivery UI excludes demo data and keeps simplified Settings copy', () => {
  assert.doesNotMatch(app, /demoMode|demoPapers|demoRuleSuggestions|radar-demo|weekly-demo|体验示例|示例模式|演示内容/);
  assert.doesNotMatch(css, /demo-banner|experience-grid|runtime-example|weekly-flow|radar-signal/);
  assert.match(app, /'sources\.domain'/); assert.match(app, /\['pubmed\.days', 'openalex\.days'\]/);
  assert.match(app, /保存本组/); assert.doesNotMatch(html, /本地研究工作空间 · XLSX \/ DOCX 继续兼容 · 反馈不会直接生成永久排除规则/);
});
test('compact UI hierarchy removes D and redundant review details', () => {
  assert.match(app, /function pageIntro/); assert.match(app, /displayablePapers/);
  assert.match(app, /'review\.batch'/); assert.doesNotMatch(app, /人工复核批量大小|进入等级复审或人工复核阶段的候选条目上限/);
  assert.match(app, /keyboardHelp\('数字键快速审阅'/); assert.match(app, /主键盘或小键盘数字键/); assert.match(app, /Numpad\[1-4\]/); assert.match(app, /el\('kbd', key\)/); assert.doesNotMatch(app, /补充原因（可选）|等级复审依据：/);
  assert.doesNotMatch(css, /\.badge\.grade-D/); assert.match(css, /\.source-options label\{min-height:48px/);
  assert.match(css, /\.settings-subgroup\+\.settings-subgroup\{border-top:1px/); assert.match(css, /\.group-save\{justify-content:flex-start/);
});
test('normal and manual review expose distinct rating contracts', () => {
  assert.match(app, /grade-step-\$\{tone\}/); assert.match(css, /\.grade-step-final\{/);
  assert.match(app, /manualGrades = \['A', 'B', 'C', 'D'\]/);
  assert.match(app, /mode === 'manual'/); assert.match(app, /manualGrade: value/);
  assert.match(app, /人工评级/); assert.match(app, /item\.manualGrade/);
});
test('desktop workspace and shared content columns stay left aligned', () => {
  assert.match(css, /\.content-wrap\{max-width:none;margin:0;/);
  assert.match(css, /main\{width:100%;max-width:1520px;[^}]*margin:0 auto 0 0/);
  assert.match(css, /--sidebar-width:clamp\(280px,20vw,344px\)/); assert.doesNotMatch(css, /--sidebar-width:276px/); assert.match(css, /@media\(min-width:1400px\)\{\.workspace-grid:has\(\.context-rail\)/);
  assert.match(css, /grid-template-columns:minmax\(0,1fr\) minmax\(300px,324px\)/);
  assert.match(css, /\.review-workspace\{width:100%;max-width:none/);
  assert.match(css, /\.research-form\{width:100%;max-width:none/);
  assert.match(app, /document-list page-content document-column/);
  assert.match(app, /review-workspace page-content document-column/);
  assert.match(app, /research-form page-content document-column/);
});
test('Settings exposes product controls while hiding internal LLM request batching', () => {
  assert.match(app, /'review\.batch'/);
  assert.match(app, /group-save section-actions/);
  assert.doesNotMatch(app, /`共 \$\{saves\.length\} 项`/);
  assert.match(app, /\[\.\.\.input\.querySelectorAll\('input'\)\]\.filter/);
  assert.match(css, /\.source-options label:has\(input:checked\)/);
  assert.match(css, /\.source-options label:has\(input:focus-visible\)/);
  assert.match(app, /featureToggleIds/); assert.match(app, /container\.dataset\.featureCollapsed/); assert.match(app, /row\.hidden = !expanded/); assert.match(app, /input\.placeholder = settingPlaceholder/);
  assert.match(app, /writeIds: \['review\.master', 'review\.enabled', 'preference\.enabled'\]/); assert.doesNotMatch(app, /\['rating', '评级设置'/);
  assert.match(app, /translation\.enabled/); assert.match(app, /updates: values\.map/); assert.doesNotMatch(app, /查看完整设置示例|renderAdvancedSettingsDemo|advanced-demo/);
  assert.doesNotMatch(app, /input\.disabled = true; row\.append\(label\(setting\.description, input\)/);
  assert.match(app, /Zotero Web 配置/); assert.match(app, /个人文库/); assert.doesNotMatch(app, /群组文库|Group ID/); assert.match(app, /Zotero 数字 User ID/); assert.match(app, /API v3/); assert.match(app, /写入权限/); assert.match(app, /配置 API Key/); assert.match(app, /替换 API Key/); assert.match(app, /清除/);
  assert.doesNotMatch(app, /runtimePathFields[\s\S]{0,400}web\.apiBase/); assert.match(app, /PaperEcho 本地工作区/);
  assert.match(app, /基础配置：不完整/); assert.match(app, /连接状态：运行前检测尚未执行/); assert.doesNotMatch(app, /Web 连接将在运行时验证/);
});
test('UI renders untrusted content through text nodes and keeps credentials write-only', () => {
  assert.doesNotMatch(app, /\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(/);
  assert.match(app, /node\.textContent = text/);
  assert.match(app, /input\.type = 'password'/);
  assert.match(app, /const value = input\.value; await api\('\/api\/credentials'.*input\.value = ''/);
  assert.doesNotMatch(app, /input\.value\s*=\s*item\.(?:value|secret|password)/);
  assert.match(app, /连接测试尚未开放/);
});
test('UI feedback and responsive contracts retain fail-closed messaging and accessible state', () => {
  assert.match(app, /aria-label', '文献评级任务'/);
  assert.match(app, /application_status === 'requires_manual_action'/);
  assert.match(app, /正式规则尚未改变/);
  assert.match(app, /humanApproval: true/);
  assert.match(app, /aria-describedby/); assert.match(app, /aria-invalid/);
  assert.match(css, /--focus:/); assert.match(css, /:focus-visible/);
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  assert.match(css, /@media\(max-width:760px\)/); assert.match(css, /position:static/);
  assert.match(css, /overflow-wrap:anywhere/);
  assert.match(app, /aria-modal', 'true'/); assert.match(app, /event\.key === 'Escape'/); assert.match(css, /\.completion-backdrop/);
});
test('rule review and typography support the desktop hierarchy without demo branches', () => {
  assert.match(app, /async function suggestions/); assert.match(app, /api\('\/api\/decision'/); assert.doesNotMatch(app, /data\.demo|demoRuleSuggestions|示例决策/);
  assert.match(css, /font-size:16px; line-height:1\.65/); assert.match(css, /h2\{font-size:clamp\(29px,2vw,32px\)/); assert.match(css, /\.primary-nav>button[^}]*font-size:18px/);
  assert.match(css, /\.secondary-nav button[^}]*font-size:16px/); assert.match(css, /\.tertiary-nav button[^}]*font-size:16px/); assert.match(css, /\.keyboard-help kbd/);
  assert.match(css, /\.review-navigation\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/); assert.match(css, /\.review-navigation button[^}]*min-height:54px/);
});
