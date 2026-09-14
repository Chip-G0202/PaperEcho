# PaperEcho Control Center — v2.4 使用与兼容说明

## 启动与使用

普通用户在已有 PaperEcho 项目目录中双击：

- **Windows：`PaperEcho.vbs`**。隐藏启动窗口，服务就绪后打开默认浏览器。若 Windows Script Host 不可用，使用 `PaperEcho.cmd` 诊断备用入口，此时会显示终端。
- **macOS：`PaperEcho.app`**。最薄的未签名应用包装，不含运行环境或用户数据；保留整个项目目录，不能单独搬走 `.app`。Git 中启动脚本为 executable、LF 换行。当前已检查 bundle/脚本契约，但尚未在 macOS Finder 实机验证；如果系统不能运行该包装，可双击 `PaperEcho.command` 诊断备用入口，此时仍会出现 Terminal，不能称为无终端启动。

前置条件仍为 Node.js 18+ 与已安装的项目依赖。启动器不会下载、安装或升级运行环境。Windows 使用系统 PATH 中的 `node.exe`；macOS 检查 PATH 及标准 Homebrew/Node 安装位置。仅在终端初始化的版本管理器可能需要另行配置 GUI 可见的 Node 路径。

服务默认只监听 <http://127.0.0.1:8765>。共享 `workflow/tools/web/launcher.mjs` 调用原 server/bootstrap 与正式 Runner/runtime loader，不维护另一套路径配置。它检查产品、协议和不含原始路径的工作区指纹；同一实例就绪则直接打开，不重复启动。其他程序或另一工作区占用端口时明确报错，不强杀、不换端口。首次启动最多等待约 15 秒就绪，再调用系统默认浏览器。

包装进程退出后后台 Node 服务继续运行；关闭浏览器不会停止服务。系统注销或重启后后台进程结束，不设置自动启动或调度任务。启动器不执行 workflow、不修改调度器、不探测 Zotero。

### 高级启动与故障诊断

在项目目录运行以下命令；原有配置参数仍通过同一个 Runner loader 解析：

```sh
node workflow/tools/web/launcher.mjs
node workflow/tools/web/launcher.mjs --stop
```

`--stop` 只停止匹配当前工作区指纹的实例，使用现有 session、Origin、CSRF 校验。Windows 也可运行 `PaperEcho.cmd --stop`。使用自定义 `--config` 启动时，停止应传入同一配置参数；修改运行根配置前先停止原实例。后台服务没有托盘菜单或独立守护进程管理器。

开发者仍可用 `node workflow/tools/web/server.mjs` 前台启动，并通过 Ctrl+C 停止。若自动打开浏览器失败，可手动访问上述地址；详细错误使用 `.cmd` / `.command` 或共享 Node 启动命令查看，错误不会包含凭据或原始配置堆栈。HTML `file://` 不承担启动本机进程的职责。

启动器定向验证：`node --test tests/control_launcher.test.mjs`；正式 `npm test` 也通过 Control Center HTTP 测试入口加载这些测试。平台包装只负责查找 Node、调用共享 owner 和提示启动失败，不复制服务逻辑。原 Desktop/Web/Local workflow launcher 完全独立运行。

1. **概览**：最近可用 Weekly、可识别的 Radar、最近运行结果、来源与审核数量。无可靠证据的状态显示未知；Zotero 只反映最近写入记录，不表示实时连接正常。
2. **文献**：当前结果的只读汇总，显示最终等级数量，点击等级按钮筛选，每页最多 50 篇。英文原始标题在前、中文翻译在后。基于实际运行根的 registered run manifest 查询；Desktop/Web 经过现有 verified-write filter，Local 复用 Local Stage4 筛选规则，不依赖临时 export source。绝不展示 Stage1 全候选池，也不在此页提交反馈。
3. **研究反馈**：自然语言直接调用共享 evaluation 核心，先保存收据再尝试处理。需要原有 LLM 配置。失败保留输入，显示 blocker；重试相同请求不会重复生成已完成建议。网页不显示 prompt 或 raw LLM response。
4. **规则建议**：一次审阅一条，点击“接受”“拒绝”直接提交人工决策；“修改后接受”先进入编辑区，再显式提交。不重复弹窗确认，原安全校验仍是正式应用的必要条件。高风险或无可靠 mutation owner 的建议保持 pending，回执说明对应建议、原因与下一步；本次接受意图不代表正式规则已修改。
5. **设置**：四组内部导航——研究与检索（Sources / Search / RSS）；评审与学习（Models / Ranking / Review / Radar / Weekly / Integrity）；连接与通知（Zotero / Notifications / Credentials）；工作区与高级（General / Advanced）。小枚举使用单选按钮，布尔项使用开关。原配置 owner、校验和安全写入契约不变。

