# PaperEcho 配置指南

## v2.6 程序与数据路径契约

唯一 root owner 仍是 `workflow/tools/lib/runtime_config.mjs`：`resolveRuntimePaths()` 解析 Application/User Data/Cache/Temporary roots，`prepareRuntimePaths()` 校验边界和目录写权限。部署 layout 与业务 mode（Desktop/Web/Local）独立，不自动切换 backend。下列 bootstrap 环境参数必须在启动前提供，不能通过 `.env` 改变自身位置；打包 Headless 的显式参数见 OS Scheduler 小节，不包含安装器。

| 参数 | 契约 |
|---|---|
| `PAPERECHO_LAYOUT` | `dev`（默认）、`portable`、`installed`；不根据 cwd、只读目录或凭据猜测 layout |
| `PAPERECHO_APPLICATION_ROOT` | 可选绝对程序根；默认由模块位置确定，代码、静态资源与未来 bundled runtime 位于这里 |
| `PAPERECHO_RESOURCE_ROOT` | 只读代码资源根，默认等于 Application Root，必须为其内部绝对路径；packaged bootstrap 固定为 `<application>/resources/core`，不能由 `.env` 改写 |
| `PAPERECHO_DATA_ROOT` | Portable 默认 `<application>/data`，覆盖值相对程序根且必须为其子目录；Installed 覆盖值必须为绝对、独立数据根；Dev 不接受此新参数，保留旧配置契约 |
| `PAPERECHO_WORKSPACE_ID` | 独立脚本的 Installed 模式未显式给 data root 时必填；packaged 入口在两者均缺省时绑定稳定的 `default` workspace；1–64 位字母数字/下划线/短横线，以字母数字起始，不从安装路径派生 |
| `PAPERECHO_CACHE_ROOT` | Portable 默认 `<application>/cache`；Installed 显式 data root 时默认 `<data>/.cache`，可选独立绝对 cache root；cache 不能包含 data 或程序目录 |

