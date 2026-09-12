import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createControlServices } from '../lib/control_application_services.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']]]);
export const MAX_BODY_BYTES = 65536;
export function safeLink(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
}
const equal = (a, b) => typeof a === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('CONTENT_TYPE_INVALID');
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new Error('BODY_INVALID'); }
}
export async function startControlCenter({ root = path.resolve(here, '../../..'), host = '127.0.0.1', port = 8765, services } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('LOOPBACK_BIND_REQUIRED');
  services ||= createControlServices({ root });
  const session = randomBytes(32).toString('hex');
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(services.secrets.redact(JSON.stringify(value)));
    };
    try {
      const actualPort = server.address().port;
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`]);
      if (!allowedHosts.has(req.headers.host)) return send(403, { error: 'HOST_REJECTED' });
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(403, { error: 'CROSS_SITE_REJECTED' });
      const rawPath = req.url.split('?')[0];
      const decoded = decodeURIComponent(rawPath);
      if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) return send(404, { error: 'NOT_FOUND' });
      const url = new URL(req.url, `http://${req.headers.host}`);
      const cookieName = `paperecho_${actualPort}`;
      if (req.method === 'GET' && decoded === '/api/session') {
        res.setHeader('Set-Cookie', `${cookieName}=${session}; HttpOnly; SameSite=Strict; Path=/`);
        return send(200, { token });
      }
      if (req.method === 'GET' && assets.has(decoded)) {
        const [name, type] = assets.get(decoded);
        res.writeHead(200, { 'Content-Type': type });
        return res.end(await fs.readFile(path.join(here, 'static', name)));
      }
      if (!decoded.startsWith('/api/')) return send(404, { error: 'NOT_FOUND' });
      const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!equal(cookie, session)) return send(403, { error: 'SESSION_REQUIRED' });
      if (req.method === 'GET') {
        if (decoded === '/api/status') return send(200, await services.review.status());
        if (decoded === '/api/weekly') return send(200, await services.review.weekly({ offset: Number(url.searchParams.get('offset') || 0), limit: Number(url.searchParams.get('limit') || 50) }));
        if (decoded === '/api/settings') return send(200, await services.config.list());
        if (decoded === '/api/credentials') return send(200, services.secrets.list());
        if (decoded === '/api/suggestions') {
          const list = await services.rules.list();
          return send(200, list.map((entry) => Object.fromEntries(['id', 'suggestion_id', 'target', 'change_type', 'rule_text', 'suggested_rule', 'rationale', 'evidence_titles', 'evidence_text_excerpt', 'risk_level', 'status'].map((key) => [key, entry[key]]))));
        }
      }
      if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'ORIGIN_REJECTED' });
      if (!equal(req.headers['x-csrf-token'], token)) return send(403, { error: 'CSRF_REQUIRED' });
      const input = await body(req);
      if (decoded === '/api/feedback') {
        const paper = await services.review.resolvePaper(input.runId, input.paperId);
        return send(200, await services.feedback.submit({ kind: 'paper_feedback', paper, requestId: input.requestId, value: input.value, reason: input.reason }));
      }
      if (decoded === '/api/research') return send(200, await services.feedback.submit({ kind: 'research_evaluation', text: input.text, requestId: input.requestId }));
      if (decoded === '/api/decision') return send(200, await services.feedback.submit({ kind: 'rule_decision', id: input.id, decision: input.decision, revisedRule: input.revisedRule, humanApproval: input.humanApproval }));
      if (decoded === '/api/settings') return send(200, await services.config.update(input.id, input.value));
      return send(404, { error: 'NOT_FOUND' });
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      const code = /^[A-Z][A-Z_]{1,80}$/.test(error.message || '') ? error.message : 'REQUEST_FAILED';
      send(code === 'BODY_TOO_LARGE' ? 413 : 400, { error: code });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return { server, url: `http://${host === '::1' ? '[::1]' : host}:${server.address().port}` };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startControlCenter().then(({ url }) => { console.log(`PaperEcho Control Center: ${url}`); }).catch(() => { console.error('CONTROL_CENTER_START_FAILED'); process.exitCode = 1; });
}
