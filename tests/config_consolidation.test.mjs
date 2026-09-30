import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { migrateApplicationConfig } from '../workflow/tools/lib/application_config_migration.mjs';
import { getTranslationConfig } from '../workflow/tools/lib/title_translation_support.mjs';
import { getPreferenceLearningConfig } from '../workflow/tools/lib/preference_learning_support.mjs';
import { resolveRunnerConfiguration } from '../workflow/tools/runner/config_loader.mjs';
import { parseRunnerArgs } from '../workflow/tools/runner/args.mjs';
import { ConfigService } from '../workflow/tools/lib/control_config_service.mjs';
import { createControlServices } from '../workflow/tools/lib/control_application_services.mjs';
import { startControlCenter } from '../workflow/tools/web/server.mjs';
import { loadRssSources, loadPubMedPmcSearchConfig, loadSourceSelectionConfig, loadWorkflowRules, updatePubMedPmcKeywordGroups } from '../workflow/tools/lib/literature_config.mjs';
import { SecretService } from '../workflow/tools/lib/control_credentials_service.mjs';
import { RuleSuggestionService } from '../workflow/tools/lib/control_rule_suggestion_service.mjs';
import { emailTransportConfig } from '../workflow/tools/stage5/email_sender.mjs';

const base = fileURLToPath(new URL('./runs/config-consolidation/', import.meta.url));
async function fixture(t, version = 2) {
  await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'case-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, value) => { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value)); return file; };
  const configPath = path.join(root, 'config/paperecho.config.json');
  if (version) await write('config/paperecho.config.json', { schemaVersion: version, mode: 'desktop', common: {} });
  const prompt = await write('config/fixture-prompt.md', '测试 ${sourceText}');
  await write('config/title_translation.config.json', { model: 'model-T', endpoint: 'https://translation.example/v1/chat/completions', temperature: 0.1, prompt_file: prompt });
  await write('config/preference_learning.config.json', { model: 'model-R', endpoint: 'https://review.example/v1/chat/completions', temperature: 0.3, prompt_file: prompt });
  const env = { PAPERECHO_APPLICATION_CONFIG: configPath, TITLE_TRANSLATION_CONFIG_PATH: path.join(root, 'config/title_translation.config.json'), PREFERENCE_LEARNING_CONFIG_PATH: path.join(root, 'config/preference_learning.config.json') };
  return { root, write, env, configPath };
}

test('shared resolver preserves separate capabilities and Settings wins over legacy model env after migration', async (t) => {
  const f = await fixture(t);
  const env = { ...f.env, PREFERENCE_LEARNING_MODEL: 'legacy-model', TITLE_TRANSLATION_TEMPERATURE: '0.7', SMTP_PASS: 'fake-secret' };
  const beforeT = getTranslationConfig({ env });
  const beforeR = getPreferenceLearningConfig({ env });
  await migrateApplicationConfig({ root: f.root, env });
  assert.equal(getPreferenceLearningConfig({ env }).model, beforeR.model);
  assert.equal(getTranslationConfig({ env }).temperature, beforeT.temperature);
  const service = new ConfigService({ root: f.root, env });
  await service.updateMany([{ id: 'preference.model', value: 'model-A' }, { id: 'preference.endpoint', value: 'https://a.example/v1/chat/completions' }]);
  assert.equal(getPreferenceLearningConfig({ env }).model, 'model-A');
  assert.equal(getTranslationConfig({ env }).model, 'model-T');
  const raw = await fs.readFile(f.configPath, 'utf8');
  assert.ok(!raw.includes('fake-secret'));
  assert.equal(JSON.parse(await fs.readFile(f.env.PREFERENCE_LEARNING_CONFIG_PATH, 'utf8')).model, 'model-R');
});

