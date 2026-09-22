import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const brandingDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(brandingDir, '../../..');
const source = path.join(repoRoot, 'workflow', 'tools', 'web', 'static', 'paperecho-mark.svg');
const windowsIcon = path.join(brandingDir, 'PaperEcho.ico');
const macIcon = path.join(brandingDir, 'PaperEcho.icns');
const appIcon = path.join(repoRoot, 'PaperEcho.app', 'Contents', 'Resources', 'PaperEcho.icns');
const rasterSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
async function waitForFile(file, attempts = 50) { for (let index = 0; index < attempts; index++) { if (await exists(file)) return true; await new Promise((resolve) => setTimeout(resolve, 100)); } return false; }
async function findRenderer() {
  const candidates = [
    process.env.PAPERECHO_CHROMIUM,
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' : null,
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : null,
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
    process.platform === 'darwin' ? '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' : null,
  ].filter(Boolean);
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  throw new Error('A local Chromium/Edge renderer is required; nothing was installed or downloaded.');
}
function pngSize(data) {
  if (!data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid PNG output.');
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}
function buildIco(images) {
  const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(images.length * 16); let offset = header.length + entries.length;
  images.forEach(({ size, data }, index) => {
    const row = index * 16; entries[row] = size === 256 ? 0 : size; entries[row + 1] = size === 256 ? 0 : size;
    entries.writeUInt16LE(1, row + 4); entries.writeUInt16LE(32, row + 6); entries.writeUInt32LE(data.length, row + 8); entries.writeUInt32LE(offset, row + 12); offset += data.length;
  });
  return Buffer.concat([header, entries, ...images.map(({ data }) => data)]);
}
function buildIcns(images) {
  const types = new Map([[16, 'icp4'], [32, 'icp5'], [64, 'icp6'], [128, 'ic07'], [256, 'ic08'], [512, 'ic09'], [1024, 'ic10']]);
  const chunks = images.filter(({ size }) => types.has(size)).map(({ size, data }) => { const header = Buffer.alloc(8); header.write(types.get(size), 0, 4, 'ascii'); header.writeUInt32BE(data.length + 8, 4); return Buffer.concat([header, data]); });
  const header = Buffer.alloc(8); header.write('icns', 0, 4, 'ascii'); header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

const renderer = await findRenderer();
const temporary = await fs.mkdtemp(path.join(brandingDir, '.icon-build-'));
try {
  const images = [];
  for (const size of rasterSizes) {
    const html = path.join(temporary, `${size}.html`); const png = path.join(temporary, `${size}.png`); const profile = path.join(temporary, `profile-${size}`);
    await fs.writeFile(html, `<!doctype html><style>html,body{margin:0;width:${size}px;height:${size}px;overflow:hidden;background:transparent}body{display:grid;place-items:center}img{width:78%;height:78%;object-fit:contain}</style><img src="${pathToFileURL(source).href}" alt="">`);
    const result = spawnSync(renderer, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--force-device-scale-factor=1', '--default-background-color=00000000', `--user-data-dir=${profile}`, `--window-size=${size},${size}`, `--screenshot=${png}`, pathToFileURL(html).href], { encoding: 'utf8', windowsHide: true });
    if (!(await waitForFile(png))) throw new Error(`Icon raster failed at ${size}px: ${result.error?.message || result.stderr || result.stdout || 'renderer did not produce a PNG'}`);
    const data = await fs.readFile(png); const [width, height] = pngSize(data); if (width !== size || height !== size) throw new Error(`Unexpected ${width}x${height} PNG for ${size}px icon.`);
    images.push({ size, data });
  }
  await fs.writeFile(windowsIcon, buildIco(images.filter(({ size }) => size <= 256)));
  const icns = buildIcns(images); await fs.writeFile(macIcon, icns); await fs.copyFile(macIcon, appIcon);
  console.log(`Built PaperEcho desktop icons from ${path.relative(repoRoot, source)} using ${path.basename(renderer)}.`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
}
