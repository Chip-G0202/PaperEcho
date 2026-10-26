// Build only: Windows Installer owns install, rollback and uninstall. No host installation.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appVersion } from './package-policy.mjs';
import { verifyReleaseArtifact } from './release.mjs';

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const digest = value => createHash('sha256').update(value).digest('hex');
const id = (kind, value) => kind + digest(value).slice(0, 24);
const guid = value => { const h = digest(value); return `{${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}}`.toUpperCase(); };

export function installerTables(files, productCode, packageCode = productCode) {
  if (![productCode, packageCode].every(code => /^\{[A-F0-9-]{36}\}$/.test(code)) || !Array.isArray(files) || !files.length || files.length > 20000) throw new Error('INSTALLER_INPUT_INVALID');
  const names = new Set();
  for (const file of files) {
    if (typeof file.path !== 'string' || !file.path || /[\\:"\u0000-\u001f]/.test(file.path)
      || file.path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p))
      || names.has(file.path.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 2 ** 31 - 1
      || /(^|\/)(?:\.env(?:\..*)?|paperecho\.config\.json|.*\.(?:log|pebackup|zip|pfx|p12|pem|key))$/i.test(file.path)) throw new Error('INSTALLER_INPUT_INVALID');
    names.add(file.path.toLowerCase());
  }
  if (!names.has('paperecho.exe')) throw new Error('INSTALLER_EXE_REQUIRED');
  const tables = {
    Property: { columns: 'Property CHAR(72) NOT NULL, Value CHAR(0) LOCALIZABLE', key: 'Property', rows: Object.entries({ ProductCode: productCode,
      UpgradeCode: '{7395EC5E-338E-4E71-92A2-579BD64EE6E4}', ProductName: 'PaperEcho TEST ONLY', ProductVersion: appVersion,
      ProductLanguage: '1033', Manufacturer: 'PaperEcho contributors', INSTALLLEVEL: '1', ARPNOMODIFY: '1', ARPNOREPAIR: '1', PaperEchoPackageId: packageCode,
      SecureCustomProperties: 'OLDERPRODUCTS;NEWERPRODUCTS' }) },
    AppSearch: { columns: 'Property CHAR(72) NOT NULL, Signature_ CHAR(72) NOT NULL', key: 'Property, Signature_', rows: [['PAPERECHO_INSTALLED_PACKAGE', 'InstalledPackage']] },
    // AppSearch queries this schema even for a raw registry locator; no file signature is required.
    Signature: { columns: 'Signature CHAR(72) NOT NULL, FileName CHAR(255) NOT NULL LOCALIZABLE, MinVersion CHAR(20), MaxVersion CHAR(20), MinSize LONG, MaxSize LONG, MinDate LONG, MaxDate LONG, Languages CHAR(255)', key: 'Signature', rows: [] },
    RegLocator: { columns: 'Signature_ CHAR(72) NOT NULL, Root SHORT NOT NULL, Key CHAR(255) NOT NULL, Name CHAR(255), Type SHORT', key: 'Signature_',
      rows: [['InstalledPackage', 1, 'Software\\PaperEcho\\Installer\\Packages\\' + productCode, 'PackageId', 18]] },
    Upgrade: { columns: 'UpgradeCode CHAR(38) NOT NULL, VersionMin CHAR(20), VersionMax CHAR(20), Language CHAR(255), Attributes LONG NOT NULL, Remove CHAR(255), ActionProperty CHAR(72) NOT NULL', key: 'UpgradeCode, VersionMin, VersionMax, Language, Attributes', rows: [
      ['{7395EC5E-338E-4E71-92A2-579BD64EE6E4}', null, appVersion, null, 2, null, 'OLDERPRODUCTS'],
      ['{7395EC5E-338E-4E71-92A2-579BD64EE6E4}', appVersion, null, null, 258, null, 'NEWERPRODUCTS']] },
    Directory: { columns: 'Directory CHAR(72) NOT NULL, Directory_Parent CHAR(72), DefaultDir CHAR(255) NOT NULL LOCALIZABLE', key: 'Directory', rows: [
      ['TARGETDIR', null, 'SourceDir'], ['LocalAppDataFolder', 'TARGETDIR', '.'], ['ProgramsDir', 'LocalAppDataFolder', 'Programs'], ['INSTALLROOT', 'ProgramsDir', 'PaperEcho'],
      ['ProgramMenuFolder', 'TARGETDIR', '.'], ['MenuDir', 'ProgramMenuFolder', 'PaperEcho TEST ONLY']] },
    Component: { columns: 'Component CHAR(72) NOT NULL, ComponentId CHAR(38), Directory_ CHAR(72) NOT NULL, Attributes SHORT NOT NULL, Condition CHAR(255), KeyPath CHAR(72)', key: 'Component', rows: [] },
    Feature: { columns: 'Feature CHAR(38) NOT NULL, Feature_Parent CHAR(38), Title CHAR(64) LOCALIZABLE, Description CHAR(255) LOCALIZABLE, Display SHORT, Level SHORT NOT NULL, Directory_ CHAR(72), Attributes SHORT NOT NULL', key: 'Feature', rows: [['Runtime', null, 'PaperEcho TEST ONLY', 'Unsigned test runtime', 0, 1, 'INSTALLROOT', 0]] },
    FeatureComponents: { columns: 'Feature_ CHAR(38) NOT NULL, Component_ CHAR(72) NOT NULL', key: 'Feature_, Component_', rows: [] },
    File: { columns: 'File CHAR(72) NOT NULL, Component_ CHAR(72) NOT NULL, FileName CHAR(255) NOT NULL LOCALIZABLE, FileSize LONG NOT NULL, Version CHAR(72), Language CHAR(20), Attributes SHORT, Sequence SHORT NOT NULL', key: 'File', rows: [] },
    Registry: { columns: 'Registry CHAR(72) NOT NULL, Root SHORT NOT NULL, Key CHAR(255) NOT NULL LOCALIZABLE, Name CHAR(255) LOCALIZABLE, Value CHAR(0) LOCALIZABLE, Component_ CHAR(72) NOT NULL', key: 'Registry', rows: [] },
    Media: { columns: 'DiskId SHORT NOT NULL, LastSequence SHORT NOT NULL, DiskPrompt CHAR(64) LOCALIZABLE, Cabinet CHAR(255), VolumeLabel CHAR(32), Source CHAR(72)', key: 'DiskId', rows: [[1, files.length, null, '#payload.cab', null, null]] },
    Shortcut: { columns: 'Shortcut CHAR(72) NOT NULL, Directory_ CHAR(72) NOT NULL, Name CHAR(128) NOT NULL LOCALIZABLE, Component_ CHAR(72) NOT NULL, Target CHAR(255) NOT NULL, Arguments CHAR(255), Description CHAR(255) LOCALIZABLE, Hotkey SHORT, Icon_ CHAR(72), IconIndex SHORT, ShowCmd SHORT, WkDir CHAR(72)', key: 'Shortcut', rows: [] },
    RemoveFile: { columns: 'FileKey CHAR(72) NOT NULL, Component_ CHAR(72) NOT NULL, FileName CHAR(255) LOCALIZABLE, DirProperty CHAR(72) NOT NULL, InstallMode SHORT NOT NULL', key: 'FileKey', rows: [] },
    LaunchCondition: { columns: 'Condition CHAR(255) NOT NULL, Description CHAR(255) NOT NULL LOCALIZABLE', key: 'Condition', rows: [
      ['VersionNT64', 'Windows x64 is required.'], ['NOT ALLUSERS', 'PaperEcho supports current-user installation only.'],
      ['Installed OR NOT (OLDERPRODUCTS OR NEWERPRODUCTS)', 'PAPERECHO_INPLACE_UPGRADE_BLOCKED: Verify a complete backup and retain a trusted old installer before explicitly uninstalling and reinstalling.'],
      ['NOT Installed OR REMOVE = "ALL" OR (PAPERECHO_INSTALLED_PACKAGE AND PAPERECHO_INSTALLED_PACKAGE = PaperEchoPackageId)', 'PAPERECHO_PACKAGE_REPLACEMENT_BLOCKED: Maintenance requires the original installed package; uninstall remains available.'],
      ['NOT PATCH AND NOT MSIPATCHREMOVE', 'PAPERECHO_PATCH_UNSUPPORTED: MSI patch updates are not supported.']] },
    InstallExecuteSequence: { columns: 'Action CHAR(72) NOT NULL, Condition CHAR(255), Sequence SHORT', key: 'Action', rows: [] },
    InstallUISequence: { columns: 'Action CHAR(72) NOT NULL, Condition CHAR(255), Sequence SHORT', key: 'Action', rows: [['AppSearch', null, 25], ['FindRelatedProducts', null, 50], ['LaunchConditions', null, 100], ['CostInitialize', null, 800], ['FileCost', null, 900], ['CostFinalize', null, 1000], ['ExecuteAction', null, 1300]] },
  };
  const directories = new Map([['.', 'INSTALLROOT']]);
  function directory(name) {
    if (directories.has(name)) return directories.get(name);
    const parent = path.posix.dirname(name), value = id('D', name);
    tables.Directory.rows.push([value, directory(parent), path.posix.basename(name)]); directories.set(name, value); return value;
  }
  for (const [index, file] of files.entries()) {
    const component = id('C', file.path), fileId = id('F', file.path), registry = id('R', file.path);
    tables.Component.rows.push([component, guid('PaperEcho/user/' + file.path), directory(path.posix.dirname(file.path)), 260, null, registry]);
    tables.FeatureComponents.rows.push(['Runtime', component]);
    tables.File.rows.push([fileId, component, path.posix.basename(file.path), file.size, null, null, 16896, index + 1]);
    // Stable key paths match stable component GUIDs across product versions.
    tables.Registry.rows.push([registry, 1, 'Software\\PaperEcho\\Installer\\Components', component, '[INSTALLROOT]', component]);
    if (file.path === 'PaperEcho.exe') {
      // Application-owned HKCU metadata only; never alter Installer private registration.
      tables.Registry.rows.push(['InstalledPackage', 1, 'Software\\PaperEcho\\Installer\\Packages\\' + productCode, 'PackageId', '[PaperEchoPackageId]', component]);
      tables.Shortcut.rows.push(['StartMenu', 'MenuDir', 'PaperEcho TEST ONLY', component, `[#${fileId}]`, null, 'PaperEcho TEST ONLY', null, null, null, 1, 'INSTALLROOT']);
      tables.RemoveFile.rows.push(['EmptyMenu', component, null, 'MenuDir', 2]);
    }
  }
  // Detect related products only. No automatic old-product removal or in-place upgrade.
  const sequence = { AppSearch: 25, FindRelatedProducts: 50, LaunchConditions: 100, CostInitialize: 800, FileCost: 900, CostFinalize: 1000, InstallValidate: 1400,
    InstallInitialize: 1500, ProcessComponents: 1600, UnpublishFeatures: 1800, RemoveRegistryValues: 2600,
    RemoveShortcuts: 3200, RemoveFiles: 3500, RemoveFolders: 3600, InstallFiles: 4000, CreateShortcuts: 4500,
    WriteRegistryValues: 5000, RegisterUser: 6000, RegisterProduct: 6100, PublishFeatures: 6300, PublishProduct: 6400, InstallFinalize: 6600 };
  tables.InstallExecuteSequence.rows = Object.entries(sequence).map(([action, position]) => [action, null, position]);
  return tables;
}

