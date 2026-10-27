import fs from 'node:fs/promises';
import path from 'node:path';
import { readBoundedJson, readBoundedBytes, boundedDirectory, writeAtomicJson, withAtomicJsonLock } from './atomic_json.mjs';
import { secureCredentialFile } from './credential_file_security.mjs';
import { resolveRuntimePaths, assertRuntimeDataPath } from './runtime_config.mjs';
import { inspectRestoreTransaction } from '../recovery/restore_transaction_status.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };
const contains = (parent, child) => { const r = path.relative(parent, child); return !r.startsWith('..') && !path.isAbsolute(r); };
export function startupLocationFile(env) {
  if (!path.isAbsolute(env.LOCALAPPDATA || '')) fail('STARTUP_LOCAL_APPDATA_REQUIRED');
  return path.join(env.LOCALAPPDATA, 'PaperEcho', 'startup', 'location.json');
}
export const explicitStartupLocation = env => Boolean(env.PAPERECHO_LAYOUT || env.PAPERECHO_DATA_ROOT || env.PAPERECHO_WORKSPACE_ID || env.PAPERECHO_CACHE_ROOT);
function validateTarget(applicationRoot, env, target) {
  const paths = resolveRuntimePaths({ applicationRoot, env: { ...env, PAPERECHO_LAYOUT: 'installed', PAPERECHO_DATA_ROOT: target } });
  assertRuntimeDataPath(paths, paths.userDataRoot);
  const recordRoot = path.dirname(startupLocationFile(env));
  if (contains(paths.userDataRoot, recordRoot) || contains(recordRoot, paths.userDataRoot)) fail('STARTUP_RECORD_BOUNDARY');
  return paths;
}
// Called by the shared packaged bootstrap before preparing any data/cache/log owner.
export async function resolveStartupEnvironment({ applicationRoot, env, platform = process.platform }) {
  if (platform !== 'win32' || explicitStartupLocation(env)) return { ...env };
  const file = startupLocationFile(env);
  assertRuntimeDataPath({ layout: 'installed', userDataRoot: path.dirname(file) }, file);
  const bytes = await readBoundedBytes(path.dirname(file), file, { maxBytes: 4096 });
  if (bytes === null) return { ...env };
  await secureCredentialFile(file, { checkOnly: true });
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { fail('STARTUP_RECORD_INVALID'); }
  if (record.schemaVersion !== 1 || Object.keys(record).sort().join(',') !== 'dataRoot,schemaVersion' || typeof record.dataRoot !== 'string') fail('STARTUP_RECORD_INVALID');
  const paths = validateTarget(applicationRoot, env, record.dataRoot);
  // A removed target is not a fresh workspace: never silently recreate it.
  if (!(await fs.stat(paths.userDataRoot)).isDirectory()) fail('STARTUP_TARGET_MISSING');
  return { ...env, PAPERECHO_DATA_ROOT: paths.userDataRoot };
}
export async function assertFirstRunBlank(paths) {
  if (paths.layout !== 'installed' || paths.explicitDataRoot || inspectRestoreTransaction(paths.userDataRoot).state !== 'ABSENT') fail('STARTUP_SELECTION_UNAVAILABLE');
  assertRuntimeDataPath(paths, paths.userDataRoot);
  for (const entry of await boundedDirectory(paths.userDataRoot, 8)) {
    if (entry.name === 'config' && entry.isDirectory() && !(await boundedDirectory(path.join(paths.userDataRoot, 'config'), 1)).length) continue;
    if (entry.name !== 'logs' || !entry.isDirectory()) fail('STARTUP_DATA_PRESENT');
    const root = path.join(paths.userDataRoot, 'logs');
    const owner = await readBoundedJson(root, path.join(root, 'runtime.owner.json'), { maxBytes: 1024 });
    if (owner?.owner !== 'paperecho-runtime-log' || owner.schemaVersion !== 1) fail('STARTUP_DATA_PRESENT');
    for (const log of await boundedDirectory(root, 4)) {
      if (log.name === 'runtime.owner.json') continue;
      if (!['runtime.jsonl', 'runtime.previous.jsonl'].includes(log.name)) fail('STARTUP_DATA_PRESENT');
      const bytes = await readBoundedBytes(root, path.join(root, log.name), { maxBytes: 1048576 });
      for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
        const value = JSON.parse(line);
        if (!/^GUI_(STARTED|READY|EXIT|LOAD_FAILED|RENDERER_GONE|CHILD_GONE)$/.test(value.code)) fail('STARTUP_DATA_PRESENT');
      }
    }
  }
}
// Save only a location, never config/Secret copies; the next process initializes owners.
export async function saveFirstRunLocation({ applicationRoot, env, currentPaths, target, atomicOptions = {} }) {
  if (explicitStartupLocation(env)) fail('STARTUP_SELECTION_UNAVAILABLE');
  const paths = validateTarget(applicationRoot, env, target);
  if (contains(currentPaths.userDataRoot, paths.userDataRoot) || contains(paths.userDataRoot, currentPaths.userDataRoot) || contains(currentPaths.cacheRoot, paths.userDataRoot) || contains(paths.userDataRoot, currentPaths.cacheRoot)) fail('STARTUP_TARGET_BOUNDARY');
  const file = startupLocationFile(env);
  assertRuntimeDataPath({ layout: 'installed', userDataRoot: path.dirname(file) }, file);
  await withAtomicJsonLock(file, async () => {
    if (await readBoundedBytes(path.dirname(file), file, { maxBytes: 4096 }) !== null) fail('STARTUP_LOCATION_EXISTS');
    await assertFirstRunBlank(currentPaths);
    if (!(await fs.lstat(target)).isDirectory() || (await boundedDirectory(target, 1)).length) fail('STARTUP_TARGET_NOT_EMPTY');
    // Existing safe directory only; remove only our exclusive write probe.
    const probe = path.join(target, '.paperecho-first-run-write');
    const handle = await fs.open(probe, 'wx', 0o600);
    try { await handle.close(); } finally { await fs.unlink(probe); }
    await writeAtomicJson(file, { schemaVersion: 1, dataRoot: paths.userDataRoot }, { ...atomicOptions, validateTemporary: async temporary => {
      await secureCredentialFile(temporary);
      await atomicOptions.validateTemporary?.(temporary);
      await assertFirstRunBlank(currentPaths);
      if ((await boundedDirectory(target, 1)).length) fail('STARTUP_TARGET_NOT_EMPTY');
    } });
  }, { canBreakStaleLock: async () => false });
  return paths.userDataRoot;
}
