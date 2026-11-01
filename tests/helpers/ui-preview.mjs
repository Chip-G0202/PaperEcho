// Preview only; excluded from packaged application source allowlists.
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repo, 'tests/runs/ui-preview');
const activeFile = path.join(base, 'active.json');
const request = (url, token, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'X-Preview-Token': token || '' }, timeout: 2000 }, res => {
    let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('PREVIEW_RESPONSE_INVALID')); } });
  });
  req.on('timeout', () => req.destroy(new Error('PREVIEW_TIMEOUT'))); req.on('error', reject); req.end();
});
let active;
try { active = JSON.parse(await fs.readFile(activeFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (active && !/^http:\/\/127\.0\.0\.1:\d+$/.test(active.url)) throw new Error('PREVIEW_ADDRESS_INVALID');
if (process.argv.includes('--stop')) {
  if (!active) console.log('No saved preview session.');
  else console.log(await request(active.url + '/__preview_stop', active.token, 'POST').catch(() => ({ stopped: false, reason: 'Preview is no longer reachable; no process was killed.' })));
} else {
  let running;
  if (active) running = await request(active.url + '/__preview_status', active.token).catch(() => null);
  if (running?.kind === 'PAPERECHO_UI_PREVIEW') {
    console.log(JSON.stringify({ reused: true, url: active.url, html: active.html, sourceCommit: running.sourceCommit }));
  } else {
    const root = path.join(base, randomUUID()); await fs.mkdir(root, { recursive: true });
    const applicationRoot = path.join(root, 'program'), dataRoot = path.join(root, 'data');
    await fs.mkdir(applicationRoot); await fs.mkdir(dataRoot);
    // This must precede dynamic imports: never bootstrap a developer/user .env.
    for (const name of Object.keys(process.env)) if (/API_KEY|TOKEN|SECRET|PASS|^PAPERECHO_|^TITLE_TRANSLATION_|^PREFERENCE_LEARNING_|^SMTP_|^ZOTERO_|^LLM_/.test(name)) delete process.env[name];
    Object.assign(process.env, { PAPERECHO_SKIP_DOTENV: '1', PAPERECHO_LAYOUT: 'installed', PAPERECHO_APPLICATION_ROOT: applicationRoot, PAPERECHO_RESOURCE_ROOT: applicationRoot, PAPERECHO_DATA_ROOT: dataRoot });
    const [{ startControlCenter }, { CONFIG_REGISTRY }, { CONTROL_SECRET_NAMES }] = await Promise.all([
      import('../../workflow/tools/web/server.mjs'), import('../../workflow/tools/lib/control_config_service.mjs'), import('../../workflow/tools/lib/credential_registry.mjs'),
    ]);
    const metadata = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
    const seed = { version: metadata.version, sourceCommit, registry: CONFIG_REGISTRY, secretNames: CONTROL_SECRET_NAMES };
    const staticRoot = path.join(repo, 'workflow/tools/web/static');
    const [index, css, js, svg, adapter, capabilities] = await Promise.all([
      fs.readFile(path.join(staticRoot, 'index.html'), 'utf8'), fs.readFile(path.join(staticRoot, 'styles.css'), 'utf8'),
      fs.readFile(path.join(staticRoot, 'app.js'), 'utf8'), fs.readFile(path.join(staticRoot, 'paperecho-mark.svg')),
      fs.readFile(new URL('./ui-preview-adapter.mjs', import.meta.url), 'utf8'), fs.readFile(path.join(repo, 'workflow/tools/lib/ai_capabilities.cjs'), 'utf8'),
    ]);
    const scriptSafe = value => value.replace(/<\/script/gi, '<\\/script');
    const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'";
    const html = index.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${policy}">`)
      .replace('<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`)
      .replace('<script src="/ai-capabilities.js" defer></script>', '')
      .replace('<script src="/app.js" defer></script>', '')
      .replaceAll('/paperecho-mark.svg?v=2.4', 'data:image/svg+xml;base64,' + svg.toString('base64'))
      .replace('</body>', `<script>${scriptSafe(capabilities)}</script><script>${scriptSafe(adapter)}\ninstallPaperEchoPreview(${JSON.stringify(seed).replaceAll('<', '\\u003c')});</script><script>${scriptSafe(js)}</script></body>`);
    const htmlFile = path.join(root, 'PaperEcho-workbench-preview.html'); await fs.writeFile(htmlFile, html, { flag: 'wx' });
    // Reuse the existing loopback HTTP owner; never construct real application services.
    const app = await startControlCenter({ root, port: 0, env: {}, context: { userDataRoot: dataRoot }, services: { secrets: { redact: value => value } } });
    app.server.removeAllListeners('request');
    const token = randomBytes(24).toString('hex');
    app.server.on('request', (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
      if (req.headers.host !== new URL(app.url).host) { res.writeHead(403).end(); return; }
      if (req.url === '/__preview_status' || req.url === '/__preview_stop') {
        if (req.headers['x-preview-token'] !== token) { res.writeHead(403).end(); return; }
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/__preview_stop' && req.method === 'POST') { res.end(JSON.stringify({ stopped: true })); app.server.close(); return; }
        res.end(JSON.stringify({ kind: 'PAPERECHO_UI_PREVIEW', sourceCommit })); return;
      }
      if (req.method !== 'GET' || req.url !== '/') { res.writeHead(404).end('Preview only: no business API is available.'); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Content-Security-Policy', policy); res.end(html);
    });
    await fs.writeFile(activeFile, JSON.stringify({ url: app.url, html: htmlFile, token, sourceCommit }), { mode: 0o600 });
    const close = () => app.server.close(); process.on('SIGINT', close); process.on('SIGTERM', close);
    console.log(JSON.stringify({ url: app.url, html: htmlFile, sourceCommit, stop: 'npm run preview:ui -- --stop', mode: 'MEMORY_ONLY_MOCK_NO_BUSINESS_SERVICES' }));
  }
}
