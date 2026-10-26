// Authoring/database checks only; actual MSI/patch refusal requires the separate Guest Gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { installerTables } from '../../desktop/electron-poc/installer-win.mjs';

const product = '{7395EC5E-338E-4E71-92A2-579BD64EE6E4}';
const tables = () => installerTables([{ path: 'PaperEcho.exe', size: 1 }], product);

test('native AppSearch lookup can query the empty Signature schema for a raw registry locator without installing anything', async t => {
  assert.equal(process.platform, 'win32');
  const base = path.resolve('tests/runs/installer-policy'); await fs.mkdir(base, { recursive: true });
  const root = await fs.mkdtemp(path.join(base, 'signature-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const payload = path.join(root, 'dummy-stream'); await fs.writeFile(payload, 'not an installable cabinet');
  const specification = path.join(root, 'database.json');
  await fs.writeFile(specification, JSON.stringify({ tables: tables(), msi: path.join(root, 'fixture.msi'), payload, packageCode: product }));
  const script = String.raw`
$ErrorActionPreference='Stop'
if($PSVersionTable.PSVersion.Major -lt 7 -or $PSVersionTable.PSEdition -cne 'Core'){throw 'PS7_REQUIRED'}
& $env:TEST_AUTHOR -Specification $env:TEST_SPEC
$spec=Get-Content -LiteralPath $env:TEST_SPEC -Raw|ConvertFrom-Json
$engine=New-Object -ComObject WindowsInstaller.Installer;$db=$engine.OpenDatabase($spec.msi,0)
$query='SELECT ' + [char]96+'FileName'+[char]96+', '+[char]96+'MinVersion'+[char]96+', '+[char]96+'MaxVersion'+[char]96+', '+[char]96+'MinSize'+[char]96+', '+[char]96+'MaxSize'+[char]96+', '+[char]96+'MinDate'+[char]96+', '+[char]96+'MaxDate'+[char]96+', '+[char]96+'Languages'+[char]96+' FROM '+[char]96+'Signature'+[char]96+' WHERE '+[char]96+'Signature'+[char]96+' = ?'
$view=$db.OpenView($query);$record=$engine.CreateRecord(1);$record.StringData(1)='InstalledPackage'
try{$null=$view.Execute($record);if($view.Fetch()){throw 'RAW_LOCATOR_HAS_FILE_SIGNATURE'};'NATIVE_EMPTY_SIGNATURE_LOOKUP_PASS'}
finally{$null=$view.Close();foreach($object in @($record,$view,$db,$engine)){[Runtime.InteropServices.Marshal]::FinalReleaseComObject($object)|Out-Null}}
`;
  const output = execFileSync(process.env.PWSH_PATH, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, TEST_SPEC: specification, TEST_AUTHOR: path.resolve('desktop/electron-poc/installer-database.ps1') } });
  assert.match(output, /NATIVE_EMPTY_SIGNATURE_LOOKUP_PASS/);
});

test('safe reinstall policy preserves UpgradeCode and detects all related versions without removing them', () => {
  const t = tables(), version = t.Property.rows.find(([name]) => name === 'ProductVersion')[1];
  assert.equal(t.Property.rows.find(([name]) => name === 'UpgradeCode')[1], product);
  assert.deepEqual(t.Upgrade.rows, [
    [product, null, version, null, 2, null, 'OLDERPRODUCTS'],
    [product, version, null, null, 258, null, 'NEWERPRODUCTS'],
  ]);
  assert.ok(t.Upgrade.rows.every(row => (row[4] & 2) === 2 && row[5] === null));
  assert.ok(t.InstallExecuteSequence.rows.every(([name]) => name !== 'RemoveExistingProducts'));
  assert.equal(Object.hasOwn(t, 'CustomAction'), false);
});

test('GUI and silent sequences check related products before installation can begin', () => {
  const t = tables(), execute = Object.fromEntries(t.InstallExecuteSequence.rows.map(([name, , position]) => [name, position]));
  const ui = Object.fromEntries(t.InstallUISequence.rows.map(([name, , position]) => [name, position]));
  assert.ok(execute.FindRelatedProducts < execute.LaunchConditions && execute.LaunchConditions < execute.InstallInitialize);
  assert.ok(ui.FindRelatedProducts < ui.LaunchConditions && ui.LaunchConditions < ui.ExecuteAction);
  assert.ok(t.LaunchCondition.rows.some(([condition, message]) => condition === 'Installed OR NOT (OLDERPRODUCTS OR NEWERPRODUCTS)' && message.startsWith('PAPERECHO_INPLACE_UPGRADE_BLOCKED:')));
});

test('patch properties have a separate refusal while ordinary installed maintenance and per-user scope are retained', () => {
  const t = tables();
  assert.ok(t.LaunchCondition.rows.some(([condition, message]) => condition === 'NOT PATCH AND NOT MSIPATCHREMOVE' && message.startsWith('PAPERECHO_PATCH_UNSUPPORTED:')));
  assert.ok(t.LaunchCondition.rows.some(([condition]) => condition === 'NOT ALLUSERS'));
  assert.ok(t.LaunchCondition.rows.some(([condition]) => condition.startsWith('Installed OR ')));
  assert.equal(t.Property.rows.some(([name]) => name === 'ALLUSERS'), false);
  assert.ok(t.Registry.rows.every(row => row[1] === 1));
});

test('same ProductCode packages have distinct identities; standard AppSearch precedes conditions and original-package repair remains allowed', () => {
  const next = '{11111111-1111-4111-8111-111111111111}';
  const a = tables(), b = installerTables([{ path: 'PaperEcho.exe', size: 1 }], product, next);
  assert.notEqual(a.Property.rows.find(([name]) => name === 'PaperEchoPackageId')[1], b.Property.rows.find(([name]) => name === 'PaperEchoPackageId')[1]);
  assert.deepEqual(b.AppSearch.rows, [['PAPERECHO_INSTALLED_PACKAGE', 'InstalledPackage']]);
  assert.deepEqual(b.RegLocator.rows, [['InstalledPackage', 1, 'Software\\PaperEcho\\Installer\\Packages\\' + product, 'PackageId', 18]]);
  assert.ok(b.Registry.rows.some(([name, root, key, value, data]) => name === 'InstalledPackage' && root === 1 && key.endsWith(product) && value === 'PackageId' && data === '[PaperEchoPackageId]'));
  for (const table of ['InstallUISequence', 'InstallExecuteSequence']) {
    const positions = Object.fromEntries(b[table].rows.map(([action, , n]) => [action, n]));
    assert.ok(positions.AppSearch < positions.LaunchConditions);
  }
  assert.ok(b.LaunchCondition.rows.some(([condition]) => condition === 'NOT Installed OR REMOVE = "ALL" OR (PAPERECHO_INSTALLED_PACKAGE AND PAPERECHO_INSTALLED_PACKAGE = PaperEchoPackageId)'));
  assert.equal(Object.hasOwn(b, 'CustomAction'), false);
});
