import test from 'node:test';
import '../../tests/control_launcher.test.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startControlCenter, MAX_BODY_BYTES, safeLink } from '../tools/web/server.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
const base = fileURLToPath(new URL('./.control-test-tmp/', import.meta.url));
const mockLlm = async () => ({ rules_added: ['优先关注中文机制研究'], rules_deleted: [], rules_changed: [], keywords_added: { required: [], optional: [], negative: [] }, keywords_removed: [], negative_keywords_added: [], unmapped_feedback: [] });
async function setup(t, count = 0) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'http-'));
  const reviewRoot = path.join(root, 'review_results', '文献评价');
  const pipeline = path.join(root, 'review_results', 'pipeline', 'fixture');
  const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  await write(path.join(root, 'config', 'pubmed_pmc_search.json'), { keyword_groups: { required: ['test'], optional: [], negative: [] } });
  await write(path.join(root, 'config', 'title_translation.config.json'), { model: 'mock', temperature: 0 });
  await write(path.join(root, 'config', 'rss_sources.json'), { sources: [] });
  await write(path.join(reviewRoot, 'screening_standards.md'), '# 标准\n\n## 优先关注\n\n* 基线\n\n## 相对降权\n');
  await write(path.join(reviewRoot, 'runs', 'weekly-1', 'run_group.json'), { schemaVersion: 1, runId: 'weekly-1', pipelineMode: 'desktop', startedAt: '2026-09-12T05:00:00Z', status: 'completed', artifacts: [{ kind: 'pipeline', rootKey: 'research', path: 'pipeline/fixture' }, { kind: 'weekly_export', rootKey: 'review', path: 'week/day' }] });
  const items = Array.from({ length: count }, (_, i) => ({ title: `${i}: 中文 <img src=x onerror=alert(1)> ${'长标题'.repeat(i === 0 ? 1000 : 1)}`, doi: i % 2 ? '' : `10.1234/item-${i}`, pmid: String(12345 + i), grade: 'B', source_channel: 'RSS', authors: ['作者 <script>'], journal: '期刊', needs_human_review: i === 0 }));
  await write(path.join(pipeline, 'run_report.json'), { steps: { med_weekly_synthesis: { completed: true } } });
  await write(path.join(pipeline, 'desktop_daily_review_source.json'), { triaged: items });
  await write(path.join(pipeline, 'zotero_writeback_summary.json'), { writeback_items: items.map((item, i) => ({ ...item, itemKey: `KEY${i}` })) });
  const services = createControlServices({ root, reviewRoot, env: { SMTP_PASS: 'fixture-private-key' }, llmClient: mockLlm });
  const running = await startControlCenter({ root, port: 0, services });
  t.after(async () => { running.server.closeAllConnections(); await new Promise((resolve) => running.server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const url = new URL(running.url);
  const request = (route, { method = 'GET', headers = {}, data } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method, headers }, (res) => { let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, text, json }); }); });
    req.on('error', reject); if (data !== undefined) req.write(data); req.end();
  });
  const session = await request('/api/session');
  const auth = { cookie: session.headers['set-cookie'][0].split(';')[0], origin: running.url, 'x-csrf-token': session.json.token, 'content-type': 'application/json' };
  const get = (route) => request(route, { headers: auth });
  const post = (route, value, headers = {}) => request(route, { method: 'POST', headers: { ...auth, ...headers }, data: JSON.stringify(value) });
  return { ...running, root, reviewRoot, pipeline, request, auth, get, post, write, services };
}
test('loopback default, Host/Origin/CSRF/session rejection, traversal, CSP and size limit', async (t) => {
  await assert.rejects(startControlCenter({ host: '0.0.0.0' }), /LOOPBACK/);
  const app = await setup(t);
  assert.equal(app.server.address().address, '127.0.0.1');
  assert.equal((await app.request('/api/settings')).status, 403);
  assert.equal((await app.request('/api/schedule-status')).status, 403);
  const schedule = await app.get('/api/schedule-status');
  assert.equal(schedule.status, 200);
  assert.equal(schedule.json.timezone, 'Asia/Shanghai');
  assert.equal(Object.hasOwn(schedule.json, 'runtimeState'), false);
  assert.equal((await app.post('/api/settings', {}, { host: 'evil.example' })).status, 403);
  assert.equal((await app.post('/api/settings', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await app.post('/api/settings', {}, { 'x-csrf-token': '' })).status, 403);
  for (const route of ['/%2e%2e/.env', '/..%5c.env', '/.env']) assert.equal((await app.get(route)).status, 404);
  assert.equal((await app.post('/api/research', { text: 'x'.repeat(MAX_BODY_BYTES), requestId: 'big' })).status, 413);
  const home = await app.get('/');
  assert.match(home.headers['content-security-policy'], /script-src 'self'/);
  assert.equal(home.headers['access-control-allow-origin'], undefined);
  assert.equal(safeLink('javascript:alert(1)'), null);
  assert.equal(safeLink('https://example.com'), 'https://example.com/');
  const script = await app.get('/app.js');
  assert.equal(/innerHTML|insertAdjacentHTML|document\.write/.test(script.text), false);
  assert.match(script.text, /textContent/);
  for (const route of ['/paperecho-mark.svg', '/paperecho-mark.svg?v=2.4']) {
    const logo = await app.get(route);
    assert.equal(logo.status, 200); assert.match(logo.headers['content-type'], /image\/svg\+xml/); assert.match(logo.text, /linearGradient/);
  }
});
test('latest Weekly: zero, 1000 items, long title, Chinese, missing DOI, pagination and feedback', async (t) => {
  const empty = await setup(t);
  assert.equal((await empty.get('/api/weekly')).json.total, 0);
  const app = await setup(t, 1000);
  const weekly = (await app.get('/api/weekly')).json;
  assert.equal(weekly.total, 1000);
  assert.equal(weekly.items.length, 50);
  assert.ok(weekly.items[0].title.length > 2000);
  assert.equal(weekly.items[1].doi, '');
  assert.equal(weekly.items[1].feedbackAllowed, true);
  assert.equal((await app.get('/api/weekly?offset=950')).json.items.length, 50);
  assert.equal((await app.get('/api/weekly?offset=1000')).json.items.length, 0);
  assert.equal((await app.get('/api/weekly?limit=1000')).status, 400);
  const submit = { runId: weekly.runId, paperId: weekly.items[0].id, value: 'highly_relevant', requestId: 'http-feedback' };
  assert.equal((await app.post('/api/feedback', submit)).status, 200);
  assert.equal((await app.post('/api/feedback', submit)).json.duplicate, true);
  assert.equal((await app.get('/api/weekly')).json.items[0].feedback, 'highly_relevant');
  assert.deepEqual((await app.get('/api/pending-summary')).json, { normal: 999, manual: 1, rules: 0 });
  assert.equal((await app.post('/api/feedback', { ...submit, paperId: 'unknown' })).status, 400);
  const status = (await app.get('/api/status')).json;
  assert.equal(status.needsReview, 1);
  assert.equal(status.lastWeekly, '2026-09-12T05:00:00Z');
});
test('research submit, generated suggestion, accept and replay; settings valid/invalid; no secrets', async (t) => {
  const app = await setup(t);
  const result = await app.post('/api/research', { text: '需要更多机制研究', requestId: 'research-test' });
  assert.equal(result.status, 200);
  assert.equal(result.json.status, 'processed');
  assert.equal(result.json.suggestions, 1);
  const suggestions = (await app.get('/api/suggestions')).json;
  const decision = { id: suggestions[0].id, decision: 'accepted', humanApproval: true };
  assert.equal((await app.post('/api/decision', decision)).json.status, 'accepted');
  assert.equal((await app.post('/api/decision', decision)).json.duplicate, true);
  assert.equal((await app.post('/api/settings', { id: 'translation.model', value: 'new-model' })).status, 200);
  assert.equal((await app.post('/api/settings', { updates: [{ id: 'translation.model', value: 'batch-model' }, { id: 'translation.temperature', value: 0.4 }] })).status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(app.root, 'config', 'title_translation.config.json'))).model, 'batch-model');
  assert.equal((await app.post('/api/settings', { id: 'translation.temperature', value: 20 })).status, 400);
  assert.equal((await app.post('/api/settings', { id: 'rss.sources', value: [{ name: '中文 RSS', url: 'https://example.com/rss', enabled: false }] })).status, 200);
  assert.equal((await app.post('/api/settings', { id: 'rss.sources', value: [{ name: 'x', url: 'file:///sensitive', enabled: true }] })).status, 400);
  for (const route of ['/api/settings', '/api/credentials', '/api/status', '/api/suggestions']) {
    const response = await app.get(route);
    assert.equal(response.text.includes('fixture-private-key'), false);
    assert.equal(response.text.includes(app.root), false);
  }
  assert.equal((await app.get('/api/credentials')).json.find((item) => item.id === 'SMTP_PASS').configured, true);
});

