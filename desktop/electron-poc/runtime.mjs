import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRuntimePaths, prepareRuntimePaths } from '../../workflow/tools/lib/runtime_config.mjs';

// This file lives in resources/core, shared by the packaged GUI and console entry.
export function preparePackagedRuntime() {
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
  const paths = prepareRuntimePaths(resolveRuntimePaths({ env: process.env }));
  Object.assign(process.env, { TEMP: paths.tempRoot, TMP: paths.tempRoot, TMPDIR: paths.tempRoot });
  return paths;
}
