import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveRuntimePaths, prepareRuntimePaths } from '../../workflow/tools/lib/runtime_config.mjs';
import { inspectRestoreTransaction, restoreTransactionRoot } from '../../workflow/tools/recovery/restore_transaction_status.mjs';

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
