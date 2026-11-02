# 浏览器工作台图标入口

生成一个新的、不可覆盖的交付目录：

```sh
node desktop/browser-workbench/build-icon-entry.mjs output/browser-workbench-icons
```

- Mac：保留整个 `Mac` 文件夹，双击其中的 `PaperEcho 浏览器工作台.app`。它通过 Terminal 打开同目录原有 `.command`；关闭服务仍在该终端按 Ctrl+C。可以整体移动文件夹，不要单独移动 app。
- Mac 运行环境沿用现有启动器：优先使用“应用程序”内的 PaperEcho 内嵌运行时，否则需完整源码环境、Node.js 18+ 与项目依赖。图标 app 本身不包含后端。
- Windows：将 `Windows` 内四个文件放到**已经可用的** `Start-Workbench.cmd` 同目录，先运行一次 `Prepare-Workbench-Icon.cmd`，再打开 `PaperEcho 浏览器工作台.lnk`。不替换原 `.cmd`、`.ps1` 或后端。
- Windows 图标准备需要 PowerShell 7，只向当前用户的 `%LOCALAPPDATA%\PaperEcho\launcher-icons` 添加内容寻址的正式 ICO，不修改业务配置。快捷方式目标是同目录的相对路径，图标通过用户缓存环境路径定位；不记录原交付目录；移动后的 Windows 原生解析仍需实机确认。换电脑或图标缓存被移除后，重新运行准备入口。不要单独把快捷方式移到桌面。
- Windows 启动链仍为原 `.cmd → PowerShell 7 → Node`。Mac 无法证明 Windows 原生快捷方式解析及图标显示结果；这些行为保持 **UNVERIFIED**。

图标只复用正式 ICNS、ICO 和现有网页 SVG favicon。快捷方式结构采用 Microsoft 的 [RelativePath](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/17b69472-0f34-4bcf-b290-eccdb8de224b) 和 [IconEnvironmentDataBlock](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-shllink/9e6b7dfe-2ca2-4875-a0c9-8d75ee4f9b65)，不记录开发目录的绝对目标路径。

生成器复制当前 `.command` 和 `start.mjs`，包括尚未提交的启动器草稿；因此图标验证不能代表完整工作台通过验收。上轮页面断言失败保持未解决。本入口不属于现有 Electron DMG/EXE，不需重建安装包。
