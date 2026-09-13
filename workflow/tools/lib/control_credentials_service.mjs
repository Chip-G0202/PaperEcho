import fs from 'node:fs/promises';
import path from 'node:path';
import { parseEnvFile } from './env_file_bootstrap.mjs';
import { writeAtomicText, withAtomicJsonLock } from './atomic_json.mjs';

export const CONTROL_SECRET_NAMES = Object.freeze([
  'TITLE_TRANSLATION_API_KEY', 'PREFERENCE_LEARNING_API_KEY', 'EASYSCHOLAR_SECRET_KEY', 'SMTP_PASS', 'ZOTERO_API_KEY',
]);

// Editing supports a strict subset of the existing loader's single-line format.
// Unknown entries are preserved byte-for-byte; ambiguous files fail closed.
function inspect(text) {
  const entries = new Map();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || entries.has(match[1]) || /[\u0000-\u0008\u000b-\u001f]/.test(line)) throw new Error('CREDENTIAL_ENV_FORMAT_UNSUPPORTED');
    const value = match[2].trim();
    if (/^["']/.test(value) && !/^"[^"\r\n]*"$|^'[^'\r\n]*'$/.test(value)) throw new Error('CREDENTIAL_ENV_FORMAT_UNSUPPORTED');
    entries.set(match[1], index);
  }
  return { entries, values: parseEnvFile(text) };
}

export class SecretService {
  #env; #file; #seen = new Set(); #atomicOptions;
  constructor({ root, env = process.env, atomicOptions } = {}) {
    this.#env = env;
    this.#file = root ? path.join(path.resolve(root), '.env') : null;
    this.#atomicOptions = atomicOptions;
    this.#remember(env);
  }
  #remember(values) { for (const id of CONTROL_SECRET_NAMES) if (values[id]) this.#seen.add(values[id]); }
  async #read() {
    if (!this.#file) throw new Error('SECRET_WRITE_OWNER_UNAVAILABLE');
    const parent = await fs.lstat(path.dirname(this.#file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('CREDENTIAL_ENV_PATH_UNSAFE');
    try {
      const stat = await fs.lstat(this.#file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('CREDENTIAL_ENV_PATH_UNSAFE');
      const text = await fs.readFile(this.#file, 'utf8');
      const parsed = inspect(text);
      this.#remember(parsed.values);
      return { text, ...parsed };
    } catch (error) { if (error.code === 'ENOENT') return { text: '', ...inspect('') }; throw error; }
  }
  async list() {
    let state; let reason;
    try { state = await this.#read(); } catch { reason = '本地凭据文件不可安全编辑；请通过现有环境配置入口检查格式和权限。'; }
    return CONTROL_SECRET_NAMES.map((id) => {
      const external = state && this.#env[id] !== undefined && this.#env[id] !== state.values[id];
      return { id, configured: Boolean(this.#env[id] ?? state?.values[id]), writable: Boolean(state) && !external, testAvailable: false,
        reason: external ? '外部环境变量覆盖本地配置；请在原注入入口维护并重启。' : reason || '', reload: '当前 Control Center 和下一次 workflow 生效；已运行的进程需重启。' };
    });
  }
  replace(id, value) { return this.#write(id, value, false); }
  clear(id) { return this.#write(id, '', true); }
  async #write(id, value, clear) {
    if (!CONTROL_SECRET_NAMES.includes(id)) throw new Error('CREDENTIAL_KEY_NOT_ALLOWED');
    if (typeof value !== 'string' || (!clear && !value.length) || value.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(value) || (value.includes('"') && value.includes("'"))) throw new Error('CREDENTIAL_VALUE_INVALID');
    if (!this.#file) throw new Error('SECRET_WRITE_OWNER_UNAVAILABLE');
    try {
      return await withAtomicJsonLock(this.#file, async () => {
        const before = await this.#read();
        if (this.#env[id] !== undefined && this.#env[id] !== before.values[id]) throw new Error('CREDENTIAL_EXTERNALLY_MANAGED');
        const quote = value.includes('"') ? "'" : '"';
        const entry = `${id}=${quote}${value}${quote}`;
        const lines = before.text.split(/(?<=\n)/);
        const index = before.entries.get(id);
        if (index !== undefined) lines[index] = entry + (lines[index].endsWith('\r\n') ? '\r\n' : lines[index].endsWith('\n') ? '\n' : '');
        else lines.push((before.text && !before.text.endsWith('\n') ? '\n' : '') + entry + (before.text.includes('\r\n') ? '\r\n' : '\n'));
        const next = lines.join('');
        if (Buffer.byteLength(next, 'utf8') > 65536) throw new Error('CREDENTIAL_ENV_FORMAT_UNSUPPORTED');
        const parsed = inspect(next);
        if (parsed.values[id] !== value) throw new Error('CREDENTIAL_VALUE_INVALID');
        for (const key of Object.keys(before.values)) if (key !== id && parsed.values[key] !== before.values[key]) throw new Error('CREDENTIAL_ENV_FORMAT_UNSUPPORTED');
        // No backup containing credentials; temp files have restrictive POSIX mode.
        await writeAtomicText(this.#file, next, { fsApi: { ...fs, open: (file, flags) => fs.open(file, flags, 0o600) }, ...this.#atomicOptions });
        this.#seen.add(value);
        this.#env[id] = value;
        return { id, configured: Boolean(value), status: clear ? 'cleared' : 'replaced' };
      });
    } catch (error) {
      const allowed = ['CREDENTIAL_EXTERNALLY_MANAGED', 'CREDENTIAL_ENV_FORMAT_UNSUPPORTED', 'CREDENTIAL_ENV_PATH_UNSAFE', 'CREDENTIAL_VALUE_INVALID'];
      throw new Error(allowed.includes(error.message) ? error.message : 'CREDENTIAL_WRITE_FAILED');
    }
  }
  redact(value) {
    this.#remember(this.#env);
    let text = String(value);
    for (const secret of [...this.#seen].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text.replace(/(bearer\s+)[^\s,;]+/ig, '$1[REDACTED]');
  }
}
