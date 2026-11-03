import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repo, 'tests', 'runs', 'electron-poc');
const started = Date.now();
fs.mkdirSync(path.join(base, 'tmp'), { recursive: true });
const evidence = path.join(base, `evidence-${started}`); fs.mkdirSync(evidence);
for (const name of ['smoke-report.json', 'smoke-failure.json', 'smoke-1366.png', 'smoke-1920.png', 'smoke-390.png']) {
  if (fs.existsSync(path.join(base, name))) fs.copyFileSync(path.join(base, name), path.join(evidence, name));
}
const env = { ...process.env, PATH: '', PAPERECHO_SKIP_DOTENV: '1', TEMP: path.join(base, 'tmp'), TMP: path.join(base, 'tmp') };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(repo, 'desktop/electron-poc/node_modules/electron/dist/electron.exe'), [path.join(repo, 'tests/helpers/electron_smoke.mjs')], { cwd: repo, env, stdio: 'inherit', windowsHide: false, shell: false });
const timer = setTimeout(() => { child.kill(); process.exitCode = 1; }, 45000);
child.once('error', () => { clearTimeout(timer); console.error('ELECTRON_GUI_SPAWN_FAILED'); process.exitCode = 1; });
child.once('close', code => {
  clearTimeout(timer);
  const file = path.join(base, 'smoke-report.json');
  const fresh = fs.existsSync(file) && fs.statSync(file).mtimeMs >= started;
  if (code === 0 && fresh && JSON.parse(fs.readFileSync(file, 'utf8')).ownedServerClosed) console.log('ELECTRON_GUI_SMOKE_PASSED');
  else { console.error('ELECTRON_GUI_SMOKE_FAILED'); process.exitCode = 1; }
});
