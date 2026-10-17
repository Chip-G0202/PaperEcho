import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { resolveRuntimePaths, prepareRuntimePaths } from './runtime_config.mjs';
import { writeAtomicText, withAtomicJsonLock, readBoundedJson } from './atomic_json.mjs';
import { redactSecrets, secretValues } from './credential_registry.mjs';

export const RUNTIME_LOG_MAX_BYTES = 1048576;
const files = ['runtime.jsonl', 'runtime.previous.jsonl', 'runtime.pending.tmp', 'runtime.owner.json'];
const events = Object.freeze({
  RUNNER_STARTED: ['info', 'Runner started'], RUNNER_PREFLIGHT_READY: ['info', 'Local preflight passed'],
  RUNNER_PREFLIGHT_BLOCKED: ['warn', 'Local preflight blocked'], RUNNER_FINISHED: ['info', 'Runner completed'],
  RUNNER_FAILED: ['error', 'Runner did not complete; consult registered run evidence'],
  RUNNER_ADMITTED: ['info', 'Run admitted; correlation refers to the registered run'],
  CHILD_STDERR: ['warn', 'Child stderr received; raw payload omitted'],
  GUI_STARTED: ['info', 'Desktop shell started'], GUI_READY: ['info', 'Local workspace loaded'],
  GUI_LOAD_FAILED: ['error', 'Local workspace could not be loaded'], GUI_EXIT: ['info', 'Desktop shell closed'],
  GUI_RENDERER_GONE: ['error', 'Renderer exited'], GUI_CHILD_GONE: ['warn', 'Desktop child process exited'],
  HEADLESS_STARTED: ['info', 'Headless entry started'], HEADLESS_START_FAILED: ['error', 'Headless bootstrap failed'],
});
const observations = new Map();
export const RUNTIME_LOG_EVENT_CODES = Object.freeze(Object.keys(events));
const digest = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const errorCode = error => ['ENOSPC', 'EACCES', 'EPERM', 'EBUSY'].includes(error?.code) ? `RUNTIME_LOG_${error.code}` : 'RUNTIME_LOG_UNAVAILABLE';