Installed 默认 Windows 数据根为 `%LOCALAPPDATA%/PaperEcho/workspaces/<id>`，cache 为 `%LOCALAPPDATA%/PaperEcho/cache/<id>`；使用本机非漫游目录，未设置合法 `LOCALAPPDATA` 时明确失败。macOS 路径契约为 `~/Library/Application Support/PaperEcho/<id>` 与 `~/Library/Caches/PaperEcho/<id>`，目前仅模拟路径测试，未实机验收。依据：[Microsoft 本机应用数据约定](https://learn.microsoft.com/en-us/windows/apps/develop/windows-app-restore)、[Apple 支持文件与缓存约定](https://developer.apple.com/documentation/foundation/using-the-file-system-effectively)。

新模式的 canonical 配置仍是 `<data>/config/paperecho.config.json`，SecretService 与 loader 只用 `<data>/.env`，不复制、不合并文件，不改变 schema。相对 canonical 配置字段继续相对其 config 目录解析；如 `common.projectRoot: ".."` 指向数据根。相对调用路径以选定 data root 为基准，程序脚本仍来自 Application Root；业务结果、研究规则、反馈/审核历史、claim、ledger、receipt 与恢复信息继续由现有 owner 管理。Local 默认 `<data>/review_results/local`。新模式拒绝越出 data root 的可变状态 override；外部只读导入输入保持显式指定。Temporary Root 为 `<cache>/tmp`，传递给 workflow 子进程的 TEMP/TMP/TMPDIR；旧业务 cache 仍保留在既有数据路径，不在本轮移动或删除。

Portable 用相对配置随整个程序目录移动；指向旧绝对位置的配置不会被自动重写或猜测修复。Installed 的 data/cache 与程序目录必须互不包含，不允许写入 app.asar。启动时拒绝 root/配置路径的 symlink/junction 越界；凭据文件原有 hardlink、格式、原子写入、锁与 Windows ACL 检查保留。目录采用并发安全创建、独占空探针确认可写，不放宽已有目录 ACL。不可写或布局冲突必须停止，不回退到程序目录或另一数据根。

兼容边界：默认 Dev 继续读取 v2.5 程序根 `config/paperecho.config.json` 与 `.env`，已有 `common.projectRoot`、Local output 等旧契约保留；内部默认程序位置由模块定位，不随启动 cwd 改变。新模式只检查程序根的已知旧数据标记（`.env`、canonical config、runtime state、研究规则、runs、pipeline），不扫描历史目录。发现旧标记且未显式选定 `PAPERECHO_DATA_ROOT` 时返回 `RUNTIME_LEGACY_DATA_FOUND`，不自动选择或复制；显式选定 data root 后旧根仍原样保留，不作为 fallback。多个工作区须分别指定 id/root，配置与凭据不能跨根拼接。

本轮没有迁移、卸载或自动回滚动作。回滚代码不得清理新数据根；旧 v2.5 不认识新 layout，回用旧版本前须保留两套目录并人工核对旧版本路径/凭据入口，不能假定它会自动发现新根。安装更新不得将 data/cache 当程序产物替换；Windows unpacked runtime 验证见下节，Installer 与 macOS 仍需后续验收。

验证：`node --test workflow/tests/runtime_paths.test.mjs`（隔离 Portable/Installed HTTP、移动、并发目录、Secret 与状态 owner），加 `runner_config`、`control_credentials`、`control_runtime_roots`、`control_http`、`operation_ledger`、recovery、scheduled-daily 定向回归，再运行 `npm run check` 和 `npm test`。测试 TEMP/TMP 及产物限定 `tests/runs/`，无真实外部操作；只读程序目录用拒写文件系统注入验证，不修改真实安装目录 ACL。

v2.5 的 schema v3 收敛非敏感配置，v4 增加 Radar/Weekly 通知偏好，v5 增加 QQ outbound，v6 一次增加默认关闭的微信、飞书、企业微信群机器人渠道。Settings → 通知与推送可独立多选五个渠道；凭据由 SecretService 管理。迁移、字段、产品长度预算与 provider 边界以 [Config map](../config/README.md) 为准。本文以下表格继续描述 v1/v2 compatibility；迁移后旧领域文件不再是保存目标，旧模型 env 不再覆盖 Settings。

**日常首选 Control Center → Settings。当前 schemaVersion 为 6，非敏感应用配置的唯一 canonical 文件是 `config/paperecho.config.json`；密钥通过 Credentials、本机 `.env` 或外部环境维护，不进入 JSON。** 长期研究规则正文 `screening_standards.md` 由 Research Feedback / Rule Suggestions 或正式编辑入口维护；它不是第二份应用配置。pending/feedback/规则建议及决策历史、runtime/schedule state、ledger、receipts、reports、history、logs 都是运行数据，不应手工编辑来配置应用。

迁移后的安装无需同步旧领域 JSON；尚未迁移的 v1/v2 安装仍走这些文件的 compatibility 读取和保存。canonical section 缺失时不会回读旧文件。完整 A–F 文件分类见 [配置职责](../config/README.md)。示例与 prompt Markdown 是模板/高级入口，普通使用无需额外维护模型参数 JSON。

## Windows unpacked runtime

已安装根目录及 `desktop/electron-poc` 的锁定依赖后，在 Dev 仓库运行：

```powershell
npm run package:win --prefix desktop/electron-poc
node --test tests/helpers/packaging.test.mjs
npm run smoke:packaged --prefix desktop/electron-poc
```

唯一打包工具为 Electron Packager。构建按代码/模板 allowlist 和 npm production dependency tree 组装一次 `resources/core`；Electron Shell 放入 `app.asar`。物理 workflow、静态资源和依赖只保留一份，供 Electron 与独立 Node 子进程共同读取。产物及报告在 `tests/runs/phase2b/`，不进入 Git。打包使用锁定 Electron npm 包的官方 `checksums.json` 验证 ZIP；`tests/runs/electron-cache/` 中由官方安装器或 `@electron/get` 填充的匹配缓存可离线复用，无需再次获取远程校验表。缺少资产时仍走官方下载和校验，不关闭 TLS/checksum。

GUI 运行产物中的 `PaperEcho.exe`；独立无窗口入口为 `PaperEcho-headless.cmd --check --mode local`（或显式选择 `desktop` / `web`）。Headless 复用 Shared Runner、preflight 和原 workflow entry，退出码沿用 Runner，无系统 Node/npm 依赖。Packaged 缺省为 Installed，未指定数据根/id 时使用 `default` workspace；GUI 首次配置通过下述向导完成。显式数据根/id 仍优先，Portable 需显式设置 `PAPERECHO_LAYOUT=portable`。不迁移数据或自动生成文献输入。

Packaged bootstrap 固定 Application Root 为程序目录、Resource Root 为其 `resources/core`，不受 cwd 或外部程序根 override 影响。配置、Secret 和可变状态继续使用数据根；Electron profile/session/crash/native debug 使用 cache，正式运行日志使用下述 User Data Logs Root。业务脚本通过统一 owner 从 Resource Root 定位；模块边界测试使用 `realpath` 加 `path.relative`，兼容末尾分隔符并拒绝链接或外部根，不能用字符串前缀扩大允许范围。

实际二进制 fuses：RunAsNode、CookieEncryption、EmbeddedAsarIntegrityValidation、OnlyLoadAppFromAsar、WasmTrapHandlers 开启；NodeOptionsEnvironmentVariable、NodeCliInspectArguments、BrowserProcessSpecificV8Snapshot、FileProtocolExtraPrivileges 关闭。RunAsNode 是独立入口和现有 Node 子进程链所必需，保留了执行任意 Node 代码的能力。ASAR integrity 覆盖 Shell，不覆盖物理 `resources/core`；这些资源必须作为程序代码保护写权限，正式签名/发行另行验收。不能将关闭 RunAsNode 的产物用于此 Headless 方案。

Windows 验证使用中文/空格目录、空 PATH、仓库外 cwd、仅 dummy/mock 数据；同时验证三尺寸 GUI、真实 Headless Local 子进程、scheduled 入口 mock、模块来源、异常退出、无遗留进程、实际 fuses 与 EXE 内嵌 ASAR header hash。smoke 对临时 Application 副本实际拒写并在 finally 恢复 ACL；不会改真实安装目录或 Production ACL。复用既有产物时，先逐文件核对业务源码，仅更新测试副本内的测试文件；正式运行时或构建配置变化必须重建。macOS、Installer、系统调度注册、签名与升级迁移均未在此 Gate 验证。

常规与恢复页面的精确尺寸 smoke 显式使用测试进程参数 `--force-device-scale-factor=1`，逐项验证原生 content DIP、renderer CSS viewport、zoom 和窗口所在工作区，不在原生尺寸校验后叠加 viewport 仿真。报告在分支前初始化 `views`，只在真实页面检查完成后追加记录；失败保留数值 `lastViewport`，不保留页面正文。这是 100% 测试缩放下的矩阵，不能代表所有系统 DPI；产品默认缩放和系统设置不变。首次向导的仿真在独立测试进程执行。

## OS Scheduler 离线契约（Phase 5A）

唯一离线 owner 为 `workflow/tools/lib/os_scheduler.mjs`；不含 OS 执行或注册接口，不在 GET、首次配置或 workflow 中自动启用。schemaVersion 6 的 canonical config 可选增加 `"scheduler": {"schemaVersion":1,"enabled":false,"time":"15:00","timezone":"Asia/Shanghai"}`；无此段的旧配置保持兼容，离线调度预检要求显式配置。`enabled:false` 也由正式 `--scheduled-daily` 判定拒绝，不能靠旧任务继续触发。Local、Dev 和任意其它时间/时区不属于当前业务调度契约，安全拒绝，不为 OS 适配改变业务规则。

schedule spec v1 的任务标识来自规范化数据根 hash，同根重复标识拒绝且不覆盖；参数由正式 Runner parser 验证。Windows 定义使用单独 Command/Arguments/WorkingDirectory，明确启动 `PaperEcho.exe --headless`，无 shell、Node/npm PATH 查找、环境密码或 SYSTEM 身份。任务身份契约为当前用户已登录的 InteractiveToken / LeastPrivilege；未登录执行不在本阶段范围内。程序路径、数据根、缓存根在定义中固定；Portable 移动后必须重新预检和生成定义，不自动寻找旧根。

固定 Asia/Shanghai 15:00 = UTC 07:00，无 DST；不支持有跳时/重复小时的其它业务时区。Windows 定义日历触发、StartWhenAvailable、IgnoreNew、不唤醒机器、不要求网络条件；错过多日只评估当前业务日计划槽，不补跑历史日期，当前槽之前退出。重复触发仍由现有 Stage0 day claim、workflow lease 和 ledger 决定，不能以 OS IgnoreNew 代替业务幂等。macOS 仅生成静态 LaunchAgent plist：StartCalendarInterval、不 RunAtLoad/KeepAlive，要求主机 Shanghai 时区；macOS 平台预检保持 UNKNOWN，尚未实测。

只读 `--schedule-preflight` 与 `--schedule-dry-run` 互斥于 workflow 参数，复用 Runtime Root、ConfigService resolver、SecretService ACL、Doctor 和现有 scheduled selection/recovery owner。预检读取当前程序边界内的固定 executable/resources；Electron 下用 `original-fs` 验证物理 app.asar 为单链接常规文件，不把虚拟 ASAR 目录当成安全检查失败或放宽断言。资源完整性/签名发行要求仍见 Windows unpacked runtime。活动/不明 lease、损坏 claim、待恢复 ledger、Restore transaction 或待审阅恢复历史均阻止就绪；不清锁、改权限、重放通知或调用外部服务。外部托管凭据的非交互注入尚无证明时返回 UNKNOWN，不写入任务定义；本地 `.env` 先通过 SecretService 安全检查再由原 loader 读取。

打包入口：`PaperEcho.exe --headless --runtime-layout installed --user-data-root "<绝对数据根>" --cache-root "<绝对缓存根>" --schedule-preflight`；将末参数换为 `--schedule-dry-run` 得到脱敏 XML 模板。Portable 用 `--runtime-layout portable` 且根必须在程序目录内。入口在 Electron ready 前等待内置 Node 子进程，未创建 BrowserWindow；沿用已核验 RunAsNode fuse，清除 NODE_PATH/NODE_OPTIONS，不增加 renderer 能力。原 `.cmd` 和 `--check` 入口兼容。

两条只读命令均不创建日志、目录、任务或临时定义文件；PASS 退出 0、FAIL 退出 2、UNKNOWN 退出 3（参数错误退出 3）。CLI 只返回安全检查 ID/状态、任务策略和以 `__APPLICATION_ROOT__` / `__USER_DATA_ROOT__` / `__CACHE_ROOT__` 代替实际路径的定义模板；非 PASS 不返回定义。模板不能直接当作已注册任务或真实 OS 验收证据。

验证：`node --test workflow/tests/os_scheduler.test.mjs`，加 scheduled-daily、Runner/config/runtime、Secret、Doctor、claim/ledger/recovery 与 Restore gate 回归。已有离线缓存构建：`npm run package:win --prefix desktop/electron-poc`；`node tests/helpers/packaged_scheduler.mjs` 在独立 dummy 根验证真实 native executable、内置 Node、空 PATH、仓库外 cwd、原生参数引用、只读快照、UNKNOWN/恢复阻塞、fuses 与进程清理。原生 raw argv 测试必须同时正确引用 executable argv[0] 和每个参数。最终使用原样 `npm run check`、`npm test`，不降低并行度。

Phase 5A 的结果仅为离线/模拟验证，不代表真实 OS 注册通过。Windows 的 Phase 5B 验证范围见下节；休眠重启、未登录运行和 macOS 实机行为仍未验证。

## Windows Scheduler 显式管理与 Sandbox 验收（Phase 5B）

packaged Headless 提供七个独立命令：`--schedule-register`、`--schedule-query`、`--schedule-enable`、`--schedule-disable`、`--schedule-update`、`--schedule-run`、`--schedule-delete`，沿用上节绝对 Runtime Root 参数，不与 workflow 参数混用。需明确的 PowerShell 7 `PWSH_PATH`。普通 GET、preflight、dry-run 和启动不会注册任务。register/update/enable/run 必须通过正式预检；query/disable/delete 在仍能识别合法 spec 时可用于安全清理。启用/运行还要求 canonical scheduler.enabled=true。

薄原生 owner 通过固定 PowerShell 脚本及 UTF-8 JSON stdin 调用 Task Scheduler COM；COM XmlText 使用 UTF-16 BSTR 声明，下载模板仍是 UTF-8。任务只属于当前 SID，InteractiveToken / LeastPrivilege；Create 和 Update 分离，拒绝重复注册与接管。动作、参数、工作目录、触发器和并发策略来自现有 canonical spec，执行与启用前核对原任务定义，不接受任意 XML 或 shell 命令。

正式 Runner 在 scheduled selection 的安全跳过之前检查 Restore transaction owner；Restore/Migration PREPARED 返回既有 pipeline 退出码 5 与 `RESTORE_RECOVERY_REQUIRED`，不改事务、claim、receipt 或研究数据。正常的 before-slot/已完成空跑仍允许退出 0。日志目录被事务门禁保护时，用正式 schedule 响应证明拒绝，不强行写日志。

自动验收需要当前用户可用的 wsb CLI 和可信 packaged 产物；有既存沙盒时安全拒绝，不关闭或接管用户会话。在 PowerShell 7 中执行：

```powershell
$env:PWSH_PATH = Join-Path $PSHOME 'pwsh.exe'
$env:WSB_PATH = (Get-Command wsb.exe -ErrorAction Stop).Source
node tests/helpers/sandbox_scheduler.mjs --prepared
node tests/helpers/sandbox_scheduler.mjs --run
```

每轮唯一 runId，先验证产物源码、输入 SHA256 与客体身份，再通过 wsb + ExistingLogin 自动执行。网络关闭，仅共享只读公共输入和专用可丢弃输出；Runtime 复制到客体本地。终态报告要求实际 Runner PID/退出事件与新的 RuntimeLog 完成事件对应，不仅依据 LastTaskResult。临近自动触发只存在于 TEST ONLY 客体定义；禁用不触发、重新启用、更新、并发/恢复拒绝、只读 Doctor、任务删除和进程清理均有真实断言。宿主不调用任何任务修改接口，不执行真实研究或外部服务。测试日期从 JSON 的 DateTime 转为 DateTimeOffset 时保留 UTC Kind，不能先转字符串丢失时区。

已验证范围是隔离 Sandbox 中当前已登录用户、packaged Runtime、空 PATH 与仓库外 cwd；长期重启/休眠、未登录身份、安装器整合仍未验证。Phase 3A、Phase 6C、Signing、macOS 和正式 Release Gate 继续 Blocked，不把此结果当作发行通过。

## 离线升级兼容性预检（Phase 6A）

`upgrade_preflight_service.mjs` 只读识别源程序/数据契约并生成 schema v1 计划，始终返回 `executionAllowed:false`。不创建目标根、锁、日志、备份或迁移副本，不执行升级、Restore、调度注册或外部服务调用。显式指定的源根、目标根不能重叠；目标必须全新，父目录已存在。未知证据保持 UNKNOWN，危险或不支持的映射为 BLOCKED，不自动选择多个候选根。

| 证据或状态 | 支持范围与限制 |
|---|---|
| v2.5 tag `2b5e65e` | canonical schema 已是 6，Runner 可读 1–6；旧程序仅 Dev 布局。根 package 无 version，以该 tag 的公开 Runtime Root 文件精确 SHA256 识别契约族；不是整个程序或签名真实性证明 |
| 当前 v2.6 | packaged `resources/core/package.json` 明确携带 2.6.x 版本；缺少版本元数据的旧包保持 UNKNOWN，不从目录名推断 |
| canonical schema 3/4/5/6 | 3→4→5→6 已由现有 `application_config_migration.mjs` 实现，本预检仅调用纯对象预览；6 保留原字节，绝不自动写回 |
| canonical schema 1/2 | Runner 兼容读取，但完整迁移涉及旧领域文件及 env 合成；本预检不调用会写入的迁移器，标记 BLOCKED，需另行验证 |
| 同为 schema 6 的字段差异 | v2.5 未定义 scheduler，混入该字段的旧契约拒绝；当前配置的 scheduler absent/disabled/enabled 原样保留，不注册或启用任务 |
| 数据布局 | 源 Dev/Portable/Installed，目标仅全新 Portable/Installed；绝对业务数据路径需要人工重映射时 BLOCKED，不静默改写或丢弃字段 |
| 状态格式 | 现有 ledger schema 1、lease schema 1、receipt schema 2 保持原 owner；活动/不明 claim、未完成 ledger/恢复事务、待审阅恢复历史阻塞，保留历史调度决定为 UNKNOWN，绝不自动激活 |

旧 `.env` 无当前来源登记语义。本地文件先由 SecretService 检查 hardlink、路径和 ACL；当前环境中的引用名称以及认证备份声明的 external Secret 依赖分别保留，需重新配置时 UNKNOWN。不加载源 `.env` 到环境，不读取或复制外部凭据值，报告不含自定义 Secret 名称、路径、正文或配置全文。

计划复用 BackupService 的九类 owner：config、secrets、research-feedback、rules、review-history、results、run-recovery、local-state、user-input。清单只输出各类数量/覆盖状态、源清单摘要、配置 hash、依赖步骤和安全动作标识。顺序为停止写入并复核 → 认证备份 → 保留各 owner → 配置与 Secret 校验 → Doctor/Runtime/recovery 验证且历史不激活 → 后续 Phase 6B 发布或回滚。当前不会执行这些步骤。

回滚前提要求源程序和原数据根保留；提供的加密备份必须由现有 Verify 完成 AES-GCM、manifest/SHA256 验证，并与当前源文件及 owner 清单逐项匹配。备份 schema 1、creator releaseLine 2.6、restoreContract 1 不等于已证明跨版本恢复。缺少备份为 UNKNOWN，错误密码、篡改或源已变更为 BLOCKED。旧程序能否读取新数据、实际失败回滚和 Doctor 后验须在 Phase 6B 隔离环境验证，不能靠 Verify PASS 宣称成立。

文件系统预检复用路径 owner 和安全文件读取；拒绝 symlink/junction、hardlink、外部 owner、已有目标和跨卷方案。Windows 只读检查 NTFS、可用空间（至少源数据三倍加 64 MiB）及父目录创建权限。Node `access(W_OK)` 不能证明 NTFS DACL 允许创建，因此额外申请现有目录的 `FILE_ADD_SUBDIRECTORY` 句柄并立即关闭，不创建探针、不修改 ACL；拒绝为 BLOCKED，无法确认平台或空间为 UNKNOWN。该预检是当时观察，不代替执行前重新校验。

打包命令示例（所有路径均为明确选定的隔离根）：

```powershell
PaperEcho.exe --headless --runtime-layout installed --user-data-root "<host data>" --cache-root "<host cache>" --upgrade-dry-run --source-application-root "<old app>" --source-data-root "<old data>" --source-layout dev --target-data-root "<new data>" --target-layout installed --verified-backup "<source.pebackup>" --password-stdin
```

`--upgrade-preflight` 返回相同安全摘要和简化步骤；与 `--upgrade-dry-run`、workflow 参数互斥。密码沿用 Backup 的隐藏终端或显式 stdin，不接受 argv/env 密码。退出码 PASS/WARN 为 0，BLOCKED 为 2，UNKNOWN/参数错误为 3。源布局可选 dev/portable/installed，目标可选 portable/installed；Portable 仍受统一程序内数据子目录边界约束。源码入口为 `node workflow/tools/runner/main.mjs` 加相同 Upgrade 参数，目标程序证据不充分时不能得到 PASS。

验证：`node --test workflow/tests/upgrade_preflight.test.mjs`，配合 Config、Runtime、Secret、Backup/Verify、Restore transaction、Stage0/ledger/recovery、Scheduler 和 Doctor 回归。`tests/helpers/upgrade-v2.5-runtime-contract.txt` 是上述 tag 的公开源文件 fixture，不作为代码执行。离线缓存构建 `npm run package:win --prefix desktop/electron-poc` 后，`node tests/helpers/packaged_upgrade.mjs` 核对最终源码、真实 native executable/内置 Node、空 PATH、仓库外 cwd、Portable/Installed、源文件 hash 不变、目标不存在与进程退出。最终运行默认 `npm test`、`npm run check` 和 diff check，不降低并行度。所有测试数据虚构，不访问 Production。

Phase 6B 的合成工作区执行见下一节；Phase 6C 的真实安装升级尚未实现。Phase 3A Installer 仍 Blocked，Phase 5B 真实 OS 注册仍待可信 VM，macOS 未实测。契约识别不替代完整安装资产完整性、签名或发行 Gate。

### 隔离迁移执行（Phase 6B）

`upgrade_migration_service.mjs` 在上述只读计划上编排执行，不另建配置、备份或恢复状态。入口仅接受 `tests/runs/phase6b/<UUID>` 下由测试 fixture 创建的私有合成工作区；打包程序必须位于其 `new-program`，源、目标、备份及计划均按固定边界解析。普通数据根不能借此入口迁移。marker 是测试范围标识，不是任意数据真实性或发行签名证明。

| 条件 | 执行兼容性 |
|---|---|
| schema 3/4/5，源证据及认证备份全部 PASS | SUPPORTED：在私有 staging 中调用现有 `migrateApplicationConfig`，真实执行到 schema 6；不修改源根 |
| schema 6，预检全部 PASS | 配置转换 NO_OP，保留配置原字节；数据仍经过认证恢复、检查和全新根发布 |
| UNKNOWN 证据、外部凭据需重新配置、保留的历史调度 claim 需审阅 | PREVIEW_ONLY：只读报告，不允许执行，不自动删改或激活历史状态 |
| schema 1/2、不支持的 schema、活动 lease/事务、路径或完整性错误 | BLOCKED；不合成旧领域配置、不绕过安全门禁 |

执行要求明确确认 Plan ID，重新验证完整计划、源目录身份与文件清单，以及源绑定的 AES-GCM/manifest/SHA256 备份。九类数据 owner 复用 Backup 清单；除正式配置转换外，备份条目逐项核对字节。ledger、receipt、反馈、审核和结果保持原内容，恢复历史 receipt 继续禁止自动运行；Doctor 的关键配置、Secret、资源检查必须 PASS，`canRun:false` 不被包装成正式 workflow Ready。旧 `.env` 只在私有 staging 恢复并复查 ACL，外部管理值不复制，Scheduler 配置不触发注册。

发布与恢复复用 `RestoreTransaction` 的单一 journal，`kind:upgrade-new-root` 绑定源身份、源快照、Plan 和备份摘要。源根只保留指向该 journal 的门禁引用；源和目标的活动 writer 均被拒绝。lease admission 在 `mkdir` 前检查，创建 lease 时仍复检，避免被拒绝的竞争者先改变源目录。私有 staging 的配置写入需要真实、存活且不可伪造的 NTFS guard capability，普通 writer 不能绕过事务状态。

Windows NTFS 同卷发布只接受全新 B；A 保留原字节及旧程序，回滚撤回 B 到私有事务目录，不覆盖或删除 A。未完成事务显式恢复时保守回滚，已提交响应丢失时返回同一操作；未知身份、源变化或损坏证据保持 `RECOVERY_REQUIRED`，不强行清锁。保留原程序、A、备份及事务目录供回滚，不能把这里的验证等同于真实旧二进制启动或安装器升级。

执行参数为 `--upgrade-execute --isolated-workspace "<fixture absolute root>" --confirm-plan <plan.id> --password-stdin`；恢复和回滚分别使用 `--upgrade-recover`、`--upgrade-rollback` 加同样的 workspace/Plan 确认，不需要密码。源码调用 `node workflow/tools/runner/main.mjs`，测试须显式绑定 fixture 的 Application/Resource/User Data roots；打包调用 `PaperEcho.exe --headless --runtime-layout installed --user-data-root "<fixture host data>" --cache-root "<fixture host cache>"` 加上述参数。目标 Installed/Portable 类型来自已确认的计划，host cache 不得位于切换中的 A/B。

验证命令：`node --test workflow/tests/upgrade_migration.test.mjs workflow/tests/upgrade_migration_security.test.mjs workflow/tests/upgrade_migration_crash.test.mjs`。离线构建后运行 `node tests/helpers/packaged_upgrade_migration.mjs`，为其提供指向已批准 PowerShell 7 可执行文件的绝对 `PWSH_PATH`；脚本验证最终源码、真实内置 Node、空 PATH、仓库外 cwd、Installed/Portable 迁移/回滚及进程终止后的幂等恢复。测试仅用合成数据；不操作 Production、真实 OS 任务或外部服务。最终检查仍使用默认 `npm test` 并行度、`npm run check` 和 diff check。

### v2.5 数据接续与恢复验收（Phase 6C-A）

数据验收与程序/MSI 升级独立。v2.5 来源使用固定 tag 的 Runtime Root 指纹识别；已落盘 canonical schema 6 的配置保持原字节，不虚构 schema 5→6 转换。旧 tag 的示例模板仍为 schema 2，不应把模板版本误当成已落盘配置的 canonical 版本。

`v25_data_recovery.test.mjs` 通过正式 owner 构造隔离合成反馈、建议、研究历史及九类数据，验证认证 Backup/Verify、Installed/Portable 全新目标根、Secret ACL、completed ledger、accepted receipt、期刊元数据和逐文件 hash。文章反馈 owner 与固定 v2.5 tag 一致；样本中的 v2.6 结构化研究 inbox 只验证附加状态保留，不冒充旧版原生输出。既有有效目标拒绝覆盖，源程序、原数据根、备份及事务证据保留。Doctor 只读；恢复历史继续阻止自动 workflow，不能将数据恢复成功解释为允许重发研究或通知。

中断验收实际终止独立 Node 迁移进程，待其及 Guard 退出后，在另一个进程读取正式 journal 恢复；覆盖 PREPARED、NEW_PUBLISHED、COMMITTED 响应丢失及重复恢复。HTTP/TCP/TLS 测试入口拒绝外部调用，拒绝动作本身也有负例验证。验证命令：`node --test workflow/tests/v25_data_recovery.test.mjs`；与上述 UpgradePreflight/Migration 安全回归及默认全量测试联合验收。

Restore 中断测试的子进程通过同一 IPC 通道报告真实 hook/checkpoint 进度，父进程在监听建立后等待准确的目标阶段。60 秒约束用于无进展等待，有限且顺序递增的阶段才可重新计时，重复阶段不能续期；总等待仍受阶段数量限制。这不是整个 Backup/ACL/Restore 操作的性能 SLA。PRESERVING/OLD_PRESERVED 还需核对持久 journal、旧目录身份及 rename 两侧事实，随后真实终止进程并验证恢复和哈希，不能以收到任意消息代替安全断言。

执行器仍只接受上述隔离工作区，不开放普通用户根自动迁移。此数据子阶段不替代 Guest/OS 重启、程序替换、MSI 失败回滚或发行验收；Phase 6C-B 及 Signing/macOS/Notarization/Release Gate 继续受各自未完成条件阻断。

## Crash Recovery 与启动安全

`recovery/run_recovery.mjs` 只读投影现有 run manifest、ledger、receipt、workflow lease 和当天 schedule claim，返回 `SAFE_TO_CONTINUE`、`RECOVERY_REQUIRED`、`BLOCKED` 或 `UNKNOWN`；不新增恢复数据库，不以日志或 mtime 推断成功。每个 runRoot 最多检查 100 个目录条目、单份元数据最多 1 MiB、累计投影内容最多 8 MiB；达到边界、元数据损坏或链接身份不明均安全阻塞。较新的完成记录不能隐藏较早的未完成运行。正式无操作 skip，以及具备已完成 manifest、必需阶段验证和安全通知终态的无操作成功运行，可以继续启动；空 ledger 本身不是成功证据。

Runner 父进程持有原 `.workflow.lease.json`，覆盖子进程及其后的结果/通知收尾；同主机、同 runId/profile、真实直接子进程及匹配 ownerId 才能借用，子进程不能释放父 lease。只有本地主机已确认终止且过期的 owner 才可接管；使用同一文件系统的 hardlink、不覆盖历史文件及文件身份复核选出一个接管者，接管中断的歧义证据保持阻塞。远程 owner、存活进程、未知 legacy `.runner.operation.lock` 不自动清除。当前 Windows 接管实测范围为 NTFS，macOS 未实测。

普通启动和 `--scheduled-daily` 不自动重跑未确认业务；显式恢复仍走对应固定 launcher 的 `--run --resume <runId>` 和原 ledger/artifact 校验。自动恢复仅在业务阶段及所有非通知操作已验证时进入原恢复 owner；通知操作再由原 receipt 校验决定是否可继续，已 accepted 不重发，unknown 不当作失败重试。Restore/Migration 的事务门禁继续由原 transaction owner 持有。已配置用户遇到启动恢复阻塞进入 System Health，保留配置，不重新初始化；Doctor 只读展示 `workflow.startup`，GUI 不参与 Headless 的准入决策。

定向验证：`node --test workflow/tests/startup_recovery.test.mjs workflow/tests/control_setup.test.mjs workflow/tests/scheduled_daily_integration.test.mjs workflow/tests/operation_ledger.test.mjs`。最终源码离线打包后，`node tests/helpers/packaged_startup.mjs` 验证 Installed/Portable 的真实 GUI 三尺寸、内置 Node、空 PATH、仓库外 cwd、进程终止/恢复、只读 Doctor 和无遗留进程；`--cold-only` 补测干净配置的 GUI/Headless 冷启动。测试核对所有正式打包源码，仅允许刷新外部 smoke helper。Windows GUI 测试使用可启动 Chromium 子进程的正常桌面用户上下文，保持应用 sandbox/contextIsolation/webSecurity；记录 HTTP listen/200、导航和子进程退出，区分服务就绪与 renderer 加载。精确尺寸测试显式使用 100% 测试缩放，不改变系统设置或放宽 CSS/DIP 断言。最终仍运行默认 `npm test`、`npm run check` 和 diff check；单次全绿不消除历史间歇性锁错误的未确认风险。

## 首次运行配置向导

GUI 启动读取真实配置与原 `runPreflight` 的本地检查结果：缺少配置或必要条件未满足时进入向导；已配置且本地检查可运行时直接进入 Control Center。可从“设置 → 首次配置向导”再次进入。没有完成布尔标记或第二份配置状态；关闭、部分保存、重复进入均以现有 owner 的持久数据恢复。合法但未选择 mode 的配置仅在 UI bootstrap 中提供临时显示上下文，不回写默认 mode；歧义、错误配置或冲突数据根仍由正式 resolver 拒绝。

步骤为欢迎、本地数据位置确认、基础配置、可选凭据、本地检查摘要。运行路径由用户明确选择，Local 输入/输出、Web User ID 等字段来自既有 Settings registry；凭据可稍后补充，缺少运行必需项仍显示“仍需配置”。普通设置走原 `/api/settings` / ConfigService 原子批量保存；凭据完全复用 Settings 编辑器及 SecretService write-only API，外部管理只读，旧值不回显，不写 URL/browser storage/普通 JSON。旧版配置不会在读取或检查时自动初始化、迁移或重写。新布局的缺省配置模板读取包内 Resource Root，保存目标始终为 User Data Root。

`control_setup_service.mjs` 仅组合已有 ConfigService、Runner resolver 与 preflight，返回受既有会话保护的 `/api/setup` 摘要，不执行 workflow、LLM、Zotero 写入、通知测试或调度注册。本地检查通过不等于外部服务已连接。运行路径变更继续遵守 Settings 的下次启动语义；摘要区分已保存路径和当前服务路径，不原地切换工作空间。失败保持原子写与原 Secret ACL 约束；成功步骤保留，失败步骤可重试。

Headless 不导入向导，也不弹窗等待配置；缺少配置或必要依赖时由原 Runner 返回失败码。Packaged GUI 和 Headless 使用同一默认/显式 workspace 契约。Windows 凭据写入继续依赖项目既有 PowerShell 7 ACL owner，不能回退 Windows PowerShell 5 或放宽权限；缺少该运行时应安全拒绝凭据保存。空 PATH 的凭据 smoke 通过 `PWSH_PATH` 显式提供已安装 PowerShell 7，同时保持系统 Node/npm 不可见。

Secret 最终 ACL 校验失败后的原子回滚复用 `atomic_json.mjs` 的有界瞬时重命名重试；持久失败仍保留受保护的 rollback 旧值并报告 `CREDENTIAL_RECOVERY_REQUIRED`，不能冒报保存成功。对应安全回归在 `control_credentials.test.mjs`。

验证入口：`node --test workflow/tests/control_setup.test.mjs`，加 ConfigService/SecretService/runtime/preflight/HTTP/UI 回归；`npm run smoke:packaged --prefix desktop/electron-poc` 在隔离假 AppData、空 PATH、只读程序目录验证三尺寸首次向导、保存失败恢复、Secret、重复进入及独立 Headless。原 Electron smoke 同时保留导航/renderer/ownership/fuses 检查；截图需真实绘制并拒绝空白图。最终运行 `npm run check`、`npm test` 和 diff check。Windows Installer Phase 3A 仍因缺少可信隔离安装环境而 Blocked；本向导不改变该 Gate。

## Doctor / System Health

Control Center 的“系统”页提供显式的“检查 / 刷新健康状态”，不会后台轮询。GUI 与 CLI 共用 `control_doctor_service.mjs`；诊断只读，不创建目录、配置、Secret、恢复记录或日志，不修改 ACL，不消费反馈，不连接外部服务或执行 workflow。

源码入口：`node workflow/tools/runner/main.mjs --doctor`，可附加 `--config <json>`。打包版：`PaperEcho-headless.cmd --doctor`，使用与 GUI 相同的数据根和内置 Node，不要求系统 Node/npm。`--doctor` 与执行参数互斥，不改变 `--check`，也不经过生产入口；数据根和运行布局仍由统一 Runtime Root 选择。

结果包含稳定 `checkId`、`status`、`severity`、`summary`、`actionableHint`。PASS 为已确认的本地条件，WARN 为可选缺失或待处理事项，FAIL 为已证实的关键阻塞，UNKNOWN 为证据不足或检查无法安全完成。退出码：PASS/WARN 为 0，FAIL 为 2，UNKNOWN 为 3；`canRun=null` 表示关键条件无法确认，不能视为 Ready。外部连通性和 macOS 发行状态不由本地检查宣布通过。

凭据只返回 presence/provenance；外部托管仍只读，本地文件复用 SecretService 的路径、hardlink 和 ACL 检查。缺少可执行 PowerShell 7 时不能确认 Windows ACL。目录访问使用只读系统权限检查，不创建写入探针，因此不替代实际写入验收。所有异常使用固定提示，不返回环境值、URL、研究正文或 owner 原始对象。

工作流按 manifest 的登记时间查最近记录，不按 mtime；复用 lease/ledger/recovery/receipt owner，不清锁或重放。进程存活的 lease 正常，远程/不明 lease 为 UNKNOWN。业务成功与通知失败分开。反馈 pending/prepared 是正常等待，模型结果未知保持 UNKNOWN 并提示人工核对，published 后未消费或失败批次可提示待恢复。

检查单项默认上限 2.5 秒，凭据检查 20 秒；最多检查 100 个顶层运行条目、100 个反馈条目和当前运行 8 个通知回执，单 JSON 默认 1 MiB，反馈事件 128 KiB。超过限制返回 UNKNOWN，不递归扫描历史、论文或日志。超时只终止诊断等待，不取消或更改业务状态。

验证：`node --test workflow/tests/control_doctor.test.mjs`，加 preflight、runtime、Secret、安全、ledger/recovery、研究反馈和 HTTP/UI 回归；打包 GUI/Headless 使用 `npm run smoke:packaged --prefix desktop/electron-poc`，检查显式刷新、三尺寸、空 PATH 和 Doctor 前后数据快照不变。Windows Installer Phase 3A 仍为 Blocked；Phase 5 仅完成上节离线契约，Phase 5B/6 未实施。

## 用户数据备份与 Verify

源码入口为 `node workflow/tools/runner/main.mjs --backup "<绝对输出路径>.pebackup"` 或 `--verify-backup "<绝对输入路径>.pebackup"`；打包版使用 `PaperEcho-headless.cmd` 加同样参数，不需要系统 Node/npm。两种操作与 workflow 参数互斥，不启动 GUI、Doctor 或外部服务。交互终端密码不回显；自动化仅接受显式 `--password-stdin` 管道，不接受密码参数或环境变量。密码长度为 12–1024 个 UTF-8 字节，不落盘；调用方不得把密码写进命令、日志或脚本。

备份需要有效的 canonical config，复用 Runtime Root 与正式 resolver。Portable/Installed 从 User Data Root 选择数据，Dev 只选择既有配置、研究/审核/结果/恢复状态和已配置的 Local 输入，不扫描程序源码。正式 owner 包含 Config、本地 `.env`、研究反馈与规则、审核历史、工作流结果、run manifest、ledger、receipt、recovery 和 Local state；manifest 记录各类文件数量及每个文件的相对路径、大小和 SHA256。外部注入凭据只记录变量名，不读取其值；已配置 owner 位于数据根之外时拒绝备份，不静默漏备或自动迁移。日志、已知可重建缓存及活动锁/lease 排除并说明原因；合法 runId 为 `tmp` 或 `cache` 的业务状态仍保留。

容器 `PEBK0001` 使用 scrypt（N=32768、r=8、p=1）派生 256-bit key，随机 16-byte salt、12-byte nonce，AES-256-GCM 和 16-byte tag；头部作为 AAD，manifest 与文件内容一起加密。schemaVersion 1 / restoreContract 1 记录相对 root 映射、owner 清单、排除项、兼容信息与恢复约束。它包含用户数据和本地 Secret，必须作为私密备份保管，不能当作 Support Bundle 分享。

上限为 20,000 个文件、单文件 64 MiB、文件总量 256 MiB、manifest 8 MiB；超限明确拒绝，不截断内容。文件读取检查身份、大小、mtime/ctime，禁止 traversal、symlink/junction、hardlink 与不安全路径。输出必须为数据根和程序根之外的绝对路径，且目标不存在。仅加密字节写入受保护的同目录临时文件，完成同步、自验证和源文件复核后独占发布；不覆盖已有文件，失败清理本次临时产物，不放宽源 Secret ACL。

一致性策略为 `quiescent-owner-locks-and-double-read`：先取得正式 writer locks（含 Runner admission），再取得 workflow lease，不接管已有活动或陈旧 lease；Local 运行登记和 lease 使用同一个 runId，覆盖失败清理。源文件重复核对，变化时拒绝发布。它是协作 owner 协议，不是操作系统文件系统快照；备份前须关闭旧版执行程序和不遵守锁的编辑器。业务文件字节、权限和文件 mtime 不变，临时锁创建/删除会改变父目录的目录项时间。

Verify 不解析现有数据根、不加载 `.env`、不创建目录或解密副本；先验证 AEAD，再验证 manifest、路径、文件大小/SHA256、Config/Secret/ledger 格式与兼容约束。错误密码、篡改、缺失内容或不兼容均拒绝。成功仍为 `restoreReady:false`、`requiresRestorePlanning:true`，不能冒充已完成恢复演练；Restore 仍须验证路径映射、Secret ACL 和兼容性，不能重新激活 claim/lease。Verify 本身不执行 Restore。

`PaperEcho-headless.cmd --verify-backup-data <绝对备份路径>` 复用安全密码输入，认证备份后只读核对当前 Runtime Root 的 owner 文件清单、逐文件 SHA256、根映射与本地 Secret ACL；额外、缺失或被修改的 owner 文件返回 `BACKUP_DATA_MISMATCH`，不修复数据。两次正式源清单检查拒绝观察期间的变化，外部 owner 在访问前拒绝。此数据审计保持 `restoreReady:false`、`installerAuthorization:false`，不能代替旧包来源核验、运行状态检查、用户卸载确认、Doctor 或完整方案 B 的真实 Guest Gate。

验证：`node --test workflow/tests/backup.test.mjs`，配合 Local、Secret、Runtime Root、Runner 与 ledger/recovery 回归。Local fixture 必须符合真实 Import 的“标题 + 稳定身份”契约，标题单独存在仍应被拒绝。Windows 使用已校验的本地 Electron ZIP 执行 `npm run package:win --prefix desktop/electron-poc`，随后 `npm run smoke:packaged --prefix desktop/electron-poc`，验证空 PATH、仓库外 cwd 下的真实 packaged Backup/Verify、源数据快照和独立 Headless。macOS 未实测；Phase 3A 仍为 Blocked。

## 恢复到全新 User Data Root

源码入口：`node workflow/tools/runner/main.mjs --restore-backup "<绝对备份路径>.pebackup" --target-data-root "<绝对全新数据根>"`；打包版使用 `PaperEcho-headless.cmd` 加同样参数。密码沿用备份的隐藏终端输入或显式 `--password-stdin`，不接受密码参数或环境变量。仅验证了 Windows NTFS / PowerShell 7；其它平台安全拒绝，macOS 未实测。目标的父目录必须存在，目标本身必须不存在，空目录也不覆盖；目标不得与当前程序根、数据根重叠，不执行真实用户数据迁移。

复用 AES-GCM、manifest 和 SHA256，认证全部内容后才创建私有 staging。原生句柄固定现有父目录链，拒绝 reparse point；staging 从创建起具有私有 DACL，`.env` 写入前另由正式 Secret owner 保护。逐文件同步并复核内容、路径和 ACL 后，以 NTFS 不覆盖目录 rename 发布，不降级为复制。相对配置通过正式 resolver 重新定位；仍引用旧数据绝对路径时返回 `RESTORE_PATH_MAPPING_REQUIRED`，不重写配置。外部凭据只保留变量名，需要用户另行配置。

恢复保留历史文件字节，另写 `.paperecho-restore.json`，标记 `restored-history-only`、`requiresStateReview:true`、`reactivateClaims:false`。成功恢复不等于可以运行 workflow：preflight 阻止普通、scheduled 和 `--check` 自动激活历史状态；Doctor 可确认配置和 Secret，同时报告 `canRun:false`。本入口不提供解除历史审阅门槛或覆盖已有根；已有根必须使用下述显式事务入口。发布前失败只清理本次身份核对通过的 staging；清理失败为 `RESTORE_CLEANUP_REQUIRED`，发布后检查失败为 `RESTORE_PUBLISHED_INSPECTION_REQUIRED`，均不得冒报成功。

验证入口：`node --test workflow/tests/restore.test.mjs workflow/tests/backup.test.mjs`，配合 Secret、runtime、ledger/recovery、Doctor 与 Runner 回归；离线构建后用 `npm run smoke:packaged --prefix desktop/electron-poc` 验证真实内置运行时的 Backup→Verify→Restore→Doctor、逐文件 hash、历史执行阻断、源数据不变和进程退出。Doctor 业务快照只排除正式 resolver 给出的 Temporary Root，并要求诊断后其中无残留文件；PowerShell ACL 检查的临时编译文件不算业务状态。最后运行默认 `npm test`、`npm run check` 与 diff check。

Windows ACL 负例在隔离 staging 的测试 `.env` 上使用 `.NET FileSystemAclExtensions.GetAccessControl(file, AccessControlSections.Access)` 和 `SetAccessControl`，只增加不安全 DACL ACE。重新读取 Access 验证 Everyone ReadData Allow 确实存在且无对应 Deny，另读 Owner 确认未改变，再调用正式 Restore 并断言 `CREDENTIAL_ACL_UNSAFE`、未发布及清理完成。此方法无需管理员或 `SeSecurityPrivilege`，不读取或改写 SACL；不能用通用 `Set-Acl` 的权限异常代替正式安全拒绝断言。

## 已有 User Data Root 的事务恢复

Windows NTFS / PowerShell 7 下，Shared Runner 与 `PaperEcho-headless.cmd` 共用 `--restore-preflight <绝对备份路径> --target-data-root <绝对已有根>`、`--restore-existing`、`--restore-recover --target-data-root <绝对已有根>` 和 `--restore-rollback --target-data-root <绝对已有根>`。前两项复用备份密码输入。替换、回滚及未完成事务恢复需要独立的明确确认；普通非交互 CLI 不因提供密码而允许替换，也没有 `--force` 或自动确认环境变量。

目标须为合法、静止的已有根，不得与程序根重叠；活跃或不明确的 lease、writer lock、claim 一律拒绝，不接管未知锁。选中当前根且默认 Cache 位于目标内时，须先通过正式 `PAPERECHO_CACHE_ROOT` 选择目标树外的可信 Cache；运行时临时目录与目标也不能互为祖先，否则返回 `RESTORE_TEMP_CONFLICT`，不暗中搬迁数据。

认证备份并复核旧根完整清单后，在同卷私有 `.paperecho-restore-tx-*` 中准备新根；以 NTFS 分步 rename 保留旧根、发布新根并复核 hash、Secret ACL 和 Doctor。此处不是两个目录同时原子替换。私有 journal 的不可变检查点与状态文件记录进度；非终态或无法确认身份时，Runner 与正式写入阻塞，GUI 跳过首次配置并进入 System Health，Doctor 只读显示恢复事务。显式恢复根据实际目录身份保守回滚，无法确认则保持 `RECOVERY_REQUIRED`，不冒报成功。

提交后旧根继续私有保留；回滚也不删除未知文件。当前不提供自动清理旧根，已有保留事务会阻止下一次替换。恢复仍保留历史字节与 `requiresStateReview`，不自动激活 workflow、claim、通知或外部操作。

验证：`node --test workflow/tests/restore_transaction.test.mjs workflow/tests/restore_transaction_crash.test.mjs workflow/tests/restore_transaction_security.test.mjs`，配合 Backup/Verify、Secret、NTFS、runtime、ledger/recovery 与 Doctor 回归。`npm run smoke:packaged --prefix desktop/electron-poc` 使用真实内置运行时和隔离 fixture 验证替换、回滚、中断恢复及三尺寸阻塞页面；默认 `npm test` 不覆盖文件并行度。macOS 未实测，Phase 3A Installer 仍为 Blocked。

## Support Bundle

System Health 的“导出诊断包”仅由用户主动触发。`POST /api/support-bundle` 接受空 JSON，复用 loopback、Host、session、Origin、CSRF 与 body 限制；普通 Doctor GET 不生成包。下载使用用户选择的保存位置，不上传。服务端只在内存构造 ZIP，不创建临时下载 URL 或磁盘诊断副本；浏览器下载发起不等同于用户已确认保存。

schema v1 固定四个 UTF-8 JSON：`manifest.json`、`doctor-summary.json`、`runtime-summary.json`、`log-events-summary.json`。只投影版本/平台/运行模式、Doctor checkId/status/severity、注册的错误码及固定日志事件统计；不复制 Doctor 对象或原始日志。缺失证据保持 UNKNOWN/omitted；Secret 安全检查不明确或最终内容安全校验失败时拒绝导出。Secret、用户绝对路径、用户名、研究正文、配置全文、ledger/receipt 原文和异常栈均不在白名单内。

限制：4 个文件，单文件 32 KiB，总解压内容与 ZIP 各 64 KiB，最多 100 项 Doctor 检查和最近 200 条日志事件，导出响应时限 10 秒。每个服务实例仅允许一个在途导出；取消或超时后，正在进行的只读检查结束前不释放名额。日志读取失败或轮转期间无法取得完整记录时明确 omitted，不修改或轮转日志。manifest 记录导出时间、限制及三个内容文件的大小和 SHA256；manifest 不自哈希，包未签名，SHA256 仅用于内容完整性检查，不证明来源。

验证：`node --test workflow/tests/control_support_bundle.test.mjs`，配合 Doctor、RuntimeLog、Secret、HTTP、runtime 与 UI 回归；`npm run smoke:packaged --prefix desktop/electron-poc` 验证真实三尺寸 POST、原生下载、ZIP 解包/hash、键盘焦点及独立 Headless。Electron smoke 跨进程求值只返回可序列化值；修改函数属性的测试脚本以 `void 0` 结束。异步导出等待下载事件和页面状态，不用固定延时猜测完成。按钮禁用后只在原控件仍连接且焦点退回 body 时恢复焦点，不抢走用户已选择的其它控件。macOS 未实测，Phase 3A 仍为 Blocked。

## RuntimeLog 与日志轮转

`workflow/tools/lib/runtime_logging.mjs` 是 Runner、GUI、Headless 的共享运行日志 owner，复用 Runtime Root、`atomic_json.mjs` 和 Secret registry，不替代业务审计。Dev/Portable/Installed 均写入 `<User Data Root>/logs`，不由 cwd 选择，不向 Installed 程序目录或 `app.asar` 写入。

正式保留 `runtime.jsonl` 与一份 `runtime.previous.jsonl`，各最多 1 MiB；容量到达后淘汰旧归档，不承诺永久保留。`runtime.owner.json` 声明 ownership；跨进程写锁与唯一 staging 文件仅用于当前原子操作。可变日志文件检查、读取和替换都在同一写锁内，避免 Windows 文件检查句柄与另一写入者重命名重叠。每次写入最多读取当前有界文件，不扫描历史；轮转只处理明确拥有的固定文件，不删除 ledger、receipt、feedback、研究结果或同名未知文件。

事件使用固定 code、severity、subsystem 和安全摘要；可选 run/request 关联标识只保留摘要，未知字段、正文、异常栈、原始 stdout/stderr、URL 和环境值不进入日志。复用最长 Secret 优先的完整脱敏及 Authorization/Cookie/敏感 URL 保护；凭据格式与 ACL owner 不变。普通日志失败返回明确错误并有界告警，不改变业务操作成功状态；必须持久化的 ledger/receipt/recovery 仍遵守各自原有失败语义，不能用日志成功代替。

链接、hardlink、未知 ownership 与越界路径安全拒绝；不扩大目录权限。锁等待有上限，只允许回收本机已确认死亡且未被替换的陈旧锁，不接管远程或存活进程。Doctor 只读检查目录权限元数据、大小、ownership 和锁状态；不创建探针、不清理、不轮转。最近日志错误只报告当前进程确知的证据，不推断其他进程历史；权限元数据检查不等于实际写入已成功。

验证：`node --test workflow/tests/runtime_logging.test.mjs workflow/tests/control_doctor.test.mjs`，覆盖跨进程成功事件完整性、容量轮转、故障释放/恢复、正文脱敏、业务文件保护和只读诊断；再运行相关 Runner/Secret/runtime/workspace 回归、`npm run check`、`npm test`。`npm run smoke:packaged --prefix desktop/electron-poc` 检查真实三尺寸 GUI、Headless、四个隔离日志根、只读程序目录、无残留锁及 Doctor 前后快照。Packaged smoke 必须复用已初始化的 ASAR shell 入口，避免测试加载另一份模块实例。macOS 未实测；Phase 3A 仍为 Blocked。

RuntimeLog 并发定向检查可运行 `node --test --test-name-pattern="concurrent instances and processes|concurrent processes rotate bounded" workflow/tests/runtime_logging.test.mjs`。测试等待所有子进程的 `close` 后才清理独立 fixture；安全诊断区分同进程实例与子进程阶段，仅记录操作、flags、PID 和锁资源状态。单项或全量通过不能证明历史 Windows EPERM 根因已经修复。

同进程正例复用两个持久 owner 的正式实例队列，并发提交 30 次写入，要求实际发生文件锁竞争；随后两个真实子进程各写入 20 条，验证全部 70 条记录完整且无重复。fixture 不为每条消息创建独立 owner，不调整正式等锁预算或默认文件并行度；独立 live-lock 负例继续验证超时明确失败、不丢失旧记录且不接管存活锁。

## 用户实际需要处理的文件

### 可选初始化参考

- [`docs/paperecho-setup-template.md`](paperecho-setup-template.md)：交给用户填写、再交给 Codex 应用的问卷；不是运行时配置。
- 本文档：字段、优先级、缺失行为、文件职责和模板映射的事实来源。

### 复制后填写

- [`config/paperecho.config.example.json`](../config/paperecho.config.example.json) -> `config/paperecho.config.json`：Runner 支持 schema v1–v6；提交的示例仍使用 v2，通过集中迁移升级为当前 v6（见 [迁移说明](../config/README.md)）。实际配置只保存在本机且已被 Git 忽略。

### 本地 Secret

- [`.env.example`](../.env.example) -> `.env`：只在需要环境变量时创建。API key、SMTP password 和 token 只放本机 `.env`、进程环境或 secret store，不写入 JSON/Markdown。

### 按路径提供

- Desktop：Zotero executable（无法自动发现时）和可用的 CLI/JS bridge。
- Web：本机环境中的 Zotero API key 和配置中的 user ID 均必需。
- Local：可读的 JSON/JSONL input 和安全、可写的 output root；feedback JSONL 可选。

### Canonical section 与旧领域文件对照

以下 JSON 名称仅用于兼容/迁移对照；schema v3–v6 日常读取与保存的是主配置中的 `sources`、`rss`、`pubmed`、`openalex`、`review`、`translation`、`preference` section。只有无 canonical 配置时才使用旧 JSON。两个 prompt 仍是独立模板。

- `config/source_selection.json`、`rss_sources.json`、`pubmed_pmc_search.json`、`openalex_search.json`：检索源和检索策略。
- `config/review-workflow-rules.json`：分级、期刊质量、LLM review 与反馈策略。
- `config/title_translation.config.json`、`preference_learning.config.json` 及两个 prompt：非敏感模型参数与提示词。
- `<运行根>/review_results/文献评价/screening_standards.md`：唯一长期筛选标准；缺失时由 Stage1 初始化，之后可由用户维护。

### 程序自动生成，不要人工填写

- `state/`、`runs/`、`exports/`、`run_group.json`、Stage5 receipt/overview、housekeeping receipt/lock。
- `current_literature_index.json`、translation/journal cache、feedback checkpoint、timings、pipeline audit JSON。
- `周报.xlsx`、`月报-*.docx` 和 `screening_standards.docx`。DOCX 的评价区可供反馈，但文件结构由程序维护。

### 不应由用户编辑

- Runner/config loader/preflight、三个 launcher、Stage1-Stage5 源码、四个 PaperEcho Skills 和生成的 manifest。它们定义行为，不承载个人配置。

## 配置来源与 compatibility 缺失行为

下表的旧领域 JSON 行描述未迁移安装的兼容行为，不表示迁移后仍需用户分别编辑。`screening_standards.md` 是规则正文，prompt 是模板；两者均不合并进 application config。

| 路径/来源 | Git | 用户创建或编辑 | 可存 Secret | 读取者/适用路径 | 必需与缺失行为 |
|---|---|---|---|---|---|
| `docs/paperecho-setup-template.md` | 提交 | 填写副本或直接提供答案 | 否 | Codex；不被运行时读取 | 可选问卷；缺失不影响 Runner |
| `config/paperecho.config.example.json` | 提交 | 只复制，不写个人值 | 否 | 示例与验证 | 必须保持有效 JSON、schema v2、三路径及可靠性通知默认 disabled |
| `config/paperecho.config.json` | 忽略 | 是 | 否，只存 secret 环境变量名 | Runner；三路径 | 使用 `--config` 指定却缺失/无效时 blocked；未使用统一文件时 direct Runner 仍需显式 `--mode` |
| `.env.example` | 提交 | 只复制 | 否 | 环境变量目录 | 可选模板 |
| `.env` / 进程环境 / secret store | 忽略或外部 | 是 | 是 | env bootstrap、Runner、领域 owner；按功能 | Web key 必需；SMTP/LLM/期刊 key 仅在相应功能被要求时生效或阻塞 |
| `source_selection.json` | 提交 | 可选 | 否 | Stage1；三路径 | 缺失用 biomedical fallback；解析错误失败 |
| `rss_sources.json` | 提交 | 可选 | 否 | Stage1 RSS；三路径 | 缺失退化为空 RSS 源；无有效 URL 时该源无结果 |
| `pubmed_pmc_search.json` | 提交 | 可选 | 否 | Stage1 PubMed/PMC；三路径 | 缺失用代码默认；无效正整数回退并 warning；解析错误失败 |
| `openalex_search.json` | 提交 | 可选 | 否 | Stage1 OpenAlex；三路径 | 默认 disabled；启用但 query 为空时 warning/空结果 |
| `review-workflow-rules.json` | 提交 | 可选 | 否 | Stage1 分类、期刊 gate、反馈学习；三路径 | 缺失用代码默认；解析错误失败 |
| `title_translation.config.json` + prompt | 提交 | 可选 | 否 | shared translation；三路径 | 缺失/无效字段使用代码默认；key 独立放环境变量 |
| `preference_learning.config.json` + prompt | 提交 | 可选 | 否 | shared LLM preference；三路径 | 缺失/无效字段使用代码默认；key 按 fallback order 从环境读取 |
| `screening_standards.md` | 运行根，本地状态 | 可维护 | 否 | Stage1 preference learning；三路径 | 缺失时初始化基线并继续 |
| Desktop executable/CLI bridge | 外部程序 | 安装或配置 | 否 | Desktop preflight | executable 可自动发现；CLI bridge 缺失 blocked |
| Zotero Web API key | 本机环境 | 是 | 是 | Web preflight/backend | 缺失 blocked；preflight 只查存在性、不访问网络 |
| Local input/output/feedback | 外部或本地数据 | 是 | 不应 | Local preflight/repository | input/output 必需且失败 blocked；feedback 可选但提供后必须是可读 JSONL |

旧版本初始化可将 [`config/paperecho.config.example.json`](../config/paperecho.config.example.json) 复制为本机的 `config/paperecho.config.json`，填写 `common` 和要使用的一条路径后通过集中迁移进入 v6。已有 v6 配置直接使用 Settings，不必再次复制示例。真实配置已被 `.gitignore` 精确忽略。也可用 `--config <path>` 或 `PAPERECHO_CONFIG` 指向其他 JSON 文件；配置中的相对路径均相对于该 JSON 所在目录解析。

当前统一配置同时管理 Runner、路径和上述七个领域 section；领域 owner 通过共享解析层取得各自的内存配置。旧领域 JSON 保留为 compatibility / migration source，不是迁移后的 runtime owner。显式 `--preference-config` / `--translation-config` 仅覆盖当次 invocation，不写回 Settings。

## 1. 通用/共用配置

| 配置项 | 配置文件字段 | 环境变量 | 必需条件 | 默认值 | Secret | 说明 |
|---|---|---|---|---|---|---|
| schema | `schemaVersion` | - | 始终 | 兼容示例为 `2`；当前为 `6` | 否 | 支持整数 `1`–`6`；下列环境变量/旧参数路径以 compatibility 语义为准 |
| profile | `profile` | - | 可选 | `standard` | 否 | `standard` 或 `complete` |
| 项目/共享根 | `common.projectRoot` | `ZOTERO_PROJECT_ROOT` | Desktop/Web 输出或 Local 共享索引需要覆盖时 | 当前项目根 | 否 | JSON 值优先于环境变量 |
| LLM 开关 | `common.llm.enabled` | - | 可选 | 路径现有默认 | 否 | `false` 强制禁用；Local 未声明时保持旧默认 `disabled` |
| LLM mode | `common.llm.mode` | `LLM_MODE` | 可选 | 路径现有默认 | 否 | `disabled`、`mock`、`real` |
| 强制真实 LLM | `common.llm.requireRealModel` | CLI `--require-llm` | 明确要求真实模型时 | `false` | 否 | 缺 key 时 preflight 阻塞 |
| 偏好学习 key 引用 | `common.llm.preferenceApiKeyEnv` | 指向的变量，通常 `PREFERENCE_LEARNING_API_KEY` | 真实偏好学习 | - | 引用否/值是 | JSON 只保存环境变量名 |
| 翻译 key 引用 | `common.llm.translationApiKeyEnv` | 指向的变量，通常 `TITLE_TRANSLATION_API_KEY` | 真实标题翻译 | - | 引用否/值是 | JSON 只保存环境变量名 |
| Legacy LLM 参数文件 | `common.llm.preferenceConfig` / `translationConfig` | `PREFERENCE_LEARNING_CONFIG_PATH` / `TITLE_TRANSLATION_CONFIG_PATH` | 未迁移安装覆盖默认文件时 | `config/*.config.json` | 否 | 当前由 canonical `preference` / `translation` 管理；迁移移除旧路径字段，显式 CLI 参数仅覆盖当次调用 |
| 期刊质量 key 引用 | `common.journalQualityApiKeyEnv` | 指向的变量，通常 `EASYSCHOLAR_SECRET_KEY` | 启用相关 gate 时 | - | 引用否/值是 | 只报告是否存在 |
| 邮件开关 | `common.email.enabled` | - | 可选 | 未请求 | 否 | `false` 禁用配置及遗留 recipient |
| 收件人 | `common.email.recipient` | `PAPERFLOW_REPORT_TO` / `NOTIFICATION_EMAIL` | 请求 Stage5 邮件时 | 无 | 否 | CLI `--email` 优先 |
| SMTP | `common.email.smtp.host/user/port/secure/from` | `SMTP_HOST/USER/PORT/SECURE/FROM` | 请求邮件时 | port `465`；from 回退 user | 否 | JSON 可保存非敏感 sender 参数 |
| SMTP 密码引用 | `common.email.smtp.passwordEnv` | 指向的变量，通常 `SMTP_PASS` | 请求邮件时 | - | 引用否/值是 | 密码值只放 `.env`/secret store |
| 清理 | `common.cleanup.enabled` | `PAPERFLOW_CLEANUP_ENABLED` | 可选 | `true` | 否 | housekeeping 失败不改变业务结果 |
| 保留天数 | `common.cleanup.retentionDays` | `PAPERFLOW_RETENTION_DAYS` | cleanup 启用时 | `30` | 否 | `0` 禁用按年龄删除 |
| 来源状态根 | `common.sourceState.root` | `PAPERECHO_SOURCE_STATE_ROOT` | schema v2 可选 | `review_results/source_state` | 否 | schema v1 不启用新状态能力 |
| 失败通知 | `common.notifications.failure.enabled` | `PAPERECHO_FAILURE_NOTIFIER_ENABLED` | schema v2 可选 | `false` | 否 | Stage1–4 独立失败通知，默认不发送 |
| 健康通知 | `common.notifications.health.enabled/consecutiveThreshold` | `PAPERECHO_HEALTH_NOTIFIER_ENABLED` / `PAPERECHO_HEALTH_DEGRADATION_THRESHOLD` | schema v2 可选 | `false` / `2` | 否 | 连续两次降级后通知 |
| 通知 receipt | `common.notifications.receiptStore.root/retryFailed/unknownPolicy` | `PAPERECHO_NOTIFICATION_RECEIPT_ROOT` 等 | schema v2 可选 | retry `true`、unknown `hold` | 否 | `unknown` 不自动视为 accepted |
| 预留能力 | `common.radar.enabled` / `common.integrity.enabled` | - | schema v2 可选 | `false` | 否 | v2.1 仅保留字段，不产生 Radar 或 integrity 副作用 |

## 2. Zotero Desktop 路径配置

| 配置项 | 配置文件字段 | 环境变量 | 必需条件 | 默认值 | Secret | 说明 |
|---|---|---|---|---|---|---|
| 启用识别 | `desktop.enabled` | - | 自动选择 Desktop 时 | `false` | 否 | 与其他路径同时启用时应显式设置 `mode` |
| Zotero executable | `desktop.zoteroExe` | `ZOTERO_EXE` | 自动发现失败时 | 平台发现 | 否 | preflight 只做本地存在性检查 |
| CLI bridge | `desktop.cliTool` | `ZOTERO_DESKTOP_CLI_TOOL`，兼容 `ZOTERO_CLI_TOOL` | Desktop 必需 | `zotero-cli` | 否 | 不在 preflight 中启动真实写入 |
| 写回 batch | `desktop.writebackBatchSize` | `ZOTERO_CLI_WRITEBACK_BATCH_SIZE` | 可选 | `50` | 否 | 有效范围 `1-50` |
| 启动重试 | `desktop.startupRetries` | `WORKFLOW_STARTUP_ZOTERO_BACKEND_RETRIES` | 可选 | `45` | 否 | Desktop readiness 参数 |
| 重试间隔 | `desktop.startupIntervalMs` | `WORKFLOW_STARTUP_ZOTERO_BACKEND_INTERVAL_MS` | 可选 | `1000` | 否 | 毫秒 |
| 启动后等待 | `desktop.postStartDelayMs` | `WORKFLOW_STARTUP_ZOTERO_POST_START_DELAY_MS` | 可选 | `5000` | 否 | 毫秒 |
| Production backend | - | `ZOTERO_BACKEND` | scheduled/maintenance 直接 Stage0 时 | `auto` | 否 | Runner 不用它选路径；Desktop launcher 固定为 `cli` |

Desktop launcher 固定 `mode=desktop`，Runner 为子流程设置 `ZOTERO_BACKEND=cli` 并移除 Web API key。配置文件若显式选择 Web/Local，launcher 会报冲突并停止。

## 3. Zotero Web API 路径配置

| 配置项 | 配置文件字段 | 环境变量 | 必需条件 | 默认值 | Secret | 说明 |
|---|---|---|---|---|---|---|
| 启用识别 | `web.enabled` | - | 自动选择 Web 时 | `false` | 否 | 不根据残留 API key 自动选择 |
| API key 引用 | `web.apiKeyEnv` | 指向的变量，通常 `ZOTERO_API_KEY` | Web 必需 | - | 引用否/值是 | preflight 只检查存在，不请求网络 |
| User ID | `web.userId` | `ZOTERO_USER_ID` | Web 必需 | - | 否 | Zotero 个人文库数字 ID，不是用户名或邮箱 |
| API base | `web.apiBase` | `ZOTERO_API_BASE` | 仅测试/开发覆盖 | `https://api.zotero.org` | 否 | Control Center 普通设置不暴露 |
| 请求并发 | `web.requestConcurrency` | `ZOTERO_WEB_API_REQUEST_CONCURRENCY` | 可选 | `4` | 否 | 有效范围 `1-4` |

Zotero 官方 API 同时定义个人与群组文库 URL；PaperEcho v2.4 的 Web 路径按当前产品范围只使用个人文库 `/users/<User ID>`。正式请求固定使用 HTTPS、`Zotero-API-Version: 3` 与 `Zotero-API-Key` 请求头，API Key 必须由 Zotero 授予个人文库写权限。`common.projectRoot` 只管理 PaperEcho 本地状态、索引与报告，不属于 Zotero 官方字段。Web launcher 固定 `mode=web`，不会启动 Zotero Desktop。

## 4. Standalone Local 路径配置

| 配置项 | 配置文件字段 | 环境变量 | 必需条件 | 默认值 | Secret | 说明 |
|---|---|---|---|---|---|---|
| 启用识别 | `local.enabled` | - | 自动选择 Local 时 | `false` | 否 | Local 不读取 Zotero 路径配置 |
| 输入 | `local.input` | CLI `--input` | Local 必需 | 无 | 否 | `.json`、`.jsonl` 文件或包含它们的目录 |
| 输出根 | `local.outputRoot` | CLI `--output-root` | Local 必需 | 无 | 否 | 必须是安全、可写的专用目录 |
| 反馈 | `local.feedback` | CLI `--feedback` | 可选 | 无 | 否 | 可读 `.jsonl` |

Local 的 `state/`、`runs/`、`exports/`、feedback 和 checkpoint 均从 `outputRoot` 派生，不提供第二套独立 root。执行计划会移除 Zotero backend、API key、user ID 和 executable，不调用 Desktop/Web/Stage2/Stage3。

## 5. 路径选择规则

优先级为 CLI `--mode`、配置文件顶层 `mode`、唯一一个 `enabled=true` 的路径模块。多个模块启用且没有显式 `mode`、或没有任何可识别路径时，Runner 以配置错误阻塞；`ZOTERO_API_KEY`、`ZOTERO_BACKEND`、SMTP 或 LLM key 都不能用于猜测路径。

三个路径 launcher 会注入固定 mode。固定 mode 与配置顶层 mode 或唯一启用的其他路径冲突时 fail closed。直接 Runner CLI 的 `--mode` 可以覆盖配置 mode，但会输出 warning。preflight 只返回 `common` 和当前路径的缺失项，不要求另两条路径配置。

完整优先级为：CLI -> unified config -> environment / `.env` -> 既有领域配置与默认值。`PAPERFLOW_*` 和 `.env` 兼容读取保持有效。Stage0/Local direct entry 仅用于 scheduled automation、维护/测试或自行承担 preflight/验证的集成；统一 Runner 不根据 `ZOTERO_BACKEND` 或残留 secret 推断 mode。没有统一配置文件时，Runner 必须继续显式传 `--mode`。

## 6. standard / complete

`standard` 允许现有安全降级：未请求邮件时 Stage5 可跳过，未强制真实 LLM 时可使用既有 fallback，月报未到期可为 `NOT_DUE`。`complete` 不会自行发邮件或强制 LLM；它只加强用户显式请求的能力。传入 `--email` 后 SMTP 必须齐全，传入 `--require-llm` 或设置 `common.llm.requireRealModel=true` 后真实 key 和非 fallback 结果必须可验证。Local 在两种 profile 下都不运行 Stage2/Stage3。

## 7. Secret 配置

API key、SMTP 密码、token 和用户密码只放环境变量、本地 `.env` 或系统 secret store。统一 JSON 只填写 `apiKeyEnv`、`passwordEnv` 等环境变量名称。不要提交 `.env` 或 `config/paperecho.config.json`，不要把 secret 粘贴到聊天、CLI 参数、日志或文档中。Runner/preflight 只报告 secret 是否存在并对生产输出脱敏。

## 8. 三条路径最小示例

Desktop：

```json
{"schemaVersion":1,"mode":"desktop","common":{},"desktop":{"enabled":true,"cliTool":"zotero-cli"}}
```

Web，另在 `.env` 中留空模板对应位置填写 `ZOTERO_API_KEY`：

```json
{"schemaVersion":1,"mode":"web","common":{},"web":{"enabled":true,"apiKeyEnv":"ZOTERO_API_KEY"}}
```

Local：

```json
{"schemaVersion":1,"mode":"local","common":{},"local":{"enabled":true,"input":"../input/items.jsonl","outputRoot":"../review_results/local"}}
```

## 9. Codex 使用示例

Desktop：`使用 $paperecho-zotero-desktop，读取 config/paperecho.config.json，检查配置后执行完整流程；不要修改代码。`

Web：`使用 $paperecho-zotero-web，读取 config/paperecho.config.json，以 complete 模式运行并发送邮件。`

Local：`使用 $paperecho-local，读取 config/paperecho.config.json，执行完整 Local 流程；不要调用 Zotero。`

本地只读检查示例：

```powershell
node skills/paperecho-zotero-desktop/scripts/run.mjs --check --config config/paperecho.config.json
node skills/paperecho-zotero-web/scripts/run.mjs --check --config config/paperecho.config.json
node skills/paperecho-local/scripts/run.mjs --check --config config/paperecho.config.json
```

显式 `--config` 文件不存在、JSON/schema/字段无效、mode 冲突或当前路径缺配置时，Runner 返回清晰的配置错误或按 `common`/当前路径分组的缺失清单，生产入口调用次数保持为零。补齐本机配置后再次执行同一命令；Skill 场景中回复“继续”会重新读取文件并重新 preflight。

## 10. Schema v1/v2 类型、必需性与失败语义

| 字段 | 类型/示例 | standard / complete | 缺失或无效 | 实际 owner / preflight |
|---|---|---|---|---|
| `schemaVersion` | integer，`1` 或 `2` | 两者必需 | 非 1/2、缺失或类型错误均 blocked | config loader |
| `mode` | `desktop` / `web` / `local` / `null` | 可选，但必须能解析唯一 mode | 无 mode 且非唯一 enabled 时 blocked；非法值 blocked | config loader；fixed launcher 检查冲突 |
| `profile` | `standard` / `complete` | 可选，默认 standard | 非法值 blocked | config loader/Runner |
| `common.projectRoot` | path string，如 `..` | 可选 | 回退环境或当前项目；输出根不可写时 blocked | config loader -> runtime config；preflight 检查可写祖先 |
| `common.journalQualityApiKeyEnv` | env-name string | 可选 | 没有 key 时期刊 API gate 按现有 missing policy 降级 | config loader -> Stage1 journal gate；preflight 不单独阻塞 |
| `common.llm.enabled` | boolean | 可选 | Local 未显式启用时默认 disabled；其他路径沿用运行时默认 | config loader |
| `common.llm.mode` | disabled/mock/real/null | 可选 | 非法值 blocked；未填沿用 CLI/env/路径默认 | config loader -> `LLM_MODE` |
| `common.llm.requireRealModel` | boolean | 仅明确要求时为 true | true 且无可用偏好/翻译 key 时 blocked | config loader；preflight 检查 key presence |
| `common.llm.preferenceApiKeyEnv` | env-name string | 真实偏好学习条件必需 | 引用变量为空时不泄露旧 canonical key；按是否 require 决定 blocked/fallback | config loader/LLM runtime |
| `common.llm.translationApiKeyEnv` | env-name string | 真实翻译条件必需 | 同上 | config loader/translation runtime |
| `common.llm.preferenceConfig` | path string | 可选 | 回退 `config/preference_learning.config.json` | config loader -> preference owner；preflight 不解析领域文件 |
| `common.llm.translationConfig` | path string | 可选 | 回退 `config/title_translation.config.json` | config loader -> translation owner；preflight 不解析领域文件 |
| `common.email.enabled` | boolean | 可选，默认未请求 | false 清除统一配置/遗留 recipient | config loader/Stage5 request |
| `common.email.recipient` | string | 请求邮件时必需 | 无 recipient 时 Stage5 skipped；有 recipient 后 SMTP 缺项 blocked | config loader；preflight |
| `common.email.smtp.host` | string/null | 请求邮件时必需 | 缺失时 blocked | config loader -> email sender；preflight |
| `common.email.smtp.user` | string/null | 请求邮件时必需 | 缺失或不是有效邮箱且 from 未覆盖时 blocked | config loader -> email sender；preflight |
| `common.email.smtp.from` | string/null | 可选，默认 SMTP user | 显式值不是有效邮箱时 blocked | config loader -> email sender；preflight |
| `common.email.smtp.passwordEnv` | env-name string | 请求邮件时对应 secret 必需 | 引用变量为空时 blocked | config loader；preflight 只报告变量名 |
| `common.email.smtp.port` | integer 1-65535 | 可选，默认 465 | JSON 越界 blocked；运行时非法 blocked | config loader/email sender |
| `common.email.smtp.secure` | boolean | 可选 | 未填时仅 port 465 推导 true | config loader/email sender |
| `common.cleanup.enabled` | boolean | 可选，默认 true | 非布尔 blocked；兼容 env 非法则 cleanup skipped/warning | config loader/housekeeping |
| `common.cleanup.retentionDays` | integer 0-36500 | 可选，默认 30 | `0` 禁用年龄删除；越界 blocked | config loader/housekeeping |
| `desktop.enabled` | boolean | 唯一路径选择时必需为 true | 与其他 enabled 冲突且无 mode 时 blocked | config loader |
| `desktop.zoteroExe` | path string/null | 自动发现失败时必需 | 找不到 Desktop app 时 blocked | config loader；Desktop preflight |
| `desktop.cliTool` | command/path string | Desktop 必需 | 默认 `zotero-cli`；找不到时 blocked | config loader；Desktop preflight |
| `desktop.writebackBatchSize` | integer 1-50 | 可选，默认 50 | 越界 blocked | config loader -> CLI backend |
| `desktop.startupRetries` | integer 1-300 | 可选，默认 45 | 越界 blocked | config loader -> readiness |
| `desktop.startupIntervalMs` | integer 1-120000 | 可选，默认 1000 | 越界 blocked | config loader -> readiness |
| `desktop.postStartDelayMs` | integer 0-120000 | 可选，默认 5000 | 越界 blocked | config loader -> Desktop launcher |
| `web.enabled` | boolean | 唯一路径选择时必需为 true | 多启用且无 mode 时 blocked | config loader |
| `web.apiKeyEnv` | env-name string | Web 必需 | 引用变量为空时 blocked | config loader；Web preflight |
| `web.userId` | numeric string/null | Web 必需 | 缺失时 blocked | config loader/Web backend；preflight 不联网 |
| `web.apiBase` | URL string | 仅测试/开发覆盖 | 普通 UI 不暴露；默认官方 HTTPS base | config loader/Web backend |
| `web.requestConcurrency` | integer 1-4 | 可选，默认 4 | 越界 blocked | config loader/Web backend |
| `local.enabled` | boolean | 唯一路径选择时必需为 true | 多启用且无 mode 时 blocked | config loader |
| `local.input` | path string | Local 两种 profile 都必需 | 缺失、不可读或无 JSON/JSONL 时 blocked | config loader；Local preflight |
| `local.outputRoot` | path string | Local 两种 profile 都必需 | 缺失、不安全或无可写祖先时 blocked | config loader；Local preflight |
| `local.feedback` | path string/null | 可选 | 提供后若非可读 `.jsonl` 则 blocked | config loader；Local preflight |

`complete` 不会隐式把邮件或 LLM 变成必需项；只有收件人/邮件开关或 `--require-llm`/`requireRealModel=true` 明确提出后才加强验收。Desktop/Web 固定执行 Stage2/Stage3；Local 两种 profile 都不执行。

## 11. 领域配置项矩阵

| 文件 | 用户配置项 | 默认/缺失行为 | 实际读取模块 |
|---|---|---|---|
| `source_selection.json` | `research_domain`、`domain_options`、`override_enabled_sources`、`require_manual_confirmation` | 默认 biomedical -> PubMed/PMC + RSS；非法 domain 变 unknown 并 warning | `literature_config.mjs` / Stage1 source selection |
| `rss_sources.json` | `sources[].name/url/enabled`，可选 `publicationTitle` | 缺失为空；`enabled=false` 或空 URL 不运行该条 | `loadRssSources` |
| `pubmed_pmc_search.json` | `databases`、`days_back`、`retmax`、`sort`、`datetype`、`query`、`keyword_groups`，以及受支持的 `adaptive_query` | days_back 10、retmax 300、PubMed/date/pdat；无效值 warning + fallback | `loadPubMedPmcSearchConfig` |
| `openalex_search.json` | `enabled`、`query`、`days_back`、`per_page`、`mailto`、`filters`、`sort`、`select` | 默认 disabled；per_page 最大 200；空 query warning/空结果 | `loadOpenAlexConfig` |
| `review-workflow-rules.json` | `triage`、`llm_review`、`manual_standard_evaluation`、`feedback_learning` | 缺失用代码内保守规则；解析错误失败 | `loadWorkflowRules`、classifier、quality gate、feedback learning |
| `title_translation.config.json` | endpoint/model、temperature/top_p、stream/thinking、timeout/retries、batch/concurrency、user_id、fallback、rate_limit、prompt | 字段缺失/非法时使用代码默认；API key 只来自环境 | `title_translation_support.mjs` |
| `preference_learning.config.json` | endpoint/model、sampling、stream/thinking、timeout/retries/tokens、user_id、response format、prompt、key fallback order | 字段缺失/非法时使用代码默认；首选 preference key、再用 translation key | `preference_learning_support.mjs` |
| 两个 prompt Markdown | prompt text 与 `${sourceText}` 等既有占位 | 使用领域 config 指向的文件 | 对应 LLM owner |
| `screening_standards.md` | 用户长期筛选边界与理由 | 缺失初始化中文基线；是长期标准唯一来源 | Stage1 preference learning |

RSS Settings 中，`name` 是 Feed 显示名称；可选 `publicationTitle` 是用户明确声明的正式期刊名，最多 200 字符。旧配置不必补字段；综合来源可留空，保存不会从 `name` 自动复制。非空值拒绝 URL、HTML、控制字符及 `RSS` / `Latest Results` / `Table of Contents` 等噪声。现有 parser 保留 feed provenance，并将显式期刊名作为 venue 候选；无可靠 venue 时 UI/XLSX 安全显示 RSS。已有历史产物不会因此自动回填。

RSS URL 继续使用 Settings 的 URL 校验，接受公开 HTTP(S) feed 的普通查询参数（推荐 HTTPS，例如 `facet-journal-id`、`query`、`search-within`），拒绝敏感凭据参数、userinfo、fragment、不安全 scheme、控制字符、本地名称和 IP 字面地址。敏感值应由独立 Secret owner 管理，不得嵌入 Feed URL；不会静默删除参数后声称保存成功。此处是静态配置检查，不执行 DNS/redirect 检查，也不改变检索器网络策略；其他 Settings URL 的校验保持原样。

## 12. 高级/兼容配置，不进入普通填写问卷

这些入口由 direct Stage0、维护、测试或既有自动化读取，仍受兼容承诺保护，但统一 onboarding 不应要求普通用户填写：

| 类别 | 真实变量/入口 | 说明 |
|---|---|---|
| 调度与运行 | `review_results_RUN_INTERVAL_DAYS`、`FORCE_review_results_RUN`、`review_results_FORCE_RUN`、`review_results_ORCHESTRATOR_TRIGGER`、`ZOTERO_ORCHESTRATOR_TRIGGER`、`review_results_STAGE1_ONLY`、`review_results_RUN_ID`、`review_results_OVERRIDE_DATE` | Runner/launcher 正常交互不靠这些选路径 |
| dry-run/抽样 | `review_results_DRY_RUN`、`review_results_NO_WRITE`、`ZOTERO_DRY_RUN`、`SKIP_ZOTERO_MCP`、`NO_FORMAL_RULE_APPLY`、`review_results_SAMPLE_LIMIT`、`review_results_SAMPLE_STRATEGY`、`review_results_FETCH_LIMIT`、`review_results_MAX_GRADE_REVIEW_ITEMS`、`review_results_GRADE_REVIEW_BATCH_SIZE`、`review_results_ALLOW_NETWORK_FETCH`、`ALLOW_DRY_RUN_ON_OFFICIAL_ROOT`、`PAPERFLOW_ALLOW_FIXTURE_INPUT` | 测试/诊断 fail-safe，不是首次配置字段 |
| 路径兼容 | `review_results_OUTPUT_ROOT`、`review_results_ROOT`、`LEGACY_DESKTOP_REVIEW_ROOT`、`DESKTOP_REVIEW_ROOT_LEGACY`、`DESKTOP_REVIEW_ROOT`、`PWSH_PATH`、`PYTHON` | 统一路径优先使用 common/local 字段；legacy root 不进入模板 |
| Desktop 高级 | `ZOTERO_EXTERNAL_LAUNCHER`、`ZOTERO_CLI_BATCH_CREATE_TIMEOUT_MS_PER_ITEM`、`ZOTERO_CLI_CREATE_ITEM_DISABLE_IMPORT_FALLBACK`、`ZOTERO_WEB_CLI_TOOL` | 内部兼容/诊断；默认实现参数不进入 schema |
| Zotero 业务策略 | `ZOTERO_STAR_MIGRATION_MODE`、`ZOTERO_STAR_MIGRATION_WINDOW_DAYS`、`ZOTERO_STAR_MIGRATION_MIN_STARS`、`APPLY_FEEDBACK_ITEM_ACTIONS` | 现有业务兼容项；本轮不改变 Stage 行为 |
| LLM 参数覆盖 | `PREFERENCE_LEARNING_*`、`TITLE_TRANSLATION_*`、`TRANSLATION_API_*` | 优先用于临时环境覆盖；常规非敏感值应留在两个领域 config |
| 期刊 gate | `EASYSCHOLAR_RATE_LIMIT_PER_SECOND` | 常规阈值/速率来自 `review-workflow-rules.json` |

Web 的 API v3、读取 page size 100、写入 batch 50、timeout 30 秒、默认 retry 3、间隔 2 秒和 Backoff/429 处理是 adapter 固定策略。Desktop backend 的 timeout/retry/recovery、collection routing 和 exact-key cleanup 也是内部契约；它们不是遗漏的用户字段。

## 13. 填写模板到目标文件

| 模板字段 | 目标文件 | 目标字段/环境变量 | Secret | 适用路径 | Codex 行为 |
|---|---|---|---|---|---|
| 0. profile | `config/paperecho.config.json` | `profile` | 否 | 全部 | 写入 standard/complete；执行意图不写入配置 |
| 0. 邮件/真实 LLM | JSON + 启动参数 | `common.email.enabled`、`common.llm.requireRealModel`；必要时 `--email`/`--require-llm` | 否 | 全部 | 只在用户明确要求时启用 |
| 1.1 项目根 | JSON | `common.projectRoot` | 否 | 全部 | 写相对或绝对路径；不创建第二套 output 配置 |
| 1.2 LLM 开关/路径 | JSON | `common.llm.*` | 引用否 | 全部 | provider/model 参数写对应领域 config，不塞进 unified JSON |
| 1.2 LLM secret 状态 | JSON + `.env`/环境 | 两个 `*ApiKeyEnv` 引用及其本地变量 | 值是 | 全部 | 未有安全本地来源时只提示变量名，不索要聊天粘贴 |
| 1.3 邮件非敏感项 | JSON | `common.email.recipient/smtp.*` | recipient 属个人信息但非认证 secret | 全部 | 仅请求邮件时写入/检查 |
| 1.3 SMTP password | JSON + `.env`/环境 | `passwordEnv` 指向的变量 | 是 | 全部 | 只改明确授权键，不输出值 |
| 1.4 source selection | `config/source_selection.json` | research domain / enabled sources / confirmation | 否 | 全部 | 只有用户选择定制时修改 |
| 1.4 RSS/PubMed/OpenAlex | 对应 `config/*.json` | 对应检索字段 | 否 | 全部 | 沿用默认时不改文件 |
| 1.4 规则/期刊 gate | `config/review-workflow-rules.json` | 对应 rule/filter 字段 | 否 | 全部 | 不把规则复制进 unified JSON |
| 1.4 长期标准 | 运行根 `screening_standards.md` | 文本内容 | 否 | 全部 | 可让 Stage1 初始化；仅按明确内容更新 |
| 1.4 期刊 API secret | JSON + `.env`/环境 | `journalQualityApiKeyEnv` 指向的变量 | 是 | 全部 | 只记录引用与 presence |
| 1.5 cleanup | JSON | `common.cleanup.enabled/retentionDays` | 否 | 全部 | `0` 保持“禁用年龄删除”语义 |
| 1.6 确认项 | 不写运行配置 | readiness/权限确认 | 否 | 全部 | 用于决定是否只 check 或允许 run |
| 2.1 Desktop | JSON | `desktop.*`，且只启用 desktop | 否 | Desktop | 不读取/要求 Web 或 Local 字段 |
| 2.2 Web | JSON + `.env`/环境 | `web.*` + key 引用变量 | key 是 | Web | 不读取/要求 Desktop 或 Local 字段 |
| 2.3 Local | JSON | `local.input/outputRoot/feedback`，且只启用 local | 否 | Local | 不创建独立 state/runs/exports 字段，不检查 Zotero |
| 3/5 Codex 结果 | 不写运行配置 | 解析与 preflight 报告 | 否 | 全部 | 只记录 sanitized 结果，不写 generated state |

## 14. Codex 应用填写模板的固定行为

1. 读取已填写模板和本指南，校验通用答案并统计三个路径模块的 `启用` 数量。
2. 确定唯一 mode；多路径冲突或全部关闭时停止，不用环境残留猜测。
3. 路径 Skill 只处理 `common` 加自己的 section，并固定自身 mode；其他 section 即使有残留内容也不能触发切换。
4. 非敏感运行参数写入本地 `config/paperecho.config.json`；领域参数只写回其既有 owner 文件。
5. Secret 值不写入 JSON、Markdown、聊天、CLI 或输出。更新 `.env` 时保留未知变量，只修改用户明确授权且有安全本地来源的键，不打印值，也不提交 `.env`。
6. 配置后只运行所选路径 launcher 的 `--check --config config/paperecho.config.json`。blocked 时仅报告缺失项与安全 retry command。
7. ready/warning 后，用户选择“只检查”则停止；只有明确选择“配置后运行”且 preflight 允许时才执行同一 launcher 的 `--run`。
8. 单纯应用个人配置不 stage、不 commit。文档/模板维护任务才可在通过验证后提交非个人文件。
