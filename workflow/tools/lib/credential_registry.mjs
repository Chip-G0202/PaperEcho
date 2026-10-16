// One registry for editable credentials, trusted origins and output redaction.
export const CONTROL_SECRET_NAMES = Object.freeze([
  'TITLE_TRANSLATION_API_KEY', 'PREFERENCE_LEARNING_API_KEY', 'EASYSCHOLAR_SECRET_KEY', 'SEMANTIC_SCHOLAR_API_KEY',
  'SMTP_PASS', 'ZOTERO_API_KEY', 'QQ_BOT_APP_SECRET', 'WXPUSHER_APP_TOKEN', 'FEISHU_WEBHOOK_URL', 'FEISHU_SIGNING_SECRET', 'WECOM_WEBHOOK_URL',
]);
const origins = new WeakMap();
export function credentialOrigin(env, name) {
  return origins.get(env)?.get(name) || { kind: Object.hasOwn(env, name) ? 'external-managed' : 'unconfigured' };
}
export function markLocalCredential(env, name, file) {
  if (!origins.has(env)) origins.set(env, new Map());
  origins.get(env).set(name, { kind: 'local-managed', file });
}
export function copyEnvironment(env, overrides = {}) {
  const copy = { ...env, ...overrides };
  origins.set(copy, new Map(origins.get(env) || []));
  for (const key of Object.keys(overrides)) origins.get(copy).delete(key);
  return copy;
}
export function mapCredentialReference(target, source, name, reference) {
  if (!origins.has(target)) origins.set(target, new Map());
  origins.get(target).set(name, { ...credentialOrigin(source, reference), reference });
}
export function secretValues(env) {
  const names = new Set([...CONTROL_SECRET_NAMES, ...[...(origins.get(env)?.values() || [])].map(value => value.reference).filter(Boolean)]);
  return [...names].map(name => env[name]).filter(Boolean);
}
export function redactSecrets(value, secrets = []) {
  let text = String(value ?? '');
  const values = [...new Set(secrets)].map(String).filter(Boolean).sort((a, b) => b.length - a.length);
  // Complete values must all be removed before fingerprints can alter a match.
  for (const secret of values) text = text.split(secret).join('[REDACTED]');
  for (const secret of values) {
    // Providers sometimes log a prefix/suffix as a fingerprint; keep these out too.
    if (secret.length >= 12) for (const part of [secret.slice(0, 8), secret.slice(-8)]) text = text.split(part).join('[REDACTED]');
  }
  return text.replace(/(\b(?:Authorization|Proxy-Authorization)\s*[:=]\s*)(?:Basic|Bearer)?\s*[^\r\n"}]+/gi, '$1[REDACTED]')
    .replace(/("(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi, '$1"[REDACTED]"')
    .replace(/(\b(?:Cookie|Set-Cookie)\s*[:=]\s*)[^\r\n"}]+/gi, '$1[REDACTED]')
    .replace(/(\bbearer\s+)[^\s,;"}]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:[^=&\s"<>]*(?:key|token|secret|password|signature|credential|authorization)[^=&\s"<>]*)=)[^&\s"<>]*/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}