export class RuntimeLog {
  constructor({ env = process.env, applicationRoot, maxBytes = RUNTIME_LOG_MAX_BYTES, atomicOptions = {}, warning = () => {}, fsApi = fs } = {}) {
    Object.assign(this, { env, applicationRoot, maxBytes, atomicOptions, warning, fsApi });
    this.queue = Promise.resolve(); this.warned = false;
  }
  paths() {
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1024 || this.maxBytes > RUNTIME_LOG_MAX_BYTES) throw new Error('LOG_LIMIT_INVALID');
    const paths = resolveRuntimePaths({ ...(this.applicationRoot ? { applicationRoot: this.applicationRoot } : {}), env: this.env });
    prepareRuntimePaths(paths, { readOnly: true });
    return paths;
  }
  async safe(file, { directory = false } = {}) {
    for (let current = path.resolve(file); ; current = path.dirname(current)) {
      try {
        const stat = await this.fsApi.lstat(current);
        if (stat.isSymbolicLink() || current === path.resolve(file) && (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw new Error('LOG_PATH_UNSAFE');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current === path.dirname(current)) break;
    }
  }
  async owner(root) {
    const value = await readBoundedJson(root, path.join(root, 'runtime.owner.json'), { maxBytes: 1024 });
    if (value && (value.schemaVersion !== 1 || value.owner !== 'paperecho-runtime-log' || value.maxBytes !== this.maxBytes || value.archives !== 1)) throw new Error('LOG_OWNER_INVALID');
    return value;
  }
  async atomic(root, name, text) {
    await writeAtomicText(path.join(root, name), text, { ...this.atomicOptions, fsApi: this.fsApi, temporaryPath: path.join(root, 'runtime.pending.tmp') });
  }
  write(code, { subsystem = 'runner', runId, requestId, exitCode } = {}) {
    const task = this.queue.then(async () => {
      let root;
      try {
        if (!Object.hasOwn(events, code) || !['runner', 'headless', 'gui'].includes(subsystem)) throw new Error('LOG_EVENT_INVALID');
        root = this.paths().logsRoot;
        await this.safe(root, { directory: true }); await this.fsApi.mkdir(root, { recursive: true, mode: 0o700 }); await this.safe(root, { directory: true });
        const result = await withAtomicJsonLock(path.join(root, 'runtime.owner.json'), async () => {
          // Windows replacement can fail while another writer inspects an open file.
          // Validate mutable entries only while holding the same lock as replacement.
          const checks = await Promise.allSettled([...files, 'runtime.owner.json.lock'].map(name => this.safe(path.join(root, name))));
          const failed = checks.find(check => check.status === 'rejected');
          if (failed) throw failed.reason;
          const owned = await this.owner(root);
          if (!owned) {
            for (const name of files.slice(0, 3)) {
              try { await this.fsApi.lstat(path.join(root, name)); throw new Error('LOG_UNOWNED_FILE'); }
              catch (error) { if (error.code !== 'ENOENT') throw error; }
            }
            await this.atomic(root, 'runtime.owner.json', JSON.stringify({ schemaVersion: 1, owner: 'paperecho-runtime-log', maxBytes: this.maxBytes, archives: 1 }));
          }
          // A dead writer can leave only this one owned staging file. Never discover/delete by glob.
          await this.safe(path.join(root, 'runtime.pending.tmp'));
          await this.fsApi.unlink(path.join(root, 'runtime.pending.tmp')).catch(error => { if (error.code !== 'ENOENT') throw error; });
          const [severity, summary] = events[code];
          const record = { schemaVersion: 1, timestamp: new Date().toISOString(), severity, subsystem, eventId: randomUUID(), code, summary,
            ...(runId ? { runId: digest(runId) } : {}), ...(requestId ? { requestId: digest(requestId) } : {}),
            ...(Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255 ? { exitCode } : {}) };
          // Closed fields and fixed summaries exclude body/stack/env/URL and unknown semantic secret fields.
          const line = redactSecrets(JSON.stringify(record), secretValues(this.env)) + '\n';
          if (Buffer.byteLength(line) > this.maxBytes) throw new Error('LOG_RECORD_TOO_LARGE');
          const current = path.join(root, 'runtime.jsonl'); await this.safe(current);
          let data = '';
          try {
            const handle = await this.fsApi.open(current, 'r');
            try {
              const stat = await handle.stat();
              if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.maxBytes) throw new Error('LOG_FILE_TOO_LARGE');
              const buffer = Buffer.alloc(this.maxBytes + 1);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
              if (bytesRead > this.maxBytes) throw new Error('LOG_FILE_TOO_LARGE');
              data = buffer.subarray(0, bytesRead).toString('utf8');
            } finally { await handle.close(); }
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (Buffer.byteLength(data + line) > this.maxBytes) {
            await this.safe(path.join(root, 'runtime.previous.jsonl'));
            await this.atomic(root, 'runtime.previous.jsonl', data);
            data = '';
          }
          await this.atomic(root, 'runtime.jsonl', data + line);
          return { ok: true, eventId: record.eventId };
        }, { fsApi: this.fsApi, timeoutMs: 5000, metadata: { owner: 'paperecho-runtime-log', hostname: os.hostname() },
          canBreakStaleLock: async (file, stat) => {
            const lease = await readBoundedJson(root, file, { maxBytes: 1024 });
            if (lease?.owner !== 'paperecho-runtime-log' || lease.hostname !== os.hostname() || !Number.isInteger(lease.pid) || lease.pid < 1) return false;
            try { process.kill(lease.pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') return false; }
            const latest = await this.fsApi.lstat(file).catch(() => null);
            return latest && stat.ino === latest.ino && stat.dev === latest.dev && stat.mtimeMs === latest.mtimeMs;
          } });
        observations.set(root, { ...observations.get(root), recovered: true }); this.warned = false;
        return result;
      } catch (error) {
        const code = errorCode(error);
        if (root) observations.set(root, { code, at: new Date().toISOString(), recovered: false });
        if (!this.warned) { this.warned = true; try { this.warning(code); } catch {} }
        return { ok: false, code };
      }
    });
    this.queue = task.catch(() => {}); return task;
  }
  async health() {
    try {
      const root = this.paths().logsRoot;
      const recent = observations.get(root);
      const finish = result => ({ ...result, ...(recent?.code ? { lastError: recent.code, at: recent.at, recovered: recent.recovered } : {}) });
      await this.safe(root, { directory: true });
      try { await this.fsApi.access(root, constants.R_OK | constants.W_OK); }
      catch (error) { return finish({ status: error.code === 'ENOENT' ? 'WARN' : 'UNKNOWN', code: 'RUNTIME_LOG_DIRECTORY_UNCONFIRMED' }); }
      for (const name of [...files, 'runtime.owner.json.lock']) await this.safe(path.join(root, name));
      if (!await this.owner(root)) return finish({ status: 'UNKNOWN', code: 'RUNTIME_LOG_OWNER_UNCONFIRMED' });
      const lease = await readBoundedJson(root, path.join(root, 'runtime.owner.json.lock'), { maxBytes: 1024 });
      if (lease) {
        if (lease.owner !== 'paperecho-runtime-log' || lease.hostname !== os.hostname() || !Number.isInteger(lease.pid) || lease.pid < 1) return finish({ status: 'UNKNOWN', code: 'RUNTIME_LOG_LOCK_UNCONFIRMED' });
        try { process.kill(lease.pid, 0); }
        catch { return finish({ status: 'WARN', code: 'RUNTIME_LOG_LOCK_REQUIRES_CHECK' }); }
      }
      for (const name of files.slice(0, 3)) {
        try {
          if ((await this.fsApi.stat(path.join(root, name))).size > this.maxBytes) return finish({ status: 'WARN', code: 'RUNTIME_LOG_SIZE_EXCEEDED' });
          if (name === 'runtime.pending.tmp') return finish({ status: 'WARN', code: 'RUNTIME_LOG_STAGING_REQUIRES_CHECK' });
        }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return finish({ status: recent?.code && !recent.recovered ? 'WARN' : 'PASS', code: recent?.code || 'RUNTIME_LOG_READY', maxBytes: this.maxBytes, archives: 1 });
    } catch { return { status: 'UNKNOWN', code: 'RUNTIME_LOG_INSPECTION_UNAVAILABLE' }; }
  }
  // Read-only support projection: inspect only the bounded current file, never
  // acquire a writer lock, rotate, or copy free text/correlation identifiers.
  async eventSummary({ signal } = {}) {
    try {
      signal?.throwIfAborted();
      const root = this.paths().logsRoot; await this.safe(root, { directory: true });
      if (!await this.owner(root)) throw new Error();
      const current = path.join(root, 'runtime.jsonl'); await this.safe(current);
      const handle = await this.fsApi.open(current, 'r');
      let text;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > this.maxBytes) throw new Error();
        const buffer = Buffer.alloc(this.maxBytes + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > this.maxBytes) throw new Error();
        text = buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await handle.close(); }
      signal?.throwIfAborted();
      if (text && !text.endsWith('\n')) throw new Error();
      const lines = text.trim().split('\n').filter(Boolean); const counts = new Map(); let omitted = 0;
      for (const line of lines.slice(-200)) {
        let record; try { record = JSON.parse(line); } catch { omitted++; continue; }
        if (!Object.hasOwn(events, record.code) || !['runner', 'gui', 'headless'].includes(record.subsystem)) { omitted++; continue; }
        const key = `${record.code}:${record.subsystem}`;
        const event = counts.get(key) || { code: record.code, severity: events[record.code][0], subsystem: record.subsystem, count: 0 };
        event.count++; counts.set(key, event);
      }
      return { status: 'available', sampled: Math.min(lines.length, 200), truncated: lines.length > 200, omitted, events: [...counts.values()] };
    } catch { return { status: 'omitted', code: 'RUNTIME_LOG_SNAPSHOT_UNAVAILABLE' }; }
  }
}
