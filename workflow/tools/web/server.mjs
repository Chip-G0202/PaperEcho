import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { createControlServices } from '../lib/control_application_services.mjs';
import '../lib/env_file_bootstrap.mjs';
import { resolveApplicationRuntimeContext } from '../lib/runtime_config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const CONTROL_CENTER_HOST = '127.0.0.1';
export const CONTROL_CENTER_PORT = 8765;
export const CONTROL_CENTER_PRODUCT = 'PaperEcho Control Center';
export const CONTROL_CENTER_ROOT = path.resolve(here, '../../..');
export function controlCenterInstance(root, context = {}) {
  return createHash('sha256').update(JSON.stringify([path.resolve(root), context.configPath, context.mode, context.reviewRoot, context.researchRoot, context.localRepository?.root])).digest('hex');
}
export async function resolveControlCenterStartup({ root = CONTROL_CENTER_ROOT, env = process.env, argv = [] } = {}) {
  const context = await resolveApplicationRuntimeContext({ cwd: root, env, argv });
  return { root, env, argv, context };
}
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']], ['/app.js', ['app.js', 'text/javascript; charset=utf-8']], ['/styles.css', ['styles.css', 'text/css; charset=utf-8']], ['/paperecho-mark.svg', ['paperecho-mark.svg', 'image/svg+xml']]]);
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
export async function startControlCenter({ root = CONTROL_CENTER_ROOT, host = CONTROL_CENTER_HOST, port = CONTROL_CENTER_PORT, services, env = process.env, argv = [], context } = {}) {
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('LOOPBACK_BIND_REQUIRED');
  if (!services) {
    context ||= (await resolveControlCenterStartup({ root, env, argv })).context;
    services = createControlServices({ root, env, context });
  }
  const instance = controlCenterInstance(root, context);
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
      if (req.method === 'GET' && decoded === '/api/ready') return send(200, { product: CONTROL_CENTER_PRODUCT, protocol: 1, ready: true, instance });
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
        if (decoded === '/api/pending-summary') return send(200, await services.review.pendingSummary());
        if (decoded === '/api/settings') return send(200, await services.config.list());
        if (decoded === '/api/credentials') return send(200, await services.secrets.list());
        if (decoded === '/api/suggestions') {
          const list = await services.rules.list();
          return send(200, list.map((entry) => Object.fromEntries(['id', 'suggestion_id', 'target', 'change_type', 'rule_text', 'suggested_rule', 'rationale', 'evidence_titles', 'evidence_text_excerpt', 'risk_level', 'status', 'content_issue', 'decision_receipt'].map((key) => [key, entry[key]]))));
        }
      }
      if (req.method !== 'POST') return send(405, { error: 'METHOD_NOT_ALLOWED' });
      if (req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: 'ORIGIN_REJECTED' });
      if (!equal(req.headers['x-csrf-token'], token)) return send(403, { error: 'CSRF_REQUIRED' });
      const input = await body(req);
      if (decoded === '/api/shutdown') {
        res.once('finish', () => {
          const timer = setTimeout(() => server.closeAllConnections(), 2000); timer.unref();
          server.close(() => clearTimeout(timer)); server.closeIdleConnections?.();
        });
        return send(202, { status: 'stopping' });
      }
      if (decoded === '/api/credentials') {
        if (input.action === 'replace') return send(200, await services.secrets.replace(input.id, input.value));
        if (input.action === 'clear') return send(200, await services.secrets.clear(input.id));
        return send(400, { error: 'CREDENTIAL_ACTION_NOT_SUPPORTED' });
      }
      if (decoded === '/api/feedback') {
        const paper = await services.review.resolvePaper(input.runId, input.paperId);
        const kind = input.manualGrade ? 'manual_grade' : 'paper_feedback';
        return send(200, await services.feedback.submit({ kind, paper, requestId: input.requestId, value: input.value, manualGrade: input.manualGrade, reason: input.reason }));
      }
      if (decoded === '/api/research') return send(200, await services.feedback.submit({ kind: 'research_evaluation', text: input.text, requestId: input.requestId }));
      if (decoded === '/api/decision') return send(200, await services.feedback.submit({ kind: 'rule_decision', id: input.id, decision: input.decision, revisedRule: input.revisedRule, humanApproval: input.humanApproval }));
      if (decoded === '/api/settings') return send(200, Array.isArray(input.updates) ? await services.config.updateMany(input.updates) : await services.config.update(input.id, input.value));
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
  startControlCenter({ argv: process.argv.slice(2) }).then(({ url }) => { console.log(`PaperEcho Control Center: ${url}`); }).catch(() => { console.error('CONTROL_CENTER_START_FAILED'); process.exitCode = 1; });
}
