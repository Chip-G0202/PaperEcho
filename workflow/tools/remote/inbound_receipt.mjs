import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withAtomicJsonLock, writeAtomicJson } from '../lib/atomic_json.mjs';

export const identityDigest = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export class InboundReceiptStore {
  constructor({ root, atomicWriter = writeAtomicJson, clock = () => new Date() }) { Object.assign(this, { root: path.resolve(root), atomicWriter, clock }); }
  async process(identity, { action, subject }, operation) {
    if (!/^[a-f0-9]{64}$/.test(identity) || !/^[a-f0-9]{64}$/.test(subject) || !['help', 'status', 'latest', 'radar', 'weekly', 'unsupported'].includes(action)) throw new Error('REMOTE_RECEIPT_ID_INVALID');
    await fs.mkdir(this.root, { recursive: true });
    if ((await fs.lstat(this.root)).isSymbolicLink()) throw new Error('REMOTE_RECEIPT_PATH_UNSAFE');
    const file = path.join(this.root, `${identity}.json`);
    return withAtomicJsonLock(file, async () => {
      try {
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8192) throw new Error('REMOTE_RECEIPT_INVALID');
        const old = JSON.parse(await fs.readFile(file, 'utf8'));
        if (old.schemaVersion !== 1 || old.provider !== 'qq' || old.identity !== identity || old.subject !== subject || old.action !== action || old.authorized !== true || !['started', 'completed', 'failed', 'unsupported', 'rate_limited'].includes(old.execution) || !['none', 'started', 'accepted', 'failed', 'unknown'].includes(old.reply)) throw new Error('REMOTE_RECEIPT_INVALID');
        // A crash at either started boundary is deliberately held. Execution and
        // uncertain replies are never repeated, even after a fresh gateway session.
        return { duplicate: true, receipt: old };
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const receipt = { schemaVersion: 1, provider: 'qq', identity, subject, action, authorized: true, execution: 'started', reply: 'none', at: this.clock().toISOString() };
      const save = async () => { receipt.at = this.clock().toISOString(); await this.atomicWriter(file, receipt); };
      await save();
      await operation(receipt, save);
      return { duplicate: false, receipt };
    }, { timeoutMs: 1000, staleMs: 600000 });
  }
}
