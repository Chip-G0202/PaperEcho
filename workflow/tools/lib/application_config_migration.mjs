import fs from 'node:fs/promises';
import path from 'node:path';
import { DOMAIN_SECTIONS, assertNonSecret, applicationConfigPath } from './application_config.mjs';
import { validateRunnerConfigObject } from '../runner/config_loader.mjs';
import { getTranslationConfig } from './title_translation_support.mjs';
import { getPreferenceLearningConfig } from './preference_learning_support.mjs';
import { writeAtomicJson, withAtomicJsonLock } from './atomic_json.mjs';
import { parseEnvFile } from './env_file_parser.mjs';

async function read(file, fallback = null) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error('CONFIG_MIGRATION_SOURCE_UNREADABLE'); }
}
export async function migrateApplicationConfig({ root, env = {}, configPath, atomicOptions = {}, now = () => new Date() } = {}) {
  const target = applicationConfigPath({ root, env: {}, configPath });
  return withAtomicJsonLock(target, async () => {
    const old = await read(target);
    if (old) validateRunnerConfigObject(old);
    if (old?.schemaVersion === 3) return { migrated: false, schemaVersion: 3 };
    let localEnv = {};
    try { localEnv = parseEnvFile(await fs.readFile(path.join(root, '.env'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('CONFIG_MIGRATION_ENV_UNREADABLE'); }
    env = { ...localEnv, ...env };
    const candidate = structuredClone(old || { schemaVersion: 2 });
    const base = path.dirname(target);
    const sources = [];
    const legacyEnv = { ...env, PAPERECHO_APPLICATION_CONFIG: target };
    delete legacyEnv.PAPERECHO_INVOCATION_PREFERENCE_CONFIG;
    delete legacyEnv.PAPERECHO_INVOCATION_TRANSLATION_CONFIG;
    for (const [file, section] of Object.entries(DOMAIN_SECTIONS)) {
      const custom = section === 'preference' ? old?.common?.llm?.preferenceConfig : section === 'translation' ? old?.common?.llm?.translationConfig : '';
      const envPath = section === 'preference' ? env.PREFERENCE_LEARNING_CONFIG_PATH : section === 'translation' ? env.TITLE_TRANSLATION_CONFIG_PATH : '';
      const input = custom ? path.resolve(base, custom) : envPath ? path.resolve(envPath) : path.join(root, 'config', file);
      let value = await read(input);
      if (value === null && (custom || envPath)) throw new Error('CONFIG_MIGRATION_CUSTOM_SOURCE_MISSING');
      if (value !== null) { assertNonSecret(value); sources.push(section); }
      if (section === 'rss' && Array.isArray(value)) value = { sources: value };
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('CONFIG_MIGRATION_SOURCE_INVALID');
      if (value !== null || ['translation', 'preference'].includes(section)) candidate[section] = value || {};
      if (section === 'preference') legacyEnv.PREFERENCE_LEARNING_CONFIG_PATH = input;
      if (section === 'translation') legacyEnv.TITLE_TRANSLATION_CONFIG_PATH = input;
    }
    // Reuse the v2 domain resolvers to retain coercions, fallback order and prompt path semantics.
    const translation = getTranslationConfig({ env: legacyEnv });
    const { apiKeyConfigured, cachePath, batchSize, ...translationValues } = translation;
    candidate.translation = { ...candidate.translation, ...translationValues, batch_size: batchSize };
    const preference = getPreferenceLearningConfig({ env: legacyEnv });
    const preferenceFields = ['endpoint', 'model', 'temperature', 'top_p', 'stream', 'thinking', 'timeout_ms', 'max_retries', 'max_output_tokens', 'user_id', 'response_format', 'api_key_env_fallback_order'];
    for (const field of preferenceFields) candidate.preference[field] = preference[field];
    candidate.preference.prompt_file = preference.promptFile;
    candidate.common ||= {};
    if (candidate.common.llm) {
      delete candidate.common.llm.preferenceConfig;
      delete candidate.common.llm.translationConfig;
    }
    // Non-secret legacy SMTP is a migration input, not a permanent override.
    candidate.common.email ||= {};
    candidate.common.email.smtp ||= {};
    const smtp = candidate.common.email.smtp;
    for (const [field, key] of Object.entries({ host: 'SMTP_HOST', user: 'SMTP_USER', from: 'SMTP_FROM' })) if (smtp[field] == null && env[key]) smtp[field] = env[key];
    if (smtp.port == null && env.SMTP_PORT) smtp.port = Number(env.SMTP_PORT);
    if (smtp.secure == null && env.SMTP_SECURE) {
      if (!/^(true|false|1|0|yes|no|on|off)$/i.test(env.SMTP_SECURE)) throw new Error('CONFIG_MIGRATION_SMTP_INVALID');
      smtp.secure = /^(true|1|yes|on)$/i.test(env.SMTP_SECURE);
    }
    if (candidate.common.email.recipient == null && (env.PAPERFLOW_REPORT_TO || env.NOTIFICATION_EMAIL)) candidate.common.email.recipient = env.PAPERFLOW_REPORT_TO || env.NOTIFICATION_EMAIL;
    candidate.weekly = { intervalDays: Number(env.review_results_RUN_INTERVAL_DAYS || 7) };
    if (!candidate.common.projectRoot && env.ZOTERO_PROJECT_ROOT) candidate.common.projectRoot = path.resolve(env.ZOTERO_PROJECT_ROOT);
    if (!candidate.desktop?.zoteroExe && env.ZOTERO_EXE) { candidate.desktop ||= {}; candidate.desktop.zoteroExe = path.resolve(env.ZOTERO_EXE); }
    for (const [field, key] of Object.entries({ writebackBatchSize: 'ZOTERO_CLI_WRITEBACK_BATCH_SIZE', startupRetries: 'WORKFLOW_STARTUP_ZOTERO_BACKEND_RETRIES', startupIntervalMs: 'WORKFLOW_STARTUP_ZOTERO_BACKEND_INTERVAL_MS', postStartDelayMs: 'WORKFLOW_STARTUP_ZOTERO_POST_START_DELAY_MS' })) {
      if (candidate.desktop?.[field] == null && env[key]) { candidate.desktop ||= {}; candidate.desktop[field] = Number(env[key]); }
    }
    if (env.PAPERFLOW_CLEANUP_ENABLED || env.PAPERFLOW_RETENTION_DAYS) {
      candidate.common.cleanup ||= {};
      if (candidate.common.cleanup.enabled == null && env.PAPERFLOW_CLEANUP_ENABLED) candidate.common.cleanup.enabled = !/^(false|0|no|off)$/i.test(env.PAPERFLOW_CLEANUP_ENABLED);
      if (candidate.common.cleanup.retentionDays == null && env.PAPERFLOW_RETENTION_DAYS) candidate.common.cleanup.retentionDays = Number(env.PAPERFLOW_RETENTION_DAYS);
    }
    candidate.schemaVersion = 3;
    candidate.migration = { fromSchema: old?.schemaVersion || 0, toSchema: 3, success: true, sourceKinds: sources, timestamp: now().toISOString() };
    validateRunnerConfigObject(candidate);
    // The original unified config is retained separately; domain files are never rewritten.
    if (old) {
      const backup = `${target}.legacy-backup`;
      const existing = await read(backup);
      if (existing && JSON.stringify(existing) !== JSON.stringify(old)) throw new Error('CONFIG_MIGRATION_BACKUP_CONFLICT');
      if (!existing) await writeAtomicJson(backup, old);
    }
    await writeAtomicJson(target, candidate, { ...atomicOptions, validateTemporary: async (temporary) => {
      const reloaded = await read(temporary);
      validateRunnerConfigObject(reloaded);
      if (JSON.stringify(reloaded) !== JSON.stringify(candidate)) throw new Error('CONFIG_MIGRATION_READBACK_FAILED');
      await atomicOptions.validateTemporary?.(temporary);
    } });
    return { migrated: true, schemaVersion: 3, metadata: candidate.migration };
  });
}
