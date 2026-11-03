// Build-only, offline SVG rasterization with an existing Chrome installation.
// The committed icons let Windows builds run without any conversion tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const source = path.join(repo, 'workflow/tools/web/static/paperecho-mark.svg');
const icons = fileURLToPath(new URL('./icons/', import.meta.url));
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
export function pngPixels(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), type = bytes[25];
  assert.equal(bytes[24], 8); assert.ok([2, 6].includes(type)); assert.equal(bytes[28], 0);
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = bytes.readUInt32BE(offset); const tag = bytes.toString('ascii', offset + 4, offset + 8);
    if (tag === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + size));
    offset += size + 12;
  }
  const channels = type === 6 ? 4 : 3, stride = width * channels;
  const packed = inflateSync(Buffer.concat(chunks)), raw = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => { const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c); return x <= y && x <= z ? a : y <= z ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = packed[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? raw[y * stride + x - channels] : 0, up = y ? raw[(y - 1) * stride + x] : 0, corner = y && x >= channels ? raw[(y - 1) * stride + x - channels] : 0;
      const predict = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, corner)][filter];
      raw[y * stride + x] = (packed[y * (stride + 1) + 1 + x] + predict) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) { raw.copy(rgba, i * 4, i * channels, i * channels + 3); rgba[i * 4 + 3] = channels === 4 ? raw[i * channels + 3] : 255; }
  return { width, height, rgba };
}
export function icoFile(images) {
  const header = Buffer.alloc(6 + images.length * 16); header.writeUInt16LE(1, 2); header.writeUInt16LE(images.length, 4);
  let offset = header.length; const parts = [header];
  images.forEach((png, index) => {
    const { width: size, height, rgba } = pngPixels(png); assert.equal(size, height); assert.ok(size <= 256);
    const maskStride = Math.ceil(size / 32) * 4, pixels = size * size * 4;
    const dib = Buffer.alloc(40 + pixels + maskStride * size);
    dib.writeUInt32LE(40); dib.writeInt32LE(size, 4); dib.writeInt32LE(size * 2, 8); dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14); dib.writeUInt32LE(pixels, 20);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const src = (y * size + x) * 4, dst = 40 + ((size - y - 1) * size + x) * 4;
      dib[dst] = rgba[src + 2]; dib[dst + 1] = rgba[src + 1]; dib[dst + 2] = rgba[src]; dib[dst + 3] = rgba[src + 3];
      if (!rgba[src + 3]) dib[40 + pixels + (size - y - 1) * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
    const entry = 6 + index * 16; header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6); header.writeUInt32LE(dib.length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    parts.push(dib); offset += dib.length;
  });
  return Buffer.concat(parts);
}
export async function generateIcons() {
  if (process.platform !== 'darwin') throw new Error('ICON_GENERATION_MAC_REQUIRED');
  const svg = await fs.readFile(source); assert.match(svg.toString(), /viewBox="0 0 64 64"/); assert.doesNotMatch(svg.toString(), /<script|href=|foreignObject/);
  await fs.mkdir(path.join(repo, 'tests/runs/branding'), { recursive: true });
  const stage = await fs.mkdtemp(path.join(repo, 'tests/runs/branding/render-')); const profile = path.join(stage, 'profile');
  await fs.mkdir(path.join(stage, 'home')); await fs.mkdir(icons, { recursive: true });
  const child = spawn(process.env.PAPERECHO_ICON_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--no-default-browser-check', '--use-mock-keychain', '--password-store=basic', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { env: { HOME: path.join(stage, 'home'), PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  let ws;
  try {
    let port;
    for (let n = 0; n < 100 && !port; n++) { try { port = Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch {} await new Promise(r => setTimeout(r, 50)); }
    assert.ok(port, 'ICON_BROWSER_START_FAILED');
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let serial = 0; const calls = new Map(); ws.onmessage = ({ data }) => { const message = JSON.parse(data); calls.get(message.id)?.(message); };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial, timer = setTimeout(() => { calls.delete(id); reject(new Error('ICON_RENDER_TIMEOUT')); }, 5000);
      calls.set(id, value => { calls.delete(id); clearTimeout(timer); value.error ? reject(new Error('ICON_RENDER_FAILED')) : resolve(value.result); }); ws.send(JSON.stringify({ id, method, params }));
    });
    await call('Page.enable'); await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    const html = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg{width:100%;height:100%;display:block}</style>${svg}`;
    await call('Page.navigate', { url: 'data:text/html;base64,' + Buffer.from(html).toString('base64') });
    const pngs = new Map();
    for (const size of sizes) {
      await call('Emulation.setDeviceMetricsOverride', { width: size, height: size, deviceScaleFactor: 1, mobile: false });
      await new Promise(r => setTimeout(r, 60));
      const png = Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'); const image = pngPixels(png);
      assert.equal(image.width, size); assert.equal(image.height, size); assert.equal(image.rgba[3], 0); assert.ok(image.rgba.some((value, i) => i % 4 === 3 && value === 255));
      pngs.set(size, png); await fs.writeFile(path.join(stage, `${size}.png`), png);
    }
    await fs.writeFile(path.join(icons, 'paperecho.png'), pngs.get(256));
    await fs.writeFile(path.join(icons, 'paperecho.ico'), icoFile(sizes.filter(s => s <= 256).map(s => pngs.get(s))));
    const iconset = path.join(stage, 'PaperEcho.iconset'); await fs.mkdir(iconset);
    for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) await fs.writeFile(path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`), pngs.get(size * scale));
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', path.join(icons, 'paperecho.icns'), iconset]);
    await fs.writeFile(path.join(icons, 'source.json'), JSON.stringify({ source: 'workflow/tools/web/static/paperecho-mark.svg', sha256: createHash('sha256').update(svg).digest('hex'), icoSizes: sizes.filter(s => s <= 256), icnsSizes: [16,32,64,128,256,512,1024], background: 'transparent' }, null, 2) + '\n');
    console.log(JSON.stringify({ icons, rasterStage: stage, sourceSha256: createHash('sha256').update(svg).digest('hex') }));
  } finally { ws?.close(); child.kill('SIGTERM'); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await generateIcons();