## 反馈语义与存储

### 界面约定

App Shell 由固定 Sidebar、页头和主内容组成；窄窗口通过“导航菜单”展开，正文随导航向下排列。当前入口为概览、文献、反馈、设置、系统，不放置尚未实现的未来模块。文献页严格只读；反馈内的文献等级、研究方向、规则建议使用原生按钮子导航。波形标识为可替换的简单 inline SVG，不是正式品牌资产的精确复用。

Settings 按分类显示字段，分类切换不丢弃当前页尚未保存的输入；凭据仍为空密码框，仅写入、不回显。研究评价草稿只在当前页面会话内保留，不写浏览器持久存储。System 只展示已有状态的安全摘要，不显示绝对路径、不把历史证据当作实时健康检查。没有结构化推荐依据时不生成“Why Recommended”。

可复用展示约定位于 `web/static/`：CSS custom properties 管理颜色、间距、圆角和 focus；`.subnav`、`.badge`、`.empty-state`、`.manual-action` 与字段错误提示承载一致状态。新增页面继续通过 service API 读取数据，动态文字使用 textContent；不得把 UI 状态改成业务决策或新增服务逻辑。

UI 定向验证：`node --test workflow/tests/control_ui.test.mjs workflow/tests/control_http.test.mjs workflow/tests/spreadsheet_adapter_compat.test.mjs`。`control_ui.test.mjs` 同时加载 `tests/control_review_workspace.test.mjs`，验证实际按钮事件、队列保存与键盘隔离；轻量 DOM 测试替身不代替真实浏览器的交互／布局检查。运行产物使用 `tests/runs/`。

### 连续等级审阅

反馈回答“最终等级是否正确”，不会改写本次 rule / semantic / final grade、Weekly 结果或即时修改 Zotero。文献队列分类及等级字段兼容规则归 Stage4 `spreadsheet_adapter.mjs#getWeeklyReviewEvidence`，查询服务复用该 owner，Web 不根据等级差另推人工复核资格。现有 `needs_human_review` 及 legacy aliases 保持兼容；普通队列与人工复核队列互斥，保留输入结果顺序，默认定位尚未反馈且具可靠标识的文献。

一次仅突出一篇，默认折叠详细信息；人工复核另列三个只读等级及已有复审依据，不补造推荐理由。点击即保存，成功后前进，失败停留并允许重试。上 / 下一篇可回看已处理条目，改选继续追加原 canonical revision。缺少可靠 identity 时禁止提交但允许跳过。进度按当前已保存反馈计数；页面内草稿、当前位置和高风险回执不形成第二份持久状态。

文献工作区：1 升级、2 不变、3 降级、4 排除；规则工作区：1 接受、2 拒绝、3 进入修订；↑ / ↓ 回看或继续。快捷键仅绑定当前审阅工作区，在 input、textarea、select、contenteditable、dialog 或编辑状态内禁用；不拦截系统组合键，保存期间拒绝重复动作。鼠标和触屏有等价按钮。

