import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { modelCredentials, modelConfigurationIssues, SHARED_MODEL_KEY } from '../tools/lib/model_credentials.mjs';
import { SecretService } from '../tools/lib/control_credentials_service.mjs';
import { getTranslationConfig, callMimoTranslateStream } from '../tools/lib/title_translation_support.mjs';
import { getPreferenceLearningConfig, understandPreferenceEvaluation } from '../tools/lib/preference_learning_support.mjs';
import { runLlmPreferenceLearning } from '../tools/stage1/llm_preference_learning.mjs';

async function fixture(t) {
  const base = path.resolve('tests/runs/model-settings'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'isolated-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {};
  for (const [name, variable] of [['translation', 'TITLE_TRANSLATION_CONFIG_PATH'], ['preference', 'PREFERENCE_LEARNING_CONFIG_PATH']]) {
    env[variable] = path.join(root, `${name}.json`);
    await fs.writeFile(env[variable], JSON.stringify({ enabled: true, endpoint: 'https://provider.invalid/v1/chat/completions', model: 'dummy', stream: false, max_retries: 0 }));
  }
  return { root, env };
}
test('shared credentials reuse single/equal legacy keys, preserve conflicts and refuse incompatible providers', async t => {
  const { env } = await fixture(t);
  for (const legacy of [{ TITLE_TRANSLATION_API_KEY: 'dummy-a' }, { PREFERENCE_LEARNING_API_KEY: 'dummy-a' }, { TITLE_TRANSLATION_API_KEY: 'dummy-a', PREFERENCE_LEARNING_API_KEY: 'dummy-a' }]) {
    const input = { ...env, ...legacy }, before = JSON.stringify(input), resolved = modelCredentials(input);
    assert.equal(resolved.translation, 'dummy-a'); assert.equal(resolved.preference, 'dummy-a');
    assert.equal(getPreferenceLearningConfig({ env: input }).apiKey, 'dummy-a');
    assert.equal(getTranslationConfig({ env: input }).apiKeyConfigured, true);
    assert.equal(JSON.stringify(input), before);
  }
  const conflict = { ...env, TITLE_TRANSLATION_API_KEY: 'dummy-a', PREFERENCE_LEARNING_API_KEY: 'dummy-b' };
  assert.equal(modelCredentials(conflict).conflict, true);
  assert.equal(modelCredentials(conflict).translation, 'dummy-a'); assert.equal(modelCredentials(conflict).preference, 'dummy-b');
  const shared = { ...conflict, [SHARED_MODEL_KEY]: 'dummy-new' };
  assert.equal(modelCredentials(shared).translation, 'dummy-new'); assert.equal(getPreferenceLearningConfig({ env: shared }).apiKey, 'dummy-new');
  const split = { ...shared, PREFERENCE_LEARNING_ENDPOINT: 'https://other.invalid/v1' };
  assert.equal(modelCredentials(split).compatible, false); assert.equal(modelCredentials(split).preference, 'dummy-b');
  const original = JSON.parse(await fs.readFile(env.PREFERENCE_LEARNING_CONFIG_PATH, 'utf8'));
  await fs.writeFile(env.PREFERENCE_LEARNING_CONFIG_PATH, JSON.stringify({ ...original, api_key_env_fallback_order: ['CUSTOM_API_KEY'] }));
  assert.equal(getPreferenceLearningConfig({ env: { ...env, TITLE_TRANSLATION_API_KEY: 'dummy-a', CUSTOM_API_KEY: 'dummy-custom' } }).apiKey, 'dummy-custom');
});
test('shared secure storage never modifies legacy values and redacts the new key', async t => {
  const { root, env } = await fixture(t); const file = path.join(root, '.env');
  const before = 'TITLE_TRANSLATION_API_KEY="dummy-old-a"\nPREFERENCE_LEARNING_API_KEY="dummy-old-b"\nUNKNOWN=keep\n';
  await fs.writeFile(file, before, { mode: 0o600 }); const service = new SecretService({ root, env });
  const state = (await service.list()).find(x => x.id === SHARED_MODEL_KEY); assert.equal(state.conflict, true);
  await service.replace(SHARED_MODEL_KEY, 'dummy-shared-secret');
  assert.ok((await fs.readFile(file, 'utf8')).startsWith(before));
  assert.equal(service.redact('dummy-shared-secret'), '[REDACTED]');
  assert.equal(JSON.stringify(await service.list()).includes('dummy-shared-secret'), false);
  await service.clear(SHARED_MODEL_KEY); assert.ok((await fs.readFile(file, 'utf8')).startsWith(before));
  env.PREFERENCE_LEARNING_ENDPOINT = 'https://other.invalid/v1';
  await assert.rejects(service.replace(SHARED_MODEL_KEY, 'dummy-next'), /SHARED_MODEL_PROVIDER_MISMATCH/);
});
test('disabled functions make no API calls; translation uses the same shared bearer as preference', async t => {
  const { env, root } = await fixture(t); const oldFetch = globalThis.fetch;
  const names = [SHARED_MODEL_KEY, 'TITLE_TRANSLATION_API_KEY', 'PREFERENCE_LEARNING_API_KEY', ...Object.keys(env)];
  const before = Object.fromEntries(names.map(n => [n, process.env[n]]));
  t.after(() => { globalThis.fetch = oldFetch; for (const [n, v] of Object.entries(before)) { if (v === undefined) delete process.env[n]; else process.env[n] = v; } });
  for (const n of names) delete process.env[n]; Object.assign(process.env, env, { [SHARED_MODEL_KEY]: 'dummy-shared' });
  let calls = 0; globalThis.fetch = async (_url, options) => { calls++; assert.equal(options.headers.Authorization, `Bearer ${getPreferenceLearningConfig({ env: process.env }).apiKey}`); return new Response(JSON.stringify({ choices: [{ message: { content: '测试翻译' } }] })); };
  await callMimoTranslateStream('dummy', { runtime: { enabled: false } });
  await runLlmPreferenceLearning({ config: { enabled: false }, runtime: {}, feedbackRows: [{ title: 'dummy', feedback: 'keep' }] });
  assert.equal(calls, 0);
  assert.equal(await callMimoTranslateStream('dummy'), '测试翻译'); assert.equal(calls, 1);
  assert.equal(await callMimoTranslateStream('dummy', { runtime: { ...getTranslationConfig(), promptTemplate: '${sourceText}' } }), '测试翻译');
  assert.equal(calls, 2);
  await fs.writeFile(path.join(root, 'review-workflow-rules.json'), JSON.stringify({ llm_review: { enabled: true, preference_learning_enabled: false } }));
  const disabled = getPreferenceLearningConfig({ env: process.env }); assert.equal(disabled.preferenceEnabled, false);
  assert.equal((await understandPreferenceEvaluation({}, { runtime: disabled, llmClient: () => { throw Error('must not call'); } })).blocker, 'preference_disabled');
  assert.equal(calls, 2);
});
test('configuration diagnostics show only enabled, incomplete functions', () => {
  const settings = values => Object.entries(values).map(([id, value]) => ({ id, value }));
  assert.deepEqual(modelConfigurationIssues(settings({ 'translation.enabled': false, 'preference.enabled': false }), []), []);
  assert.equal(modelConfigurationIssues(settings({ 'translation.enabled': true }), [])[0].checkId, 'model.translation');
  const configured = settings({ 'translation.enabled': true, 'translation.model': 'dummy', 'translation.endpoint': 'https://provider.invalid/v1', 'preference.enabled': false });
  assert.deepEqual(modelConfigurationIssues(configured, [{ id: SHARED_MODEL_KEY, effectiveConfigured: true }]), []);
});
test('shared UI saves only a changed feature and displays one key editor', async () => {
  const source = await fs.readFile('workflow/tools/web/static/app.js', 'utf8');
  const fn = source.slice(source.indexOf('async function appendModelSettings('), source.indexOf('async function settings(')) + '\nappendModelSettings;';
  const nodes = [], buttons = [], writes = []; let editors = 0;
  const el = (tag, text) => { const node = { tag, text, children: [], append(...v) { this.children.push(...v); }, prepend(...v) { this.children.unshift(...v); }, setAttribute() {}, addEventListener() {} }; nodes.push(node); return node; };
  const append = vm.runInNewContext(fn, { el, button: (text, run) => { const b = { text, run }; buttons.push(b); return b; }, appendCredentialEditor: () => { editors++; }, api: async (_url, value) => writes.push(JSON.parse(JSON.stringify(value))) });
  await append(el('main'), [{ id: 'translation.enabled', value: false }, { id: 'preference.enabled', value: false }, { id: 'review.master', value: false }, { id: 'review.enabled', value: true }], [{ id: SHARED_MODEL_KEY, compatible: true }]);
  assert.equal(editors, 1); const toggles = nodes.filter(n => n.tag === 'input'); assert.equal(toggles.length, 2);
  await buttons[0].run(); assert.equal(writes.length, 0);
  toggles[0].checked = true; await buttons[0].run(); assert.deepEqual(writes[0].updates, [{ id: 'translation.enabled', value: true }]);
  toggles[1].checked = true; await buttons[0].run(); assert.ok(writes[1].updates.every(row => row.id !== 'translation.enabled'));
  assert.ok(writes[1].updates.some(row => row.id === 'review.enabled' && row.value === false));
  toggles[1].checked = false; await buttons[0].run(); assert.deepEqual(writes[2].updates, [{ id: 'preference.enabled', value: false }]);
});
test('System presentation omits healthy/optional credentials but preserves real failures and unknown origins', async () => {
  const source = await fs.readFile('workflow/tools/web/static/app.js', 'utf8');
  const fn = source.slice(source.indexOf('async function system()'), source.indexOf('async function feedback()')) + '\nsystem;';
  const nodes = [], buttons = [];
  const el = (tag, text, className) => { const n = { tag, text, className, dataset: {}, children: [], append(...v) { this.children.push(...v); }, replaceChildren(...v) { this.children = v; }, setAttribute() {} }; nodes.push(n); return n; };
  const checks = [
    { checkId: 'runtime.roots', status: 'PASS', summary: 'hidden healthy' },
    { checkId: 'secret.SMTP_PASS', status: 'WARN', summary: 'hidden optional' },
    { checkId: 'runtime.data', status: 'FAIL', summary: 'visible runtime failure' },
    { checkId: 'secret.UNKNOWN', status: 'UNKNOWN', summary: 'visible unsafe origin' },
  ];
  let failing = false;
  const system = vm.runInNewContext(fn, { main: el('main'), pageIntro: () => el('header'), el, button: (text, run) => { const b = { text, run, dataset: {} }; buttons.push(b); return b; }, supportExportBusy: false, diagnosticCache: null, diagnosticFull: false, diagnosticState: 'unknown', settingDestinations: {}, refreshConfigurationDiagnostics: async () => {}, api: async url => { if (failing) throw new Error('offline'); return url === '/api/version' ? { version: '2.6.0' } : { status: 'FAIL', checks, configurationIssues: [] }; } });
  await system();
  assert.equal(nodes.filter(n => n.className === 'doctor-check').length, 2);
  assert.equal(nodes.some(n => String(n.text).includes('hidden healthy')), false);
  assert.equal(nodes.some(n => String(n.text).includes('hidden optional')), false);
  failing = true; await buttons.find(b => b.text.includes('刷新')).run();
  assert.equal(nodes.filter(n => n.className === 'doctor-check').length, 2);
  assert.ok(nodes.some(n => String(n.textContent).includes('诊断结果未知')));
});

test('confirmed common service has one owner, retains legacy fields and never moves old keys to another provider', async t => {
  const { root, env } = await fixture(t);
  const { ConfigService } = await import('../tools/lib/control_config_service.mjs');
  const service = new ConfigService({ root, env });
  const original = await fs.readFile(env.TITLE_TRANSLATION_CONFIG_PATH, 'utf8');
  const preferenceBefore = await fs.readFile(env.PREFERENCE_LEARNING_CONFIG_PATH, 'utf8');
  await assert.rejects(service.update('ai.enabled', true), /SETTING_BATCH_INVALID/);
  assert.equal(await fs.readFile(env.TITLE_TRANSLATION_CONFIG_PATH, 'utf8'), original);
  const shared = { endpoint: 'https://new-provider.invalid/v1/chat/completions', model: 'common-model', temperature: 0.7, timeout_ms: 12000, top_p: 0.5, stream: false, thinking: false, max_retries: 1 };
  await service.updateMany([{ id: 'ai.enabled', value: true }, ...Object.entries(shared).map(([key, value]) => ({ id: `ai.${key}`, value }))]);
  const saved = JSON.parse(await fs.readFile(env.TITLE_TRANSLATION_CONFIG_PATH, 'utf8'));
  for (const [key, value] of Object.entries(JSON.parse(original))) assert.deepEqual(saved[key], value);
  assert.equal(await fs.readFile(env.PREFERENCE_LEARNING_CONFIG_PATH, 'utf8'), preferenceBefore);
  const input = { ...env, TITLE_TRANSLATION_API_KEY: 'dummy-old', PREFERENCE_LEARNING_API_KEY: 'dummy-other', TITLE_TRANSLATION_MODEL: 'old-override' };
  assert.equal(getTranslationConfig({ env: input }).model, shared.model);
  assert.equal(getPreferenceLearningConfig({ env: input }).model, shared.model);
  assert.equal(getTranslationConfig({ env: input }).apiKeyConfigured, false);
  assert.equal(getPreferenceLearningConfig({ env: input }).apiKey, '');
  assert.equal(modelCredentials({ ...input, [SHARED_MODEL_KEY]: 'dummy-new' }).preference, 'dummy-new');
  const listed = await service.list();
  assert.equal(listed.find(row => row.id === 'preference.model').value, shared.model);
  assert.equal(listed.find(row => row.id === 'preference.model').legacyValue, 'dummy');
});

test('configuration refresh keeps last evidence on failure and updates only after an acknowledged response', async () => {
  const source = await fs.readFile('workflow/tools/web/static/app.js', 'utf8');
  const fn = source.slice(source.indexOf('let diagnosticCache ='), source.indexOf('const settingDestinations'));
  let fail = false;
  const context = vm.createContext({ api: async () => { if (fail) throw new Error('offline'); return { configurationIssues: [] }; } });
  vm.runInContext(fn, context);
  vm.runInContext('diagnosticCache = {checks: [{status:"FAIL"}], configurationIssues: [{checkId:"model.translation"}]};', context);
  fail = true; await vm.runInContext('refreshConfigurationDiagnostics()', context);
  assert.equal(vm.runInContext('diagnosticState', context), 'unknown');
  assert.equal(vm.runInContext('diagnosticCache.configurationIssues.length', context), 1);
  fail = false; await vm.runInContext('refreshConfigurationDiagnostics()', context);
  assert.equal(vm.runInContext('diagnosticCache.configurationIssues.length', context), 0);
  assert.equal(vm.runInContext('diagnosticCache.checks.length', context), 1);
});

test('canonical shared settings save atomically and invocation configuration remains explicit', async t => {
  const { root, env } = await fixture(t);
  const { ConfigService } = await import('../tools/lib/control_config_service.mjs');
  const canonical = JSON.parse(await fs.readFile('config/paperecho.config.example.json', 'utf8'));
  canonical.translation = { enabled: true, endpoint: 'https://legacy.invalid/v1', model: 'old-a' };
  canonical.preference = { endpoint: 'https://legacy.invalid/v1', model: 'old-b' };
  const configPath = path.join(root, 'canonical.json'); await fs.writeFile(configPath, JSON.stringify(canonical));
  const input = { ...env, PAPERECHO_APPLICATION_CONFIG: configPath, [SHARED_MODEL_KEY]: 'dummy-only' };
  const service = new ConfigService({ root, env: input, configPath });
  const fields = { endpoint: 'https://new.invalid/v1', model: 'chosen', temperature: 0.2, timeout_ms: 10000, top_p: 0.6, stream: false, thinking: false, max_retries: 1 };
  await service.updateMany([{ id: 'ai.enabled', value: true }, ...Object.entries(fields).map(([key, value]) => ({ id: `ai.${key}`, value }))]);
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(saved.translation.model, 'old-a'); assert.deepEqual(saved.preference, canonical.preference);
  for (const runtime of [getTranslationConfig({ env: input }), getPreferenceLearningConfig({ env: input })]) {
    assert.equal(runtime.model, 'chosen'); assert.equal(runtime.endpoint, 'https://new.invalid/v1/chat/completions'); assert.equal(runtime.temperature, 0.2);
  }
  assert.equal(getTranslationConfig({ env: { ...input, PAPERECHO_INVOCATION_TRANSLATION_CONFIG: env.TITLE_TRANSLATION_CONFIG_PATH } }).model, 'dummy');
});
