import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { RuntimeLog } from '../tools/lib/runtime_logging.mjs';
import { resolveRuntimePaths } from '../tools/lib/runtime_config.mjs';
import { CONTROL_SECRET_NAMES, redactSecrets } from '../tools/lib/credential_registry.mjs';
import { main, runProduction } from '../tools/runner/main.mjs';
import { EventEmitter } from 'node:events';
import { Session } from 'node:inspector';
import { AsyncLocalStorage } from 'node:async_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
const repo = fileURLToPath(new URL('../../', import.meta.url));
async function fixture(t, layout = 'installed') {
  const base = path.join(repo, 'tests/runs/logging'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, '日志 安全-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app'); await fs.mkdir(app);
  const env = { PAPERECHO_LAYOUT: layout, PAPERECHO_APPLICATION_ROOT: app, ...(layout === 'dev' ? {} : layout === 'portable' ? {} : { PAPERECHO_DATA_ROOT: path.join(root, 'data') }), PAPERECHO_SKIP_DOTENV: '1' };
  const paths = resolveRuntimePaths({ env });
  return { root, app, env, paths, log: new RuntimeLog({ env }), current: path.join(paths.logsRoot, 'runtime.jsonl') };
}
async function records(f) {
  const records = [];
  for (const name of ['runtime.previous.jsonl', 'runtime.jsonl']) {
    try { records.push(...(await fs.readFile(path.join(f.paths.logsRoot, name), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return records;
}
async function snapshot(root) {
  const result = {};
  async function visit(dir) { for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, e.name); const s = await fs.lstat(file);
    result[path.relative(root, file)] = [s.mode, s.mtimeMs, e.isDirectory() ? null : await fs.readFile(file, 'utf8')];
    if (e.isDirectory()) await visit(file);
  } }
  await visit(root); return result;
}
test('Dev/Portable/Installed select the central logs root, isolate workspaces and never use cwd/app install', async t => {
  for (const layout of ['dev', 'portable', 'installed']) {
    const f = await fixture(t, layout); assert.equal(f.paths.logsRoot, path.join(f.paths.userDataRoot, 'logs'));
    assert.equal((await f.log.write('RUNNER_STARTED')).ok, true);
    assert.equal((await records(f)).length, 1);
    if (layout === 'installed') assert.deepEqual(await fs.readdir(f.app), []);
  }
  const a = await fixture(t), b = await fixture(t); await a.log.write('RUNNER_STARTED');
  await assert.rejects(fs.access(b.current)); assert.equal((await records(a)).length, 1);
});
test('closed structured fields omit all secret/payload/stack content, identifiers are correlated digests', async t => {
  const f = await fixture(t); const secrets = Object.fromEntries(CONTROL_SECRET_NAMES.map((name, i) => [name, `dummy-channel-${i}-credential-value`]));
  const log = new RuntimeLog({ env: { ...f.env, ...secrets } });
  const unknown = 'dummy-unregistered-private-value';
  assert.equal((await log.write('RUNNER_FAILED', { runId: unknown, requestId: unknown, exitCode: 2,
    token: unknown, password: unknown, key: unknown, message: unknown, stack: unknown, body: unknown, feedback: unknown, title: unknown, response: unknown, url: `https://example.invalid/?token=${unknown}` })).ok, true);
  const text = await fs.readFile(f.current, 'utf8');
  assert.ok(!text.includes(unknown)); for (const secret of Object.values(secrets)) assert.ok(!text.includes(secret));
  const [record] = await records(f); assert.equal(record.runId, record.requestId); assert.match(record.runId, /^[a-f0-9]{16}$/);
  assert.deepEqual(Object.keys(record).sort(), ['schemaVersion', 'timestamp', 'severity', 'subsystem', 'eventId', 'code', 'summary', 'runId', 'requestId', 'exitCode'].sort());
  assert.equal(record.severity, 'error'); assert.equal((await log.write(unknown)).ok, false);
});
test('shared registry redacts inclusion orders, repeats, all channels, headers, cookie and query values', () => {
  const small = 'dummy-sensitive'; const large = small + '-longer';
  for (const values of [[small, large], [large, small]]) {
    const text = redactSecrets(`${large} ${small} ${large}`, values);
    assert.doesNotMatch(text, /dummy|longer/);
  }
  const values = CONTROL_SECRET_NAMES.map((_, i) => `dummy-credential-${i}-end`);
  const safe = redactSecrets(values.join(' ') + ' ' + values.join(' '), values);
  for (const value of values) assert.ok(!safe.includes(value));
  const headers = redactSecrets('Authorization: Bearer dummy-auth\nCookie: dummy-cookie=x; second=y\nSet-Cookie: dummy-set=z\nhttps://example.invalid/?api_key=dummy-query&token=dummy-other');
  assert.doesNotMatch(headers, /dummy-/);
  assert.doesNotMatch(redactSecrets(JSON.stringify({ Authorization: 'dummy-auth', Cookie: 'dummy-cookie' })), /dummy-/);
});
test('size rotation retains one bounded archive, never scans/deletes business records', async t => {
  const f = await fixture(t); const log = new RuntimeLog({ env: f.env, maxBytes: 1024 });
  await fs.mkdir(f.paths.logsRoot, { recursive: true });
  for (const name of ['operation_ledger.json', 'notification_receipt.json', 'feedback.json', 'run_group.json', 'research_evaluations.json', 'unified_suggestions.json', '研究结果.json']) await fs.writeFile(path.join(f.paths.logsRoot, name), 'protected-dummy');
  for (let i = 0; i < 40; i++) assert.equal((await log.write('RUNNER_STARTED', { runId: `dummy-${i}` })).ok, true);
  for (const name of ['runtime.jsonl', 'runtime.previous.jsonl']) assert.ok((await fs.stat(path.join(f.paths.logsRoot, name))).size <= 1024);
  assert.ok((await records(f)).length < 40); assert.equal(new Set((await records(f)).map(x => x.eventId)).size, (await records(f)).length);
  for (const name of (await fs.readdir(f.paths.logsRoot)).filter(x => !x.startsWith('runtime.'))) assert.equal(await fs.readFile(path.join(f.paths.logsRoot, name), 'utf8'), 'protected-dummy');
  assert.deepEqual((await fs.readdir(f.paths.logsRoot)).filter(x => x.startsWith('runtime.')).sort(), ['runtime.jsonl', 'runtime.owner.json', 'runtime.previous.jsonl']);
});
function runNode(args, env) { return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, { cwd: repo, env: { ...process.env, ...env }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; let started = false; child.once('spawn', () => { started = true; }); const capture = b => { output = (output + b).slice(-4096); };
  child.stdout.on('data', capture); child.stderr.on('data', capture);
  const timer = setTimeout(() => child.kill(), 15000);
  child.once('error', error => { clearTimeout(timer); reject(new Error(['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? `CHILD_SPAWN_${error.code}` : 'CHILD_SPAWN_FAILED')); });
  child.once('close', (code, signal) => {
    clearTimeout(timer);
    if (code === 0) { resolve(child.pid); return; }
    const diagnostics = output.split(/\r?\n/).flatMap(line => {
      try { const value = JSON.parse(line); return /^LOG_[A-Z_]+$|^RUNTIME_LOG_[A-Z_]+$|^FS_[A-Z_]+$/.test(value.code) && /^[a-z._]+$/.test(value.step) ? [{ step: value.step, code: value.code,
        syscall: value.syscall, flags: value.flags, pid: value.pid, lockExists: value.lockExists, lockStateCode: value.lockStateCode, openLockHandles: value.openLockHandles, releasing: value.releasing, rootIdentityUnchanged: value.rootIdentityUnchanged }] : []; } catch { return []; }
    });
    const errorType = output.match(/(?:^|\n)(SyntaxError|ReferenceError|TypeError|Error)(?::| \[)/)?.[1] || null;
    reject(new Error(JSON.stringify({ step: 'child.close', code: 'LOG_CHILD_FAILED', started, exitCode: code, signal, errorType, diagnostics })));
  });
}); }
function logChildCode(maxBytes = 1048576) {
  const module = pathToFileURL(path.join(repo, 'workflow/tools/lib/runtime_logging.mjs')).href;
  return `import {RuntimeLog} from ${JSON.stringify(module)};import fs from 'node:fs/promises';import {lstatSync} from 'node:fs';import path from 'node:path';
    let first,rootIdentity,releasing=0;const handles=new Set();
    const state=file=>{try{const s=lstatSync(file);return{exists:true,identity:s.dev+':'+s.ino}}catch(e){return{exists:false,code:e.code}}};
    const step=file=>['runtime.jsonl','runtime.previous.jsonl','runtime.pending.tmp','runtime.owner.json','runtime.owner.json.lock'].includes(path.basename(file||''))?path.basename(file):'directory';
    const fsApi={...fs};
    for(const method of ['open','rename','unlink','lstat','stat','realpath','mkdir','chmod'])fsApi[method]=async(...args)=>{
      const lock=path.basename(args[0])==='runtime.owner.json.lock';if(method==='unlink'&&lock)releasing++;
      try{const result=await fs[method](...args);if(method==='open'&&lock){handles.add(result);rootIdentity??=state(path.dirname(args[0])).identity}if(method==='lstat'&&result.isFile()&&result.nlink!==1)first={step:'lstat.'+step(args[0]),code:'LOG_LINK_COUNT_UNSAFE'};return result;}
      catch(error){if(['EPERM','EACCES','EBUSY'].includes(error.code)){const s=state(args[0]);first={step:method+'.'+step(args[0]),code:'FS_'+error.code,syscall:error.syscall||method,flags:method==='open'?args[1]:undefined,pid:process.pid,lockExists:lock?s.exists:undefined,lockStateCode:lock?s.code:undefined,openLockHandles:[...handles].filter(h=>h.fd!==-1).length,releasing,rootIdentityUnchanged:rootIdentity===state(path.dirname(args[0])).identity}}throw error;}
      finally{if(method==='unlink'&&lock)releasing--;}
    };
    class Probe extends RuntimeLog {async safe(file,options){try{return await super.safe(file,options);}catch{first||={step:'safe.'+step(file),code:'LOG_PATH_UNSAFE'};throw new Error('LOG_PATH_UNSAFE');}}}
    const log=new Probe({fsApi,maxBytes:${maxBytes}});for(let i=0;i<20;i++){const result=await log.write('RUNNER_STARTED');if(!result.ok){console.log(JSON.stringify(first||{step:'write',code:result.code}));process.exitCode=1;break;}}`;
}
test('concurrent instances and processes preserve every acknowledged event without truncation', async t => {
  const f = await fixture(t);
  const writer = new AsyncLocalStorage(), origin = performance.now(), timeline = [], io = {};
  const elapsed = () => Math.round(performance.now() - origin);
  const mark = step => { if (timeline.length < 160) timeline.push({ step, writer: writer.getStore(), atMs: elapsed() }); };
  const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
  t.after(() => { loop.disable(); writer.disable(); });
  // A non-pausing, in-process test logpoint captures the cause before the public
  // safety wrapper discards it. No inspector port or production hook is added.
  const causes = []; const session = new Session(); session.connect();
  const post = (method, params = {}) => new Promise((resolve, reject) => session.post(method, params, (error, value) => error ? reject(error) : resolve(value)));
  const probeKey = '__paperechoRuntimeLogTestCause';
  assert.equal(Object.hasOwn(globalThis, probeKey), false);
  globalThis[probeKey] = error => causes.push({
    writer: writer.getStore(), atMs: elapsed(),
    reason: error.message === 'ATOMIC_JSON_LOCK_TIMEOUT:runtime.owner.json' ? 'ATOMIC_JSON_LOCK_TIMEOUT'
      : ['LOG_EVENT_INVALID', 'LOG_PATH_UNSAFE', 'LOG_OWNER_INVALID', 'LOG_UNOWNED_FILE', 'LOG_RECORD_TOO_LARGE', 'LOG_FILE_TOO_LARGE', 'INSPECTION_PATH_UNSAFE', 'INSPECTION_FILE_UNSAFE', 'INSPECTION_LIMIT'].includes(error.message) ? error.message : 'UNCLASSIFIED',
    code: ['EPERM', 'EACCES', 'EBUSY', 'ENOSPC', 'ENOENT', 'EEXIST', 'EMFILE', 'ENFILE', 'ENOMEM'].includes(error.code) ? error.code : null,
    errno: Number.isInteger(error.errno) ? error.errno : null,
    syscall: ['open', 'rename', 'unlink', 'stat', 'lstat', 'realpath', 'mkdir', 'read', 'write', 'close'].includes(error.syscall) ? error.syscall : null,
    location: error.stack?.match(/(?:atomic_json|runtime_logging)\.mjs:\d+:\d+/g) || [],
  });
  let breakpoint;
  t.after(async () => {
    try { if (breakpoint) await post('Debugger.removeBreakpoint', { breakpointId: breakpoint }); await post('Debugger.disable'); }
    finally { session.disconnect(); delete globalThis[probeKey]; }
  });
  const moduleUrl = pathToFileURL(path.join(repo, 'workflow/tools/lib/runtime_logging.mjs')).href;
  const lineNumber = (await fs.readFile(new URL(moduleUrl), 'utf8')).split('\n').findIndex(line => line.includes('const code = errorCode(error);'));
  assert.ok(lineNumber >= 0);
  await post('Debugger.enable');
  const point = await post('Debugger.setBreakpointByUrl', { url: moduleUrl, lineNumber, condition: `globalThis.${probeKey}(error), false` });
  breakpoint = point.breakpointId; assert.ok(point.locations.length > 0, 'RuntimeLog cause logpoint must bind');
  assert.equal((await f.log.write('DIAGNOSTIC_INVALID_EVENT')).ok, false);
  assert.equal(causes.at(-1)?.reason, 'LOG_EVENT_INVALID', 'cause capture must execute before the public wrapper'); causes.length = 0;
  const faults = []; const fsApi = { ...fs };
  const lockHandles = new Set(); let releasing = 0, contentions = 0;
  const state = file => { try { const s = lstatSync(file); return { exists: true, directory: s.isDirectory(), linked: s.isSymbolicLink(), links: s.nlink, identity: `${s.dev}:${s.ino}` }; } catch (e) { return { exists: false, code: e.code }; } };
  let rootIdentity;
  for (const method of ['open', 'rename', 'lstat', 'unlink']) fsApi[method] = async (...args) => {
    const started = performance.now();
    const lock = path.basename(args[0]) === 'runtime.owner.json.lock';
    if (method === 'unlink' && lock) releasing++;
    try {
      const result = await fs[method](...args);
      if (method === 'open' && lock) {
        mark('lock.acquired');
        rootIdentity ??= state(f.paths.logsRoot).identity;
        lockHandles.add(result); const close = result.close.bind(result);
        result.close = async () => { try { return await close(); } finally { lockHandles.delete(result); mark('lock.closed'); } };
      }
      if (method === 'unlink' && lock) mark('lock.released');
      return result;
    }
    catch (error) {
      if (method === 'open' && lock && error.code === 'EEXIST') contentions++;
      if (['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) faults.push({ step: `${method}.${['runtime.jsonl', 'runtime.previous.jsonl', 'runtime.pending.tmp', 'runtime.owner.json', 'runtime.owner.json.lock'].includes(path.basename(args[0])) ? path.basename(args[0]) : 'directory'}`, code: error.code,
        syscall: error.syscall || method, flags: method === 'open' ? args[1] : undefined, pid: process.pid, stage: method === 'open' && lock ? 'acquire' : method,
        workspace: 'isolated-logging-fixture', lock: state(path.join(f.paths.logsRoot, 'runtime.owner.json.lock')), openLockHandles: lockHandles.size, releasing,
        rootIdentityUnchanged: rootIdentity === state(f.paths.logsRoot).identity, location: error.stack?.match(/(?:atomic_json|runtime_logging)\.mjs:\d+:\d+/g) || [] });
      throw error;
    } finally {
      const duration = performance.now() - started, stat = io[method] ||= { count: 0, maxMs: 0 };
      stat.count++; stat.maxMs = Math.max(stat.maxMs, Math.round(duration));
      if (method === 'unlink' && lock) releasing--;
    }
  };
  // Match Runner/GUI owner lifetime: each instance queues its concurrent calls.
  // Two independent owners still compete for the real cross-process file lock.
  const owners = [new RuntimeLog({ env: f.env, fsApi }), new RuntimeLog({ env: f.env, fsApi })];
  const same = await Promise.all(Array.from({ length: 30 }, (_, id) => writer.run(id, async () => {
    mark('write.started'); const result = await owners[id % owners.length].write('RUNNER_STARTED'); mark('write.finished'); return result;
  })));
  const timing = { elapsedMs: elapsed(), eventLoopMaxMs: Math.round(loop.max / 1e6), io, timeline };
  assert.ok(same.every(x => x.ok), JSON.stringify({ step: 'instances.write', failures: same.filter(x => !x.ok).map(x => x.code), faults, causes, timing }));
  assert.ok(contentions > 0, 'independent owners must actually contend for the file lock');
  t.diagnostic(JSON.stringify({ step: 'instances.complete', elapsedMs: timing.elapsedMs, eventLoopMaxMs: timing.eventLoopMaxMs,
    acquired: timeline.filter(x => x.step === 'lock.acquired').length, released: timeline.filter(x => x.step === 'lock.released').length, contentions, io }));
  const code = logChildCode();
  const children = await Promise.allSettled([runNode(['--input-type=module', '-e', code], f.env), runNode(['--input-type=module', '-e', code], f.env)]);
  for (const result of children) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? result.reason.message : '');
  const found = await records(f); assert.equal(found.length, 70); assert.equal(new Set(found.map(x => x.eventId)).size, 70);
  for (const name of ['runtime.owner.json.lock', 'runtime.pending.tmp']) await assert.rejects(fs.access(path.join(f.paths.logsRoot, name)));
});
test('mutable log file inspection shares the replacement lock on Windows', async t => {
  const f = await fixture(t); await f.log.write('RUNNER_STARTED');
  let inspected = 0;
  const fsApi = { ...fs, lstat: async file => {
    if (path.dirname(file) === f.paths.logsRoot && ['runtime.jsonl', 'runtime.previous.jsonl', 'runtime.pending.tmp'].includes(path.basename(file))) {
      const lease = JSON.parse(await fs.readFile(path.join(f.paths.logsRoot, 'runtime.owner.json.lock'), 'utf8'));
      assert.equal(lease.owner, 'paperecho-runtime-log'); assert.equal(lease.pid, process.pid); inspected++;
    }
    return fs.lstat(file);
  } };
  assert.equal((await new RuntimeLog({ env: f.env, fsApi }).write('RUNNER_STARTED')).ok, true);
  assert.ok(inspected > 0); assert.equal((await records(f)).length, 2);
  await assert.rejects(fs.access(path.join(f.paths.logsRoot, 'runtime.owner.json.lock')));
});
test('concurrent processes rotate bounded complete records and release their shared lock', async t => {
  const f = await fixture(t);
  const code = logChildCode(1024);
  const children = await Promise.allSettled([runNode(['--input-type=module', '-e', code], f.env), runNode(['--input-type=module', '-e', code], f.env)]);
  for (const result of children) assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? result.reason.message : '');
  const found = await records(f); assert.ok(found.length > 1 && found.length < 40);
  assert.equal(new Set(found.map(x => x.eventId)).size, found.length);
  assert.ok(found.every(x => x.code === 'RUNNER_STARTED'));
  for (const name of ['runtime.jsonl', 'runtime.previous.jsonl']) assert.ok((await fs.stat(path.join(f.paths.logsRoot, name))).size <= 1024);
  assert.deepEqual((await fs.readdir(f.paths.logsRoot)).sort(), ['runtime.jsonl', 'runtime.owner.json', 'runtime.previous.jsonl']);
});

test('rotation faults preserve current bytes, report failure, and permit bounded recovery', async t => {
  for (const target of ['runtime.previous.jsonl', 'runtime.jsonl']) {
    const f = await fixture(t); const normal = new RuntimeLog({ env: f.env, maxBytes: 1024 });
    await normal.write('RUNNER_STARTED'); const bytes = (await fs.stat(f.current)).size;
    while ((await fs.stat(f.current)).size + bytes <= 1024) await normal.write('RUNNER_STARTED');
    const old = await fs.readFile(f.current, 'utf8'); const warnings = [];
    const failing = new RuntimeLog({ env: f.env, maxBytes: 1024, warning: code => warnings.push(code), atomicOptions: { renameImpl: async (from, to) => {
      if (path.basename(to) === target) throw Object.assign(new Error('dummy-sensitive-error'), { code: 'EACCES' }); await fs.rename(from, to);
    } } });
    assert.equal((await failing.write('RUNNER_STARTED')).ok, false); assert.equal(await fs.readFile(f.current, 'utf8'), old);
    assert.deepEqual(warnings, ['RUNTIME_LOG_EACCES']); assert.equal((await normal.write('RUNNER_STARTED')).ok, true);
    assert.equal(await fs.readFile(path.join(f.paths.logsRoot, 'runtime.previous.jsonl'), 'utf8'), old);
    assert.ok((await normal.health()).recovered);
  }
});
test('disk-full and permission errors are bounded, nonrecursive, and cannot fail successful Runner work', async t => {
  const f = await fixture(t); const warnings = [];
  const failing = new RuntimeLog({ env: f.env, warning: code => warnings.push(code), fsApi: { ...fs, open: async () => { throw Object.assign(new Error('dummy-private-error'), { code: 'ENOSPC' }); } } });
  assert.equal((await failing.write('RUNNER_STARTED')).ok, false); assert.equal((await failing.write('RUNNER_STARTED')).ok, false);
  assert.deepEqual(warnings, ['RUNTIME_LOG_ENOSPC']);
  assert.equal((await failing.health()).lastError, 'RUNTIME_LOG_ENOSPC');
  let output = ''; const sink = { write: text => output += text };
  const ready = { canRun: true, status: 'ready', mode: 'local', profile: 'standard', requiredMissing: [], featureMissing: [], optionalMissing: [] };
  const code = await main(['--check', '--mode', 'local'], { env: f.env, cwd: f.app, stdout: sink, stderr: sink,
    runtimeLog: { write: async () => { throw new Error('dummy-private-error'); } }, runPreflightImpl: async () => ready });
  assert.equal(code, 0); assert.doesNotMatch(output, /dummy-private-error/); assert.match(output, /RUNTIME_LOG_UNAVAILABLE/);
});
test('unsafe links/hardlinks/unowned names fail closed and leave external/protected files untouched', async t => {
  const f = await fixture(t); const outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  await fs.mkdir(f.paths.userDataRoot, { recursive: true });
  await fs.symlink(outside, f.paths.logsRoot, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.log.write('RUNNER_STARTED')).ok, false); assert.deepEqual(await fs.readdir(outside), []);
  const g = await fixture(t); await fs.mkdir(g.paths.logsRoot, { recursive: true }); await fs.writeFile(g.current, 'user-owned-dummy');
  assert.equal((await g.log.write('RUNNER_STARTED')).ok, false); assert.equal(await fs.readFile(g.current, 'utf8'), 'user-owned-dummy');
  const h = await fixture(t); await h.log.write('RUNNER_STARTED'); const external = path.join(h.root, 'protected'); await fs.writeFile(external, 'external-dummy');
  await fs.unlink(h.current); await fs.link(external, h.current);
  assert.equal((await h.log.write('RUNNER_STARTED')).ok, false); assert.equal(await fs.readFile(external, 'utf8'), 'external-dummy');
});
test('dead local crash lock and owned staging recover; foreign/live claims are never taken over by Doctor', async t => {
  const f = await fixture(t); await f.log.write('RUNNER_STARTED'); const pid = await runNode(['--version'], f.env);
  const lock = path.join(f.paths.logsRoot, 'runtime.owner.json.lock');
  await fs.writeFile(lock, JSON.stringify({ owner: 'paperecho-runtime-log', hostname: os.hostname(), pid, createdAt: '2000-01-01T00:00:00Z' }));
  await fs.utimes(lock, 1, 1); await fs.writeFile(path.join(f.paths.logsRoot, 'runtime.pending.tmp'), 'uncommitted-dummy');
  const before = await snapshot(f.root); assert.equal((await f.log.health()).status, 'WARN'); assert.deepEqual(await snapshot(f.root), before);
  assert.equal((await f.log.write('RUNNER_STARTED')).ok, true); assert.equal((await records(f)).length, 2);
  await fs.writeFile(lock, JSON.stringify({ owner: 'paperecho-runtime-log', hostname: 'foreign-dummy', pid, createdAt: '2000-01-01T00:00:00Z' }));
  const foreign = await snapshot(f.root); assert.equal((await f.log.health()).status, 'UNKNOWN'); assert.deepEqual(await snapshot(f.root), foreign);
});
test('live lock contention fails explicitly within its bound without losing prior events or stealing ownership', async t => {
  const f = await fixture(t); assert.equal((await f.log.write('RUNNER_STARTED')).ok, true);
  const before = await fs.readFile(f.current, 'utf8'); const lock = path.join(f.paths.logsRoot, 'runtime.owner.json.lock');
  const lease = JSON.stringify({ owner: 'paperecho-runtime-log', hostname: os.hostname(), pid: process.pid });
  await fs.writeFile(lock, lease);
  const result = await new RuntimeLog({ env: f.env }).write('RUNNER_STARTED');
  assert.deepEqual(result, { ok: false, code: 'RUNTIME_LOG_UNAVAILABLE' });
  assert.equal(await fs.readFile(f.current, 'utf8'), before); assert.equal(await fs.readFile(lock, 'utf8'), lease);
  await fs.unlink(lock); assert.equal((await f.log.write('RUNNER_STARTED')).ok, true);
  assert.equal((await records(f)).length, 2);
  await assert.rejects(fs.access(lock)); await assert.rejects(fs.access(path.join(f.paths.logsRoot, 'runtime.pending.tmp')));
});

test('Doctor inspection is read-only and child output/errors never expose untrusted payloads', async t => {
  const f = await fixture(t); const before = await snapshot(f.root); assert.equal((await f.log.health()).status, 'WARN'); assert.deepEqual(await snapshot(f.root), before);
  await f.log.write('RUNNER_STARTED'); const owned = await snapshot(f.root); assert.equal((await f.log.health()).status, 'PASS'); assert.deepEqual(await snapshot(f.root), owned);
  let output = ''; const sink = { write: text => output += text }; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const promise = runProduction({ entry: 'dummy', args: [], childEnv: {}, cwd: f.root }, { stdout: sink, stderr: sink,
    spawnImpl: () => { queueMicrotask(() => { child.stdout.emit('data', 'dummy-private-paper-content\n'); child.stderr.emit('data', 'Error: dummy-token-value\n at dummy-stack\n'); child.emit('close', 0, null); }); return child; } });
  const result = await promise; assert.equal(result.code, 0); assert.match(result.stdout, /dummy-private/); assert.doesNotMatch(result.stderr + output, /dummy-/);
  output = ''; const code = await main(['--unknown=dummy-private-input'], { cwd: f.app, env: f.env, stdout: sink, stderr: sink, runtimeLog: f.log });
  assert.notEqual(code, 0); assert.doesNotMatch(output, /dummy-private-input/);
});
