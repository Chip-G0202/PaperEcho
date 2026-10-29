import fs from 'node:fs/promises';
import os from 'node:os';
import { posix as path } from 'node:path';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { scheduleSpec, scheduleDefinition } from './os_scheduler.mjs';

const nativeExec = promisify(execFile);
const fail = code => { throw new Error(code); };
const marker = '\n<!-- PaperEcho LaunchAgent v1 ';
const missing = error => error.code === 'ENOENT';
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
export function validateMacScheduleSpec(spec) {
  if (spec?.platform !== 'darwin') fail('SCHEDULER_MACOS_REQUIRED');
  const expected = scheduleSpec({ paths: { applicationRoot: spec.workingDirectory, userDataRoot: spec.userDataRoot, cacheRoot: spec.cacheRoot, layout: spec.layout },
    platform: 'darwin', config: { schemaVersion: 6, mode: spec.args?.[10], profile: spec.args?.[12], scheduler: { schemaVersion: 1, enabled: spec.enabled, time: '15:00', timezone: 'Asia/Shanghai' } } });
  if (!isDeepStrictEqual(spec, expected) || [spec.workingDirectory, spec.userDataRoot, spec.cacheRoot].some(p => p === '/' || path.normalize(p) !== p)) fail('SCHEDULER_SPEC_INVALID');
  return expected;
}
function content(spec) { return scheduleDefinition(spec).content + marker + Buffer.from(JSON.stringify(spec)).toString('base64') + ' -->\n'; }

