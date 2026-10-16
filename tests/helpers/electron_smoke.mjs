// Actual Electron entry: no providers, no workflow execution, dummy sandbox only.
import { app, BrowserWindow } from 'electron';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareShell, startShell } from '../../desktop/electron-poc/main.mjs';
import { sandboxBase, allowedDocument, failurePage } from '../../desktop/electron-poc/shell.mjs';
export async function smoke({ root, outputRoot = sandboxBase, prepare = true } = {}) {
const began = performance.now();
let shell;
const report = { platform: process.platform, electron: process.versions.electron, node: process.versions.node, pathEmpty: !process.env.PATH, checks: [], consoleErrors: [], runtimeErrors: [], rendererGone: [] };
let securityProbe = false;
app.on('web-contents-created', (_event, wc) => {
  wc.on('console-message', (_event, level, message, _line, source) => {
    if (level !== 3) return;
    if (report.expectedConfigFailure && /status of 400/.test(message) && /^http:\/\/127\.0\.0\.1:\d+\/api\/settings$/.test(source || '')) { report.expectedConfigFailureMessages = (report.expectedConfigFailureMessages || 0) + 1; return; }
    if (securityProbe && /file:\/\/\/dummy|https:\/\/example\.invalid/.test(message) && /Content Security Policy|Refused to connect/.test(message)) return;
    report.consoleErrors.push(message.slice(0, 240));
  });
  wc.on('render-process-gone', (_event, details) => report.rendererGone.push({ reason: details.reason, exitCode: details.exitCode }));
});
const write = async (file, value) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(value)); };
if (prepare) root = await prepareShell({ workspace: path.join(sandboxBase, 'smoke') });
await fs.mkdir(outputRoot, { recursive: true });
try {
  shell = await startShell({ root });
  assert.ok(shell?.lease); const { window, lease } = shell; const wc = window.webContents;
  wc.debugger.attach('1.3');
  wc.debugger.on('message', (_event, method, params) => { if (method === 'Runtime.exceptionThrown') report.runtimeErrors.push(params.exceptionDetails.text); });
  await wc.debugger.sendCommand('Runtime.enable');
  report.startupMs = Math.round(performance.now() - began);
  if (await fs.access(path.join(root, '.first-run-smoke.json')).then(() => true, () => false)) {
    const { wizardSmoke } = await import('./first_run_smoke.mjs');
    await wizardSmoke({ window, root, outputRoot, report });
    report.processes = app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type }));
    wc.debugger.detach();
    app.once('will-quit', () => { report.ownedServerClosed = !lease.server.listening; writeFileSync(path.join(outputRoot, 'smoke-report.json'), JSON.stringify(report)); });
    window.close(); return;
  }
  const context = lease.context;
  await write(context.localRepository.papersPath, { schema_version: 1, papers: [{ title: 'PoC dummy paper', doi: '10.1234/dummy-poc', grade: 'B', rule_grade: 'B', semantic_grade: 'B' }] });
  await write(path.join(context.runRoot, 'dummy', 'run_group.json'), { schemaVersion: 1, runId: 'dummy', pipelineMode: 'local', status: 'completed', startedAt: '2026-10-15T05:00:00Z', artifacts: [{ kind: 'weekly_export' }, { kind: 'pipeline', rootKey: 'local', path: 'review_results/pipeline/dummy' }] });
  await write(path.join(context.researchRoot, 'pipeline', 'dummy', 'run_report.json'), { steps: { med_weekly_synthesis: { completed: true } } });
  const evaluate = code => wc.executeJavaScript(code);
  const until = async code => { for (let i = 0; i < 100; i++) { if (await evaluate(code)) return; await delay(100); } throw new Error('SMOKE_UI_TIMEOUT'); };
  await window.loadURL(lease.url);
  await until("document.querySelector('#content')?.getAttribute('aria-busy') === 'false'");
  assert.deepEqual(await evaluate('[typeof require, typeof process, typeof Buffer, typeof window.electron, typeof window.ipcRenderer]'), Array(5).fill('undefined'));
  const prefs = wc.getLastWebPreferences();
  for (const [key, value] of Object.entries({ nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true })) assert.equal(prefs[key], value);
  assert.ok(!prefs.preload); report.checks.push('renderer isolation/no preload');
  let denied = 0;
  wc.on('did-create-window', () => { throw new Error('UNEXPECTED_WINDOW'); });
  wc.on('will-frame-navigate', event => { if (!allowedDocument(event.url, new URL(lease.url).origin)) { assert.equal(event.defaultPrevented, true); denied++; } });
  await evaluate("window.open('https://example.invalid'); document.querySelector('.brand').insertAdjacentHTML('beforeend', '<a id=nav-test href=https://example.invalid>dummy</a>'); document.querySelector('#nav-test').click()");
  await delay(300); assert.equal(BrowserWindow.getAllWindows().length, 1); assert.equal(wc.getURL(), lease.url + '/'); assert.equal(denied, 1);
  await evaluate("document.querySelector('#nav-test').remove()"); report.checks.push('external navigation/window.open denied');
  securityProbe = true;
  assert.equal(await evaluate("fetch('file:///dummy').then(()=>false,()=>true)"), true);
  assert.equal(await evaluate("fetch('https://example.invalid').then(()=>false,()=>true)"), true);
  securityProbe = false;
  report.checks.push('file/network access denied');
  report.views = [];
  for (const [width, height] of [[1366, 768], [1920, 1080], [390, 844]]) {
    window.setContentSize(width, height); await delay(200);
    const size = window.getContentSize();
    assert.ok(Math.abs(size[0] - width) <= 1 && Math.abs(size[1] - height) <= 1, 'Windows DIP rounding must remain within one pixel');
    await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await evaluate('[innerWidth, innerHeight]'), [width, height]);
    for (const route of ['home', 'feedback/rating/normal', 'feedback/rating/manual', 'feedback/research', 'feedback/rules', 'settings/general/databases', 'settings/connections/credentials']) {
      await evaluate(`location.hash = ${JSON.stringify(route)}`); await delay(120);
      await until("document.querySelector('#content')?.getAttribute('aria-busy') === 'false'");
      const state = await evaluate("({ title: document.querySelector('#page-title').textContent, error: document.querySelector('#notice').dataset.kind === 'error' ? document.querySelector('#notice').textContent : '', overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.querySelector('#content').textContent.length, passwords: [...document.querySelectorAll('input[type=password]')].map(x=>x.value) })");
      assert.equal(state.error, '', route); assert.ok(state.text > 10, route); assert.equal(state.overflow, false, `${route} width ${width}`);
      assert.ok(state.passwords.every(x => x === '')); if (route.endsWith('credentials')) assert.ok(state.passwords.length > 0);
      report.views.push({ width, height, route, title: state.title });
    }
    // capturePage's surface copy rejects with UnknownVizError on this Windows host.
    // Capture the same live window through Electron's native debugger view path.
    const capture = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false });
    const png = Buffer.from(capture.data, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    await fs.writeFile(path.join(outputRoot, `smoke-${width}.png`), png);
  }
  report.checks.push('21 UI route/viewport checks');
  const memory = [];
  for (let i = 0; i < 3; i++) { await delay(2000); memory.push(app.getAppMetrics().reduce((sum, p) => sum + p.memory.workingSetSize, 0) / 1024); }
  report.idleWorkingSetMiB = memory.map(x => Math.round(x));
  report.processes = app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type }));
  // The error view is fixed, script-free and contains no raw exception details.
  await window.loadURL(failurePage);
  assert.equal(await evaluate("document.body.textContent.includes('无法连接本地工作空间')"), true);
  assert.equal(await evaluate("typeof process"), 'undefined'); report.checks.push('safe failure view');
  assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.runtimeErrors, []); assert.deepEqual(report.rendererGone, []);
  wc.debugger.detach();
  app.once('will-quit', () => {
    report.ownedServerClosed = !lease.server.listening;
    writeFileSync(path.join(outputRoot, 'smoke-report.json'), JSON.stringify(report, null, 2));
  });
  window.close();
} catch (error) {
  await shell?.lease?.close();
  writeFileSync(path.join(outputRoot, 'smoke-failure.json'), JSON.stringify({ code: error.code || error.message, stack: error.stack?.split('\n').slice(0, 3) }));
  app.exit(1);
}
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void smoke();
