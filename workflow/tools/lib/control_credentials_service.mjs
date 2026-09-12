export const CONTROL_SECRET_NAMES = Object.freeze([
  'TITLE_TRANSLATION_API_KEY', 'PREFERENCE_LEARNING_API_KEY', 'EASYSCHOLAR_SECRET_KEY', 'SMTP_PASS', 'ZOTERO_API_KEY',
]);

// No independent credential vault or unsafe .env writer. The existing injected
// environment remains the secret owner until a safe write contract is available.
export class SecretService {
  #env;
  constructor({ env = process.env } = {}) { this.#env = env; }
  list() { return CONTROL_SECRET_NAMES.map((id) => ({ id, configured: Boolean(this.#env[id]), writable: false, testAvailable: false })); }
  replace() { throw new Error('SECRET_WRITE_OWNER_UNAVAILABLE'); }
  clear() { throw new Error('SECRET_WRITE_OWNER_UNAVAILABLE'); }
  redact(value) {
    let text = String(value);
    for (const id of CONTROL_SECRET_NAMES) if (this.#env[id]) text = text.split(this.#env[id]).join('[REDACTED]');
    return text.replace(/(bearer\s+)[^\s,;]+/ig, '$1[REDACTED]');
  }
}
