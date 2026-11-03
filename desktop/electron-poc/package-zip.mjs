// Delivery envelope only: reuse the existing unpacked build and its release owner.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyReleaseArtifact } from './release.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const base = path.join(repo, 'tests/runs/phase2b');
export async function packageZip({ root, parent, expectedCommit, inspect, outputParent = base, testOnly = false }) {
  const artifact = await verifyReleaseArtifact({ root, parent, expectedCommit, inspect });
  if (artifact.dirty && testOnly !== true) throw new Error('ZIP_DIRTY_ARTIFACT');
  outputParent = path.resolve(outputParent);
  const relative = path.relative(repo, outputParent);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('ZIP_OUTPUT_BOUNDARY');
  await fs.mkdir(outputParent, { recursive: true });
  if ((await fs.realpath(outputParent)).toLowerCase() !== outputParent.toLowerCase()) throw new Error('ZIP_OUTPUT_BOUNDARY');
  const folder = await fs.mkdtemp(path.join(outputParent, 'zip-'));
  const name = `PaperEcho-${artifact.appVersion}-win32-x64${testOnly === true ? '-TEST-ONLY' : ''}`;
  const zip = path.join(folder, name + '.zip');
  const bytes = await fs.readFile(path.join(root, 'release-manifest.json'));
  const manifest = JSON.parse(bytes);
  const plan = path.join(folder, 'zip-plan.json');
  await fs.writeFile(plan, JSON.stringify({ root, prefix: name, files: [...manifest.files,
    { path: 'release-manifest.json', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] }), { flag: 'wx' });
  execFileSync(process.env.PWSH_PATH || 'pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('./zip-win.ps1', import.meta.url)), '-Plan', plan, '-Destination', zip],
  { windowsHide: true, timeout: 180000, maxBuffer: 4096 });
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(zip)) digest.update(chunk);
  const report = { zip, sha256: digest.digest('hex'), sizeBytes: (await fs.stat(zip)).size,
    fileCount: manifest.files.length + 1, artifactId: artifact.artifactId, gitCommit: artifact.gitCommit,
    evidence: artifact.evidence, layout: 'UNCHANGED_INSTALLED_DEFAULT', release: 'BLOCKED', testOnly: testOnly === true };
  await fs.writeFile(zip + '.sha256', `${report.sha256}  ${name}.zip\n`, { flag: 'wx' });
  await fs.writeFile(path.join(folder, 'zip-report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { output } = JSON.parse(await fs.readFile(path.join(base, 'latest-build.json'), 'utf8'));
  const expectedCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const manifest = JSON.parse(await fs.readFile(path.join(output, 'release-manifest.json'), 'utf8'));
  // Refuse a stale working-copy payload, even when HEAD has not changed.
  for (const source of manifest.sources) {
    if (!(await fs.readFile(path.join(output, 'resources/core', source))).equals(await fs.readFile(path.join(repo, source)))) throw new Error('ZIP_STALE_SOURCE');
  }
  console.log(JSON.stringify(await packageZip({ root: output, parent: path.dirname(output), expectedCommit, testOnly: process.argv.includes('--test-only') })));
}