| 按钮 / 兼容 API 值 | 原 workflow 值 | 意义 |
|---|---|---|
| 升级 / highly_relevant | upgrade | 提高最终等级的人工评价信号 |
| 不变 / relevant | keep | 认可当前等级，保留原弱正向语义 |
| 降级 / maybe | downgrade | 降低最终等级的人工评价信号 |
| 排除 / irrelevant | drop | 强负向反馈，后续条目处理由原工作流执行 |
| 历史兼容 / do_not_recommend_similar | drop | 旧值继续读取、显示为原强负反馈；不直接创建永久排除规则 |

`review_results/文献评价/paper_feedback.json` 是 schemaVersion 1 的 canonical paper feedback state。每次有效提交追加 revision，保留 requestId、canonical identity aliases、时间与反馈上下文；当前有效反馈由最后一个 revision 推导。相同 requestId/内容幂等，改变内容应使用新 requestId。Title 仅作为上下文，不能单独用于 identity。

Stage1 在存在 canonical feedback 时从该 state 读取当前值；无 state/无反馈时仍使用原 XLSX adapter。原有 Local 显式 JSONL 输入优先级保留。论文动作使用稳定 DOI/PMID/PMCID 匹配；无法匹配时保留人工处理，不回退到猜标题。下一次 workflow 通过既有 collection guard 执行动作，网页提交不会直接操作 Zotero。

研究评价收据位于 `review_results/文献评价/research_evaluations/`；pending schema、去重与状态仍使用 `standards_rule_suggestions_log.json`。这些存储边界不合并。

## Legacy compatibility 与单向 import

- Weekly XLSX 仍由原 Stage4 生成，历史 feedback reader 保留。
- `screening_standards.docx` 仍可解析、导出。DOCX evaluation 与纯文本入口走同一核心；DOCX decision adapter 与网页走同一 RuleSuggestionService。
- 不存在 Web → XLSX、Web → DOCX feedback 的双向同步。网页评价不会替换或清空 DOCX 评价区。
- 不自动扫描、迁移全部历史文献。可由维护调用者使用 `importLegacyWorkbook(file, feedbackService)` 做显式单向导入；原文件不变，导入返回 receipt。没有可靠 DOI/PMID 的行会阻止该次导入，不猜测 title identity。
- 批量导入一次原子提交；requestId 由源文件内容 hash 和 row 派生，重复导入同一文件幂等。
- 不需要启动 Control Center 才能读取 canonical state；正常 workflow 仍按原有 launcher 运行。

## 当前能力边界

- 查询覆盖正式 resolver 选定的 Desktop/Web runtime roots 和 Local output root。未注册历史输出不自动扫描或迁移；不会混入仓库默认根中其他实例的数据。
- 下一次调度只有在可可靠读取时才应显示；当前显示未知。Weekly 间隔只读，不重写正式 scheduler state。
- 等级复审和 literature overview 使用现有 preference learning 模型配置，不增加第二套模型 owner。
- 缺少 owner JSON 时设置只显示未初始化；按原配置指南初始化后再使用网页。
- ConfigService 不提供 arbitrary JSON/path API。PubMed keyword groups 更新由现有 query builder 生成检索式；已有 keyword groups 时直接 query 编辑被拒绝。
- 安全 apply 当前仅支持正文追加及修订后追加。高风险、删除、已有规则替换、搜索关键词 suggestion、其他 target mutation 保持 pending；Control Center 返回 `application_status: requires_manual_action`、target、risk、未应用原因和人工处理说明。这是预期安全行为，不表示按钮失效或正式规则已应用。可以拒绝建议，或通过现有规则/检索配置维护流程人工核对范围、验证和备份；网页确认不能解除 guard。
- Credentials 支持 configured/not configured、Replace、Clear；覆盖 TITLE_TRANSLATION_API_KEY、PREFERENCE_LEARNING_API_KEY、EASYSCHOLAR_SECRET_KEY、SMTP_PASS、ZOTERO_API_KEY。Configured 不等于连接有效。没有可复用的安全连接测试 owner，因此 Test 未开放。不提供 raw secret GET，不创建 credential vault。
- 低风险规则正文变更先保存固定 `.backup`，再原子替换正文；日志写入失败时恢复正文。进程在正文提交后中断、决策日志提交前中断时，pending 保留，重试经已有 duplicate guard 不重复追加。

