import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { sandboxConfiguration } from '../../desktop/electron-poc/sandbox-lab.mjs';
import { sourceAllowed } from '../../desktop/electron-poc/package-policy.mjs';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const input = path.win32.join(repo, '.sandbox-lab/input'), output = path.win32.join(repo, '.sandbox-lab/output');
test('Sandbox XML exposes only dedicated handoff and disables host integration features', () => {
  const config = new XMLParser().parse(sandboxConfiguration(input, output)).Configuration;
  for (const key of ['vGPU', 'Networking', 'ClipboardRedirection', 'PrinterRedirection', 'VideoInput', 'AudioInput']) assert.equal(config[key], 'Disable');
  assert.equal(config.ProtectedClient, 'Enable');
  assert.deepEqual(config.MappedFolders.MappedFolder.map(x => [x.HostFolder, x.SandboxFolder, x.ReadOnly]),
    [[input, 'C:\\PaperEchoLab\\Input', true], [output, 'C:\\PaperEchoLab\\Output', false]]);
  assert.equal(config.LogonCommand.Command.includes('Input\\boundary.cmd'), true);
  assert.equal(config.LogonCommand.Command.includes('Output'), false);
});
test('arbitrary roots, overlapping directories, traversal and shell interpolation are refused', () => {
  for (const value of ['C:\\', repo, path.win32.join(repo, '..'), output, input + '\\..', input + '\\%USERNAME%', input + '"', input + '\n']) assert.throws(() => sandboxConfiguration(value, output), /SANDBOX_MAPPING_INVALID/);
  assert.throws(() => sandboxConfiguration(input, input), /SANDBOX_MAPPING_INVALID/);
  for (const file of ['.sandbox-lab/input/challenge.txt', '.sandbox-lab/output/boundary-result.json', 'desktop/electron-poc/sandbox-boundary.js']) assert.equal(sourceAllowed(file), false);
});
test('installer Sandbox gets a fresh isolated run with the same host restrictions', () => {
  const run = 'c2e5d9e0-fd19-4771-9316-eaeb80889c00';
  const root = path.win32.join(repo, '.sandbox-lab/phase3a', run);
  const config = new XMLParser().parse(sandboxConfiguration(path.win32.join(root, 'input'), path.win32.join(root, 'output'), { entrypoint: 'installer.cmd' })).Configuration;
  assert.equal(config.Networking, 'Disable'); assert.equal(config.ProtectedClient, 'Enable');
  assert.equal(config.MappedFolders.MappedFolder[0].ReadOnly, true);
  assert.equal(config.LogonCommand.Command.includes('Input\\installer.cmd'), true);
  assert.throws(() => sandboxConfiguration(input, output, { entrypoint: 'installer.cmd' }), /SANDBOX_MAPPING_INVALID/);
  assert.throws(() => sandboxConfiguration(input, output, { entrypoint: 'anything.cmd' }), /SANDBOX_MAPPING_INVALID/);
});
test('boundary probe has no install, scheduler or PowerShell 5.1 execution capability', async () => {
  const source = await fs.readFile(new URL('../../desktop/electron-poc/sandbox-boundary.js', import.meta.url), 'utf8');
  for (const required of ['WDAG', 'CExecSvc', 'Win32_ComputerSystem', 'ScriptFullName', 'READY_FOR_TEST', 'BLOCKED']) assert.ok(source.toLowerCase().includes(required.toLowerCase()));
  assert.equal(/\.(Run|Exec|RegWrite|RegDelete)\s*\(|msiexec|schtasks|powershell\.exe|launchctl/i.test(source), false);
});