test('Runner explicit capability override is invocation-only; next ordinary run reads Settings', async (t) => {
  const f = await fixture(t);
  await migrateApplicationConfig({ root: f.root, env: f.env });
  const override = await f.write('override.json', { model: 'model-X', endpoint: 'https://x.example/v1/chat/completions', prompt_file: path.join(f.root, 'config/fixture-prompt.md') });
  const args = ['--check', '--config', f.configPath];
  const once = await resolveRunnerConfiguration(parseRunnerArgs([...args, '--preference-config', override]), { cwd: f.root, env: {} });
  assert.equal(getPreferenceLearningConfig({ env: once.env }).model, 'model-X');
  const normal = await resolveRunnerConfiguration(parseRunnerArgs(args), { cwd: f.root, env: {} });
  assert.equal(getPreferenceLearningConfig({ env: normal.env }).model, 'model-R');
  assert.equal(JSON.parse(await fs.readFile(f.configPath, 'utf8')).preference.model, 'model-R');
});

test('isolated Control Center HTTP Settings -> Research Feedback uses exactly the saved model/endpoint', async (t) => {
  const f = await fixture(t);
  await migrateApplicationConfig({ root: f.root, env: f.env });
  await f.write('config/pubmed_pmc_search.json', { keyword_groups: { required: [['fixture']], optional: [], negative: [] } });
  await f.write('review_results/文献评价/screening_standards.md', '# 标准\n\n## 优先关注\n* 基线\n\n## 相对降权\n');
  let used;
  const services = createControlServices({ root: f.root, env: { ...f.env, PREFERENCE_LEARNING_API_KEY: 'fake-key' }, llmClient: async (_payload, runtime) => {
    used = { model: runtime.model, endpoint: runtime.endpoint };
    return { rules_added: [], rules_deleted: [], rules_changed: [], keywords_added: { required: [], optional: [], negative: [] }, keywords_removed: [], negative_keywords_added: [], unmapped_feedback: [] };
  } });
  const running = await startControlCenter({ root: f.root, services, port: 0 });
  t.after(() => new Promise((resolve) => running.server.close(resolve)));
  const url = new URL(running.url);
  const request = (route, data, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, path: route, method: data ? 'POST' : 'GET', headers }, (res) => {
      let text = ''; res.on('data', (chunk) => text += chunk); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, value: JSON.parse(text) }));
    }); req.on('error', reject); req.end(data ? JSON.stringify(data) : undefined);
  });
  const session = await request('/api/session');
  const auth = { cookie: session.headers['set-cookie'][0].split(';')[0], origin: running.url, 'x-csrf-token': session.value.token, 'content-type': 'application/json' };
  const saved = await request('/api/settings', { updates: [{ id: 'preference.model', value: 'model-A' }, { id: 'preference.endpoint', value: 'https://a.example/v1/chat/completions' }] }, auth);
  assert.equal(saved.status, 200);
  const result = await request('/api/research', { text: '优先关注机制研究', requestId: 'config-regression' }, auth);
  assert.equal(result.status, 200);
  assert.deepEqual(used, { model: 'model-A', endpoint: 'https://a.example/v1/chat/completions' });
  assert.ok(!JSON.stringify((await request('/api/settings', null, auth)).value).includes('fake-key'));
});

for (const version of [0, 1, 2, 3, 4, 5, 6]) test(`migration schema ${version}: fresh/legacy/current and idempotency`, async (t) => {
  const f = await fixture(t, version);
  const before = await fs.readFile(f.configPath, 'utf8').catch(() => null);
  const result = await migrateApplicationConfig({ root: f.root, env: f.env });
  assert.equal(result.migrated, version !== 6);
  const after = await fs.readFile(f.configPath, 'utf8');
  assert.equal(JSON.parse(after).schemaVersion, 6);
  assert.equal((await migrateApplicationConfig({ root: f.root, env: f.env })).migrated, false);
  assert.equal(await fs.readFile(f.configPath, 'utf8'), after);
  if (version === 6) assert.equal(after, before);
  else if (before) assert.deepEqual(JSON.parse(await fs.readFile(`${f.configPath}.${version >= 3 ? `v${version}-backup` : "legacy-backup"}`, 'utf8')), JSON.parse(before));
});