这些边界不能统一等同于“v2.4 未完成”：安全限制、明确非目标和可推迟增强均不阻塞发布。发布判断应仅依据下方核心路径差距。没有 tag、release 或自动更新切换。

## v2.4 最终验收差距分类

原审计基线为 `c9a337a`，在 `a8be516` 中分类为 13 项：A 1、B 7、C 2、D 3。本次只复验唯一 A 项：路径修复后 64 项定向测试、check、1176/1176 全量回归通过，A 项已 resolved；其余 12 项分类沿用，不扩大范围。

| 名称 | 当前实际状态 | 对核心用户路径的影响与理由 | 分类 |
|---|---|---|---|
| 当前运行根及 Local 查询 | 启动时复用 Runner 配置和 runtime_config，向查询、论文反馈、研究评价及建议服务注入同一上下文 | 默认、configured project/output/research roots、Local 均可查看当前文献并写入对应 review root；默认根冲突数据不被误读误写 | Resolved（原 A） |
| 全量历史扫描／迁移 | 只支持显式单向 legacy import，不自动扫描全部历史输出 | 不影响新一期正常使用；原始 v2.4 明确不要求迁移所有历史数据 | C. Explicit v2.4 non-goal |
| 下一次调度／实时状态 | 无可靠证据显示未知；Zotero 为历史写入状态，非实时连接检测 | 不影响查看、反馈或配置；不把未知状态冒充正常 | D. Deferred enhancement |
| Weekly 间隔编辑 | 只读，正式 scheduler 仍由原 owner 管理 | 已配置用户可继续按原调度运行；网页调度管理不是日常反馈前提 | D. Deferred enhancement |
| 模型能力共享 owner | 等级复审、overview 复用 preference learning 模型配置 | 常用模型可修改，不需要为每个能力制造独立配置 | B. Accepted safety boundary |
| 缺失配置文件的初始化 | 显示未初始化，首次按原配置指南准备文件 | 初次安装配置入口未统一；已有 v2.3 项目的日常设置不因此缺失。不会自动选择或切换运行模式 | D. Deferred enhancement |
| Config Registry 和检索式 owner | 固定字段白名单；keyword groups 存在时通过词组控件生成 PubMed query | 模型、sources、搜索、RSS、review、Radar、Weekly、Integrity、Zotero、邮件均有常用控件；拒绝任意 JSON/path 编辑不阻断正常设置 | B. Accepted safety boundary |
| 高风险／删除／搜索建议 | 保持 pending，返回 requires_manual_action、target、risk、原因和下一步 | 普通建议可接受、拒绝、修订；危险变更不自动应用是明确安全策略，不是按钮失败 | B. Accepted safety boundary |
| Credentials Test／原值读取 | 五类本地凭据可 Replace/Clear；Test 未开放，原值永不返回 | UI 明示 Configured 不等于连接成功；缺少安全 test owner 不影响凭据维护 | B. Accepted safety boundary |
| 外部凭据和 env 格式 | 外部覆盖只读；含糊格式、重复 key、非 allowlist 值拒绝写入 | 支持格式的本地凭据可维护；避免破坏外部注入、其他 entries 或泄露 secret | B. Accepted safety boundary |
| 规则两文件崩溃恢复 | 正文／日志分别原子写入；失败回滚，崩溃后保留 pending，经 duplicate guard 重试 | 不误报正式应用成功，不重复添加；保留既有物理 owner | B. Accepted safety boundary |
| Legacy 与 identity | XLSX/DOCX 读写兼容，Web 单独提交 canonical feedback；identity 不确定时拒绝 | 正常网页反馈不需要打开 XLSX/DOCX；无危险双向同步，不能可靠匹配的个例不猜测 | B. Accepted safety boundary |
| 外部产品与分发能力 | Bot／QQ／Feishu、Installer／Portable、Backup/Restore UI、auto-update、Electron/Tauri、cloud/multi-user、依赖升级不在范围 | 原始任务明确排除，不属于 v2.4 未完成项 | C. Explicit v2.4 non-goal |

