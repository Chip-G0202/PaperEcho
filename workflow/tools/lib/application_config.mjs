import fs from 'node:fs';
import path from 'node:path';
import { validateRunnerConfigObject } from '../runner/config_loader.mjs';
import { cleanJournalName } from './journal_name_cleaner.mjs';

export const APPLICATION_SCHEMA_VERSION = 6;
export const DOMAIN_SECTIONS = Object.freeze({
  'source_selection.json': 'sources',
  'rss_sources.json': 'rss',
  'pubmed_pmc_search.json': 'pubmed',
  'openalex_search.json': 'openalex',
  'review-workflow-rules.json': 'review',
  'title_translation.config.json': 'translation',
  'preference_learning.config.json': 'preference',
});
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
export function isValidRssPublicationTitle(value) {
  if (value === undefined) return true;
  if (typeof value !== 'string' || value.length > 200 || /[<>\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f]/u.test(value)) return false;
  const venue = cleanJournalName(value);
  return !value.trim() || Boolean(venue) && !/[<>]|https?:\/\//i.test(venue);
}
export function assertNonSecret(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(api[_-]?key|apiKey|password|secret|token|authorization|SMTP_PASS|.*_API_KEY)$/i.test(key)) throw new Error('APPLICATION_CONFIG_SECRET_FORBIDDEN');
    assertNonSecret(child);
    if (typeof child === 'string' && /^https?:\/\//i.test(child)) {
      let url;
      try { url = new URL(child); } catch { throw new Error('APPLICATION_CONFIG_URL_INVALID'); }
      if (url.username || url.password || [...url.searchParams.keys()].some((name) => /^(api[_-]?key|token|password|secret)$/i.test(name))) throw new Error('APPLICATION_CONFIG_SECRET_FORBIDDEN');
    }
  }
}
export function validateApplicationSections(config) {
  assertNonSecret(config);
  for (const section of Object.values(DOMAIN_SECTIONS)) {
    const value = config[section];
    if (value === undefined) continue;
    if (!object(value)) throw new Error('APPLICATION_CONFIG_SECTION_INVALID');
    for (const key of ['enabled', 'stream', 'thinking']) if (value[key] !== undefined && typeof value[key] !== 'boolean') throw new Error('APPLICATION_CONFIG_VALUE_INVALID');
    for (const key of ['model', 'endpoint', 'prompt_file', 'query']) if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error('APPLICATION_CONFIG_VALUE_INVALID');
    if (value.temperature !== undefined && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature))) throw new Error('APPLICATION_CONFIG_VALUE_INVALID');
    if (value.sources !== undefined && !Array.isArray(value.sources)) throw new Error('APPLICATION_CONFIG_VALUE_INVALID');
    if (section === 'rss' && value.sources?.some(source => object(source) && !isValidRssPublicationTitle(source.publicationTitle))) throw new Error('APPLICATION_CONFIG_VALUE_INVALID');
  }
  if (config.weekly !== undefined && (!object(config.weekly) || !Number.isInteger(config.weekly.intervalDays) || config.weekly.intervalDays < 1)) throw new Error('APPLICATION_CONFIG_WEEKLY_INVALID');
  return config;
}
export function applicationConfigPath({ root, env = process.env, configPath } = {}) {
  return path.resolve(configPath || env.PAPERECHO_APPLICATION_CONFIG || env.PAPERECHO_CONFIG || path.join(root || env.ZOTERO_PROJECT_ROOT || process.cwd(), 'config', 'paperecho.config.json'));
}
export function readApplicationConfig(options = {}) {
  const file = applicationConfigPath(options);
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Error('APPLICATION_CONFIG_UNREADABLE'); }
  if (![1, 2, 3, 4, 5, 6].includes(config?.schemaVersion)) throw new Error('APPLICATION_CONFIG_SCHEMA_UNSUPPORTED');
  if (config.schemaVersion < 3) return null;
  return normalizeNotificationPreferences(validateRunnerConfigObject(config));
}

// Legacy lists filtered existing global switches; merging must never enable
// a previously disabled channel. Missing lists retain historical fan-out.
export function normalizeNotificationPreferences(config) {
  const notifications = config?.common?.notifications;
  if (!['radar', 'weekly'].some(event => notifications?.[event]?.channels !== undefined)) return config;
  const next = structuredClone(config);
  const ids = ['email', 'qq', 'wechat', 'feishu', 'wecom'];
  const selected = new Set(['radar', 'weekly'].flatMap(event => notifications[event]?.channels ?? ids));
  next.common.email ||= {};
  next.common.email.enabled = config.common.email?.enabled !== false && selected.has('email');
  for (const id of ids.slice(1)) {
    const channel = next.common.notifications.channels?.[id];
    if (channel) channel.enabled = channel.enabled === true && selected.has(id);
  }
  for (const event of ['radar', 'weekly']) next.common.notifications[event] = { enabled: notifications[event]?.enabled !== false };
  return next;
}

// Existing domain consumers receive their old in-memory shape, never an exported legacy file.
export function readDomainConfig(file, { root = path.dirname(path.dirname(file)), env = process.env, configPath, canonical } = {}) {
  const section = DOMAIN_SECTIONS[path.basename(file)];
  const current = canonical === undefined ? readApplicationConfig({ root, env, configPath }) : canonical;
  if (current && section) return { value: current[section] === undefined ? null : structuredClone(current[section]), path: applicationConfigPath({ root, env, configPath }), canonical: true };
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')), path: file, canonical: false }; }
  catch (error) { if (error.code === 'ENOENT') return { value: null, path: file, canonical: false }; throw new Error('LEGACY_CONFIG_UNREADABLE'); }
}
export function resolveCapabilityInput(capability, { env = process.env, legacyPath } = {}) {
  if (env.PAPERECHO_APPLICATION_CONFIG && !env[capability === 'translation' ? 'TITLE_TRANSLATION_CONFIG_PATH' : 'PREFERENCE_LEARNING_CONFIG_PATH']) {
    legacyPath = path.join(path.dirname(env.PAPERECHO_APPLICATION_CONFIG), capability === 'translation' ? 'title_translation.config.json' : 'preference_learning.config.json');
  }
  const current = readApplicationConfig({ env, root: path.dirname(path.dirname(legacyPath)) });
  const invocation = env[capability === 'translation' ? 'PAPERECHO_INVOCATION_TRANSLATION_CONFIG' : 'PAPERECHO_INVOCATION_PREFERENCE_CONFIG'];
  if (!current && !invocation) return { ...readDomainConfig(legacyPath, { env, canonical: null }), env, configPath: legacyPath };
  const effectiveEnv = { ...env };
  // These are historical ordinary settings; secrets and execution intent remain separate.
  for (const key of Object.keys(effectiveEnv)) {
    if (/^(TITLE_TRANSLATION_|PREFERENCE_LEARNING_|TRANSLATION_API_)/.test(key) && !/API_KEY$/.test(key)) delete effectiveEnv[key];
  }
  if (invocation) {
    const loaded = readDomainConfig(path.resolve(invocation), { canonical: null, env: {} });
    if (!loaded.value) throw new Error('INVOCATION_CONFIG_UNREADABLE');
    assertNonSecret(loaded.value);
    return { ...loaded, env: effectiveEnv, configPath: path.resolve(invocation) };
  }
  return { value: structuredClone(current[capability] || {}), env: effectiveEnv, configPath: applicationConfigPath({ env }), canonical: true };
}
