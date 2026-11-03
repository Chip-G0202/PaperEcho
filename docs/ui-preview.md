# 工作台 UI 预览

在仓库根目录执行 `npm run preview:ui`，打开输出的 `http://127.0.0.1:<port>/`。
停止：`npm run preview:ui -- --stop`，或在启动终端按 Ctrl+C。更新前端代码后先停止再启动；重复启动会复用已有预览快照。

页面直接嵌入真实 renderer、CSS、现有图形和发布版本；模拟适配器与正式应用隔离，不打入安装包。导航、开关、反馈和表单保存只改变当前页面内存，刷新重置。
顶部可切换共享 Key 的缺失、完整、冲突、不兼容场景。密钥输入只读；原生目录选择、登录启动、联网测试、文件导出均不可用，不会读取 `.env`、用户工作空间或调用真实业务服务。
启动时输出的 `PaperEcho-workbench-preview.html` 是自包含离线快照，可直接分享。它不包含真实设置、密钥或交互过程中输入的数据；UI 更新后需重新生成。

## 真实 HTML 工作台

`npm run workbench` 启动真实本地服务，在浏览器打开输出的 `http://127.0.0.1:8765`；返回终端按 Ctrl+C 停止，关闭浏览器窗口不会停止服务。需 Node.js >=18 和项目已有依赖；这是源码运行入口，本轮没有制作包含运行时的免安装分发包。
Mac 可使用 `desktop/browser-workbench/Start-Workbench.command`，Windows 可使用同目录 `Start-Workbench.cmd`（需要 PowerShell 7 Core）；不修改执行策略，不自动安装依赖。
默认使用与安装版一致的 Installed/default 工作空间。自定义数据目录时用 `npm run workbench -- --user-data-root <绝对路径>`；Windows 脚本可传 `-UserDataRoot <绝对路径>`，须与桌面版选择同一目录。Windows 复用已有受保护的启动位置记录；不要把 Portable 工作空间误当 Installed/default。
同一工作空间的配置格式、SecretService、锁和原子保存均与桌面版共用，无 localStorage 数据副本。切换前关闭桌面版或当前服务；端口已占用时不会接管其他实例。已有源码目录含旧数据时保留原有边界阻断，须显式指定正确的用户数据目录。
界面标记“本地 HTML 工作台 · 真实工作空间”，与黄色模拟预览不同。保留 Host/Origin/session/CSRF 保护，只监听 127.0.0.1。浏览器工作台复用现有 Control Center 的配置、状态、文献及反馈能力，不会自动执行工作流。
登录启动和原生目录选择仍需桌面应用；浏览器可手动填写数据路径，诊断包通过浏览器保存。首次选择自定义工作空间可用启动参数。Windows 实际运行与原生 GUI 往返仍需用户手动体验，不将服务层验证等同于 Windows 验收。