**结论：V2.4 RELEASE READY。原唯一 blocker 已解决。** 其余 accepted safety boundaries、明确非目标及 deferred enhancements 不阻塞 v2.4；未创建 tag、发布或同步 Production。

长期约定：Control Center/CLI/workflow 必须共享 `runtime_config.mjs` path owner，Web 不维护独立 root resolution。`resolveApplicationRuntimeContext` 复用 Runner 参数及配置优先级，组合 `buildRuntimeConfig`、`buildLocalRuntimeConfig` 与 LocalRepository 的既有路径；不执行 preflight、workflow 或 repository.load。网页支持既有 `--config`、`--mode`、Local `--output-root` 参数及原环境/config 覆盖，不新增 Web 专属 root 配置。未配置时保持默认根；指定但无数据的根显示空结果，不回退到其他实例；无效配置在监听前失败。

canonical feedback、研究评价收据和 pending suggestions 均使用解析后的 runtime.reviewRoot（默认仍为 `review_results/文献评价`；Local 为 output root 下对应 review root）。Local 当前文献来自既有 papers snapshot，经共享 Stage4 builder 筛选；不调用会写索引的 repository.load。Runner settings 写入实际选中的配置文件；领域配置和凭据仍保持原 owner 位置。运行上下文在启动时确定，修改路径配置后需重启 Control Center，不迁移、复制或同步任何数据。

## 凭据安全写入约定

`control_credentials_service.mjs` 中的 SecretService 是唯一网页凭据写入 owner；持久存储仍为项目 `.env`。只接受 allowlist key 和最多 4096 字符的单行值，不接受控制字符或同时包含两种引号的值。格式检查复用既有 loader 的解析结果，并仅支持无重复 key 的单行赋值、空行及注释；多行、export、含糊引号等格式拒绝写入，请通过原环境配置入口维护。未知 entries 保持原样。

写入使用既有原子文件 owner 和锁，临时文件 POSIX mode 为 0600（Windows 继承目录 ACL），不生成含 secret 的备份；`.env`、临时文件和锁均被 gitignore 排除。写入失败不更新当前环境，错误仅返回固定代码。旧值在当前服务进程内继续用于脱敏，清除不会使旧值重新出现在响应中。

当前进程中的外部环境值与本地文件不一致时该项只读，需在原注入入口维护后重启。本地修改对当前 Control Center 和下一次 workflow 生效，已运行的其他进程需重启。Clear 将目标值置空，不修改其他 key；例如 preference learning 仍可能按既有规则回退使用 title translation key。

## 安全与验证

默认只绑定 `127.0.0.1`，程序调用只允许 `127.0.0.1`/`::1`；Host allowlist、防跨站 Origin 检查、HttpOnly SameSite session cookie 和 CSRF header 共同保护 mutation。请求体限制 64 KiB，静态资源固定 allowlist，CORS 默认不开放。UI 使用 textContent，安全外链限制 http/https，并设置 CSP、防嵌入和 no-referrer。

```sh
node --test workflow/tests/control_services.test.mjs workflow/tests/control_http.test.mjs
node --test workflow/tests/control_credentials.test.mjs
node --test workflow/tests/control_runtime_roots.test.mjs workflow/tests/runtime_safety_config.test.mjs workflow/tests/runner_config.test.mjs workflow/tests/local_pipeline.test.mjs
npm run check
npm test
```

新增测试只写项目内临时 fixture，HTTP 使用临时 loopback port，LLM 为注入 mock；不连接真实 Zotero、LLM、SMTP，不访问 Production。运行全量旧 tests 时，将 TEMP/TMP 与 npm_config_cache 指向工作区临时目录，以保持输出隔离。不得为 Control Center 的验收更改正式 scheduler、配置、ledger、索引或用户反馈。