for (const mode of ['desktop', 'web', 'local']) test(`legacy ${mode}: source/RSS/review/Radar/Weekly/Email effective equivalence`, async (t) => {
  const f = await fixture(t);
  const unified = { schemaVersion: 2, mode, common: { radar: { enabled: true, dailyTime: '15:00' }, integrity: { enabled: true }, email: { enabled: true, recipient: 'reader@example.test', smtp: { host: 'smtp.example.test', user: 'sender@example.test', port: 465 } } }, web: { userId: '1234', apiKeyEnv: 'ZOTERO_API_KEY' }, desktop: { writebackBatchSize: 12 }, local: { outputRoot: '../local-output' } };
  await f.write('config/paperecho.config.json', unified);
  await f.write('config/rss_sources.json', { sources: [{ name: 'Fixture RSS', url: 'https://rss.example.test/feed', enabled: true }] });
  await f.write('config/source_selection.json', { research_domain: 'biomedical', override_enabled_sources: ['rss', 'pubmed_pmc'] });
  await f.write('config/pubmed_pmc_search.json', { query: 'fixture', days_back: 12, retmax: 40 });
  await f.write('config/review-workflow-rules.json', { triage: { terms: { pollutant: ['fixture'] } }, llm_review: { enabled: true } });
  const inputs = { root: f.root, now: new Date('2026-09-29T07:00:00Z') };
  const snapshot = () => [loadRssSources(inputs), loadPubMedPmcSearchConfig(inputs), loadSourceSelectionConfig(inputs), loadWorkflowRules(inputs)].map(({ path, ...rest }) => rest);
  const before = snapshot();
  const env = { ...f.env, review_results_RUN_INTERVAL_DAYS: '9', SMTP_PASS: 'fake-smtp', ZOTERO_API_KEY: 'fake-zotero' };
  const args = parseRunnerArgs(['--check', '--config', f.configPath]);
  const old = await resolveRunnerConfiguration(args, { cwd: f.root, env });
  await migrateApplicationConfig({ root: f.root, env });
  assert.deepEqual(snapshot(), before);
  const current = await resolveRunnerConfiguration(args, { cwd: f.root, env });
  for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PORT', 'SMTP_PASS', 'PAPERECHO_RADAR_ENABLED', 'PAPERECHO_INTEGRITY_ENABLED', 'review_results_RUN_INTERVAL_DAYS']) assert.equal(current.env[key], old.env[key]);
  assert.deepEqual(emailTransportConfig(current.env), emailTransportConfig(old.env));
  assert.equal(current.options.mode, old.options.mode);
  assert.equal(current.options.email, old.options.email);
});

test('legacy selected custom preference file and env conflict migrate the old effective values', async (t) => {
  const f = await fixture(t);
  const custom = await f.write('custom.json', { model: 'custom', endpoint: 'https://custom.example.test/v1/chat/completions', prompt_file: path.join(f.root, 'config/fixture-prompt.md') });
  await f.write('config/paperecho.config.json', { schemaVersion: 2, mode: 'desktop', common: { llm: { preferenceConfig: '../custom.json' } } });
  await migrateApplicationConfig({ root: f.root, env: { ...f.env, PREFERENCE_LEARNING_MODEL: 'env-winner' } });
  const value = JSON.parse(await fs.readFile(f.configPath, 'utf8'));
  assert.equal(value.preference.model, 'env-winner');
  assert.equal(value.preference.endpoint, 'https://custom.example.test/v1/chat/completions');
  assert.equal(value.common.llm.preferenceConfig, undefined);
  assert.equal(JSON.parse(await fs.readFile(custom, 'utf8')).model, 'custom');
});

