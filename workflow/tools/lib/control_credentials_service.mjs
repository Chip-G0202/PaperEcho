import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnvFile } from './env_file_parser.mjs';
import { writeAtomicText, withAtomicJsonLock, renameWithTransientRetry } from './atomic_json.mjs';
import { CONTROL_SECRET_NAMES, credentialOrigin, markLocalCredential, redactSecrets, secretValues } from './credential_registry.mjs';
import { secureCredentialFile } from './credential_file_security.mjs';
import { resolveRuntimePaths, assertRuntimeDataPath } from './runtime_config.mjs';
export { CONTROL_SECRET_NAMES } from './credential_registry.mjs';

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
    const paths = resolveRuntimePaths({ applicationRoot: root, env });
    if (paths.layout !== 'dev') root = paths.userDataRoot;
    this.#env = env;
    this.#file = root ? path.join(path.resolve(root), '.env') : null;
    if (this.#file) assertRuntimeDataPath(paths, this.#file);
    this.#atomicOptions = atomicOptions;
    this.#remember(env);
  }
  #remember(values) { for (const value of secretValues(values)) this.#seen.add(value); }
  async #read() {
    if (!this.#file) throw new Error('SECRET_WRITE_OWNER_UNAVAILABLE');
    for (let dir = path.dirname(this.#file); ; dir = path.dirname(dir)) {
      const parent = await fs.lstat(dir);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('CREDENTIAL_ENV_PATH_UNSAFE');
      if (dir === path.dirname(dir)) break;
    }
    try {
      const stat = await fs.lstat(this.#file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('CREDENTIAL_ENV_PATH_UNSAFE');
      const text = await fs.readFile(this.#file, 'utf8');
      const parsed = inspect(text);
      this.#remember(parsed.values);
      return { text, exists: true, ...parsed };
    } catch (error) { if (error.code === 'ENOENT') return { text: '', ...inspect('') }; throw error; }
  }
  async list() {
    let state; let reason;
    try { state = await this.#read(); } catch { reason = '本地凭据文件不可安全编辑；请通过现有环境配置入口检查格式和权限。'; }
    return CONTROL_SECRET_NAMES.map((id) => {
      const origin = this.#origin(id, state);
      return { id, configured: Boolean(this.#value(id, state)), storageClass: origin.kind, writable: Boolean(state) && origin.writable, testAvailable: false,
        reason: reason || origin.reason || '', reload: '已保存到本地；当前凭据服务读取新值。新 workflow 启动时加载；已运行的进程需重启，外部环境仍优先。' };
    });
  }
  #origin(id, state) {
    const origin = credentialOrigin(this.#env, id);
    if (origin.reference && origin.reference !== id) return { kind: origin.kind, writable: false, reason: '凭据由自定义环境引用管理，请在原配置入口维护。' };
    if (origin.kind === 'external-managed') return { ...origin, writable: false, reason: '由外部环境管理；请在原注入入口维护并重启。' };
    if (origin.kind === 'local-managed' && path.resolve(origin.file).toLowerCase() !== this.#file?.toLowerCase()) return { kind: 'unknown', writable: false, reason: '无法确认凭据来源，请在原配置入口检查。' };
    return { kind: state ? (state.values[id] ? 'local-managed' : 'unconfigured') : 'unknown', writable: Boolean(state) };
  }
  #value(id, state) {
    const origin = credentialOrigin(this.#env, id);
    return origin.kind === 'local-managed' && (!origin.reference || origin.reference === id) ? state?.values[id] : this.#env[id] ?? state?.values[id];
  }
  replace(id, value) { return this.#write(id, value, false); }
  clear(id) { return this.#write(id, '', true); }
  async smtpStatus(passwordEnv = 'SMTP_PASS') {
    if (passwordEnv === 'SMTP_PASS') return (await this.list()).find((entry) => entry.id === 'SMTP_PASS');
    const state = await this.#read().catch(() => null);
    return { id: 'SMTP_PASS', configured: Boolean(this.#env[passwordEnv] ?? state?.values[passwordEnv]), storageClass: credentialOrigin(this.#env, passwordEnv).kind, writable: false, reason: '密码由自定义环境引用管理，请在原配置入口维护。' };
  }
  // Only the application service receives this environment; HTTP never exposes it.
  async withSmtpEnvironment(smtp, operation) {
    const state = await this.#read().catch(() => null);
    const passwordEnv = smtp.passwordEnv || 'SMTP_PASS';
    const password = this.#value(passwordEnv, state) ?? '';
    if (password) this.#seen.add(password);
    const env = { SMTP_PASS: password };
    for (const [field, key] of Object.entries({ host: 'SMTP_HOST', user: 'SMTP_USER', from: 'SMTP_FROM', port: 'SMTP_PORT', secure: 'SMTP_SECURE' })) {
      if (smtp[field] != null) env[key] = String(smtp[field]);
    }
    return operation(env);
  }
  async withCredential(id, operation) {
    if (!CONTROL_SECRET_NAMES.includes(id)) throw new Error('CREDENTIAL_KEY_NOT_ALLOWED');
    const state = await this.#read().catch(() => null);
    const secret = this.#value(id, state) ?? '';
    if (secret) this.#seen.add(secret);
    return operation(secret);
  }
  async #write(id, value, clear) {
    if (!CONTROL_SECRET_NAMES.includes(id)) throw new Error('CREDENTIAL_KEY_NOT_ALLOWED');
    if (typeof value !== 'string' || (!clear && !value.length) || value.length > 4096 || /[\r\n\u0000-\u001f\u007f]/.test(value) || (value.includes('"') && value.includes("'"))) throw new Error('CREDENTIAL_VALUE_INVALID');
    if (!this.#file) throw new Error('SECRET_WRITE_OWNER_UNAVAILABLE');
    try {
      return await withAtomicJsonLock(this.#file, async () => {
        const before = await this.#read();
        if (!this.#origin(id, before).writable) throw new Error('CREDENTIAL_EXTERNALLY_MANAGED');
        this.#seen.add(value);
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
        await this.#save(next, before);
        this.#seen.add(value);
        this.#env[id] = value;
        markLocalCredential(this.#env, id, this.#file);
        return { id, configured: Boolean(value), storageClass: value ? 'local-managed' : 'unconfigured', status: clear ? 'cleared' : 'replaced', savedToFile: true, currentServiceUpdated: true, workflowEffect: 'on-next-start-unless-externally-overridden' };
      // Native ACL checks can exceed the shared 5s default; waiting remains bounded.
      }, { timeoutMs: 15000, staleMs: Infinity }); // Never steal a credential lock from a slow live writer.
    } catch (error) {
      const allowed = ['CREDENTIAL_EXTERNALLY_MANAGED', 'CREDENTIAL_ENV_FORMAT_UNSUPPORTED', 'CREDENTIAL_ENV_PATH_UNSAFE', 'CREDENTIAL_VALUE_INVALID', 'CREDENTIAL_ACL_UNSAFE', 'CREDENTIAL_CONCURRENT_CHANGE', 'CREDENTIAL_RECOVERY_REQUIRED'];
      throw new Error(allowed.includes(error.message) ? error.message : 'CREDENTIAL_WRITE_FAILED');
    }
  }
  async #save(next, before) {
    const permission = this.#atomicOptions?.secureFile || secureCredentialFile;
    const source = before.exists ? this.#file : '';
    const fsApi = { ...fs, open: async (file, flags) => {
      const handle = await fs.open(file, flags, 0o600);
      try { await permission(file, { source }); return handle; }
      catch (error) { await handle.close(); await fs.unlink(file).catch(() => {}); throw error; }
    } };
    const rollback = `${this.#file}.${randomUUID()}.rollback`;
    let replaced = false; let recoveryRequired = false;
    try {
      // The rollback copy is protected BEFORE any bytes are written and removed
      // on either outcome. It also restores the old value if final ACL checks fail.
      if (before.exists) await writeAtomicText(rollback, before.text, { fsApi });
      await writeAtomicText(this.#file, next, { ...this.#atomicOptions, fsApi,
        validateTemporary: async (file) => {
          await permission(file, { checkOnly: true });
          const current = await this.#read();
          if (current.text !== before.text || Boolean(current.exists) !== Boolean(before.exists)) throw new Error('CREDENTIAL_CONCURRENT_CHANGE');
        },
        renameImpl: async (from, to) => {
          await (this.#atomicOptions?.renameImpl || fs.rename)(from, to); replaced = true;
        },
      });
      await permission(this.#file, { checkOnly: true });
    } catch (error) {
      if (replaced) {
        try { if (before.exists) await renameWithTransientRetry(rollback, this.#file, { renameImpl: this.#atomicOptions?.renameImpl || fs.rename }); else await fs.unlink(this.#file); }
        catch { recoveryRequired = true; throw new Error('CREDENTIAL_RECOVERY_REQUIRED'); }
      }
      throw error;
    } finally { if (!recoveryRequired) await fs.unlink(rollback).catch(() => {}); }
  }
  redact(value) {
    this.#remember(this.#env);
    return redactSecrets(value, this.#seen);
  }
}
