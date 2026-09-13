import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { startControlCenter } from '../tools/web/server.mjs';
import { resolveApplicationRuntimeContext, buildRuntimeConfig } from '../tools/lib/runtime_config.mjs';
import { canonicalFeedbackPath } from '../tools/lib/control_feedback_service.mjs';
import { ruleSuggestionsLogPath } from '../tools/lib/screening_standards_paths.mjs';
import { createControlServices } from '../tools/lib/control_application_services.mjs';
const base = fileURLToPath(new URL('./.control-test-tmp/', import.meta.url));
async function fixture(t) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'roots-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'); await fs.mkdir(repo);
  return { root, repo };
}
async function write(file, value) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); }
async function seed(context, title) {
  const local = context.localRepository;
  const runRoot = context.runRoot || path.join(context.reviewRoot, 'runs');
  const runId = 'current';
  const paper = { title, doi: '10.1234/current', grade: 'B' };
  await write(path.join(runRoot, runId, 'run_group.json'), { schemaVersion: 1, runId, pipelineMode: local ? 'local' : 'desktop', status: 'completed', startedAt: '2026-09-13T05:00:00Z', artifacts: [{ kind: 'weekly_export' }, { kind: 'pipeline', rootKey: local ? 'local' : 'research', path: local ? 'review_results/pipeline/current' : 'pipeline/current' }] });
  const pipeline = path.join(context.researchRoot, 'pipeline', 'current');
  await write(path.join(pipeline, 'run_report.json'), { steps: { med_weekly_synthesis: { completed: true } } });
  if (local) await write(local.papersPath, { schema_version: 1, papers: [paper, { title: 'excluded D', doi: '10.1234/drop', grade: 'D' }] });
  else {
    await write(path.join(pipeline, 'desktop_daily_review_source.json'), { triaged: [paper] });
    await write(path.join(pipeline, 'zotero_writeback_summary.json'), { writeback_items: [{ ...paper, itemKey: 'CURRENT' }] });
  }
  await write(path.join(context.reviewRoot, 'screening_standards.md'), '# 筛选标准\n\n## 优先关注\n\n* 基线\n');
  await write(ruleSuggestionsLogPath(context.reviewRoot), { suggestions: [{ id: title, target: 'screening_standards.md', status: 'pending', change_type: 'add_rule', rule_text: '优先机制研究' }] });
}
async function client(t, options) {
  const app = await startControlCenter({ port: 0, ...options });
  t.after(async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); });
  const send = (route, data, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(new URL(route, app.url), { method: data ? 'POST' : 'GET', headers }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(text) }));
    });
    request.on('error', reject); request.end(data ? JSON.stringify(data) : undefined);
  });
  const session = await send('/api/session');
  const headers = { cookie: session.headers['set-cookie'][0].split(';')[0], origin: app.url, 'x-csrf-token': session.json.token, 'content-type': 'application/json' };
  return (route, data) => send(route, data, headers);
}
for (const mode of ['default', 'project', 'configured', 'local']) test(`Control Center ${mode} roots: current query and all feedback owners agree`, async (t) => {
  const { root, repo } = await fixture(t);
  const env = {};
  const fallback = buildRuntimeConfig({ cwd: repo, env, argv: [] });
  if (mode !== 'default') {
    await seed(fallback, 'wrong repository data');
    await write(canonicalFeedbackPath(fallback.reviewRoot), { schemaVersion: 1, history: [] });
    const configPath = path.join(repo, 'instance', 'runner.json');
    env.PAPERECHO_CONFIG = configPath;
    await write(configPath, { schemaVersion: 2, mode: mode === 'local' ? 'local' : 'desktop', common: { projectRoot: path.join(root, 'project') }, local: { outputRoot: path.join(root, 'local-output') } });
    if (mode === 'configured') {
      env.review_results_OUTPUT_ROOT = path.join(root, 'output');
      env.review_results_ROOT = path.join(root, 'separate-research');
    }
  }
  const context = await resolveApplicationRuntimeContext({ cwd: repo, env });
  const services = createControlServices({ root: repo, env, context });
  await assert.rejects(services.review.read(path.join(root, 'outside.json')), /ARTIFACT_PATH_BLOCKED/);
  await seed(context, `${mode} current paper`);
  const api = await client(t, { root: repo, env });
  const weekly = (await api('/api/weekly')).json;
  assert.equal(weekly.total, 1); assert.equal(weekly.items[0].title, `${mode} current paper`);
  const submitted = await api('/api/feedback', { runId: weekly.runId, paperId: weekly.items[0].id, value: 'relevant', requestId: 'current-feedback' });
  assert.equal(submitted.status, 200);
  assert.equal(JSON.parse(await fs.readFile(canonicalFeedbackPath(context.reviewRoot), 'utf8')).history.length, 1);
  const research = await api('/api/research', { text: '希望机制研究', requestId: 'current-research' });
  assert.equal(research.status, 200);
  assert.equal(JSON.parse(await fs.readFile(path.join(context.reviewRoot, 'research_evaluations/current-research.json'), 'utf8')).text, '希望机制研究');
  assert.equal((await api('/api/suggestions')).json[0].id, `${mode} current paper`);
  const decision = await api('/api/decision', { id: `${mode} current paper`, decision: 'accepted', humanApproval: true });
  assert.equal(decision.json.status, 'accepted');
  assert.equal(JSON.parse(await fs.readFile(ruleSuggestionsLogPath(context.reviewRoot), 'utf8')).suggestions[0].status, 'accepted');
  if (mode !== 'default') {
    assert.equal(JSON.parse(await fs.readFile(canonicalFeedbackPath(fallback.reviewRoot), 'utf8')).history.length, 0);
    assert.equal(JSON.parse(await fs.readFile(ruleSuggestionsLogPath(fallback.reviewRoot), 'utf8')).suggestions[0].status, 'pending');
    await assert.rejects(fs.access(path.join(fallback.reviewRoot, 'research_evaluations')), { code: 'ENOENT' });
    assert.equal((await api('/api/settings', { id: 'general.profile', value: 'complete' })).status, 200);
    assert.equal(JSON.parse(await fs.readFile(env.PAPERECHO_CONFIG, 'utf8')).profile, 'complete');
    await assert.rejects(fs.access(path.join(repo, 'config/paperecho.config.json')), { code: 'ENOENT' });
  }
});
test('missing configured data does not fall back; malformed configuration fails before listening', async (t) => {
  const { root, repo } = await fixture(t);
  await seed(buildRuntimeConfig({ cwd: repo, env: {}, argv: [] }), 'wrong fallback');
  const env = { ZOTERO_PROJECT_ROOT: path.join(root, 'absent') };
  const api = await client(t, { root: repo, env });
  assert.equal((await api('/api/weekly')).json.total, 0);
  const config = path.join(repo, 'config/paperecho.config.json'); await write(config, '{bad');
  await assert.rejects(startControlCenter({ root: repo, port: 0, env: {} }), (error) => error.code === 'CONFIG_JSON_INVALID');
});