export async function buildInstaller() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('WINDOWS_X64_BUILD_REQUIRED');
  const latest = JSON.parse(await fs.readFile(path.join(repo, 'tests/runs/phase2b/latest-build.json')));
  const root = path.resolve(latest.output), parent = path.join(repo, 'tests/runs/phase2b');
  const artifact = await verifyReleaseArtifact({ root, parent });
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'release-manifest.json')));
  // Reuse a previously built binary only when every packaged source still matches.
  for (const source of manifest.sources) if (!Buffer.from(await fs.readFile(path.join(root, 'resources/core', source))).equals(await fs.readFile(path.join(repo, source)))) throw new Error('INSTALLER_STALE_PACKAGED_SOURCE');
  const base = path.join(repo, 'tests/runs/phase3a'); await fs.mkdir(base, { recursive: true });
  const stage = await fs.mkdtemp(path.join(base, 'installer-'));
  const files = [...manifest.files, { path: 'release-manifest.json', size: (await fs.stat(path.join(root, 'release-manifest.json'))).size }];
  // Same version/architecture/scope retains ProductCode; every MSI gets a fresh PackageCode.
  const productCode = guid(`PaperEcho TEST ONLY/${appVersion}/x64/per-user`), packageCode = `{${randomUUID().toUpperCase()}}`, tables = installerTables(files, productCode, packageCode);
  const payload = path.join(stage, 'payload.cab');
  const ddf = ['.OPTION EXPLICIT', '.Set Cabinet=on', '.Set Compress=on', '.Set CompressionType=MSZIP', '.Set MaxDiskSize=0', '.Set MaxCabinetSize=0', '.Set CabinetNameTemplate=payload.cab', `.Set DiskDirectoryTemplate=${stage}`];
  for (const file of files) ddf.push(`"${path.join(root, file.path)}" ${id('F', file.path)}`);
  await fs.writeFile(path.join(stage, 'payload.ddf'), ddf.join('\r\n'), 'ascii');
  execFileSync(path.join(process.env.SystemRoot, 'System32/makecab.exe'), ['/F', path.join(stage, 'payload.ddf')], { cwd: stage, timeout: 300000, stdio: 'ignore' });
  const msi = path.join(stage, `PaperEcho-${appVersion}-TEST-ONLY-x64.msi`);
  const spec = path.join(stage, 'database.json');
  await fs.writeFile(spec, JSON.stringify({ tables, msi, payload, packageCode }));
  const pwsh = process.env.PWSH_PATH;
  if (!pwsh || !path.isAbsolute(pwsh)) throw new Error('INSTALLER_PWSH_7_REQUIRED');
  execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-File', path.join(repo, 'desktop/electron-poc/installer-database.ps1'), '-Specification', spec], { cwd: stage, timeout: 180000, stdio: 'pipe' });
  const result = { schemaVersion: 1, testOnly: true, productCode, version: appVersion, msi, sha256: digest(await fs.readFile(msi)), artifactId: artifact.artifactId, fileCount: files.length };
  await fs.writeFile(path.join(stage, 'installer-report.json'), JSON.stringify(result));
  await fs.writeFile(path.join(base, 'latest-installer.json'), JSON.stringify(result));
  console.log(JSON.stringify({ stage: 'installer-build', status: 'TEST_ONLY_BUILT', fileCount: files.length, sha256: result.sha256 })); return result;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildInstaller();
