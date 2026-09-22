import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { startControlCenter, resolveControlCenterStartup, controlCenterInstance, CONTROL_CENTER_HOST, CONTROL_CENTER_PORT } from '../workflow/tools/web/server.mjs';
import { launchControlCenter, probeControlCenter, waitUntilReady, browserInvocation, requestLocal, LAUNCH_ERRORS } from '../workflow/tools/web/launcher.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url));
async function fixture(t) {
  const base = path.join(repo, 'tests', 'runs', 'control-launcher'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'space 中文 '));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 40 }));
  return root;
}
const mockServices = { secrets: { redact: (text) => text } };
async function server(t, options) {
  const app = await startControlCenter({ port: 0, services: mockServices, ...options });
  t.after(async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); });
  return app;
}
test('shared bootstrap resolves official Local runtime/config from an explicit spaced Unicode root', async (t) => {
  const root = await fixture(t); await fs.mkdir(path.join(root, 'config'));
  await fs.writeFile(path.join(root, 'config', 'paperecho.config.json'), JSON.stringify({ schemaVersion: 2, mode: 'local', common: { projectRoot: root } }));
  const startup = await resolveControlCenterStartup({ root, env: {}, argv: ['--mode', 'local', '--output-root', 'local output 中文'] });
  assert.equal(startup.context.mode, 'local');
  assert.ok(startup.context.localRepository.root.startsWith(root));
  assert.equal(startup.context.localRepository.root, path.join(root, 'local output 中文'));
  assert.equal(CONTROL_CENTER_HOST, '127.0.0.1'); assert.equal(CONTROL_CENTER_PORT, 8765);
  const app = await server(t, startup);
  assert.equal(await probeControlCenter(app.url, controlCenterInstance(root, startup.context)), true);
  const ready = await requestLocal(`${app.url}/api/ready`);
  assert.equal(JSON.stringify(ready.json).includes(root), false); assert.equal(JSON.stringify(ready.json).includes('local output'), false);
});
test('already-running same instance opens once without spawn, different workspace fails closed', async (t) => {
  const root = await fixture(t); const startup = { root, context: {} }; const app = await server(t, { root });
  let opened = 0;
  const result = await launchControlCenter({ root, port: app.server.address().port, resolveStartup: async () => startup, spawnImpl: () => assert.fail('duplicate child'), openBrowser: async (url) => { assert.equal(url, app.url); opened++; } });
  assert.equal(result.status, 'reused'); assert.equal(opened, 1);
  await assert.rejects(launchControlCenter({ port: app.server.address().port, resolveStartup: async () => ({ root: `${root}-other`, context: {} }), spawnImpl: () => assert.fail('must not spawn'), openBrowser: () => assert.fail('must not open') }), /PORT_OCCUPIED/);
});
test('startup opens browser only after readiness and spawns a detached shell-free shared bootstrap', async () => {
  const events = []; let attempts = 0; const child = new EventEmitter(); child.unref = () => events.push('unref');
  await launchControlCenter({ root: repo, argv: ['--mode', 'local'], resolveStartup: async () => ({ root: repo, context: {} }), probe: async () => ++attempts >= 3,
    spawnImpl: (exe, args, options) => { assert.equal(exe, process.execPath); assert.match(args[0], /web[\\/]launcher\.mjs$/); assert.deepEqual(args.slice(1), ['--serve', '--mode', 'local']); assert.equal(options.detached, true); assert.equal(options.windowsHide, true); assert.equal(options.shell, false); assert.equal(options.cwd, repo); events.push('spawn'); return child; },
    openBrowser: async () => { assert.ok(attempts >= 3); events.push('open'); } });
  assert.deepEqual(events, ['spawn', 'unref', 'open']);
});
test('readiness timeout is bounded and does not open browser; only owned child is terminated', async () => {
  await assert.rejects(waitUntilReady(async () => false, { timeoutMs: 5, intervalMs: 1 }), /READY_TIMEOUT/);
  const child = new EventEmitter(); child.unref = () => {}; child.exitCode = null; let killed = 0; child.kill = () => killed++;
  await assert.rejects(launchControlCenter({ resolveStartup: async () => ({ root: repo, context: {} }), probe: async () => false, timeoutMs: 5, spawnImpl: () => child, openBrowser: () => assert.fail('not ready') }), /READY_TIMEOUT/);
  assert.equal(killed, 1);
});
test('wrong service, redirects, oversized response and unresponsive port are rejected', async (t) => {
  const wrong = http.createServer((req, res) => { if (req.url === '/hang') return; res.end('unrelated service'); });
  await new Promise((resolve) => wrong.listen(0, '127.0.0.1', resolve));
  t.after(async () => { wrong.closeAllConnections(); await new Promise((resolve) => wrong.close(resolve)); });
  const url = `http://127.0.0.1:${wrong.address().port}`;
  await assert.rejects(probeControlCenter(url, 'anything'), /PORT_OCCUPIED/);
  await assert.rejects(requestLocal(`${url}/hang`, { timeoutMs: 20 }), /PORT_OCCUPIED/);
  await assert.rejects(probeControlCenter(url, 'anything', async () => ({ status: 302, json: {} })), /PORT_OCCUPIED/);
  wrong.removeAllListeners('request'); wrong.on('request', (_req, res) => res.end('x'.repeat(5000)));
  await assert.rejects(requestLocal(url), /PORT_OCCUPIED/);
});
test('readiness retains Host/CORS boundary; shutdown requires existing session, Origin and CSRF', async (t) => {
  const root = await fixture(t); const app = await server(t, { root });
  assert.equal((await requestLocal(`${app.url}/api/ready`, { headers: { Host: 'evil.test' } })).status, 403);
  assert.equal((await requestLocal(`${app.url}/api/ready`)).headers['access-control-allow-origin'], undefined);
  assert.equal((await requestLocal(`${app.url}/api/shutdown`, { method: 'POST', body: '{}' })).status, 403);
  const session = await requestLocal(`${app.url}/api/session`); const cookie = session.headers['set-cookie'][0].split(';')[0];
  const headers = { Cookie: cookie, 'Content-Type': 'application/json', Origin: app.url, 'X-CSRF-Token': session.json.token };
  assert.equal((await requestLocal(`${app.url}/api/shutdown`, { method: 'POST', headers: { ...headers, Origin: 'http://evil.test' }, body: '{}' })).status, 403);
  assert.equal((await requestLocal(`${app.url}/api/shutdown`, { method: 'POST', headers: { ...headers, 'X-CSRF-Token': 'wrong' }, body: '{}' })).status, 403);
  const result = await launchControlCenter({ root, stop: true, port: app.server.address().port, resolveStartup: async () => ({ root, context: {} }), openBrowser: () => assert.fail('stop must not open') });
  assert.equal(result.status, 'stopping');
  await waitUntilReady(async () => !(await probeControlCenter(app.url, controlCenterInstance(root))), { timeoutMs: 1000, intervalMs: 10 });
});
test('default-browser commands are fixed argv, never a browser-controlled shell or URL scheme', () => {
  assert.deepEqual(browserInvocation('http://127.0.0.1:8765', 'darwin'), { command: '/usr/bin/open', args: ['http://127.0.0.1:8765'] });
  const win = browserInvocation('http://127.0.0.1:8765', 'win32', { SystemRoot: 'C:\\Windows' });
  assert.match(win.command, /rundll32\.exe$/); assert.deepEqual(win.args, ['url.dll,FileProtocolHandler', 'http://127.0.0.1:8765']);
  for (const url of ['file:///tmp', 'http://evil.test', 'http://127.0.0.1:8765/?exec=x', 'http://user:pass@127.0.0.1:8765', 'javascript:alert(1)']) assert.throws(() => browserInvocation(url), /BROWSER_FAILED/);
});
test('Windows and macOS wrappers use their own path, fixed arguments and shared owner; no bundled runtime', async () => {
  const read = (file) => fs.readFile(path.join(repo, file), 'utf8');
  const source = await read('workflow/tools/web/launcher-windows/PaperEchoLauncher.cs'); const cmd = await read('PaperEcho.cmd'); const mac = await read('PaperEcho.app/Contents/MacOS/PaperEcho'); const plist = await read('PaperEcho.app/Contents/Info.plist');
  const ico = await fs.readFile(path.join(repo, 'workflow/tools/branding/PaperEcho.ico')); const icns = await fs.readFile(path.join(repo, 'workflow/tools/branding/PaperEcho.icns')); const bundledIcns = await fs.readFile(path.join(repo, 'PaperEcho.app/Contents/Resources/PaperEcho.icns'));
  // Historical EXE migration invariant: the retired VBS entry must not return.
  await assert.rejects(fs.access(path.join(repo, 'PaperEcho.vbs')), { code: 'ENOENT' });
  assert.ok((await fs.stat(path.join(repo, 'PaperEcho.exe'))).size > 0);
  assert.match(source, /AppDomain.CurrentDomain.BaseDirectory/);
  assert.match(source, /Path.Combine\(root, "workflow", "tools", "web", "launcher.mjs"\)/);
  assert.match(source, /args.Length != 0/); assert.match(source, /UseShellExecute = false/);
  assert.match(source, /CreateNoWindow = true/); assert.match(source, /WorkingDirectory = root/);
  assert.match(source, /child.WaitForExit\(\)/); assert.match(source, /MessageBox.Show/);
  assert.match(source, /Path.IsPathRooted/); assert.match(source, /Environment.GetEnvironmentVariable\("PATH"\)/);
  assert.doesNotMatch(source, /powershell\.exe|cmd\.exe|wscript|cscript|mshta|8765|HttpClient|Process.Start\("/i);
  const build = await read('workflow/tools/web/launcher-windows/build.ps1');
  assert.match(build, /\/target:winexe/); assert.match(build, /csc\.exe/);
  assert.match(build, /\/win32icon:\$icon/); assert.match(build, /workflow\/tools\/branding\/PaperEcho\.ico/);
  assert.match(build, /LASTEXITCODE -ne 0/); assert.match(build, /finally/);
  assert.doesNotMatch(build, /Invoke-WebRequest|ExecutionPolicy|Start-BitsTransfer|winget/i);
  assert.match(cmd, /%~dp0/); assert.doesNotMatch(cmd, /%\*/); assert.match(cmd, /--stop/);
  assert.ok(mac.startsWith('#!/bin/sh\n')); assert.doesNotMatch(mac, /\r|C:\\|GaoChen/); assert.match(mac, /launcher\.mjs/); assert.match(mac, /command -v node/); assert.match(mac, /osascript/);
  assert.match(plist, /CFBundleExecutable<\/key><string>PaperEcho<\/string>/); assert.match(plist, /CFBundleIconFile<\/key><string>PaperEcho\.icns<\/string>/); assert.match(plist, /LSUIElement<\/key><true\/>/);
  assert.equal(ico.readUInt16LE(0), 0); assert.equal(ico.readUInt16LE(2), 1); assert.equal(ico.readUInt16LE(4), 7); assert.deepEqual([...Array(7)].map((_, index) => ico[6 + index * 16] || 256), [16, 24, 32, 48, 64, 128, 256]);
  assert.equal(icns.subarray(0, 4).toString('ascii'), 'icns'); assert.equal(icns.readUInt32BE(4), icns.length); assert.deepEqual(icns, bundledIcns); for (const type of ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10']) assert.ok(icns.includes(Buffer.from(type)));
  const iconBuilder = await read('workflow/tools/branding/build-desktop-icons.mjs'); assert.match(iconBuilder, /paperecho-mark\.svg/); assert.match(iconBuilder, /\[16, 24, 32, 48, 64, 128, 256, 512, 1024\]/);
  assert.match(await read('PaperEcho.command'), /exec "\$repo_root\/PaperEcho\.app\/Contents\/MacOS\/PaperEcho"/);
  assert.match(LAUNCH_ERRORS.RUNTIME_REQUIRED[1], /Node\.js 18/);
});
