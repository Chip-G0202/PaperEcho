// Optional browser entry only; no backend, installer or user data is generated.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const icons = path.resolve(here, '../electron-poc/icons');
export async function buildMacIconEntry(destination) {
  const output = path.resolve(destination);
  await fs.mkdir(output); // Exclusive delivery directory; never overwrite a user's entry.
  const app = path.join(output, 'PaperEcho 浏览器工作台.app');
  const contents = path.join(app, 'Contents');
  await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await fs.mkdir(path.join(contents, 'Resources'));
  await fs.copyFile(path.join(icons, 'paperecho.icns'), path.join(contents, 'Resources/paperecho.icns'));
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.paperecho.browser-workbench.launcher</string>
<key>CFBundleName</key><string>PaperEcho 浏览器工作台</string>
<key>CFBundleDisplayName</key><string>PaperEcho 浏览器工作台</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleExecutable</key><string>open-workbench</string>
<key>CFBundleIconFile</key><string>paperecho.icns</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
`, { flag: 'wx' });
  await fs.writeFile(path.join(contents, 'MacOS/open-workbench'), `#!/bin/zsh
set -eu
export LC_CTYPE=UTF-8
folder="\${0:A:h}"
folder="\${folder:h}/Resources/workbench"
entry="$folder/Start-Workbench-Quiet.command"
if [[ ! -x "$entry" || ! -f "$folder/quiet-workbench.mjs" ]]; then
  /usr/bin/osascript -e 'display alert "PaperEcho 启动入口不完整" message "请重新获取完整的浏览器工作台应用。"' >/dev/null
  exit 1
fi
/bin/zsh "$folder/Start-Workbench-Quiet.command" </dev/null >/dev/null 2>&1 &!
exit 0
`, { flag: 'wx', mode: 0o755 });
  for (const name of ['Start-Workbench.command', 'start.mjs', 'Start-Workbench-Quiet.command', 'quiet-workbench.mjs']) await fs.copyFile(path.join(here, name), path.join(output, name));
  await fs.chmod(path.join(output, 'Start-Workbench.command'), 0o755);
  await fs.chmod(path.join(output, 'Start-Workbench-Quiet.command'), 0o755);
  // Finder must read its launch resources within its own application bundle.
  // Keep adjacent files solely for the existing command-line debug entry.
  const bundledWorkbench = path.join(contents, 'Resources/workbench');
  await fs.mkdir(bundledWorkbench);
  for (const name of ['start.mjs', 'Start-Workbench-Quiet.command', 'quiet-workbench.mjs']) {
    await fs.copyFile(path.join(here, name), path.join(bundledWorkbench, name));
  }
  await fs.chmod(path.join(bundledWorkbench, 'Start-Workbench-Quiet.command'), 0o755);
  const stopApp = path.join(output, '停止 PaperEcho 浏览器工作台.app');
  await fs.cp(app, stopApp, { recursive: true, errorOnExist: true, force: false });
  const stopInfo = path.join(stopApp, 'Contents/Info.plist');
  await fs.writeFile(stopInfo, (await fs.readFile(stopInfo, 'utf8')).replaceAll('com.paperecho.browser-workbench.launcher', 'com.paperecho.browser-workbench.stop').replaceAll('<string>PaperEcho 浏览器工作台</string>', '<string>停止 PaperEcho 浏览器工作台</string>'));
  const stopExe = path.join(stopApp, 'Contents/MacOS/open-workbench');
  await fs.writeFile(stopExe, (await fs.readFile(stopExe, 'utf8')).replace('/bin/zsh "$folder/Start-Workbench-Quiet.command" </dev/null', '/bin/zsh "$folder/Start-Workbench-Quiet.command" --stop </dev/null'));
  return { app, output, runtime: 'INSTALLED_PAPERECHO_OR_SOURCE_NODE', pageAcceptance: 'PREVIOUS_FAILURE_UNRESOLVED' };
}
// MS-SHLLINK: relative target + environment-based icon. No machine paths,
// LinkInfo, target ID list, tracking block or elevation request is serialized.
// https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/17b69472-0f34-4bcf-b290-eccdb8de224b
// https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/9e6b7dfe-2ca2-4875-a0c9-8d75ee4f9b65
export function relativeShortcut(iconPath) {
  if (!/^%LOCALAPPDATA%\\PaperEcho\\launcher-icons\\paperecho-[a-f0-9]{12}\.ico$/.test(iconPath)) throw new Error('ICON_CACHE_PATH_INVALID');
  const header = Buffer.alloc(76);
  header.writeUInt32LE(76, 0);
  Buffer.from('0114020000000000c000000000000046', 'hex').copy(header, 4);
  header.writeUInt32LE(0x40cc, 20); // Name, relative path, icon, Unicode, expanded icon.
  header.writeUInt32LE(0x20, 24); header.writeUInt32LE(1, 60);
  const string = value => { const bytes = Buffer.from(value, 'utf16le'), count = Buffer.alloc(2); count.writeUInt16LE(bytes.length / 2); return Buffer.concat([count, bytes]); };
  const icon = Buffer.alloc(0x314); icon.writeUInt32LE(0x314, 0); icon.writeUInt32LE(0xa0000007, 4);
  icon.write(iconPath, 8, 'ascii'); icon.write(iconPath, 268, 'utf16le');
  return Buffer.concat([header, string('PaperEcho 浏览器工作台'), string('.\\Start-Workbench.cmd'), string(iconPath), icon, Buffer.alloc(4)]);
}
export async function buildWindowsIconEntry(destination) {
  const output = path.resolve(destination); await fs.mkdir(output);
  const bytes = await fs.readFile(path.join(icons, 'paperecho.ico'));
  const digest = createHash('sha256').update(bytes).digest('hex');
  const iconPath = `%LOCALAPPDATA%\\PaperEcho\\launcher-icons\\paperecho-${digest.slice(0, 12)}.ico`;
  await fs.writeFile(path.join(output, 'paperecho.ico'), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(output, 'PaperEcho 浏览器工作台.lnk'), relativeShortcut(iconPath), { flag: 'wx' });
  for (const name of ['Prepare-Workbench-Icon.cmd', 'Prepare-Workbench-Icon.ps1']) await fs.copyFile(path.join(here, name), path.join(output, name));
  return { output, target: '.\\Start-Workbench.cmd', iconPath, nativeWindows: 'UNVERIFIED', usage: 'DROP_IN_BESIDE_EXISTING_CMD_AND_PREPARE_ICON_ONCE' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('ONE_NEW_OUTPUT_DIRECTORY_REQUIRED');
  const root = path.resolve(process.argv[2]); await fs.mkdir(root);
  console.log(JSON.stringify({ mac: await buildMacIconEntry(path.join(root, 'Mac')), windows: await buildWindowsIconEntry(path.join(root, 'Windows')) }));
}
