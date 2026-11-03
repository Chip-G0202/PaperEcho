# 浏览器工作台图标入口

生成一个新的、不可覆盖的交付目录：

```sh
node desktop/browser-workbench/build-icon-entry.mjs output/browser-workbench-icons
```

- Mac：双击 `PaperEcho 浏览器工作台.app`，服务就绪后自动打开默认浏览器，不显示终端。停止请双击同目录的 `停止 PaperEcho 浏览器工作台.app`；关闭浏览器标签不会停止服务。两个应用的必需脚本均在各自包内，可整体移动交付文件夹；原 `.command` 仅作为调试入口。停止入口只接受本启动器记录的实例，不关闭复用的 Electron 或其他工作台服务。
- Mac 运行环境沿用现有启动器：优先使用“应用程序”内的 PaperEcho 内嵌运行时，否则需完整源码环境、Node.js 18+ 与项目依赖。图标 app 本身不包含后端。
- Windows：保留整个 `Windows` 文件夹，双击 `PaperEcho 浏览器工作台.lnk`；停止使用同目录的 `停止 PaperEcho 浏览器工作台.lnk`。正式入口使用 VBS GUI 宿主、隐藏的 PowerShell 7 和 `CreateNoWindow` 子进程，不经过 CMD；图标缓存自动准备，无需先运行脚本。原 `.cmd` 仅用于调试。
- Windows 优先复用默认用户级安装的 PaperEcho 内嵌运行时及 PowerShell 7。其他安装位置可通过既有 `PAPERECHO_DESKTOP_APP` 环境变量指向安装目录或 EXE；找不到内嵌 PowerShell 时仍需系统可用的 PowerShell 7。仅有 Node 但没有安装版后端时，需要完整源码及项目依赖；此入口文件夹本身不包含后端。
- 快捷方式使用同目录相对目标与正式 ICO，并自动维护当前用户的图标缓存。整体移动文件夹，勿单独移动快捷方式。Windows 的实际图标显示、移动后解析、默认脚本宿主、安全策略、无黑框、停止与重启均为 **UNVERIFIED**，需在 Windows 实机确认。不会调整 ExecutionPolicy 或系统安全设置。

图标只复用正式 ICNS、ICO 和现有网页 SVG favicon。快捷方式结构采用 Microsoft 的 [RelativePath](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/17b69472-0f34-4bcf-b290-eccdb8de224b) 和 [IconEnvironmentDataBlock](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/9e6b7dfe-2ca2-4875-a0c9-8d75ee4f9b65)，不记录开发目录的绝对目标路径。

Mac 入口已用隔离配置验证 Finder 无终端启动、真实首页、重复启动复用、停止及重启；不代表全部业务验收。`.app` 主入口仅拉起后台后退出，不让 GUI 启动进程承担长期 HTTP 服务。请从已提交源码生成交付目录，避免将其他启动器草稿带入产物。本入口不属于现有 Electron DMG/EXE，不需重建安装包。
