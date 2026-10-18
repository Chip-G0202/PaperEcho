import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { sandboxWorkspace, acquireServer, allowedDocument, allowedSupportDownload, preferences, failurePage } from './shell.mjs';
let runtimeLog;

export async function prepareShell({ workspace } = {}) {
  if (app.isPackaged) {
    const { preparePackagedRuntime } = await import(pathToFileURL(path.join(process.resourcesPath, 'core/desktop/electron-poc/runtime.mjs')).href);
    const paths = preparePackagedRuntime();
    for (const [key, directory] of [['userData', 'electron-profile'], ['sessionData', 'electron-session'], ['crashDumps', 'crashes']]) {
      const value = path.join(paths.cacheRoot, directory); await fs.mkdir(value, { recursive: true }); app.setPath(key, value);
    }
    app.setAppLogsPath(path.join(paths.cacheRoot, 'logs'));
    const { RuntimeLog } = await import(pathToFileURL(path.join(process.resourcesPath, 'core/workflow/tools/lib/runtime_logging.mjs')).href);
    runtimeLog = new RuntimeLog({ env: process.env, warning: code => process.stderr.write(`[logging] ${code}\n`) });
    await runtimeLog.write('GUI_STARTED', { subsystem: 'gui' });
    return paths.userDataRoot;
  }
  const root = await sandboxWorkspace(workspace);
  await Promise.all(['electron-profile', 'electron-session', 'crashes', '.cache/native-debug'].map(name => fs.mkdir(path.join(root, name), { recursive: true })));
  app.setPath('userData', path.join(root, 'electron-profile'));
  app.setPath('sessionData', path.join(root, 'electron-session'));
  app.setPath('crashDumps', path.join(root, 'crashes'));
  app.setAppLogsPath(path.join(root, '.cache/native-debug'));
  const { RuntimeLog } = await import('../../workflow/tools/lib/runtime_logging.mjs');
  runtimeLog = new RuntimeLog({ applicationRoot: root, env: { PAPERECHO_APPLICATION_ROOT: root }, warning: code => process.stderr.write(`[logging] ${code}\n`) });
  await runtimeLog.write('GUI_STARTED', { subsystem: 'gui' });
  return root;
}
export async function startShell({ root, show = true } = {}) {
  // The profile gives each sandbox workspace its own Electron single-instance lock.
  if (!app.requestSingleInstanceLock()) { app.quit(); return null; }
  let window; let lease; let quitting = false;
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } });
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    Promise.resolve(lease?.close()).finally(async () => { await runtimeLog?.write('GUI_EXIT', { subsystem: 'gui' }); app.quit(); });
  });
  app.on('window-all-closed', () => app.quit());
  await app.whenReady();
  const partition = session.fromPartition('paperecho-poc'); // Memory-only cookies, no shared browser profile.
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', (event, item, source) => {
    const allowed = source === window?.webContents && allowedSupportDownload({ url: item.getURL(), mime: item.getMimeType(),
      filename: item.getFilename(), bytes: item.getTotalBytes(), documentURL: source.getURL() }, origin);
    if (!allowed) { event.preventDefault(); return; }
    item.setSaveDialogOptions({ title: '保存 PaperEcho 诊断包', filters: [{ name: 'ZIP 诊断包', extensions: ['zip'] }] });
  });
  window = new BrowserWindow({ width: 1366, height: 768, minWidth: 390, minHeight: 600, show, autoHideMenuBar: true, webPreferences: { ...preferences, session: partition } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('render-process-gone', () => { void runtimeLog?.write('GUI_RENDERER_GONE', { subsystem: 'gui' }); });
  app.on('child-process-gone', () => { void runtimeLog?.write('GUI_CHILD_GONE', { subsystem: 'gui' }); });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  let origin;
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) window.webContents.on(name, (event, url) => {
    if (!origin || !allowedDocument(event.url || url, origin)) event.preventDefault();
  });
  try {
    lease = await acquireServer(root, app.isPackaged ? { env: process.env } : {});
    origin = new URL(lease.url).origin;
    partition.webRequest.onBeforeRequest((details, callback) => {
      // No remote network, file:, web sockets or alternate loopback listeners.
      callback({ cancel: details.url !== failurePage && new URL(details.url).origin !== origin });
    });
    await window.loadURL(lease.url);
    await runtimeLog?.write('GUI_READY', { subsystem: 'gui' });
  } catch {
    await runtimeLog?.write('GUI_LOAD_FAILED', { subsystem: 'gui' });
    await lease?.close(); lease = null;
    await window.loadURL(failurePage);
  }
  return { window, lease, root };
}
if (import.meta.url.startsWith(pathToFileURL(app.getAppPath()).href + '/') || process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (app.isPackaged && process.argv[1] === '--headless') {
    // Native executable entry: no shell, BrowserWindow, UI setup or single-instance
    // GUI lock. Production children use the already verified RunAsNode fuse.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    // Block the browser event loop until the embedded Node entry exits, before
    // Electron reaches ready. Runner owns workflow timeouts and child cleanup.
    const child = spawnSync(process.execPath, [path.join(process.resourcesPath, 'core/desktop/electron-poc/headless.mjs'), ...process.argv.slice(2)], { env, shell: false, windowsHide: true, stdio: 'inherit' });
    app.exit(child.status ?? 2);
  } else {
  const root = await prepareShell();
  if (app.isPackaged && process.argv.includes('--smoke')) {
    const { smoke } = await import(pathToFileURL(path.join(process.resourcesPath, 'core/tests/helpers/electron_smoke.mjs')).href);
    // The diagnostic runs only against an explicitly provisioned dummy workspace.
    if (await fs.readFile(path.join(root, '.packaged-smoke-fixture'), 'utf8') !== 'dummy-only') throw new Error('SMOKE_FIXTURE_REQUIRED');
    const outputRoot = process.argv.includes('--smoke-restore') ? path.join(process.env.PAPERECHO_CACHE_ROOT, 'smoke') : path.join(root, 'smoke');
    void smoke({ root, outputRoot, prepare: false, startShellImpl: startShell });
  } else {
  // Resolve the ESM entry before waiting for ready; only path setup is top-level awaited.
  startShell({ root }).catch(() => { process.stderr.write('PAPERECHO_POC_START_FAILED\n'); app.exit(1); });
  }
  }
}
