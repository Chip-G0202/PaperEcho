import path from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { RuntimeLog, RUNTIME_LOG_MAX_BYTES, RUNTIME_LOG_EVENT_CODES } from './runtime_logging.mjs';
import { CONTROL_SECRET_NAMES } from './credential_registry.mjs';
import { resolveRuntimePaths, prepareRuntimePaths } from './runtime_config.mjs';

export const SUPPORT_LIMITS = Object.freeze({ files: 4, fileBytes: 32768, totalBytes: 65536, zipBytes: 65536, events: 200, checks: 100, milliseconds: 10000 });
const statuses = ['PASS', 'WARN', 'FAIL', 'UNKNOWN'];
const severities = ['info', 'advisory', 'blocking'];
const checkIds = new Set([
  'runtime.roots', 'runtime.application', 'runtime.data', 'runtime.cache', 'runtime.node', 'runtime.platform', 'runtime.resources', 'runtime.pwsh',
  'configuration', 'preflight', 'preflight.optional', 'secrets', 'restore.transaction', 'workflow', 'workflow.claim', 'workflow.manifest', 'workflow.ledger', 'workflow.recovery',
  'workflow.receipts', 'workflow.runner', 'workflow.scheduleClaim', 'research', 'research.pending', 'research.prepared', 'research.unknown', 'research.recoverable', 'research.processed', 'logging', 'logging.lastError',
  ...CONTROL_SECRET_NAMES.map(name => `secret.${name}`),
  ...['local.input', 'local.outputRoot', 'readable Local input', 'supported Local input', 'safe Local output root', 'writable Local output root', 'readable Local feedback JSONL', 'Zotero Desktop', 'Zotero Desktop CLI bridge', 'ZOTERO_API_KEY', 'ZOTERO_USER_ID', 'production entry', 'Node.js >= 18'].map(name => `preflight.missing.${name.replace(/[^A-Za-z0-9]/g, '_')}`),
]);
const logCodes = new Set(['RUNTIME_LOG_READY', 'RUNTIME_LOG_DIRECTORY_UNCONFIRMED', 'RUNTIME_LOG_OWNER_UNCONFIRMED', 'RUNTIME_LOG_LOCK_UNCONFIRMED', 'RUNTIME_LOG_LOCK_REQUIRES_CHECK', 'RUNTIME_LOG_SIZE_EXCEEDED', 'RUNTIME_LOG_STAGING_REQUIRES_CHECK', 'RUNTIME_LOG_INSPECTION_UNAVAILABLE', 'RUNTIME_LOG_ENOSPC', 'RUNTIME_LOG_EACCES', 'RUNTIME_LOG_EPERM', 'RUNTIME_LOG_EBUSY', 'RUNTIME_LOG_UNAVAILABLE']);
const fail = code => new Error(code);
const overall = checks => ['FAIL', 'UNKNOWN', 'WARN', 'PASS'].find(value => checks.some(check => check.status === value)) || 'UNKNOWN';
const enumValue = (value, values, fallback = 'unknown') => values.includes(value) ? value : fallback;