for (const kind of ['future', 'malformed-unified', 'malformed-domain', 'secret-domain', 'invalid-domain', 'temp-write', 'rename', 'readback']) test(`migration failure ${kind} preserves original config, secrets and state`, async (t) => {
  const f = await fixture(t);
  const secret = 'fake-protected-secret';
  await f.write('.env', `SMTP_PASS=${secret}\n`);
  const state = await f.write('state/protected.json', { sentinel: true });
  if (kind === 'future') await f.write('config/paperecho.config.json', { schemaVersion: 999 });
  if (kind === 'malformed-unified') await f.write('config/paperecho.config.json', '{broken');
  if (kind === 'malformed-domain') await f.write('config/rss_sources.json', '{broken');
  if (kind === 'secret-domain') await f.write('config/rss_sources.json', { api_key: secret });
  if (kind === 'invalid-domain') await f.write('config/rss_sources.json', { sources: 'invalid' });
  const original = await fs.readFile(f.configPath, 'utf8');
  const oldDomain = await fs.readFile(f.env.PREFERENCE_LEARNING_CONFIG_PATH, 'utf8');
  const fail = async () => { throw new Error('injected'); };
  const atomicOptions = kind === 'temp-write' ? { fsApi: { ...fs, open: fail } } : kind === 'rename' ? { renameImpl: fail } : kind === 'readback' ? { validateTemporary: fail } : {};
  await assert.rejects(migrateApplicationConfig({ root: f.root, env: f.env, atomicOptions }), (error) => !error.message.includes(secret));
  assert.equal(await fs.readFile(f.configPath, 'utf8'), original);
  assert.equal(await fs.readFile(f.env.PREFERENCE_LEARNING_CONFIG_PATH, 'utf8'), oldDomain);
  assert.equal(await fs.readFile(path.join(f.root, '.env'), 'utf8'), `SMTP_PASS=${secret}\n`);
  assert.deepEqual(JSON.parse(await fs.readFile(state, 'utf8')), { sentinel: true });
  assert.equal((await fs.readdir(path.dirname(f.configPath))).filter((name) => name.endsWith('.tmp') || name.endsWith('.lock')).length, 0);
});

test('local secret/legacy env migration leaves SecretService Replace/Clear and external precedence intact', async (t) => {
  const f = await fixture(t);
  const envFile = await f.write('.env', 'PREFERENCE_LEARNING_MODEL=local-model\nSMTP_PASS="fake-local"\n');
  await migrateApplicationConfig({ root: f.root, env: f.env });
  assert.equal(getPreferenceLearningConfig({ env: f.env }).model, 'local-model');
  assert.ok(!(await fs.readFile(f.configPath, 'utf8')).includes('fake-local'));
  const external = new SecretService({ root: f.root, env: { SMTP_PASS: 'fake-external' } });
  assert.equal((await external.list()).find((item) => item.id === 'SMTP_PASS').writable, false);
  await assert.rejects(external.clear('SMTP_PASS'), /EXTERNALLY_MANAGED/);
  const local = new SecretService({ root: f.root, env: {} });
  await local.replace('SMTP_PASS', 'fake-replacement');
  await local.clear('SMTP_PASS');
  assert.ok(!(await fs.readFile(envFile, 'utf8')).includes('fake-replacement'));
  assert.ok(!JSON.stringify(await local.list()).includes('fake-local'));
});

test('keyword learning and accepted suggestion mutate only the canonical section', async (t) => {
  const f = await fixture(t);
  const pubmed = await f.write('config/pubmed_pmc_search.json', { keyword_groups: { required: [['fixture']], optional: [], negative: [] } });
  await migrateApplicationConfig({ root: f.root, env: f.env });
  const original = await fs.readFile(pubmed, 'utf8');
  await updatePubMedPmcKeywordGroups(pubmed, { keywords_added: { optional: ['learning'] } });
  const reviewRoot = path.join(f.root, 'review_results/文献评价');
  await f.write('review_results/文献评价/standards_rule_suggestions_log.json', { suggestions: [{ id: 'suggestion', target: 'pubmed_pmc_search.json', change_type: 'add_keyword', rule_text: '添加可选检索词：mechanism', status: 'pending' }] });
  await new RuleSuggestionService({ root: f.root, reviewRoot }).decide({ id: 'suggestion', decision: 'accepted', humanApproval: true });
  assert.equal(await fs.readFile(pubmed, 'utf8'), original);
  assert.deepEqual(JSON.parse(await fs.readFile(f.configPath, 'utf8')).pubmed.keyword_groups.optional, ['learning', 'mechanism']);
});
