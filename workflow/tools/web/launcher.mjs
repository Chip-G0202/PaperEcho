import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startControlCenter, resolveControlCenterStartup, controlCenterInstance, CONTROL_CENTER_HOST, CONTROL_CENTER_PORT, CONTROL_CENTER_ROOT, CONTROL_CENTER_PRODUCT } from './server.mjs';

const launcherPath = fileURLToPath(import.meta.url);
export const LAUNCH_ERRORS = {
  RUNTIME_REQUIRED: [2, '未检测到所需运行环境。请安装或配置 Node.js 18 及以上版本；启动器不会自动安装运行环境。'],
  PORT_OCCUPIED: [3, 'Control Center 候选端口已被未知或无法验证的程序占用，或安全候选已用尽。请使用诊断入口检查；启动器不会强杀已有进程。'],
  READY_TIMEOUT: [4, 'Control Center 未在规定时间内就绪。请使用诊断入口检查运行环境和配置。'],
  START_FAILED: [5, 'Control Center 无法启动。请检查项目配置、Node.js 版本与依赖；原数据未修改。'],
  BROWSER_FAILED: [6, 'Control Center 已就绪，但无法打开默认浏览器。请重新运行启动器或使用诊断入口确认该工作区的实际地址。'],
};
export function localUrl(port = CONTROL_CENTER_PORT) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('START_FAILED');
  return `http://${CONTROL_CENTER_HOST}:${port}`;
}
// Strictly bounded local HTTP, no redirects, credentials or filesystem paths.
export function requestLocal(url, { method = 'GET', headers = {}, body, timeoutMs = 700 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; if (text.length > 4096) { reject(new Error('PORT_OCCUPIED')); req.destroy(); res.destroy(); } });
      res.on('error', reject);
      res.on('end', () => { let json; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    const timer = setTimeout(() => req.destroy(new Error('LISTENER_TIMEOUT')), timeoutMs);
    req.once('close', () => clearTimeout(timer)); req.once('error', reject);
    req.end(body);
  });
}
export async function inspectControlCenter(url, instance, request = requestLocal) {
  let result;
  try { result = await request(`${url}/api/ready`); }
  catch (error) { return error.code === 'ECONNREFUSED' ? 'vacant' : error.message === 'PORT_OCCUPIED' ? 'foreign' : 'unresponsive'; }
  const ready = result.json;
  if (result.status !== 200 || ready?.product !== CONTROL_CENTER_PRODUCT || ready.protocol !== 1 || ready.ready !== true || !/^[a-f0-9]{64}$/.test(ready.instance || '')) return 'foreign';
  return ready.instance === instance ? 'same' : 'other';
}
export async function probeControlCenter(url, instance, request = requestLocal) {
  const status = await inspectControlCenter(url, instance, request);
  if (status === 'same') return true;
  if (status === 'vacant') return false;
  throw new Error('PORT_OCCUPIED');
}
export function controlCenterPorts(instance, port = CONTROL_CENTER_PORT) {
  localUrl(port);
  const first = 19000 + Number.parseInt(instance.slice(0, 8), 16) % 30000;
  // ponytail: eight deterministic alternates; exhaustion fails closed.
  return [...new Set([port, ...Array.from({ length: 8 }, (_, index) => first + index)])];
}
async function discoverControlCenter(ports, instance, probe) {
  let vacant = null;
  for (const port of ports) {
    const url = localUrl(port); const status = await probe(url, instance);
    if (status === 'same') return { port, url, status };
    if (status === 'vacant') vacant ??= { port, url, status };
    else if (status !== 'other') throw new Error('PORT_OCCUPIED');
  }
  // Search all candidates before using a vacancy: an existing alternate may
  // still serve this workspace after the original 8765 instance stopped.
  return vacant;
}
export async function waitUntilReady(probe, { timeoutMs = 15000, intervalMs = 150, startupError = () => null } = {}) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await probe()) return;
    const failure = startupError(); if (failure && failure !== 'EADDRINUSE') throw new Error('START_FAILED');
    if (Date.now() >= deadline) break;
    await delay(Math.min(intervalMs, deadline - Date.now()));
  } while (Date.now() <= deadline);
  throw new Error('READY_TIMEOUT');
}
export function browserInvocation(url, platform = process.platform, env = process.env) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== CONTROL_CENTER_HOST || !target.port || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('BROWSER_FAILED');
  if (platform === 'win32') return { command: path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe'), args: ['url.dll,FileProtocolHandler', target.origin] };
  if (platform === 'darwin') return { command: '/usr/bin/open', args: [target.origin] };
  return { command: 'xdg-open', args: [target.origin] };
}
export async function openDefaultBrowser(url, { spawnImpl = spawn, platform = process.platform, env = process.env } = {}) {
  const { command, args } = browserInvocation(url, platform, env);
  await new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('BROWSER_FAILED')); }, 10000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('BROWSER_FAILED')); });
    child.once('exit', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('BROWSER_FAILED')); });
  });
}
export async function launchControlCenter({ root = CONTROL_CENTER_ROOT, env = process.env, argv = [], port = CONTROL_CENTER_PORT, stop = false, resolveStartup = resolveControlCenterStartup, spawnImpl = spawn, openBrowser = openDefaultBrowser, probe = inspectControlCenter, timeoutMs = 15000 } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('RUNTIME_REQUIRED');
  const startup = await resolveStartup({ root, env, argv });
  const instance = controlCenterInstance(startup.root, startup.context);
  const ports = controlCenterPorts(instance, port);
  let selected = await discoverControlCenter(ports, instance, probe);
  if (stop) {
    if (selected?.status !== 'same') return { status: 'not_running' };
    const { url } = selected;
    const session = await requestLocal(`${url}/api/session`);
    const cookie = session.headers['set-cookie']?.[0]?.split(';')[0];
    if (!cookie || typeof session.json?.token !== 'string') throw new Error('START_FAILED');
    if (await probe(url, instance) !== 'same') throw new Error('PORT_OCCUPIED');
    const result = await requestLocal(`${url}/api/shutdown`, { method: 'POST', headers: { Cookie: cookie, Origin: url, 'X-CSRF-Token': session.json.token, 'Content-Type': 'application/json' }, body: '{}' });
    if (result.status !== 202) throw new Error('START_FAILED');
    return { status: 'stopping' };
  }
  for (let attempt = 0; attempt < ports.length; attempt++) {
    if (!selected) throw new Error('PORT_OCCUPIED');
    const { url, port: selectedPort } = selected;
    if (selected.status === 'same') { await openBrowser(url); return { status: 'reused', url }; }
    // OS port binding arbitrates concurrent launchers. A losing child exits;
    // no PID files, locks, unrelated process termination or daemon manager.
    const child = spawnImpl(process.execPath, [launcherPath, '--serve', '--port', String(selectedPort), ...argv], { cwd: startup.root, env, detached: true, windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let failure = null; let bound = false;
    child.on('error', () => { failure = 'START_FAILED'; });
    child.on('message', (message) => { if (message?.ready) bound = true; if (message?.error) failure = message.error === 'EADDRINUSE' ? 'EADDRINUSE' : 'START_FAILED'; });
    child.on('exit', (code) => { if (code && !failure) failure = 'START_FAILED'; });
    child.unref(); child.channel?.unref();
    try {
      await waitUntilReady(async () => {
        const status = await probe(url, instance);
        if (status === 'other') throw new Error('OTHER_INSTANCE');
        if (!['same', 'vacant'].includes(status)) throw new Error('PORT_OCCUPIED');
        return status === 'same' && (bound || failure === 'EADDRINUSE');
      }, { timeoutMs, startupError: () => failure });
    } catch (error) {
      if (child.exitCode === null) child.kill(); // Only this launcher's own failed child.
      if (error.message !== 'OTHER_INSTANCE') throw error;
      selected = await discoverControlCenter(ports, instance, probe);
      continue;
    }
    await openBrowser(url);
    return { status: bound ? 'started' : 'reused', url };
  }
  throw new Error('PORT_OCCUPIED');
}
async function main() {
  const argv = process.argv.slice(2); const serve = argv[0] === '--serve'; const stop = argv[0] === '--stop';
  if (serve || stop) argv.shift();
  if (serve) {
    try {
      const port = argv[0] === '--port' ? Number(argv.splice(0, 2)[1]) : CONTROL_CENTER_PORT;
      localUrl(port);
      await startControlCenter({ root: process.cwd(), argv, port }); process.send?.({ ready: true });
    }
    catch (error) { process.send?.({ error: error.code === 'EADDRINUSE' ? 'EADDRINUSE' : 'START_FAILED' }); process.exitCode = 5; }
    finally { if (process.connected) process.disconnect(); }
    return;
  }
  try { const result = await launchControlCenter({ argv, stop }); console.log(`PaperEcho: ${result.status}${result.url ? ` ${result.url}` : ''}`); }
  catch (error) { const [code, text] = LAUNCH_ERRORS[error.message] || LAUNCH_ERRORS.START_FAILED; console.error(`PaperEcho 无法启动：${text}`); process.exitCode = code; }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
