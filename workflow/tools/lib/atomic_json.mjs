import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { assertRestoreWritable } from '../recovery/restore_transaction_status.mjs';

const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EACCES", "EBUSY"]);

// Bounded read-only inspection; never follow a linked directory or special file.
export async function readBoundedJson(root, file, { maxBytes = 1048576 } = {}) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('INSPECTION_PATH_UNSAFE');
  try {
    for (let dir = path.resolve(file); ; dir = path.dirname(dir)) {
      const stat = await fs.lstat(dir);
      if (stat.isSymbolicLink()) throw new Error('INSPECTION_PATH_UNSAFE');
      if (dir === path.dirname(dir)) break;
    }
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error('INSPECTION_FILE_UNSAFE');
      const buffer = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new Error('INSPECTION_LIMIT');
      return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function boundedDirectory(directory, limit = 100) {
  try {
    for (let dir = path.resolve(directory); ; dir = path.dirname(dir)) {
      if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error('INSPECTION_PATH_UNSAFE');
      if (dir === path.dirname(dir)) break;
    }
    const entries = [];
    for await (const entry of await fs.opendir(directory)) {
      if (entries.length === limit) throw new Error('INSPECTION_LIMIT');
      entries.push(entry);
    }
    return entries;
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export async function renameWithTransientRetry(source, target, {
  renameImpl = (from, to) => fs.rename(from, to),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempts = 4,
  backoffMs = 10,
} = {}) {
  const maximum = Math.max(1, Number(attempts || 1));
  for (let attempt = 1; ; attempt++) {
    try {
      await renameImpl(source, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= maximum) throw error;
      await sleep(Math.max(0, Number(backoffMs || 0)) * (2 ** (attempt - 1)));
    }
  }
}

export async function writeAtomicJson(filePath, value, options = {}) {
  return writeAtomicText(filePath, `${JSON.stringify(value, null, 2)}\n`, options);
}

export async function writeAtomicText(filePath, value, {
  fsApi = fs,
  renameImpl = (source, target) => fsApi.rename(source, target),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  renameAttempts = 4,
  renameBackoffMs = 10,
  validateTemporary = async () => {},
  temporaryPath = '',
  stagingGuard,
} = {}) {
  assertRestoreWritable(filePath, { stagingGuard });
  await fsApi.mkdir(path.dirname(filePath), { recursive: true });
  if (temporaryPath && (path.dirname(temporaryPath) !== path.dirname(filePath) || temporaryPath === filePath)) throw new Error('ATOMIC_TEMPORARY_PATH_INVALID');
  const temporary = temporaryPath || `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsApi.open(temporary, "wx");
    await handle.writeFile(value, "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    await validateTemporary(temporary);
    assertRestoreWritable(filePath, { stagingGuard });
    await renameWithTransientRetry(temporary, filePath, {
      renameImpl,
      sleep,
      attempts: renameAttempts,
      backoffMs: renameBackoffMs,
    });
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsApi.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function withAtomicJsonLock(filePath, operation, {
  fsApi = fs,
  timeoutMs = 5000,
  staleMs = 30000,
  clock = () => new Date(),
  metadata = {},
  canBreakStaleLock = async () => true,
  stagingGuard,
} = {}) {
  assertRestoreWritable(filePath, { stagingGuard });
  const lockPath = `${filePath}.lock`;
  const deadline = clock().getTime() + timeoutMs;
  await fsApi.mkdir(path.dirname(filePath), { recursive: true });
  while (true) {
    let handle;
    try {
      handle = await fsApi.open(lockPath, "wx");
      try {
        assertRestoreWritable(filePath, { stagingGuard });
        await handle.writeFile(JSON.stringify({ ...metadata, pid: process.pid, createdAt: clock().toISOString() }));
        return await operation();
      } finally {
        await handle.close();
        await fsApi.unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const stat = await fsApi.stat(lockPath).catch(() => null);
      if (stat && clock().getTime() - stat.mtimeMs > staleMs && await canBreakStaleLock(lockPath, stat)) {
        await fsApi.unlink(lockPath).catch(() => {});
        continue;
      }
      if (clock().getTime() >= deadline) throw new Error(`ATOMIC_JSON_LOCK_TIMEOUT:${path.basename(filePath)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
