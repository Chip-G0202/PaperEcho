// Run only with ELECTRON_RUN_AS_NODE=1 and an empty PATH. Never execute --run.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
import nodemailer from 'nodemailer';
import { sandboxWorkspace, sandboxBase, repo } from '../../desktop/electron-poc/shell.mjs';
process.env.PAPERECHO_SKIP_DOTENV = '1';
assert.equal(process.env.PATH, ''); assert.ok(process.versions.electron);
const root = await sandboxWorkspace(path.join(sandboxBase, 'headless'));
assert.ok(new ExcelJS.Workbook()); assert.equal(new XMLParser().parse('<p>dummy</p>').p, 'dummy');
assert.equal(typeof nodemailer.createTransport, 'function'); // No transport created or sent.
const input = path.join(root, 'input.json'); await fs.writeFile(input, '[]');
const config = path.join(root, 'config', 'paperecho.config.json');
await fs.writeFile(config, JSON.stringify({ schemaVersion: 2, mode: 'local', common: { projectRoot: root, llm: { mode: 'disabled', enabled: false }, email: { enabled: false } }, local: { input, outputRoot: path.join(root, 'local') } }));
async function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: { SystemRoot: process.env.SystemRoot, PATH: '', ELECTRON_RUN_AS_NODE: '1', PAPERECHO_SKIP_DOTENV: '1', TEMP: process.env.TEMP, TMP: process.env.TMP }, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('HEADLESS_TIMEOUT')); }, 20000);
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output) : reject(new Error(`HEADLESS_EXIT_${code}: ${output.slice(-1200)}`)); });
  });
}
assert.equal((await run(['-e', "process.stdout.write(process.versions.electron ? 'embedded-child' : 'wrong-runtime')"])).trim(), 'embedded-child');
const check = await run([path.join(repo, 'skills/paperecho-local/scripts/run.mjs'), '--check', '--config', config]);
const { parseRunnerArgs } = await import('../../workflow/tools/runner/args.mjs');
assert.equal(parseRunnerArgs(['--run', '--scheduled-daily', '--mode', 'desktop']).scheduledDaily, true);
await fs.writeFile(path.join(sandboxBase, 'headless-report.json'), JSON.stringify({ electron: process.versions.electron, node: process.versions.node, platform: process.platform, pathEmpty: true, imports: ['exceljs', 'fast-xml-parser', 'nodemailer'], embeddedChild: true, formalLauncherCheck: true, scheduledArguments: true, actualWorkflowExecuted: false, checkOutputBytes: check.length }, null, 2));
console.log('HEADLESS_RUNTIME_CHECK_PASSED');
