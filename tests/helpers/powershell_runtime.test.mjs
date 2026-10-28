import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeEntry, powershell } from '../../desktop/electron-poc/powershell-runtime.mjs';

test('runtime source is pinned to the official self-contained asset; archive names fail closed', () => {
  assert.equal(powershell.url, `https://github.com/PowerShell/PowerShell/releases/download/v${powershell.version}/PowerShell-${powershell.version}-win-x64.zip`);
  assert.match(powershell.sha256, /^[a-f0-9]{64}$/);
  for (const name of ['pwsh.exe', 'LICENSE.txt', 'Modules/module/data.psd1']) assert.equal(runtimeEntry(name), true);
  for (const name of ['', '../escape', '/absolute', 'C:/escape', 'a\\b', 'a/./b', 'a//b', 'file.']) assert.equal(runtimeEntry(name), false);
});
