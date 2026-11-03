// Fixed dummy-only packaged probe: no provider, notification or Zotero execution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { preparePackagedRuntime } from '../../desktop/electron-poc/runtime.mjs';

export async function assertPackagedModulePath(root, value) {
  const relative = path.relative(await fs.realpath(root), await fs.realpath(value));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'MODULE_OUTSIDE_PACKAGED_RESOURCES');
  return relative;
}

export async function probe() {
const began = performance.now();
const paths = preparePackagedRuntime();
assert.equal(await fs.readFile(path.join(paths.userDataRoot, '.packaged-smoke-fixture'), 'utf8'), 'dummy-only');
assert.ok(process.versions.electron); assert.equal(process.type, undefined); assert.equal(process.env.PATH, '');
assert.equal(process.env.NODE_PATH, undefined); assert.equal(process.env.NODE_OPTIONS, undefined);
const require = createRequire(import.meta.url);
const dependencies = {};
for (const name of ['exceljs', 'fast-xml-parser', 'nodemailer']) {
  const resolved = require.resolve(name); await assertPackagedModulePath(paths.resourceRoot, resolved);
  dependencies[name] = path.relative(paths.resourceRoot, resolved);
}
const ExcelJS = (await import('exceljs')).default; assert.ok(new ExcelJS.Workbook());
const { XMLParser } = await import('fast-xml-parser'); assert.equal(new XMLParser().parse('<a>dummy</a>').a, 'dummy');
assert.equal(typeof (await import('nodemailer')).default.createTransport, 'function');
assert.equal(typeof (await import('../../workflow/tools/stage0/main.mjs')).runZoteroLiteratureFilter, 'function');
assert.equal(typeof (await import('../../workflow/tools/local/main.mjs')).runLocalPipeline, 'function');
const { main, runProduction } = await import('../../workflow/tools/runner/main.mjs');
const { buildExecutionPlan } = await import('../../workflow/tools/runner/preflight.mjs');
const { resolveRunnerConfiguration } = await import('../../workflow/tools/runner/config_loader.mjs');
const { parseRunnerArgs } = await import('../../workflow/tools/runner/args.mjs');
const silent = { write() {} }; let scheduled = false;
// Real resolver + plan + child spawning, with only the external business boundary mocked.
const scheduledCode = await main(['--run', '--scheduled-daily', '--mode', 'desktop'], {
  env: process.env, stdout: silent, stderr: silent,
  selectScheduledDailyRunImpl: async resolved => ({ status: 'ready', resolved, decision: { plannedSlot: '2026-10-16T07:00:00Z', selectedFlow: 'radar' } }),
  runPreflightImpl: async options => ({ mode: options.mode, status: 'ready', canRun: true, requiredMissing: [] }),
  runProductionImpl: async plan => { scheduled = true; assert.equal(plan.entry, path.join(paths.resourceRoot, 'workflow/tools/stage0/main.mjs')); assert.equal(plan.childEnv.PAPERECHO_DATA_ROOT, paths.userDataRoot); return { code: 0, status: 'completed', stdout: '{}' }; },
  validateProductionResultImpl: async () => ({ ok: true, exitCode: 0 }),
});
assert.equal(scheduledCode, 0); assert.ok(scheduled);
const resolved = await resolveRunnerConfiguration(parseRunnerArgs(['--check', '--mode', 'local']));
const plan = buildExecutionPlan(resolved.options, { env: resolved.env });
await assertPackagedModulePath(paths.resourceRoot, plan.entry);
// Execute the formal Local entry on dummy input, with LLM/email disabled in fixture config.
const local = await runProduction(plan, { stdout: silent, stderr: silent, watchdogTimeoutMs: 30000 });
assert.equal(local.code, 0, 'dummy Local workflow child failed');
const childResult = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({electron:process.versions.electron,node:process.versions.node,type:process.type||null}))'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = ''; child.stdout.on('data', x => output += x); child.once('error', reject); child.once('close', code => { assert.equal(code, 0); resolve(JSON.parse(output)); });
});
assert.equal(childResult.electron, process.versions.electron); assert.equal(childResult.type, null);
await fs.writeFile(path.join(paths.userDataRoot, 'headless-probe.json'), JSON.stringify({ electron: process.versions.electron, node: process.versions.node, dependencies, scheduledMock: scheduledCode, localWorkflow: local.code, childResult, applicationRoot: paths.applicationRoot, resourceRoot: paths.resourceRoot, userDataRoot: paths.userDataRoot, durationMs: Math.round(performance.now() - began), source: path.relative(paths.resourceRoot, fileURLToPath(import.meta.url)) }));
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await probe();
