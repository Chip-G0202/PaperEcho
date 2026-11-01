import { fileURLToPath } from 'node:url';
import { resolveCapabilityInput } from './application_config.mjs';

export const SHARED_MODEL_KEY = 'PAPERECHO_MODEL_API_KEY';
// Reuse capability owners, including canonical/invocation config precedence.
export function modelCredentials(env = process.env) {
  const inputs = Object.fromEntries(['translation', 'preference'].map(name => { try { return [name, resolveCapabilityInput(name, {
    env, legacyPath: env[name === 'translation' ? 'TITLE_TRANSLATION_CONFIG_PATH' : 'PREFERENCE_LEARNING_CONFIG_PATH'] || fileURLToPath(new URL(`../../../config/${name === 'translation' ? 'title_translation' : 'preference_learning'}.config.json`, import.meta.url)),
  })]; } catch { return [name, { env, value: null }]; } }));
  const endpoint = name => {
    const input = inputs[name];
    const value = input.env[name === 'translation' ? 'TITLE_TRANSLATION_ENDPOINT' : 'PREFERENCE_LEARNING_ENDPOINT'] || input.value?.endpoint;
    try { const url = new URL(value); return url.username || url.password || url.search || url.hash || url.protocol !== 'https:' ? null : url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''); } catch { return null; }
  };
  const a = String(inputs.translation.env.TITLE_TRANSLATION_API_KEY || '').trim(), b = String(inputs.preference.env.PREFERENCE_LEARNING_API_KEY || '').trim();
  const shared = String(env[SHARED_MODEL_KEY] || '').trim();
  const compatible = Boolean(endpoint('translation') && endpoint('translation') === endpoint('preference'));
  const conflict = Boolean(a && b && a !== b);
  const effective = compatible ? shared || (!conflict ? a || b : '') : '';
  return { compatible, conflict, source: effective ? shared ? SHARED_MODEL_KEY : a ? 'TITLE_TRANSLATION_API_KEY' : 'PREFERENCE_LEARNING_API_KEY' : '',
    translation: effective || a, preference: effective || b,
    sharedConfigured: Boolean(shared), effectiveShared: Boolean(effective) };
}
// UI projection only: preserve the full Doctor evidence and runtime errors.
export function modelConfigurationIssues(settings, credentials) {
  const value = id => settings.find(row => row.id === id)?.value;
  const shared = credentials.find(row => row.id === SHARED_MODEL_KEY);
  const issues = [];
  for (const name of ['translation', 'preference']) {
    const enabled = name === 'translation' ? value('translation.enabled') === true : value('preference.enabled') === true && value('review.master') === true;
    if (!enabled) continue;
    const own = credentials.find(row => row.id === (name === 'translation' ? 'TITLE_TRANSLATION_API_KEY' : 'PREFERENCE_LEARNING_API_KEY'));
    const missing = [!String(value(`${name}.endpoint`) || '').trim() && 'API 地址', !String(value(`${name}.model`) || '').trim() && '模型名称', !(shared?.effectiveConfigured || (own?.effectiveConfigured ?? own?.configured)) && 'API Key'].filter(Boolean);
    if (missing.length) issues.push({ checkId: `model.${name}`, status: 'WARN', summary: `${name === 'translation' ? '翻译' : '偏好功能'}配置不完整`, actionableHint: `请在统一 AI 配置中补充：${missing.join('、')}。`, settingTarget: missing.includes('API Key') ? 'ai.key' : missing.includes('API 地址') ? 'ai.endpoint' : 'ai.model' });
  }
  return issues;
}
