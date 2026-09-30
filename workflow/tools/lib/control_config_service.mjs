import fs from 'node:fs/promises';
import path from 'node:path';
import { writeAtomicJson, withAtomicJsonLock } from './atomic_json.mjs';
import { validateRunnerConfigObject } from '../runner/config_loader.mjs';
import { buildPubMedQueryFromKeywordGroups } from './literature_config.mjs';
import { readApplicationConfig, applicationConfigPath, DOMAIN_SECTIONS } from './application_config.mjs';
import { migrateApplicationConfig, upgradeNotificationConfig, upgradeNotificationChannelsConfig } from './application_config_migration.mjs';
import { isValidSmtpHost } from '../stage5/email_sender.mjs';

const INITIAL_OWNER_VALUES = Object.freeze({
  'title_translation.config.json': { enabled: true },
  'preference_learning.config.json': {},
  'review-workflow-rules.json': { llm_review: { enabled: false, grade_review_enabled: false, preference_learning_enabled: false } },
});

const OWNER_PATH_ENV = Object.freeze({
  'title_translation.config.json': 'TITLE_TRANSLATION_CONFIG_PATH',
  'preference_learning.config.json': 'PREFERENCE_LEARNING_CONFIG_PATH',
});

const definitions = [];
function setting(id, category, file, key, type, description, validation = {}) {
  definitions.push({ id, category, file, key, type, description, validation, secret: false, advanced: category === 'Advanced', reload: 'next_run' });
}
setting('preference.enabled', 'Models', 'review-workflow-rules.json', 'llm_review.preference_learning_enabled', 'boolean', '启用偏好学习');
setting('review.master', 'Models', 'review-workflow-rules.json', 'llm_review.enabled', 'boolean', '启用智能评审总开关');
setting('translation.enabled', 'Models', 'title_translation.config.json', 'enabled', 'boolean', '启用标题翻译');
for (const [capability, file] of [['translation', 'title_translation.config.json'], ['preference', 'preference_learning.config.json']]) {
  setting(`${capability}.model`, 'Models', file, 'model', 'string', `${capability} 模型名称`, { maxLength: 200 });
  setting(`${capability}.endpoint`, 'Models', file, 'endpoint', 'url', `${capability} API 地址`);
  setting(`${capability}.temperature`, 'Models', file, 'temperature', 'number', '采样温度', { min: 0, max: 2 });
  setting(`${capability}.timeout`, 'Advanced', file, 'timeout_ms', 'integer', '请求超时（毫秒）', { min: 1000, max: 600000 });
}
setting('sources.domain', 'Sources', 'source_selection.json', 'research_domain', 'enum', '研究领域', { values: ['biomedical', 'non_biomedical_stem', 'education_social_science', 'mixed_biomedical_technical', 'unknown'] });
setting('sources.override', 'Sources', 'source_selection.json', 'override_enabled_sources', 'list', '显式检索源', { values: ['rss', 'pubmed_pmc', 'openalex', 'semantic_scholar'] });
for (const group of ['required', 'optional', 'negative']) setting(`pubmed.${group}`, 'Search', 'pubmed_pmc_search.json', `keyword_groups.${group}`, 'keywords', `${group} 检索词（修改后由现有 owner 生成检索式）`);
for (const name of ['pubmed', 'openalex']) {
  const file = name === 'pubmed' ? 'pubmed_pmc_search.json' : 'openalex_search.json';
  setting(`${name}.query`, 'Search', file, 'query', 'string', `${name} 检索式`, { maxLength: 10000 });
  setting(`${name}.days`, 'Search', file, 'days_back', 'integer', '检索天数', { min: 1, max: 366 });
}
setting('pubmed.limit', 'Search', 'pubmed_pmc_search.json', 'retmax', 'integer', '最大记录数', { min: 1, max: 10000 });
setting('openalex.enabled', 'Search', 'openalex_search.json', 'enabled', 'boolean', '启用 OpenAlex');
setting('openalex.page_size', 'Search', 'openalex_search.json', 'per_page', 'integer', '每页记录数', { min: 1, max: 200 });
setting('rss.sources', 'RSS', 'rss_sources.json', 'sources', 'rss', 'RSS 来源列表');
for (const [id, key, type, description, validation] of [
  ['review.enabled', 'llm_review.grade_review_enabled', 'boolean', '启用等级复审'],
  ['review.batch', 'llm_review.batch_size', 'integer', '复审批大小', { min: 1, max: 200 }],
  ['feedback.enabled', 'feedback_learning.enabled', 'boolean', '启用反馈学习'],
]) setting(id, 'Ranking / Review', 'review-workflow-rules.json', key, type, description, validation);
for (const [id, category, key, type, description, validation] of [
  ['general.profile', 'General', 'profile', 'enum', '运行配置', { values: ['standard', 'complete', 'radar'] }],
  ['radar.enabled', 'Radar', 'common.radar.enabled', 'boolean', '启用 Daily Radar'],
  ['integrity.enabled', 'Integrity', 'common.integrity.enabled', 'boolean', '监测撤稿与更正状态'],
  ['email.enabled', 'Notifications', 'common.email.enabled', 'boolean', '启用邮箱通知'],
  ['qq.enabled', 'Notifications', 'common.notifications.channels.qq.enabled', 'boolean', '启用 QQ 通知'],
  ['qq.appId', 'Notifications', 'common.notifications.channels.qq.appId', 'string', '机器人 AppID', { maxLength: 200 }],
  ['qq.targetType', 'Notifications', 'common.notifications.channels.qq.targetType', 'enum', '发送目标类型', { values: ['user', 'group'] }],
  ['qq.targetId', 'Notifications', 'common.notifications.channels.qq.targetId', 'string', '目标 OpenID', { maxLength: 200 }],
  ['email.recipient', 'Notifications', 'common.email.recipient', 'email', '收件人'],
  ['smtp.host', 'Notifications', 'common.email.smtp.host', 'string', 'SMTP 主机', { maxLength: 253 }],
  ['smtp.port', 'Notifications', 'common.email.smtp.port', 'integer', 'SMTP 端口', { min: 1, max: 65535 }],
  ['smtp.secure', 'Notifications', 'common.email.smtp.secure', 'boolean', 'SMTP TLS'],
  ['smtp.user', 'Notifications', 'common.email.smtp.user', 'string', 'SMTP 用户名', { maxLength: 254 }],
  ['smtp.from', 'Notifications', 'common.email.smtp.from', 'email', '发件人（默认使用登录邮箱）'],
  ['notification.radar', 'Notifications', 'common.notifications.radar.enabled', 'boolean', 'Daily Radar 推荐通知'],
  ['notification.weekly', 'Notifications', 'common.notifications.weekly.enabled', 'boolean', '周报完成通知'],
  ['notification.failure', 'Notifications', 'common.notifications.failure.enabled', 'boolean', '运行失败时通知'],
  ['notification.health', 'Notifications', 'common.notifications.health.enabled', 'boolean', '运行健康状态提醒'],
  ['runtime.mode', 'Runtime', 'mode', 'enum', '运行路径', { values: ['local', 'desktop', 'web'] }],
  ['runtime.projectRoot', 'Runtime', 'common.projectRoot', 'string', '项目根目录', { maxLength: 2000 }],
  ['local.input', 'Runtime', 'local.input', 'string', '本地输入目录', { maxLength: 2000 }],
  ['local.output', 'Runtime', 'local.outputRoot', 'string', '本地输出目录', { maxLength: 2000 }],
  ['local.feedback', 'Runtime', 'local.feedback', 'string', '本地反馈目录', { maxLength: 2000 }],
  ['desktop.zoteroExe', 'Runtime', 'desktop.zoteroExe', 'string', 'Zotero Desktop 程序路径', { maxLength: 2000 }],
  ['web.userId', 'Runtime', 'web.userId', 'string', 'Zotero User ID', { pattern: '^\\d+$' }],
  ['web.apiBase', 'Advanced', 'web.apiBase', 'url', 'Zotero Web API 地址（测试/开发覆盖）'],
  ['zotero.user', 'Zotero', 'web.userId', 'string', 'Zotero Web 用户 ID', { pattern: '^\\d+$' }],
  ['zotero.batch', 'Zotero', 'desktop.writebackBatchSize', 'integer', 'Zotero 写入批大小', { min: 1, max: 50 }],
]) setting(id, category, 'paperecho.config.json', key, type, description, validation);
export const CONFIG_REGISTRY = Object.freeze(definitions);
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function put(object, key, value) {
  const parts = key.split('.');
  const last = parts.pop();
  let owner = object;
  for (const part of parts) { owner[part] ??= {}; owner = owner[part]; }
  owner[last] = value;
}
export function validateSetting(definition, value) {
  const { type, validation: rules } = definition;
  const fail = () => { throw new Error('SETTING_VALUE_INVALID'); };
  if (definition.id === 'smtp.host' && !isValidSmtpHost(value)) fail();
  if (type === 'boolean' && typeof value !== 'boolean') fail();
  if (['number', 'integer'].includes(type) && (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)) || value < rules.min || value > rules.max)) fail();
  if (['string', 'url', 'email', 'enum'].includes(type)) {
    if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f]/.test(value) || value.length > (rules.maxLength || 2000)) fail();
    if (rules.pattern && !new RegExp(rules.pattern).test(value)) fail();
    if (type === 'enum' && !rules.values.includes(value)) fail();
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail();
    if (type === 'url') {
      let url;
      try { url = new URL(value); } catch { fail(); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail();
    }
  }
  if (type === 'list' && (!Array.isArray(value) || value.some((entry) => !rules.values.includes(entry)) || new Set(value).size !== value.length)) fail();
  if (type === 'keywords') {
    if (!Array.isArray(value) || value.length > 200) fail();
    for (const term of value.flat()) if (typeof term !== 'string' || !term.trim() || term.length > 500 || /[\r\n\u0000]/.test(term)) fail();
    if (value.some((term) => Array.isArray(term) && term.some(Array.isArray))) fail();
  }
  if (type === 'rss') {
    if (!Array.isArray(value) || value.length > 500) fail();
    for (const source of value) {
      if (!source || Object.keys(source).some((key) => !['name', 'url', 'enabled'].includes(key))) fail();
      validateSetting({ type: 'string', validation: { maxLength: 200 } }, source.name);
      validateSetting({ type: 'url', validation: {} }, source.url);
      if (typeof source.enabled !== 'boolean') fail();
    }
    if (new Set(value.map((entry) => entry.url)).size !== value.length) fail();
  }
}
export class ConfigService {
  constructor({ root, env = process.env, atomicOptions, verify = async () => {}, configPath, runtimeMode = '' }) { Object.assign(this, { root, env, atomicOptions, verify, configPath, runtimeMode }); }
  ownerPath(file) {
    if (file === 'paperecho.config.json' && this.configPath) return this.configPath;
    const envName = OWNER_PATH_ENV[file];
    if (envName && String(this.env[envName] || '').trim()) return path.resolve(this.root, this.env[envName]);
    return path.join(this.root, 'config', file);
  }
  async readOwner(file) {
    // Fixed registry owns paths; callers cannot choose arbitrary files.
    const canonical = readApplicationConfig({ root: this.root, env: this.env, configPath: this.configPath });
    if (canonical) return file === 'paperecho.config.json' ? canonical : structuredClone(canonical[DOMAIN_SECTIONS[file]] || {});
    return JSON.parse(await fs.readFile(this.ownerPath(file), 'utf8'));
  }
  async readOwnerOrTemplate(file) {
    try { return { value: await this.readOwner(file), present: true }; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (file === 'paperecho.config.json') return { value: JSON.parse(await fs.readFile(path.join(this.root, 'config', 'paperecho.config.example.json'), 'utf8')), present: false };
      if (Object.hasOwn(INITIAL_OWNER_VALUES, file)) return { value: structuredClone(INITIAL_OWNER_VALUES[file]), present: false };
      throw error;
    }
  }
  async list() {
    const result = [];
    const owners = new Map();
    for (const definition of CONFIG_REGISTRY) {
      let value = null;
      let available = true;
      let ownerPresent = true;
      try {
        if (!owners.has(definition.file)) owners.set(definition.file, await this.readOwnerOrTemplate(definition.file));
        const owner = owners.get(definition.file);
        value = get(owner.value, definition.key) ?? (['translation.enabled', 'notification.radar', 'notification.weekly'].includes(definition.id) ? true : null);
        // Show the existing SMTP transport defaults so saving the form preserves TLS.
        if (definition.id === 'smtp.port' && value == null) value = 465;
        if (definition.id === 'smtp.secure' && value == null) value = Number(owner.value.common?.email?.smtp?.port ?? 465) === 465;
        if (definition.id === 'email.enabled' && value == null) value = true;
        if (definition.id === 'qq.enabled' && value == null) value = false;
        ownerPresent = owner.present;
      }
      catch (error) { if (error.code !== 'ENOENT') throw error; available = false; }
      const { file, key, ...publicDefinition } = definition;
      result.push({ ...publicDefinition, value, available, ownerPresent, effectiveValue: definition.id === 'runtime.mode' ? this.runtimeMode || value : undefined });
    }
    result.push({ id: 'weekly.interval', category: 'Weekly', type: 'integer', value: Number(owners.get('paperecho.config.json')?.value?.weekly?.intervalDays || this.env.review_results_RUN_INTERVAL_DAYS || 7), default: 7, available: true, readOnly: true, description: '默认 7 天；由调度配置管理', validation: { min: 1 }, secret: false, advanced: true, reload: 'scheduler' });
    return result;
  }
  async update(id, value) {
    const result = await this.updateMany([{ id, value }]);
    return result.results[0];
  }
  async updateMany(updates) {
    if (!Array.isArray(updates) || updates.length < 1 || updates.length > 50) throw new Error('SETTING_BATCH_INVALID');
    if (new Set(updates.map((entry) => entry?.id)).size !== updates.length) throw new Error('SETTING_BATCH_INVALID');
    if (updates.some((entry) => !entry || Object.keys(entry).some((key) => !['id', 'value'].includes(key)))) throw new Error('SETTING_BATCH_INVALID');
    const resolved = updates.map(({ id, value }) => {
      // Legacy UI alias was the very same channel flag; never a second owner.
      if (id === 'weekly.email') id = 'email.enabled';
      const definition = CONFIG_REGISTRY.find((entry) => entry.id === id);
      if (!definition) throw new Error('SETTING_UNKNOWN');
      validateSetting(definition, value);
      return { id, value, definition };
    });
    if (new Set(resolved.map((entry) => entry.id)).size !== resolved.length) throw new Error('SETTING_BATCH_INVALID');
    const ownerFiles = [...new Set(resolved.map((entry) => entry.definition.file))].sort();
    const notificationEdit = resolved.some(({ id }) => /^(email\.|smtp\.|notification\.|qq\.)/.test(id));
    const qqEdit = resolved.some(({ id }) => id.startsWith('qq.'));
    if (notificationEdit && !readApplicationConfig({ root: this.root, env: this.env, configPath: this.configPath })) {
      await migrateApplicationConfig({ root: this.root, env: this.env, configPath: this.configPath, atomicOptions: this.atomicOptions });
    }
    if (readApplicationConfig({ root: this.root, env: this.env, configPath: this.configPath })) {
      const target = applicationConfigPath({ root: this.root, env: this.env, configPath: this.configPath });
      return withAtomicJsonLock(target, async () => {
        const current = readApplicationConfig({ root: this.root, env: this.env, configPath: target });
        const candidate = qqEdit ? upgradeNotificationChannelsConfig(current) : notificationEdit ? upgradeNotificationConfig(current) : current;
        for (const { id, value, definition } of resolved) {
          const section = DOMAIN_SECTIONS[definition.file];
          const owner = section ? (candidate[section] ||= {}) : candidate;
          if (id === 'pubmed.query' && owner.keyword_groups) throw new Error('SEARCH_KEYWORD_OWNER_REQUIRED');
          put(owner, definition.key, value);
          if (definition.key.startsWith('keyword_groups.')) owner.query = buildPubMedQueryFromKeywordGroups(owner.keyword_groups);
          await this.verify(owner, definition);
        }
        validateRunnerConfigObject(candidate);
        await writeAtomicJson(target, candidate, { ...this.atomicOptions, validateTemporary: async (temporary) => {
          const readback = JSON.parse(await fs.readFile(temporary, 'utf8'));
          validateRunnerConfigObject(readback);
          if (JSON.stringify(readback) !== JSON.stringify(candidate)) throw new Error('SETTING_VERIFY_FAILED');
          for (const { definition } of resolved) await this.verify(DOMAIN_SECTIONS[definition.file] ? readback[DOMAIN_SECTIONS[definition.file]] : readback, definition);
          await this.atomicOptions?.validateTemporary?.(temporary);
        } });
        return { saved: true, results: resolved.map(({ id, definition }) => ({ id, saved: true, reload: definition.reload })) };
      });
    }
    const withLocks = (index, operation) => index >= ownerFiles.length
      ? operation()
      : withAtomicJsonLock(this.ownerPath(ownerFiles[index]), () => withLocks(index + 1, operation));
    return withLocks(0, async () => {
      const before = new Map(); const after = new Map(); const missingBefore = new Set();
      for (const file of ownerFiles) {
        const owner = await this.readOwnerOrTemplate(file);
        if (!owner.present) missingBefore.add(file);
        before.set(file, owner.value); after.set(file, structuredClone(owner.value));
      }
      for (const { id, value, definition } of resolved) {
        const owner = after.get(definition.file);
        put(owner, definition.key, value);
        if (id === 'pubmed.query' && owner.keyword_groups) throw new Error('SEARCH_KEYWORD_OWNER_REQUIRED');
        if (definition.key.startsWith('keyword_groups.')) owner.query = buildPubMedQueryFromKeywordGroups(owner.keyword_groups);
      }
      for (const file of ownerFiles) {
        if (file === 'paperecho.config.json') validateRunnerConfigObject(after.get(file));
        for (const { definition } of resolved.filter((entry) => entry.definition.file === file)) await this.verify(after.get(file), definition);
      }
      try {
        for (const file of ownerFiles) await writeAtomicJson(this.ownerPath(file), after.get(file), this.atomicOptions);
        for (const file of ownerFiles) {
          const reloaded = await this.readOwner(file);
          for (const { value, definition } of resolved.filter((entry) => entry.definition.file === file)) {
            if (JSON.stringify(get(reloaded, definition.key)) !== JSON.stringify(value)) throw new Error('SETTING_VERIFY_FAILED');
            await this.verify(reloaded, definition);
          }
        }
      } catch (error) {
        for (const file of ownerFiles) {
          if (missingBefore.has(file)) await fs.rm(this.ownerPath(file), { force: true });
          else await writeAtomicJson(this.ownerPath(file), before.get(file));
        }
        throw error;
      }
      return { saved: true, results: resolved.map(({ id, definition }) => ({ id, saved: true, reload: definition.reload })) };
    });
  }
}