export class SupportBundleService {
  constructor({ doctor, secrets, context, env, archive = async files => {
    const zip = new JSZip();
    for (const [name, bytes] of files) zip.file(name, bytes, { date: new Date('2026-01-01T00:00:00Z'), createFolders: false, unixPermissions: 0o600 });
    return zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  }, limits = SUPPORT_LIMITS } = {}) {
    Object.assign(this, { doctor, secrets, context, env, archive }); this.active = false;
    // Injection may tighten limits for isolated failure tests, never enlarge them.
    this.limits = Object.fromEntries(Object.entries(SUPPORT_LIMITS).map(([key, max]) => [key, Math.min(max, Math.max(1, limits[key] ?? max))]));
  }
  async export({ signal } = {}) {
    if (this.active) throw fail('SUPPORT_BUSY');
    if (signal?.aborted) throw fail('SUPPORT_CANCELLED');
    this.active = true;
    const controller = new AbortController(); let timer; let abort;
    const cancel = new Promise((_, reject) => {
      abort = () => { controller.abort(); reject(fail('SUPPORT_CANCELLED')); };
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(fail('SUPPORT_TIMEOUT')); }, this.limits.milliseconds);
    });
    // Do not release the admission slot until in-flight read-only diagnostics settle,
    // even when the HTTP client cancels or the response deadline expires.
    const work = this.build(controller.signal).finally(() => { this.active = false; });
    try { return await Promise.race([work, cancel]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async build(signal) {
    try {
      signal.throwIfAborted();
      const paths = resolveRuntimePaths({ applicationRoot: this.context.applicationRoot, env: this.env });
      prepareRuntimePaths(paths, { readOnly: true });
      if (path.resolve(paths.userDataRoot) !== path.resolve(this.context.userDataRoot)) throw fail('SUPPORT_ROOT_UNSAFE');
      const log = new RuntimeLog({ applicationRoot: paths.applicationRoot, env: this.env });
      await log.safe(paths.userDataRoot, { directory: true });
      signal.throwIfAborted();
      const report = await this.doctor.status({ signal }); signal.throwIfAborted();
      if (!Array.isArray(report?.checks) || report.checks.length > this.limits.checks) throw fail('SUPPORT_LIMIT_EXCEEDED');
      if (!report.checks.some(check => check.checkId === 'secrets' && check.status === 'PASS')) throw fail('SUPPORT_SECRET_CHECK_FAILED');
      const checks = report.checks.filter(check => checkIds.has(check.checkId)).map(check => ({ checkId: check.checkId,
        status: enumValue(check.status, statuses, 'UNKNOWN'), severity: enumValue(check.severity, severities, 'advisory') }));
      const omittedChecks = report.checks.length - checks.length;
      const doctor = { schemaVersion: 1, status: overall([...checks, { status: enumValue(report.status, statuses, 'UNKNOWN') }, ...(omittedChecks ? [{ status: 'UNKNOWN' }] : [])]), checks, omittedChecks };
      const health = await log.health(); const events = await log.eventSummary({ signal }); signal.throwIfAborted();
      const logEvents = events.status === 'available' ? { status: 'available', sampled: events.sampled, truncated: events.truncated, omitted: events.omitted,
        events: events.events.map(event => ({ code: event.code, severity: event.severity, subsystem: event.subsystem, count: event.count })) } : { status: 'omitted', code: 'RUNTIME_LOG_SNAPSHOT_UNAVAILABLE' };
      if (logEvents.status === 'available' && (!Number.isSafeInteger(logEvents.sampled) || logEvents.sampled > this.limits.events || logEvents.events.some(event => !RUNTIME_LOG_EVENT_CODES.includes(event.code) || !['info', 'warn', 'error'].includes(event.severity) || !['runner', 'gui', 'headless'].includes(event.subsystem) || !Number.isSafeInteger(event.count) || event.count < 1 || event.count > this.limits.events))) throw fail('SUPPORT_SAFETY_FAILED');
      const runtime = { schemaVersion: 1, product: { name: 'PaperEcho', releaseLine: '2.6', buildIdentity: 'not-attested' },
        platform: enumValue(process.platform, ['win32', 'darwin', 'linux']), arch: enumValue(process.arch, ['x64', 'arm64', 'ia32']),
        mode: enumValue(this.context.mode, ['desktop', 'web', 'local']), layout: enumValue(paths.layout, ['dev', 'portable', 'installed']),
        node: process.versions.node, ...(process.versions.electron ? { electron: process.versions.electron } : {}),
        logging: { status: enumValue(health.status, statuses, 'UNKNOWN'), code: logCodes.has(health.code) ? health.code : 'RUNTIME_LOG_INSPECTION_UNAVAILABLE', maxBytes: RUNTIME_LOG_MAX_BYTES, archives: 1 } };
      const files = new Map();
      const put = (name, value) => {
        if (!['manifest.json', 'doctor-summary.json', 'runtime-summary.json', 'log-events-summary.json'].includes(name)) throw fail('SUPPORT_ENTRY_UNSAFE');
        const text = JSON.stringify(value, null, 2) + '\n';
        // Projection first; redaction is a final rejection guard, not permission
        // to export arbitrary text. SecretService knows current and prior values.
        if (this.secrets.redact(text) !== text || /Authorization|Cookie|https?:|[A-Z]:\\|\/Users\/|\/home\//i.test(text)) throw fail('SUPPORT_SAFETY_FAILED');
        const bytes = Buffer.from(text); if (bytes.length > this.limits.fileBytes) throw fail('SUPPORT_LIMIT_EXCEEDED');
        files.set(name, bytes);
      };
      put('doctor-summary.json', doctor); put('runtime-summary.json', runtime); put('log-events-summary.json', { schemaVersion: 1, ...logEvents });
      put('manifest.json', { schemaVersion: 1, exportedAt: new Date().toISOString(), integrity: { algorithm: 'SHA256', scope: 'payload-files', authenticity: 'unsigned', manifestSelfHash: false },
        limits: this.limits, files: [...files].map(([name, bytes]) => ({ name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })) });
      if (files.size > this.limits.files || [...files.values()].reduce((size, bytes) => size + bytes.length, 0) > this.limits.totalBytes) throw fail('SUPPORT_LIMIT_EXCEEDED');
      signal.throwIfAborted(); const zip = await this.archive(files); signal.throwIfAborted();
      if (!Buffer.isBuffer(zip) || zip.length > this.limits.zipBytes) throw fail('SUPPORT_LIMIT_EXCEEDED');
      return zip;
    } catch (error) {
      if (/^SUPPORT_(ROOT_UNSAFE|LIMIT_EXCEEDED|SECRET_CHECK_FAILED|ENTRY_UNSAFE|SAFETY_FAILED)$/.test(error?.message)) throw error;
      throw fail(signal.aborted ? 'SUPPORT_CANCELLED' : 'SUPPORT_EXPORT_FAILED');
    }
  }
}
