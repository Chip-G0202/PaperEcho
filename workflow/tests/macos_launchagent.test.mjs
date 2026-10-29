import test from 'node:test';
import assert from 'node:assert/strict';
import { posix as path } from 'node:path';
import { MacLaunchAgent } from '../tools/lib/macos_launchagent.mjs';
import { scheduleSpec } from '../tools/lib/os_scheduler.mjs';
import { manageOsSchedule } from '../tools/lib/os_scheduler_management.mjs';

// In-memory POSIX metadata and a bounded launchctl boundary: never a Mac PASS.
function fixture() {
  const home = '/Users/lab', nodes = new Map(); let ino = 1;
  const add = (p, directory, text = '') => nodes.set(p, { dev: 1, ino: ino++, uid: p === '/Users' ? 0 : 501, mode: directory ? 0o40700 : 0o100600, nlink: 1, mtimeMs: ino, directory, text });
  const dirs = p => { if (p !== '/' && !nodes.has(p)) { dirs(path.dirname(p)); add(p, true); } };
  dirs(home); dirs(home + '/程序 & 空格/PaperEcho.app/Contents/MacOS'); dirs(home + '/数据'); dirs(home + '/缓存'); dirs(home + '/新缓存');
  add(home + '/程序 & 空格/PaperEcho.app/Contents/MacOS/PaperEcho', false, 'fixture executable');
  const get = p => { const node = nodes.get(p); if (!node) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return node; };
  const stat = node => ({ ...node, size: Buffer.byteLength(node.text), isFile: () => !node.directory, isDirectory: () => node.directory, isSymbolicLink: () => Boolean(node.symlink) });
  const fs = {
    lstat: async p => stat(get(p)),
    mkdir: async p => { if (nodes.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); get(path.dirname(p)); add(p, true); },
    open: async (p, flags) => {
      if (flags === 'wx') { if (nodes.has(p)) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); get(path.dirname(p)); add(p, false); }
      const node = get(p);
      return { stat: async () => stat(node), readFile: async () => node.text, writeFile: async text => { node.text = text; node.mtimeMs++; }, sync: async () => {}, close: async () => {} };
    },
    link: async (a, b) => { if (nodes.has(b)) throw new Error('exists'); const node = get(a); node.nlink++; nodes.set(b, node); },
    unlink: async p => { const node = get(p); nodes.delete(p); node.nlink--; },
    rename: async (a, b) => { const node = get(a); nodes.set(b, node); nodes.delete(a); },
  };
  const spec = scheduleSpec({ platform: 'darwin', paths: { applicationRoot: home + '/程序 & 空格', userDataRoot: home + '/数据', cacheRoot: home + '/缓存', layout: 'installed' },
    config: { schemaVersion: 6, mode: 'desktop', scheduler: { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' } } });
  const file = home + '/Library/LaunchAgents/' + spec.taskId + '.plist';
  const state = { loaded: false, calls: [], pid: null, fail: null, timezone: 'Asia/Shanghai', session: 'Aqua' };
  const execute = async (command, args, options) => {
    assert.equal(command, '/bin/launchctl'); assert.equal(options.shell, false); assert.equal(options.timeout, 15000);
    assert.deepEqual(Object.keys(options.env).sort(), ['HOME', 'PATH']); state.calls.push([...args]);
    if (state.fail === args[0]) throw new Error('private token must never escape');
    let stdout = '';
    if (args[0] === 'manageruid') stdout = '501\n';
    else if (args[0] === 'managername') stdout = state.session + '\n';
    else if (args[0] === 'print') assert.deepEqual(args, ['print', 'gui/501']);
    else if (args[0] === 'list') stdout = 'PID\tStatus\tLabel\n' + (state.loaded ? `${state.pid || '-'}\t0\t${spec.taskId}\n` : '');
    else if (args[0] === 'bootstrap') { assert.deepEqual(args, ['bootstrap', 'gui/501', file]); state.loaded = true; }
    else if (args[0] === 'bootout') { assert.deepEqual(args, ['bootout', `gui/501/${spec.taskId}`]); state.loaded = false; }
    else assert.fail('unexpected native operation');
    return { stdout };
  };
  const adapter = new MacLaunchAgent({ fsApi: fs, execute, platform: 'darwin', identity: () => ({ uid: 501, homedir: home }), timezone: () => state.timezone });
  return { adapter, fs, nodes, add, dirs, spec, file, state, run: (op, value = spec) => adapter.execute(op, value) };
}

test('canonical Mac POSIX paths, fixed cadence, explicit argv and current-user registration are idempotent', async () => {
  const f = fixture();
  assert.equal((await f.run('status')).status, 'not-installed');
  assert.equal((await f.run('register')).status, 'loaded');
  assert.equal((await f.run('register')).unchanged, true);
  assert.equal(f.state.calls.filter(x => x[0] === 'bootstrap').length, 1);
  const plist = f.nodes.get(f.file).text;
  assert.match(plist, /程序 &amp; 空格\/PaperEcho.app\/Contents\/MacOS\/PaperEcho/);
  assert.match(plist, /<key>Hour<\/key><integer>15<\/integer><key>Minute<\/key><integer>0/);
  assert.doesNotMatch(plist, /EnvironmentVariables|Authorization|sudo|\/Library\/LaunchDaemons/);
  assert.equal(f.nodes.get(f.file).mode, 0o100600);
  assert.equal((await f.run('query')).status, 'loaded');
  f.state.loaded = false; assert.equal((await f.run('status')).status, 'installed-not-loaded');
  assert.equal((await f.run('register')).status, 'loaded');
});

test('owned update unloads, atomically replaces, reloads and removes its previous definition', async () => {
  const f = fixture(); await f.run('register');
  const next = scheduleSpec({ platform: 'darwin', paths: { applicationRoot: f.spec.workingDirectory, userDataRoot: f.spec.userDataRoot, cacheRoot: '/Users/lab/新缓存', layout: 'installed' },
    config: { schemaVersion: 6, mode: 'web', scheduler: { schemaVersion: 1, enabled: true, time: '15:00', timezone: 'Asia/Shanghai' } } });
  assert.equal((await f.run('update', next)).status, 'loaded');
  assert.match(f.nodes.get(f.file).text, /新缓存/); assert.equal(f.nodes.has(f.file + '.previous'), false);
  assert.deepEqual(f.state.calls.filter(x => ['bootstrap', 'bootout'].includes(x[0])).map(x => x[0]), ['bootstrap', 'bootout', 'bootstrap']);
});

test('partial update retains the exact old definition and blocks further edits without claiming rollback', async () => {
  const f = fixture(); await f.run('register'); const old = f.nodes.get(f.file).text;
  f.state.fail = 'bootstrap';
  await assert.rejects(f.run('update', { ...f.spec, time: '14:00' }), /SCHEDULER_SPEC_INVALID/);
  // A canonical changed profile, with the same task identity and persistent root.
  const next = structuredClone(f.spec); next.args[12] = 'complete';
  await assert.rejects(f.run('update', next), /^Error: SCHEDULER_UPDATE_RECOVERY_REQUIRED$/);
  assert.equal(f.nodes.get(f.file + '.previous').text, old); assert.notEqual(f.nodes.get(f.file).text, old);
  f.state.fail = null; await assert.rejects(f.run('status'), /SCHEDULER_RECOVERY_REQUIRED/);
  assert.equal(f.nodes.has(f.file + '.lock'), false);
});

test('bootstrap and query failures are truthful, bounded and do not expose child errors', async () => {
  const f = fixture(); f.state.fail = 'bootstrap';
  await assert.rejects(f.run('register'), /^Error: SCHEDULER_REGISTER_UNCONFIRMED$/);
  assert.equal(f.nodes.has(f.file), true); assert.equal(f.state.loaded, false);
  f.state.fail = null; assert.equal((await f.run('status')).status, 'installed-not-loaded');
  f.state.fail = 'list'; await assert.rejects(f.run('status'), /^Error: SCHEDULER_LAUNCHCTL_FAILED$/);
});

test('unregister and repeat unregister only remove the owned task and plist, never business data', async () => {
  const f = fixture(); f.add(f.spec.userDataRoot + '/ledger.json', false, 'retained'); await f.run('register');
  assert.equal((await f.run('unregister')).status, 'not-installed'); assert.equal(f.state.loaded, false);
  assert.equal((await f.run('delete')).status, 'not-installed');
  assert.equal(f.nodes.get(f.spec.userDataRoot + '/ledger.json').text, 'retained'); assert.equal(f.nodes.has(f.file), false);
});

test('foreign files, wrong owners, broad permissions, links and running services are never adopted or removed', async () => {
  for (const change of [node => { node.uid = 502; }, node => { node.mode |= 0o022; }, node => { node.symlink = true; }, node => { node.nlink = 2; }, node => { node.text = '<plist>foreign</plist>'; }]) {
    const f = fixture(); await f.run('register'); change(f.nodes.get(f.file));
    const original = f.nodes.get(f.file).text;
    await assert.rejects(f.run('delete'), /SCHEDULER_PATH_UNSAFE|SCHEDULER_TASK_OWNERSHIP_MISMATCH/);
    assert.equal(f.nodes.get(f.file).text, original); assert.equal(f.state.loaded, true);
  }
  const f = fixture(); f.state.loaded = true; await assert.rejects(f.run('register'), /SCHEDULER_TASK_OWNERSHIP_MISMATCH/);
  const g = fixture(); await g.run('register'); g.state.pid = 42;
  await assert.rejects(g.run('delete'), /SCHEDULER_TASK_RUNNING/); assert.equal(g.state.loaded, true);
});

test('path/session/timezone/spec guards reject unsafe targets and preserve disabled calendar semantics', async () => {
  const f = fixture(); f.nodes.get('/Users/lab').symlink = true; await assert.rejects(f.run('register'), /SCHEDULER_PATH_UNSAFE/);
  const g = fixture(); g.state.session = 'Background'; await assert.rejects(g.run('register'), /SCHEDULER_GUI_SESSION_REQUIRED/);
  const h = fixture(); h.state.timezone = 'America/New_York'; await assert.rejects(h.run('register'), /SCHEDULER_HOST_TIMEZONE_REQUIRED/);
  await assert.rejects(h.run('register', { ...h.spec, taskId: '../../foreign' }), /SCHEDULER_SPEC_INVALID/);
  const i = fixture(); const disabled = { ...i.spec, enabled: false };
  assert.equal((await i.run('register', disabled)).status, 'installed-not-loaded');
  assert.equal(i.state.calls.some(x => x[0] === 'bootstrap'), false);
  assert.match(i.nodes.get(i.file).text, /<key>Disabled<\/key><true\/>/);
  await assert.rejects(i.run('run'), /SCHEDULER_ARGUMENT_INVALID/);
});

test('real execution cannot be enabled on Windows through an injected platform string', async () => {
  if (process.platform === 'darwin') return;
  const f = fixture(); await assert.rejects(new MacLaunchAgent({ platform: 'darwin' }).execute('register', f.spec), /SCHEDULER_MACOS_REQUIRED/);
  await assert.rejects(new MacLaunchAgent().execute('register', f.spec), /SCHEDULER_MACOS_REQUIRED/);
});

test('write/unload failures preserve old bytes, report recovery required and never leak private native errors', async () => {
  for (const failure of ['rename', 'bootout']) {
    const f = fixture(); await f.run('register'); const old = f.nodes.get(f.file).text;
    if (failure === 'rename') f.fs.rename = async () => { throw new Error('private-token-and-path'); };
    else f.state.fail = 'bootout';
    const next = structuredClone(f.spec); next.args[12] = 'complete';
    await assert.rejects(f.run('update', next), /^Error: SCHEDULER_UPDATE_RECOVERY_REQUIRED$/);
    assert.equal(f.nodes.get(f.file).text, old); assert.equal(f.nodes.get(f.file + '.previous').text, old);
    assert.equal(f.nodes.has(f.file + '.lock'), false);
  }
});

test('unsafe ancestor, forged spec and concurrent management cannot mutate a foreign destination; CLI Mac gate remains closed', async () => {
  const f = fixture(); f.dirs('/Users/lab/Library/LaunchAgents'); f.nodes.get('/Users/lab/Library').uid = 502;
  await assert.rejects(f.run('register'), /SCHEDULER_PATH_UNSAFE/); assert.equal(f.nodes.has(f.file), false);
  const g = fixture(); await g.run('register'); g.add(g.file + '.lock', false, 'foreign lock');
  await assert.rejects(g.run('delete'), /SCHEDULER_MANAGEMENT_BUSY/); assert.equal(g.nodes.get(g.file + '.lock').text, 'foreign lock');
  await assert.rejects(g.run('register', { ...g.spec, executable: '/bin/sh', secret: 'private-test-key' }), /^Error: SCHEDULER_SPEC_INVALID$/);
  await assert.rejects(manageOsSchedule('register', { inspect: async () => ({ status: 'UNKNOWN', spec: g.spec }), adapter: { execute: () => assert.fail('Mac CLI gate must not be bypassed') } }), /SCHEDULER_WINDOWS_SPEC_REQUIRED/);
});
