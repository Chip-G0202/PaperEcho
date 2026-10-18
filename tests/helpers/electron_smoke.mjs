// Actual Electron entry: no providers, no workflow execution, dummy sandbox only.
import { app, BrowserWindow, nativeImage, screen } from 'electron';
import fs from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { prepareShell, startShell } from '../../desktop/electron-poc/main.mjs';
import { sandboxBase, allowedDocument, failurePage } from '../../desktop/electron-poc/shell.mjs';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
export async function smoke({ root, outputRoot = sandboxBase, prepare = true, startShellImpl = startShell } = {}) {
const began = performance.now();
let shell;
const report = { platform: process.platform, electron: process.versions.electron, node: process.versions.node, pathEmpty: !process.env.PATH, checks: [], views: [], consoleErrors: [], runtimeErrors: [], rendererGone: [] };
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
  shell = await startShellImpl({ root });
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
  const resize = async (width, height) => {
    window.setContentSize(width, height); window.center();
    let actual;
    for (let attempt = 0; attempt < 100; attempt++) {
      actual = await wc.executeJavaScript('[innerWidth,innerHeight]');
      if (actual[0] === width && actual[1] === height) break;
      await delay(20);
    }
    const bounds = window.getBounds(), content = window.getContentBounds();
    const display = screen.getDisplayMatching(bounds), area = display.workArea;
    const renderer = await wc.executeJavaScript('({cssViewport:[innerWidth,innerHeight],devicePixelRatio,visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale}:null,loaded:document.readyState==="complete",layoutReady:document.querySelector("#content")?.getAttribute("aria-busy")==="false"})');
    report.lastViewport = { width, height, kind: 'native', bounds, content, workArea: area, displayScaleFactor: display.scaleFactor, zoomFactor: wc.getZoomFactor(), cssViewport: actual, renderer };
    (report.viewportMeasurements ??= []).push(report.lastViewport);
    assert.deepEqual(actual, [width, height], 'native CSS viewport');
    assert.deepEqual([content.width, content.height], [width, height], 'native content DIP');
    assert.equal(display.scaleFactor, 1, 'exact-pixel smoke requires explicit 100% test DPI');
    assert.equal(wc.getZoomFactor(), 1);
    assert.ok(bounds.x >= area.x && bounds.y >= area.y && bounds.x + bounds.width <= area.x + area.width && bounds.y + bounds.height <= area.y + area.height, 'actual window must fit display work area');
  };
  if (process.argv.includes('--smoke-restore')) {
    const evaluate = code => wc.executeJavaScript(code);
    const until = async code => { for (let i = 0; i < 150; i++) { if (await evaluate(code)) return; await delay(100); } throw new Error('RESTORE_GUI_TIMEOUT'); };
    for (const [width, height] of [[1920, 1080], [1366, 768], [390, 844]]) {
      await resize(width, height);
      await until(`innerWidth === ${width} && innerHeight === ${height} && location.hash === '#system' && document.querySelector('#content')?.getAttribute('aria-busy') === 'false'`);
      assert.equal(await evaluate("location.hash"), '#system');
      await evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('检查 / 刷新')).click()");
      await until("document.querySelector('.doctor-results')?.getAttribute('aria-busy') === 'false' && document.querySelector('.doctor-results')?.dataset.doctorStatus === 'FAIL' && document.querySelector('[data-check-id=\"restore.transaction\"] h4')?.textContent.startsWith('立即阻塞 · 恢复事务')");
      const viewState = await evaluate('({viewport:[innerWidth,innerHeight],layoutReady:document.querySelector("#content")?.getAttribute("aria-busy")==="false",overflow:document.documentElement.scrollWidth>innerWidth})');
      assert.deepEqual(viewState, { viewport: [width, height], layoutReady: true, overflow: false });
      (report.restoreViewChecks ??= []).push({ ...viewState, consoleErrors: report.consoleErrors.length, runtimeErrors: report.runtimeErrors.length });
      assert.deepEqual(await evaluate('[typeof require,typeof process,typeof window.ipcRenderer]'), Array(3).fill('undefined'));
      report.views.push({ width, height, route: 'system', restoreBlocked: true });
    }
    assert.deepEqual(report.views, [[1920, 1080], [1366, 768], [390, 844]].map(([width, height]) => ({ width, height, route: 'system', restoreBlocked: true })));
    assert.deepEqual(report.consoleErrors, []); assert.deepEqual(report.runtimeErrors, []); assert.deepEqual(report.rendererGone, []);
    report.processes = app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type }));
    wc.debugger.detach();
    app.once('will-quit', () => { report.ownedServerClosed = !lease.server.listening; writeFileSync(path.join(outputRoot, 'smoke-report.json'), JSON.stringify(report)); });
    window.close(); return;
  }
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
  for (const [width, height] of [[1366, 768], [1920, 1080], [390, 844]]) {
    await resize(width, height);
    assert.deepEqual(await evaluate('[innerWidth, innerHeight]'), [width, height]);
    if (width === 390) {
      await evaluate("document.querySelector('#menu-toggle').click()");
      assert.equal(await evaluate("document.querySelector('#menu-toggle').getAttribute('aria-expanded')"), 'true');
      assert.equal(await evaluate("(()=>{const b=document.querySelector('[data-page=home]'),r=b.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===b})()"), true);
      await evaluate("document.querySelector('[data-page=home]').click()");
      await until("location.hash === '#home' && document.querySelector('#content')?.getAttribute('aria-busy') === 'false' && document.querySelector('#sidebar').dataset.open === 'false'");
      report.checks.push('390px visible navigation menu interaction');
    }
    for (const route of ['home', 'feedback/rating/normal', 'feedback/rating/manual', 'feedback/research', 'feedback/rules', 'settings/general/databases', 'settings/connections/credentials', 'system']) {
      await evaluate(`location.hash = ${JSON.stringify(route)}`); await delay(120);
      await until("document.querySelector('#content')?.getAttribute('aria-busy') === 'false'");
      if (route === 'system') {
        assert.equal(await evaluate("document.querySelectorAll('[data-check-id]').length"), 0, 'Doctor must wait for explicit request');
        await evaluate("[...document.querySelectorAll('button')].find(x=>x.textContent.includes('检查 / 刷新')).click()");
        await until("document.querySelector('.doctor-results')?.getAttribute('aria-busy') === 'false' && document.querySelectorAll('[data-check-id]').length > 0");
        assert.ok(await evaluate("['PASS','WARN','FAIL','UNKNOWN'].includes(document.querySelector('.doctor-results').dataset.doctorStatus)"));
        assert.equal(await evaluate("document.querySelector('.doctor-results').textContent.includes('dummy-external')"), false);
        report.checks.push(`Doctor explicit read-only diagnostics ${width}`);
        const checkCount = await evaluate("document.querySelectorAll('[data-check-id]').length");
        assert.equal(await evaluate("document.querySelector('[data-support-status]').dataset.supportStatus"), 'idle');
        if (width === 1366) {
          await evaluate("window.__supportFetch = window.fetch; window.fetch = (url, options) => url === '/api/support-bundle' ? Promise.resolve(new Response('{}', {status:400,headers:{'Content-Type':'application/json'}})) : window.__supportFetch(url, options); void 0");
          await evaluate("document.querySelector('[data-support-export]').click()");
          await until("document.querySelector('[data-support-status]').dataset.supportStatus === 'failed'");
          await evaluate("window.fetch = window.__supportFetch; delete window.__supportFetch");
          assert.equal(await evaluate("document.querySelectorAll('[data-check-id]').length"), checkCount);
        }
        const zipPath = path.join(outputRoot, `support-${width}.zip`);
        const downloaded = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('SUPPORT_DOWNLOAD_TIMEOUT')), 15000);
          wc.session.once('will-download', (event, item, source) => {
            try {
              assert.equal(event.defaultPrevented, false); assert.equal(source, wc); assert.equal(item.getFilename(), 'paperecho-support.zip');
              assert.equal(item.getSaveDialogOptions().filters[0].extensions[0], 'zip');
              item.setSavePath(zipPath);
              item.once('done', (_event, state) => { clearTimeout(timer); state === 'completed' ? resolve() : reject(new Error('SUPPORT_DOWNLOAD_FAILED')); });
            } catch (error) { clearTimeout(timer); reject(error); }
          });
        });
        await wc.executeJavaScript("document.querySelector('[data-support-export]').focus(); document.querySelector('[data-support-export]').click()", true);
        await downloaded; await until("document.querySelector('[data-support-status]').dataset.supportStatus === 'success'");
        const zipBytes = await fs.readFile(zipPath); assert.ok(zipBytes.length <= 65536);
        const bundle = await JSZip.loadAsync(zipBytes, { checkCRC32: true }); assert.equal(Object.keys(bundle.files).length, 4);
        const manifest = JSON.parse(await bundle.file('manifest.json').async('string'));
        for (const file of manifest.files) {
          const bytes = await bundle.file(file.name).async('nodebuffer'); assert.equal(bytes.length, file.size); assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
          assert.ok(!bytes.includes(Buffer.from(root))); assert.ok(!bytes.includes(Buffer.from('PoC dummy paper')));
        }
        assert.equal(await evaluate("document.querySelectorAll('[data-check-id]').length"), checkCount);
        assert.equal(await evaluate("document.activeElement?.matches('[data-support-export]')"), true, 'support export keyboard focus after download');
        report.checks.push(`Support ZIP download and integrity ${width}`);
      }
      const state = await evaluate("({ title: document.querySelector('#page-title').textContent, error: document.querySelector('#notice').dataset.kind === 'error' ? document.querySelector('#notice').textContent : '', overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.querySelector('#content').textContent.length, passwords: [...document.querySelectorAll('input[type=password]')].map(x=>x.value) })");
      assert.equal(state.error, '', route); assert.ok(state.text > 10, route); assert.equal(state.overflow, false, `${route} width ${width}`);
      assert.ok(state.passwords.every(x => x === '')); if (route.endsWith('credentials')) assert.ok(state.passwords.length > 0);
      report.views.push({ width, height, route, title: state.title });
    }
    // capturePage's surface copy rejects with UnknownVizError on this Windows host.
    // Capture the same live window through Electron's native debugger view path.
    window.show(); window.focus(); window.moveTop(); await wc.debugger.sendCommand('Page.bringToFront'); await delay(250);
    const capture = await wc.debugger.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: false });
    const png = Buffer.from(capture.data, 'base64');
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    const bitmap = nativeImage.createFromBuffer(png).toBitmap(); let changed = 0;
    for (let i = 4; i < bitmap.length; i += 4) if (bitmap[i] !== bitmap[0] || bitmap[i + 1] !== bitmap[1] || bitmap[i + 2] !== bitmap[2]) changed++;
    assert.ok(changed > bitmap.length / 400, 'live screenshot must contain visible content');
    await fs.writeFile(path.join(outputRoot, `smoke-${width}.png`), png);
  }
  report.checks.push('24 UI route/viewport checks');
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
  writeFileSync(path.join(outputRoot, 'smoke-failure.json'), JSON.stringify({ code: error.code || error.message, location: error.stack?.match(/electron_smoke\.mjs:\d+:\d+/)?.[0], completedChecks: report.checks, lastView: report.views?.at(-1), lastViewport: report.lastViewport, stack: error.stack?.split('\n').slice(0, 3) }));
  app.exit(1);
}
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) void smoke();
