import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function writeAtomicJson(filePath, value, { fsApi = fs } = {}) {
  await fsApi.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fsApi.open(temporary, "wx");
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    if (typeof handle.sync === "function") await handle.sync();
    await handle.close();
    handle = null;
    await fsApi.rename(temporary, filePath);
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
} = {}) {
  const lockPath = `${filePath}.lock`;
  const deadline = clock().getTime() + timeoutMs;
  await fsApi.mkdir(path.dirname(filePath), { recursive: true });
  while (true) {
    let handle;
    try {
      handle = await fsApi.open(lockPath, "wx");
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: clock().toISOString() }));
        return await operation();
      } finally {
        await handle.close();
        await fsApi.unlink(lockPath).catch(() => {});
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error?.code !== "EEXIST") throw error;
      const stat = await fsApi.stat(lockPath).catch(() => null);
      if (stat && clock().getTime() - stat.mtimeMs > staleMs) {
        await fsApi.unlink(lockPath).catch(() => {});
        continue;
      }
      if (clock().getTime() >= deadline) throw new Error(`ATOMIC_JSON_LOCK_TIMEOUT:${path.basename(filePath)}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
