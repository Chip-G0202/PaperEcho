import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveRuntimePaths, prepareRuntimePaths } from '../../workflow/tools/lib/runtime_config.mjs';
import { inspectRestoreTransaction, restoreTransactionRoot } from '../../workflow/tools/recovery/restore_transaction_status.mjs';

// Explicit bootstrap argv is shared by native OS tasks and the console entry.
// Resolve and validate through Runtime Root before any config, dotenv or writes.
export function applyHeadlessRuntimeArguments(argv, env = process.env) {
  const keys = { '--runtime-layout': 'PAPERECHO_LAYOUT', '--user-data-root': 'PAPERECHO_DATA_ROOT', '--cache-root': 'PAPERECHO_CACHE_ROOT' };
  const next = { ...env }; const seen = new Set(); const remaining = [];
  for (let i = 0; i < argv.length; i++) {
    const key = keys[argv[i]];
    if (!key) { remaining.push(argv[i]); continue; }
    const value = argv[++i];
    if (seen.has(key) || typeof value !== 'string' || !value || value.startsWith('--') || /[\u0000-\u001f]/.test(value)) throw new Error('HEADLESS_RUNTIME_ARGUMENT_INVALID');
    if (key !== 'PAPERECHO_LAYOUT' && !path.isAbsolute(value)) throw new Error('HEADLESS_RUNTIME_ARGUMENT_INVALID');
    next[key] = value; seen.add(key);
  }
  if (seen.size && (!seen.has('PAPERECHO_LAYOUT') || !seen.has('PAPERECHO_DATA_ROOT') || !['portable', 'installed'].includes(next.PAPERECHO_LAYOUT))) throw new Error('HEADLESS_RUNTIME_ARGUMENT_INVALID');
  for (const key of seen) env[key] = next[key];
  return remaining;
}

// This file lives in resources/core, shared by the packaged GUI and console entry.
export function preparePackagedRuntime({ readOnly = false } = {}) {
  const core = fileURLToPath(new URL('../../', import.meta.url));
  const applicationRoot = path.resolve(core, '../..');
  if (process.env.PAPERECHO_LAYOUT === 'dev') throw new Error('PACKAGED_DEV_LAYOUT_FORBIDDEN');
  Object.assign(process.env, {
    PAPERECHO_LAYOUT: process.env.PAPERECHO_LAYOUT || 'installed',
    PAPERECHO_APPLICATION_ROOT: applicationRoot,
    PAPERECHO_RESOURCE_ROOT: core,
  });
  // A stable packaged workspace lets a fresh GUI reach setup; Headless uses the same owner.
  if (!process.env.PAPERECHO_DATA_ROOT && !process.env.PAPERECHO_WORKSPACE_ID) process.env.PAPERECHO_WORKSPACE_ID = 'default';
  if (process.type !== 'browser') process.env.ELECTRON_RUN_AS_NODE = '1';
  let paths = resolveRuntimePaths({ env: process.env });
  if (process.type === 'browser' && inspectRestoreTransaction(paths.userDataRoot).blocking) {
    // Chromium needs writable profile files even for a read-only recovery screen.
    // Keep them outside the switching data root, under the private transaction.
    process.env.PAPERECHO_CACHE_ROOT = path.join(restoreTransactionRoot(paths.userDataRoot), 'gui-cache');
    paths = resolveRuntimePaths({ env: process.env });
    prepareRuntimePaths(paths, { readOnly: true });
    fs.mkdirSync(paths.tempRoot, { recursive: true, mode: 0o700 });
  }
  paths = prepareRuntimePaths(paths, { readOnly });
  Object.assign(process.env, { TEMP: paths.tempRoot, TMP: paths.tempRoot, TMPDIR: paths.tempRoot });
  return paths;
}
