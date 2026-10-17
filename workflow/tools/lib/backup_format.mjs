import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';

export const BACKUP_LIMITS = Object.freeze({ files: 20000, fileBytes: 64 * 1048576, totalBytes: 256 * 1048576, manifestBytes: 8 * 1048576 });
const magic = Buffer.from('PEBK0001');
const derive = promisify(scrypt);
export const backupError = code => Object.assign(new Error(code), { code });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function backupPath(value) {
  if (typeof value !== 'string' || value.length > 1024 || value !== value.normalize('NFC') || value.split('/').some(p => !p || p === '.' || p === '..' || /[\\:\x00-\x1f\x7f]|[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw backupError('BACKUP_PATH_UNSAFE');
  return value;
}
function passwordCheck(password) {
  if (!Buffer.isBuffer(password) || password.length < 12 || password.length > 1024) throw backupError('BACKUP_PASSWORD_INVALID');
}
async function keyFor(password, salt) {
  passwordCheck(password);
  return derive(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1048576 });
}
export async function sealBackup(manifest, contents, password) {
  let key; let plain;
  try {
    const metadata = Buffer.from(JSON.stringify(manifest));
    if (metadata.length > BACKUP_LIMITS.manifestBytes) throw backupError('BACKUP_LIMIT_EXCEEDED');
    const length = Buffer.alloc(4); length.writeUInt32BE(metadata.length);
    plain = Buffer.concat([length, metadata, ...contents]);
    const header = Buffer.concat([magic, randomBytes(16), randomBytes(12)]);
    key = await keyFor(password, header.subarray(8, 24));
    const cipher = createCipheriv('aes-256-gcm', key, header.subarray(24)); cipher.setAAD(header);
    return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  } finally { key?.fill(0); plain?.fill(0); }
}
export async function openBackup(bytes, password, validateManifest, inspectFile = () => {}) {
  let key; let plain; let pending;
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 56 || bytes.length > BACKUP_LIMITS.totalBytes + BACKUP_LIMITS.manifestBytes + 56) throw backupError('BACKUP_FORMAT_INVALID');
    if (!bytes.subarray(0, 8).equals(magic)) throw backupError('BACKUP_FORMAT_UNSUPPORTED');
    const header = bytes.subarray(0, 36);
    key = await keyFor(password, header.subarray(8, 24));
    const decipher = createDecipheriv('aes-256-gcm', key, header.subarray(24)); decipher.setAAD(header); decipher.setAuthTag(bytes.subarray(-16));
    try { pending = decipher.update(bytes.subarray(36, -16)); plain = Buffer.concat([pending, decipher.final()]); }
    catch { throw backupError('BACKUP_AUTH_FAILED'); }
    if (plain.length < 4) throw backupError('BACKUP_FORMAT_INVALID');
    const size = plain.readUInt32BE();
    if (!size || size > BACKUP_LIMITS.manifestBytes || size + 4 > plain.length) throw backupError('BACKUP_MANIFEST_INVALID');
    let manifest; try { manifest = JSON.parse(plain.subarray(4, 4 + size).toString('utf8')); } catch { throw backupError('BACKUP_MANIFEST_INVALID'); }
    validateManifest(manifest);
    let offset = 4 + size;
    for (const file of manifest.files) {
      if (offset + file.size > plain.length || sha256(plain.subarray(offset, offset + file.size)) !== file.sha256) throw backupError('BACKUP_HASH_MISMATCH');
      inspectFile(file, plain.subarray(offset, offset + file.size));
      offset += file.size;
    }
    if (offset !== plain.length) throw backupError('BACKUP_CONTENT_MISMATCH');
    return manifest;
  } finally { key?.fill(0); plain?.fill(0); pending?.fill(0); }
}
