import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { sandboxWorkspace, acquireServer, allowedDocument, preferences, failurePage } from './shell.mjs';

export async function prepareShell({ workspace } = {}) {
  const root = await sandboxWorkspace(workspace);
  await Promise.all(['electron-profile', 'electron-session', 'crashes', 'logs'].map(name => fs.mkdir(path.join(root, name), { recursive: true })));
  app.setPath('userData', path.join(root, 'electron-profile'));
  app.setPath('sessionData', path.join(root, 'electron-session'));
  app.setPath('crashDumps', path.join(root, 'crashes'));
  app.setAppLogsPath(path.join(root, 'logs'));
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
    Promise.resolve(lease?.close()).finally(() => app.quit());
  });
  app.on('window-all-closed', () => app.quit());
  await app.whenReady();
  const partition = session.fromPartition('paperecho-poc'); // Memory-only cookies, no shared browser profile.
  partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  partition.setPermissionCheckHandler(() => false);
  partition.on('will-download', event => event.preventDefault());
  window = new BrowserWindow({ width: 1366, height: 768, minWidth: 390, minHeight: 600, show, autoHideMenuBar: true, webPreferences: { ...preferences, session: partition } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  let origin;
  for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) window.webContents.on(name, (event, url) => {
    if (!origin || !allowedDocument(event.url || url, origin)) event.preventDefault();
  });
  try {
    lease = await acquireServer(root);
    origin = new URL(lease.url).origin;
    partition.webRequest.onBeforeRequest((details, callback) => {
      // No remote network, file:, web sockets or alternate loopback listeners.
      callback({ cancel: details.url !== failurePage && new URL(details.url).origin !== origin });
    });
    await window.loadURL(lease.url);
  } catch {
    await lease?.close(); lease = null;
    await window.loadURL(failurePage);
  }
  return { window, lease, root };
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const root = await prepareShell();
  // Resolve the ESM entry before waiting for ready; only path setup is top-level awaited.
  startShell({ root }).catch(() => { process.stderr.write('PAPERECHO_POC_START_FAILED\n'); app.exit(1); });
}