test('credential HTTP replace/clear and high-risk decisions apply only validated mutations', async (t) => {
  const app = await setup(t);
  const credential = 'http-private-中文-123';
  const reply = await app.post('/api/credentials', { id: 'TITLE_TRANSLATION_API_KEY', action: 'replace', value: credential });
  assert.equal(reply.status, 200); assert.equal(reply.text.includes(credential), false);
  const listed = await app.get('/api/credentials');
  assert.equal(listed.json.find((entry) => entry.id === 'TITLE_TRANSLATION_API_KEY').configured, true);
  assert.equal(listed.text.includes(credential), false);
  assert.equal((await app.post('/api/credentials', { id: 'PATH', action: 'replace', value: credential })).status, 400);
  assert.equal((await app.post('/api/credentials', { id: 'TITLE_TRANSLATION_API_KEY', action: 'test' })).status, 400);
  assert.equal((await app.post('/api/credentials', { id: 'TITLE_TRANSLATION_API_KEY', action: 'clear' })).status, 200);
  assert.equal((await app.get('/api/credentials')).json.find((entry) => entry.id === 'TITLE_TRANSLATION_API_KEY').configured, false);
  const { ruleSuggestionsLogPath } = await import('../tools/lib/screening_standards_paths.mjs');
  const log = ruleSuggestionsLogPath(app.reviewRoot);
  await app.write(log, { suggestions: [
    { id: 'high', status: 'pending', target: 'pubmed_pmc_search.json', change_type: 'add_keyword', risk_level: 'high', rule_text: '添加必含检索词：中文机制' },
    { id: 'unclear', status: 'pending', target: 'pubmed_pmc_search.json', change_type: 'remove_keyword', risk_level: 'high', rule_text: '删除检索词' },
    { id: 'low', status: 'pending', target: 'screening_standards.md', change_type: 'add_rule', risk_level: 'low', rule_text: '优先机制研究' },
  ] });
  const before = await fs.readFile(path.join(app.reviewRoot, 'screening_standards.md'), 'utf8');
  const unclear = await app.post('/api/decision', { id: 'unclear', decision: 'accepted', humanApproval: true });
  assert.equal(unclear.status, 400); assert.equal(unclear.json.error, 'SEARCH_MUTATION_UNCLEAR');
  const result = await app.post('/api/decision', { id: 'high', decision: 'accepted', humanApproval: true });
  assert.equal(result.status, 200); assert.equal(result.json.status, 'accepted');
  assert.equal(result.json.application_status, 'applied'); assert.equal(result.json.formal_rules_modified, true);
  assert.equal(await fs.readFile(path.join(app.reviewRoot, 'screening_standards.md'), 'utf8'), before);
  assert.match(await fs.readFile(path.join(app.root, 'config', 'pubmed_pmc_search.json'), 'utf8'), /中文机制/);
  assert.equal(JSON.parse(await fs.readFile(log, 'utf8')).suggestions[0].status, 'accepted');
  const savedHigh = (await app.get('/api/suggestions')).json.find((entry) => entry.id === 'high');
  assert.equal(savedHigh.decision_receipt, undefined);
  assert.equal((await app.get('/api/suggestions')).json.find((entry) => entry.id === 'unclear').status, 'pending');
  const low = await app.post('/api/decision', { id: 'low', decision: 'accepted', humanApproval: true });
  assert.equal(low.json.status, 'accepted'); assert.equal(low.json.formal_rules_modified, true);
  assert.equal(low.json.application_status, 'applied');
});