// Explicit adapter. Management requires local safety checks independently of
// platform release acceptance; never register during ordinary startup.
export class MacLaunchAgent {
  constructor({ fsApi = fs, execute = nativeExec, platform = process.platform, identity = () => os.userInfo(), timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    Object.assign(this, { fs: fsApi, command: execute, platform, identity, timezone });
  }
  async execute(operation, input) {
    try { return await this.manage(operation, input); }
    catch (error) { fail(/^SCHEDULER_[A-Z_]+$/.test(error.message) ? error.message : 'SCHEDULER_FILESYSTEM_FAILED'); }
  }
  async manage(operation, input) {
    if (this.platform !== 'darwin' || this.command === nativeExec && process.platform !== 'darwin') fail('SCHEDULER_MACOS_REQUIRED');
    const op = ({ query: 'status', delete: 'unregister' })[operation] || operation;
    if (!['register', 'status', 'update', 'unregister'].includes(op)) fail('SCHEDULER_ARGUMENT_INVALID');
    const spec = validateMacScheduleSpec(input), user = this.identity();
    if (!Number.isInteger(user.uid) || user.uid <= 0 || !path.isAbsolute(user.homedir) || path.normalize(user.homedir) !== user.homedir || user.homedir === '/') fail('SCHEDULER_USER_REQUIRED');
    if (['register', 'update'].includes(op) && this.timezone() !== 'Asia/Shanghai') fail('SCHEDULER_HOST_TIMEZONE_REQUIRED');
    const domain = `gui/${user.uid}`, target = `${domain}/${spec.taskId}`;
    const directory = path.join(user.homedir, 'Library/LaunchAgents'), file = path.join(directory, `${spec.taskId}.plist`), backup = file + '.previous';
    const cmd = async args => {
      try { return await this.command('/bin/launchctl', args, { shell: false, timeout: 15000, maxBuffer: 65536, env: { HOME: user.homedir, PATH: '/usr/bin:/bin' } }); }
      catch { fail('SCHEDULER_LAUNCHCTL_FAILED'); }
    };
    // list has documented PID/exit-status/label columns. Never parse `print`'s
    // explicitly unstable diagnostics or localized error strings as security data.
    if ((await cmd(['manageruid'])).stdout.trim() !== String(user.uid) || (await cmd(['managername'])).stdout.trim() !== 'Aqua') fail('SCHEDULER_GUI_SESSION_REQUIRED');
    await cmd(['print', domain]);
    const query = async () => {
      const lines = (await cmd(['list'])).stdout.trim().split(/\r?\n/);
      if (lines.shift() !== 'PID\tStatus\tLabel') fail('SCHEDULER_QUERY_FAILED');
      let result = null;
      for (const line of lines) {
        const match = /^(\d+|-)\t(-?\d+)\t([^\s]+)$/.exec(line);
        if (!match) fail('SCHEDULER_QUERY_FAILED');
        if (match[3] === spec.taskId) { if (result) fail('SCHEDULER_QUERY_FAILED'); result = { pid: match[1] === '-' ? null : Number(match[1]), lastExit: Number(match[2]) }; }
      }
      return result;
    };
    const guard = async (p, directory = false, ancestor = false) => {
      const stat = await this.fs.lstat(p);
      if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)
        || ![user.uid, ...(ancestor ? [0] : [])].includes(stat.uid) || stat.mode & 0o022) fail('SCHEDULER_PATH_UNSAFE');
      return stat;
    };
    const parents = async p => { for (const part of p.split('/').filter(Boolean).reduce((a, b) => [...a, path.join(a.at(-1) || '/', b)], [])) await guard(part, true, !part.startsWith(user.homedir)); };
    await parents(user.homedir);
    if (op === 'register' || op === 'update') {
      await parents(path.dirname(spec.executable)); await guard(spec.executable, false, true);
      for (const p of [spec.userDataRoot, spec.cacheRoot]) { await parents(p); await guard(p, true); }
    }
    for (const p of [path.dirname(directory), directory]) {
      try { await guard(p, true); }
      catch (error) {
        if (!missing(error)) throw error;
        if (op === 'status' || op === 'unregister') { if (await query()) fail('SCHEDULER_TASK_OWNERSHIP_MISMATCH'); return { status: 'not-installed', operation: op, taskId: spec.taskId }; }
        await this.fs.mkdir(p, { mode: 0o700 }); await guard(p, true);
      }
    }
    const read = async p => {
      try {
        const before = await guard(p);
        if (before.size > 32768) fail('SCHEDULER_TASK_OWNERSHIP_MISMATCH');
        const handle = await this.fs.open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!same(before, await handle.stat())) fail('SCHEDULER_CONCURRENT_CHANGE');
          const text = await handle.readFile('utf8');
          if (!same(before, await guard(p))) fail('SCHEDULER_CONCURRENT_CHANGE');
          const encoded = text.split(marker);
          if (encoded.length !== 2 || !/^[A-Za-z0-9+/=]+ -->\n$/.test(encoded[1])) fail('SCHEDULER_TASK_OWNERSHIP_MISMATCH');
          let stored;
          try { stored = validateMacScheduleSpec(JSON.parse(Buffer.from(encoded[1].slice(0, -5), 'base64').toString('utf8'))); }
          catch { fail('SCHEDULER_TASK_OWNERSHIP_MISMATCH'); }
          if (stored.taskId !== spec.taskId || text !== content(stored)) fail('SCHEDULER_TASK_OWNERSHIP_MISMATCH');
          return { text, stat: before, spec: stored };
        } finally { await handle.close(); }
      } catch (error) { if (missing(error)) return null; throw error; }
    };
    const lockPath = file + '.lock';
    let lock;
    try { lock = await this.fs.open(lockPath, 'wx', 0o600); } catch { fail('SCHEDULER_MANAGEMENT_BUSY'); }
    const lockStat = await lock.stat();
    try {
      if (await read(backup)) fail('SCHEDULER_RECOVERY_REQUIRED');
      const old = await read(file), loaded = await query();
      if (!old && loaded) fail('SCHEDULER_TASK_OWNERSHIP_MISMATCH');
      if (op === 'status') return { status: loaded ? 'loaded' : old ? 'installed-not-loaded' : 'not-installed', operation: op, taskId: spec.taskId, ...loaded };
      if (loaded?.pid) fail('SCHEDULER_TASK_RUNNING');
      if (op === 'register' && old && old.text !== content(spec)) fail('SCHEDULER_TASK_DEFINITION_MISMATCH');
      if (op === 'update' && !old) fail('SCHEDULER_TASK_NOT_FOUND');
      const checkOld = async () => { const actual = await read(file); if (old ? !actual || !same(old.stat, actual.stat) || old.text !== actual.text : actual) fail('SCHEDULER_CONCURRENT_CHANGE'); };
      const unload = async () => { if ((await query())?.pid) fail('SCHEDULER_TASK_RUNNING'); await cmd(['bootout', target]); if (await query()) fail('SCHEDULER_UNLOAD_UNCONFIRMED'); };
      if (op === 'unregister') {
        if (loaded) await unload();
        await checkOld(); if (old) await this.fs.unlink(file);
        return { status: 'not-installed', operation: op, taskId: spec.taskId };
      }
      if (old?.text === content(spec) && Boolean(loaded) === spec.enabled) return { status: loaded ? 'loaded' : 'installed-not-loaded', operation: op, taskId: spec.taskId, unchanged: true };
      // Exclusive files and atomic same-directory publication. A durable previous
      // definition survives partial update failure; ambiguity blocks later edits.
      const write = async (p, text) => { const h = await this.fs.open(p, 'wx', 0o600); try { await h.writeFile(text); await h.sync(); } finally { await h.close(); } };
      if (old) await write(backup, old.text);
      const temp = file + '.' + randomUUID() + '.tmp';
      try {
        if (loaded) await unload();
        await write(temp, content(spec)); await checkOld();
        if (old) await this.fs.rename(temp, file);
        else { await this.fs.link(temp, file); await this.fs.unlink(temp); }
        const published = await read(file);
        if (!published || published.text !== content(spec)) fail('SCHEDULER_CONCURRENT_CHANGE');
        if (spec.enabled) { await cmd(['bootstrap', domain, file]); if (!(await query())) fail('SCHEDULER_LOAD_UNCONFIRMED'); }
        const confirmed = await read(file);
        if (!confirmed || !same(published.stat, confirmed.stat) || confirmed.text !== content(spec)) fail('SCHEDULER_CONCURRENT_CHANGE');
        if (old) { await read(backup); await this.fs.unlink(backup); }
        return { status: spec.enabled ? 'loaded' : 'installed-not-loaded', operation: op, taskId: spec.taskId };
      } catch {
        // Do not kill a process or overwrite a possibly changed definition to
        // manufacture rollback success. Preserve both definitions for recovery.
        fail(old ? 'SCHEDULER_UPDATE_RECOVERY_REQUIRED' : 'SCHEDULER_REGISTER_UNCONFIRMED');
      } finally {
        try { await guard(temp); await this.fs.unlink(temp); } catch (error) { if (!missing(error)) throw error; }
      }
    } finally {
      await lock.close(); const actual = await guard(lockPath);
      if (!same(lockStat, actual)) fail('SCHEDULER_CONCURRENT_CHANGE');
      await this.fs.unlink(lockPath);
    }
  }
}
