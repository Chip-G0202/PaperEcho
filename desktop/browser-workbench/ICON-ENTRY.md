# 浏览器工作台图标入口

生成一个新的、不可覆盖的交付目录：

```sh
node desktop/browser-workbench/build-icon-entry.mjs output/browser-workbench-icons
```

- Mac：双击 `PaperEcho 浏览器工作台.app`，服务就绪后自动打开默认浏览器，不显示终端。停止请双击同目录的 `停止 PaperEcho 浏览器工作台.app`；关闭浏览器标签不会停止服务。两个应用的必需脚本均在各自包内，可整体移动交付文件夹；原 `.command` 仅作为调试入口。停止入口只接受本启动器记录的实例，不关闭复用的 Electron 或其他工作台服务。
- Mac 运行环境沿用现有启动器：优先使用“应用程序”内的 PaperEcho 内嵌运行时，否则需完整源码环境、Node.js 18+ 与项目依赖。图标 app 本身不包含后端。
- Windows：将 `Windows` 内四个文件放到**已经可用的** `Start-Workbench.cmd` 同目录，先运行一次 `Prepare-Workbench-Icon.cmd`，再打开 `PaperEcho 浏览器工作台.lnk`。不替换原 `.cmd`、`.ps1` 或后端。
- Windows 图标准备需要 PowerShell 7，只向当前用户的 `%LOCALAPPDATA%\PaperEcho\launcher-icons` 添加内容寻址的正式 ICO，不修改业务配置。快捷方式目标是同目录的相对路径，图标通过用户缓存环境路径定位；不记录原交付目录；移动后的 Windows 原生解析仍需实机确认。换电脑或图标缓存被移除后，重新运行准备入口。不要单独把快捷方式移到桌面。
- Windows 启动链仍为原 `.cmd → PowerShell 7 → Node`。Mac 无法证明 Windows 原生快捷方式解析及图标显示结果；这些行为保持 **UNVERIFIED**。

图标只复用正式 ICNS、ICO 和现有网页 SVG favicon。快捷方式结构采用 Microsoft 的 [RelativePath](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/17b69472-0f34-4bcf-b290-eccdb8de224b) 和 [IconEnvironmentDataBlock](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/9e6b7dfe-2ca2-4875-a0c9-8d75ee4f9b65)，不记录开发目录的绝对目标路径。

Mac 入口已用隔离配置验证 Finder 无终端启动、真实首页、重复启动复用、停止及重启；不代表全部业务验收。`.app` 主入口仅拉起后台后退出，不让 GUI 启动进程承担长期 HTTP 服务。请从已提交源码生成交付目录，避免将其他启动器草稿带入产物。本入口不属于现有 Electron DMG/EXE，不需重建安装包。
