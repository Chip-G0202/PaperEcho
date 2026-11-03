#!/bin/zsh
set -eu
export LC_CTYPE=UTF-8
folder="${0:A:h}"
app="${PAPERECHO_DESKTOP_APP:-/Applications/PaperEcho.app}"
runtime="$app/Contents/MacOS/PaperEcho"
if [[ -x "$runtime" && "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist" 2>/dev/null)" == 'com.electron.paperecho' ]]; then
  unset NODE_OPTIONS NODE_PATH
  export ELECTRON_RUN_AS_NODE=1
  exec "$runtime" "$folder/quiet-workbench.mjs" "$@"
elif command -v node >/dev/null 2>&1; then
  exec node "$folder/quiet-workbench.mjs" "$@"
else
  /usr/bin/osascript -e 'display alert "PaperEcho 浏览器工作台" message "请先安装 PaperEcho，或配置 Node.js 18+ 与项目依赖。" giving up after 10' >/dev/null
  exit 1
fi
