# v2.6 桌面手动分发

Mac 管理开发、构建和 GitHub Releases；Windows 用户只负责下载安装和反馈。
不需要 Developer ID、公证或 Microsoft 签名证书。macOS arm64 保留本地 ad-hoc 签名以满足运行时要求，它不证明发行者身份。此流程不触发旧 Hyper-V、MSI 或 Full UI 验收。

## 构建

在仓库根目录，安装锁定依赖（Node 24）：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm ci --ignore-scripts --no-audit --no-fund --prefix desktop/electron-poc
npm run package:dmg --prefix desktop/electron-poc
```

DMG 仅支持当前 Apple Silicon arm64，输出到 `tests/runs/mac-dmg/build-*/artifact/`。不启动应用、不读取用户配置；执行 ad-hoc 签名验证、DMG 校验和只读挂载核对。
正常构建拒绝未提交的构建输入。仅本地预览可加 `-- --allow-dirty`，文件名标记 `UNCOMMITTED`，内置身份包含基准提交、dirty 和源文件哈希；此产物不应用作某个提交的发行包。

Windows runtime 需要执行 Windows `pwsh.exe` 验证内置运行时，因此不在 Mac 安装 Wine 或搭建远程 PC；使用 `.github/workflows/windows-setup-manual.yml` 的 Windows x64 runner。其命令为 `npm run package:setup:win --prefix desktop/electron-poc`，输出 `tests/runs/phase2b/setup-*/artifact/`。
NSIS 只包裹原 Packager runtime，不替换业务逻辑；用户级安装、有卸载入口、不自动启动应用、不删除独立用户数据、不提供自动更新。
原 MSI 实现和证据保留。NSIS 不提供 MSI ProductCode、修复、事务回滚及原 MSI 重装预检；遇到当前用户 MSI 登记时拒绝安装。已有 MSI 用户须先备份数据，手动卸载原 MSI，再安装 EXE；安装格式迁移和实际卸载行为尚需人工验证。

## 在 Mac 管理 Actions 和 Release

手动构建入口为 `mac-dmg-manual.yml` 和 `windows-setup-manual.yml`，权限仅 `contents: read`；只上传安装包、SHA256 和构建身份报告，不创建 Release。
`workflow_dispatch` 工作流必须先存在于默认分支，之后在 Actions 页面选择已提交的目标分支/提交运行。必须先由用户审核并推送这些改动；本地脚本不会推送、打 tag 或触发任务。
下载两个工作流 artifacts 后，核对报告版本、架构、完整 `gitCommit`、`dirty=false` 和文件哈希，再手动创建 GitHub Release，上传 DMG、Setup.exe、各自 `.sha256` 和身份报告。两个平台必须对应同一提交。

## 可复制的 Release 安装说明

- macOS Apple Silicon：下载 `PaperEcho-2.6.0-darwin-arm64-<commit>.dmg`，打开后把 PaperEcho 拖入 Applications。未做 Developer ID 签名或公证，可能出现无法验证开发者提示；核对来源后，可按系统“隐私与安全性”中的单次“仍要打开”流程操作。不要全局关闭 Gatekeeper；管理策略禁止时请停止安装。
- Windows x64：下载 `PaperEcho-2.6.0-win32-x64-<commit>-Setup.exe`，使用普通用户运行安装向导；可从系统“已安装的应用”卸载。安装器未签名，SmartScreen 可能警告；先核对 GitHub 仓库、Release 和哈希，再根据系统允许的单次操作继续。不要全局关闭 SmartScreen。
- 仅从本项目的 GitHub Releases 下载。Mac 用 `shasum -a 256 <文件>`，Windows PowerShell 用 `Get-FileHash -Algorithm SHA256 -LiteralPath <文件>`，与同一 Release 的 `.sha256` 对照；SHA256 只证明文件一致，不替代可信来源或签名。
- 构建成功只表示产物生成与结构核对完成，不表示 Windows 安装、卸载或业务运行已验证。请先使用独立空白数据目录体验，遇到问题提供版本、平台、提交及脱敏错误信息。
