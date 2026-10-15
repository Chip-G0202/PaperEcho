import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

export const repo = fileURLToPath(new URL('../../', import.meta.url));
export const sandboxBase = path.join(repo, 'tests', 'runs', 'electron-poc');
export const preferences = Object.freeze({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true });
export const failurePage = 'data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>PaperEcho</title><p>PaperEcho 无法连接本地工作空间。请关闭窗口后重试。</p>');
export function allowedDocument(value, origin) {
  try { const u = new URL(value); return u.origin === origin && u.pathname === '/' && !u.search && !u.username && !u.password; } catch { return false; }
}
export async function sandboxWorkspace(root = path.join(sandboxBase, 'workspace')) {
  root = path.resolve(root);
  const relative = path.relative(sandboxBase, root);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('SANDBOX_REQUIRED');
  await fs.mkdir(root, { recursive: true });
  // Resolve before any data writes: even a workspace symlink must stay in this PoC sandbox.
  if (await fs.realpath(sandboxBase) !== sandboxBase || path.relative(sandboxBase, await fs.realpath(root)).startsWith('..')) throw new Error('SANDBOX_REQUIRED');
  await fs.mkdir(path.join(root, 'config'), { recursive: true });
  const config = path.join(root, 'config', 'paperecho.config.json');
  try { await fs.writeFile(config, JSON.stringify({ schemaVersion: 2, mode: 'local', common: { projectRoot: root } }), { flag: 'wx' }); }
  catch (e) { if (e.code !== 'EEXIST') throw e; }
  return root;
}
export async function acquireServer(root, { port = 8765 } = {}) {
  // Never bootstrap the development .env or inherit provider credentials in this sandbox-only PoC.
  process.env.PAPERECHO_SKIP_DOTENV = '1';
  const { resolveControlCenterStartup, controlCenterInstance, startControlCenter } = await import('../../workflow/tools/web/server.mjs');
  const { controlCenterPorts, discoverControlCenter } = await import('../../workflow/tools/web/launcher.mjs');
  const startup = await resolveControlCenterStartup({ root, env: { PAPERECHO_SKIP_DOTENV: '1' }, argv: ['--mode', 'local', '--output-root', path.join(root, 'local')] });
  for (const value of [startup.context.projectRoot, startup.context.reviewRoot, startup.context.researchRoot, startup.context.configPath, startup.context.localRepository?.root]) {
    if (value && (path.relative(root, value).startsWith('..') || path.isAbsolute(path.relative(root, value)))) throw new Error('SANDBOX_REQUIRED');
  }
  const instance = controlCenterInstance(root, startup.context);
  const ports = controlCenterPorts(instance, port);
  for (let attempt = 0; attempt < ports.length; attempt++) {
    const selected = await discoverControlCenter(ports, instance);
    if (!selected) throw new Error('PORT_OCCUPIED');
    if (selected.status === 'same') return { url: selected.url, owned: false, context: startup.context, close: async () => {} };
    try {
      const running = await startControlCenter({ ...startup, port: selected.port });
      return { ...running, owned: true, context: startup.context, close: async () => {
        running.server.closeAllConnections();
        await new Promise(resolve => running.server.close(resolve));
      } };
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('PORT_OCCUPIED');
}
