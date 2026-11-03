// Real browser UI: use the existing runtime, owners, authenticated HTTP and renderer.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
function installedRuntime() {
  if (!process.versions.electron) return null;
  const root = process.platform === 'darwin' ? path.resolve(process.execPath, '../..') : path.dirname(process.execPath);
  const resources = path.join(root, process.platform === 'darwin' ? 'Resources/core' : 'resources/core');
  return fs.existsSync(path.join(resources, 'desktop/electron-poc/headless.mjs')) ? { root, resources } : null;
}
function locations(applicationRoot, env) {
  const installed = installedRuntime();
  const root = applicationRoot || env.PAPERECHO_APPLICATION_ROOT || installed?.root || repo;
  const resources = env.PAPERECHO_RESOURCE_ROOT || (root === installed?.root ? installed.resources : root);
  const modules = fs.existsSync(path.join(repo, 'workflow/tools/web/server.mjs')) ? repo : resources;
  return { root, resources, modules };
}
const load = (root, file) => import(pathToFileURL(path.join(root, file)).href);
export async function browserEnvironment({ applicationRoot, env = process.env } = {}) {
  const { root, resources, modules } = locations(applicationRoot, env);
  const { resolveStartupEnvironment } = await load(modules, 'workflow/tools/lib/startup_location.mjs');
  const selected = await resolveStartupEnvironment({ applicationRoot: root, env });
  const next = { ...selected, PAPERECHO_LAYOUT: selected.PAPERECHO_LAYOUT || 'installed', PAPERECHO_APPLICATION_ROOT: root, PAPERECHO_RESOURCE_ROOT: resources };
  if (next.PAPERECHO_LAYOUT === 'dev') throw new Error('BROWSER_DEV_LAYOUT_FORBIDDEN');
  if (!next.PAPERECHO_DATA_ROOT && !next.PAPERECHO_WORKSPACE_ID) next.PAPERECHO_WORKSPACE_ID = 'default';
  return next;
}
export async function startBrowserWorkbench({ applicationRoot, env = process.env, port = 8765, openBrowser = false, openBrowserImpl } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('NODE_18_REQUIRED');
  const { root, modules } = locations(applicationRoot, env);
  const runtimeEnv = await browserEnvironment({ applicationRoot: root, env });
  // The existing dotenv module resolves its default path before checking skip.
  // Bind only the selected bootstrap paths during first import, never user secrets.
  const bootstrapKeys = ['PAPERECHO_SKIP_DOTENV','PAPERECHO_LAYOUT','PAPERECHO_APPLICATION_ROOT','PAPERECHO_RESOURCE_ROOT','PAPERECHO_DATA_ROOT','PAPERECHO_CACHE_ROOT','PAPERECHO_WORKSPACE_ID'];
  const previous = new Map(bootstrapKeys.map(key => [key, process.env[key]]));
  for (const key of bootstrapKeys) { if (runtimeEnv[key] === undefined) delete process.env[key]; else process.env[key] = runtimeEnv[key]; }
  process.env.PAPERECHO_SKIP_DOTENV = '1';
  let runtime, web, dotenv, launcher, owners;
  try {
    [runtime, web, dotenv, launcher, owners] = await Promise.all([
      load(modules, 'workflow/tools/lib/runtime_config.mjs'), load(modules, 'workflow/tools/web/server.mjs'),
      load(modules, 'workflow/tools/lib/env_file_bootstrap.mjs'), load(modules, 'workflow/tools/web/launcher.mjs'),
      load(modules, 'workflow/tools/lib/control_application_services.mjs'),
    ]);
  } finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
  const paths = runtime.prepareRuntimePaths(runtime.resolveRuntimePaths({ applicationRoot: root, env: runtimeEnv }));
  dotenv.loadDotEnv({ env: runtimeEnv });
  const startup = await web.resolveControlCenterStartup({ root, env: runtimeEnv });
  const instance = web.controlCenterInstance(root, startup.context);
  const ports = port === 0 ? [0] : launcher.controlCenterPorts(instance, port);
  let running;
  for (let attempt = 0; attempt < ports.length; attempt++) {
    const selected = port === 0 ? { port: 0, status: 'vacant' } : await launcher.discoverControlCenter(ports, instance);
    if (!selected) throw new Error('PORT_OCCUPIED');
    if (selected.status === 'same') { running = { url: selected.url, owned: false, close: async () => {} }; break; }
    const services = owners.createControlServices(startup);
    const automation = services.automation;
    // Browser startup/credential refresh only reads registration. Explicit user
    // automation saves retain ConfigService's existing afterSave owner and guards.
    services.automation = { status: () => automation.status(), reconcile: () => automation.status() };
    try {
      const server = await web.startControlCenter({ ...startup, services, host: '127.0.0.1', port: selected.port });
      running = { ...server, owned: true, close: async () => {
        server.server.closeAllConnections(); await new Promise(resolve => server.server.close(resolve));
      } }; break;
    } catch (error) { if (error.code !== 'EADDRINUSE' || port === 0) throw error; }
  }
  if (!running) throw new Error('PORT_OCCUPIED');
  await launcher.waitUntilReady(() => launcher.probeControlCenter(running.url, instance));
  let browserOpened = false;
  if (openBrowser) {
    try { await (openBrowserImpl || launcher.openDefaultBrowser)(running.url); browserOpened = true; }
    catch { /* Keep the owned foreground backend usable at its printed URL. */ }
  }
  return { ...running, context: startup.context, paths, browserOpened };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const env = { ...process.env }, args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--user-data-root' || !path.isAbsolute(args[1])) { console.error('启动参数无效。请使用绝对路径指定测试数据目录。'); process.exitCode = 1; }
    else { env.PAPERECHO_DATA_ROOT = args[1]; env.PAPERECHO_LAYOUT = 'installed'; }
  }
  if (!process.exitCode) startBrowserWorkbench({ env, openBrowser: true }).then(({ url, owned, close, browserOpened }) => {
    console.log(`PaperEcho 浏览器工作台（真实工作空间）：${url}/#home`);
    if (!browserOpened) console.error('无法自动打开浏览器，请复制上方地址到浏览器。');
    console.log(owned ? '停止：返回此终端按 Ctrl+C。关闭浏览器不会停止本地服务。' : '已复用现有工作空间服务；停止服务请返回原启动窗口。');
    if (owned) { const stop = () => { void close(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); }
  }).catch(error => {
    const diagnostic = error.code || error.message;
    if (/^[A-Z][A-Z0-9_]{1,80}$/.test(diagnostic || '')) console.error(`错误代码：${diagnostic}`);
    console.error(['PORT_OCCUPIED','EADDRINUSE'].includes(error.code || error.message) ? '启动端口被无法确认的程序占用，请关闭冲突程序后重试。' : '工作台启动失败。请确认 PaperEcho 已安装，或源码环境具备 Node.js 18+ 与项目依赖；原数据不会被清理。'); process.exitCode = 1;
  });
}
