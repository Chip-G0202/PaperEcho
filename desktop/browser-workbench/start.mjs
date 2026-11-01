// Real local workbench: reuse the desktop's root resolver, services and HTTP UI.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveRuntimePaths, prepareRuntimePaths } from '../../workflow/tools/lib/runtime_config.mjs';
import { resolveStartupEnvironment } from '../../workflow/tools/lib/startup_location.mjs';
const repo = fileURLToPath(new URL('../../', import.meta.url));

export async function browserEnvironment({ applicationRoot = repo, env = process.env } = {}) {
  const selected = await resolveStartupEnvironment({ applicationRoot, env });
  const next = { ...selected, PAPERECHO_LAYOUT: selected.PAPERECHO_LAYOUT || 'installed', PAPERECHO_APPLICATION_ROOT: applicationRoot, PAPERECHO_RESOURCE_ROOT: applicationRoot };
  if (next.PAPERECHO_LAYOUT === 'dev') throw new Error('BROWSER_DEV_LAYOUT_FORBIDDEN');
  if (!next.PAPERECHO_DATA_ROOT && !next.PAPERECHO_WORKSPACE_ID) next.PAPERECHO_WORKSPACE_ID = 'default';
  return next;
}
export async function startBrowserWorkbench({ applicationRoot = repo, env = process.env, port = 8765 } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('NODE_18_REQUIRED');
  const runtimeEnv = await browserEnvironment({ applicationRoot, env });
  const paths = prepareRuntimePaths(resolveRuntimePaths({ applicationRoot, env: runtimeEnv }));
  // Prevent an import-time fallback to the developer's dotenv; explicitly load only selected data.
  const previous = process.env.PAPERECHO_SKIP_DOTENV; process.env.PAPERECHO_SKIP_DOTENV = '1';
  let web, dotenv;
  try { [web, dotenv] = await Promise.all([import('../../workflow/tools/web/server.mjs'), import('../../workflow/tools/lib/env_file_bootstrap.mjs')]); }
  finally { if (previous === undefined) delete process.env.PAPERECHO_SKIP_DOTENV; else process.env.PAPERECHO_SKIP_DOTENV = previous; }
  dotenv.loadDotEnv({ env: runtimeEnv });
  const startup = await web.resolveControlCenterStartup({ root: applicationRoot, env: runtimeEnv });
  const running = await web.startControlCenter({ ...startup, host: '127.0.0.1', port });
  return { ...running, context: startup.context, paths };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const env = { ...process.env };
  const args = process.argv.slice(2);
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--user-data-root' || !path.isAbsolute(args[1])) throw new Error('WORKBENCH_ARGUMENT_INVALID');
    env.PAPERECHO_DATA_ROOT = args[1]; env.PAPERECHO_LAYOUT = 'installed';
  }
  startBrowserWorkbench({ env }).then(({ server, url }) => {
    console.log(`PaperEcho 本地 HTML 工作台（真实数据）：${url}\n停止：返回此终端按 Ctrl+C。`);
    const stop = () => { server.closeAllConnections(); server.close(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  }).catch(error => { console.error(error.code === 'EADDRINUSE' ? 'WORKBENCH_ALREADY_RUNNING: 请先关闭桌面版或已有工作台。' : /^[A-Z_]+$/.test(error.message) ? error.message : 'WORKBENCH_START_FAILED'); process.exitCode = 1; });
}
