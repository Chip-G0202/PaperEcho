# PaperEcho 配置填写模板

## 使用方法

1. 填写“1. 通用/共用配置”。
2. 只选择并填写 2.1、2.2、2.3 中的一个路径模块。
3. 被选择路径设置为 `启用：是`，其余两个设置为 `启用：否`。
4. Secret 不填写进本文档；只填写环境变量名称以及是否已在本机配置。
5. 将填写后的模板交给 Codex。Codex 负责校验答案、写入本地 `config/paperecho.config.json`、按授权处理本地 `.env`，并运行对应 launcher 的 `--check`。
6. Codex 只读取 `common` 和所选路径，不要求补齐另外两条路径。
7. 未明确选择“preflight 通过后执行 `--run`”时，Codex 只能配置并执行 `--check`，不得启动生产流程。

字段的目标文件、默认值和阻塞规则见 [PaperEcho 配置指南](configuration.md)。保留空白表示沿用当前默认或等待 Codex 报告缺失项；不要粘贴密码、API key 或 token。

## 0. 配置意图

- 配置用途（选一）：首次安装 / 更新配置 / 只检查配置 / 配置后运行
- 执行 profile（选一，默认 `standard`）：standard / complete
- 是否要求发送 Stage5 邮件（默认否）：是 / 否
- 是否要求真实 LLM（默认否）：是 / 否
- 配置完成后（选一，默认只检查）：只运行 `--check` / preflight 通过后执行 `--run`
- 若选择运行，是否已明确允许本次外部网络与生产写入：是 / 否 / 不适用

> `complete` 不会自动发送邮件或强制真实 LLM；只有上面明确选择的能力才会成为硬要求。

## 1. 通用/共用配置

### 1.1 项目与运行目录

- 使用默认项目根目录：是 / 否
- 自定义项目根目录（仅在上项为“否”时填写；示例 `<PROJECT_ROOT>`）：
- 目标路径的现有父目录可写：是 / 否 / 未检查
- 允许 PaperEcho 在该可写父目录下创建运行子目录：是 / 否
- 统一配置文件位置（默认 `config/paperecho.config.json`）：

说明：Desktop/Web 的 `review_results`、周报、run state 和 cache 从项目根目录派生。Local 的业务输出由 2.3 的 `outputRoot` 派生。不要分别填写 state、runs、exports、receipt 或 cache 路径。

### 1.2 LLM 与标题翻译

- 启用 LLM：是 / 否
- LLM mode（选一）：disabled / mock / real
- provider：当前实现使用 OpenAI-compatible endpoint，没有独立 `provider` 字段（无需写入统一 JSON）
- 必须使用真实模型，缺少 key 时阻塞：是 / 否
- 偏好学习参数：沿用 `config/preference_learning.config.json` / 使用其他路径
- 其他偏好学习参数文件路径：
- 标题翻译参数：沿用 `config/title_translation.config.json` / 使用其他路径
- 其他标题翻译参数文件路径：
- 是否修改偏好学习 provider/endpoint/model：否 / 是（如是，在下方填写非敏感值）
- 偏好学习 endpoint：
- 偏好学习 model：
- 是否修改标题翻译 provider/endpoint/model：否 / 是（如是，在下方填写非敏感值）
- 标题翻译 endpoint：
- 标题翻译 model：
- 标题翻译失败时允许回退英文标题：是 / 否
- 偏好学习 API key 环境变量名（默认 `PREFERENCE_LEARNING_API_KEY`）：
- 该环境变量已在本机配置：是 / 否 / 未检查
- 标题翻译 API key 环境变量名（默认 `TITLE_TRANSLATION_API_KEY`）：
- 该环境变量已在本机配置：是 / 否 / 未检查

说明：endpoint、model、采样、timeout、retry、并发和 prompt 属于两个领域 `.config.json`，不写入统一 JSON。`standard` 且未要求真实 LLM 时允许现有 fallback；明确要求真实 LLM 时，缺少可用 key 会被 preflight 阻塞。

### 1.3 Stage5 邮件

- 启用并要求发送邮件：是 / 否
- 收件人：
- SMTP host：
- SMTP port（默认 `465`）：
- SMTP secure（未填写时仅 port 465 推导为 true）：true / false / 留空
- SMTP user：
- SMTP from（留空时使用 SMTP user）：
- SMTP password 环境变量名（默认 `SMTP_PASS`）：
- 该环境变量已在本机配置：是 / 否 / 未检查

说明：未请求收件人时 Stage5 可以安全 skipped，SMTP 缺失不阻塞；请求邮件后，host、user、password 和有效发件地址缺失会阻塞。

### 1.4 检索、筛选与期刊质量

- 领域策略：沿用仓库默认 / 按下方定制
- 研究领域（选一）：biomedical / non_biomedical_stem / education_social_science / mixed_biomedical_technical / unknown
- 覆盖启用的检索源（留空表示按领域）：rss / pubmed_pmc / openalex
- 信息不足时要求人工确认：是 / 否
- RSS：沿用 `config/rss_sources.json` / 提供新的 name、url、enabled 列表
- RSS 定制内容：
- PubMed/PMC：沿用 `config/pubmed_pmc_search.json` / 定制
- 数据库（仅 `pubmed`、`pmc`）：
- 检索天数（默认 `10`）：
- 最大结果数（默认 `300`）：
- 正向/必需关键词组：
- 可选关键词：
- 负向关键词：
- OpenAlex：禁用 / 启用
- OpenAlex query（启用时必填）：
- OpenAlex days_back（默认 `10`）与 per_page（默认 `50`）：
- 筛选与反馈规则：沿用 `config/review-workflow-rules.json` / 描述要修改的规则
- 规则修改说明：
- 长期筛选标准：首次运行自动初始化 / 提供 `screening_standards.md` 内容 / 沿用现有文件
- 期刊质量过滤：沿用规则文件 / 描述修改
- 期刊质量修改说明：
- 期刊质量 API key 环境变量名（默认 `EASYSCHOLAR_SECRET_KEY`）：
- 该环境变量已在本机配置：是 / 否 / 未检查

说明：这些共享领域文件适用于三条路径。Codex 仅在用户明确提供定制内容时修改它们；否则保留仓库默认。prompt 文件通常无需用户填写。

### 1.5 清理与保留

- cleanup enabled（默认是）：是 / 否
- retention days（默认 `30`）：
- 确认 `0` 表示禁用按年龄删除：是 / 否 / 不适用

### 1.6 通用确认项

- Node.js >= 18：是 / 否 / 未检查
- PowerShell 7 (`pwsh`) >= 7.0.0：是 / 否 / 未检查
- 项目依赖已安装：是 / 否 / 未检查
- 目标输出目录或其父目录可写：是 / 否 / 未检查
- 本地 `.env` 已创建：是 / 否（可选；只有需要本地环境变量时才创建）
- 允许所选路径在生产运行时访问必要外部网络：是 / 否 / 不适用
- 允许所选路径在生产运行时写入目标系统/目录：是 / 否

## 2.1 Zotero Desktop 路径配置

- 启用：是 / 否
- Zotero Desktop 已安装：是 / 否 / 未检查
- 生产运行时允许 launcher 启动或复用 Zotero：是 / 否
- Zotero executable 路径（自动发现成功时可留空；示例 `C:\Program Files\Zotero\zotero.exe`）：
- Desktop backend：固定 `cli`（无需填写）
- CLI/bridge 命令或完整路径（默认 `zotero-cli`）：
- CLI/bridge 已安装并可从当前 PATH 找到：是 / 否 / 未检查
- 写回 batch size（默认 `50`，范围 `1-50`）：
- readiness 启动重试次数（默认 `45`）：
- readiness 重试间隔毫秒（默认 `1000`）：
- Zotero 启动后等待毫秒（默认 `5000`）：
- 允许 Zotero 写入：是 / 否
- 预期执行 Stage2/Stage3：是 / 否（Desktop 正常生产路径应为“是”）

固定行为，无需填写：backend 运行 timeout/retry、recovery manifest、collection routing、去重、版本与清理协议。Desktop 不需要 Web API key；CLI 可用 `--profile`、`--email`、`--require-llm` 覆盖通用执行意图，没有额外 Desktop path CLI 字段。

## 2.2 Zotero Web API 路径配置

- 启用：是 / 否
- Zotero API key 环境变量名（默认 `ZOTERO_API_KEY`）：
- 该环境变量已在本机配置：是 / 否 / 未检查
- Zotero User ID（个人文库必填；数字 ID，不是用户名或邮箱）：
- request concurrency（默认 `4`，范围 `1-4`）：
- API key 具备所需 library 写权限：是 / 否 / 未检查
- 允许访问 Zotero Web API 网络：是 / 否
- 预期执行 Stage2/Stage3：是 / 否（Web 正常生产路径应为“是”）

固定行为，无需填写：使用个人文库、官方 base `https://api.zotero.org`、API v3、header 认证、读取 page size 上限 100、写入 batch 上限 50、timeout 30 秒、默认 3 次尝试、2 秒重试间隔、`Retry-After`/`Backoff`、版本保护与 recovery。不要填写群组文库、OAuth、refresh token、Desktop executable 或 CLI bridge。

## 2.3 Standalone Local 路径配置

- 启用：是 / 否
- input 路径（必填）：
- input 形式（选一）：单个 `.json` / 单个 `.jsonl` / 包含 `.json` 或 `.jsonl` 的目录
- output root（必填，必须是安全的专用目录）：
- 允许在可写父目录下创建 output root 子目录：是 / 否
- feedback JSONL 路径（可选）：
- 允许在 output root 中创建或更新 Local state 与本次输出：是 / 否
- 使用通用 LLM 设置：是 / 否
- 使用通用 Stage5 邮件设置：是 / 否

固定行为，无需填写：`state/`、`runs/`、`exports/`、feedback checkpoint 和 timings 都从 `outputRoot` 派生。Local 不需要 Zotero Desktop，不需要 Zotero Web API key，不执行 Stage2/Stage3，也没有独立的 state/runs/exports override。

## 3. 路径选择结果（由 Codex 填写）

- 已启用路径模块数量：
- 最终 mode：desktop / web / local / blocked
- mode 来源：路径模块 / 显式用户选择 / CLI override / 固定路径 Skill
- 是否存在冲突：是 / 否
- 是否可进入 preflight：是 / 否
- 冲突或阻塞原因：

解析规则：仅 Desktop/Web/Local 中一个启用时选择对应 mode；全部未启用时 blocked；多个启用且没有明确 mode 时 blocked。显式 mode 可以消除普通 Runner 的多启用歧义，但固定路径 Skill 始终以自身 mode 为准，配置若明确选择其他路径则 blocked，不得切换 Skill。

## 4. Secret 配置清单

| Secret 用途 | 环境变量名称 | 当前是否已配置（是/否/未检查） |
|---|---|---|
| Zotero Web API | `ZOTERO_API_KEY` 或 `web.apiKeyEnv` 指向的名称 | |
| 偏好学习 LLM | `PREFERENCE_LEARNING_API_KEY` 或对应引用 | |
| 标题翻译 LLM | `TITLE_TRANSLATION_API_KEY` 或对应引用 | |
| SMTP password | `SMTP_PASS` 或 `common.email.smtp.passwordEnv` 指向的名称 | |
| 期刊质量 API | `EASYSCHOLAR_SECRET_KEY` 或对应引用 | |

不要在此表填写值。若未配置，Codex 只报告需要在本机设置的环境变量名称，不要求把 secret 粘贴到聊天。

## 5. Codex 应用结果（由 Codex 填写）

- 修改了哪些配置文件：
- 明确保留且未修改的文件：
- resolved mode：
- resolved profile：
- 缺失配置：
- warning：
- `--check` 命令：
- preflight 结果：ready / warning / blocked / 未执行
- 是否启动生产流程：否 / 是
- 是否需要用户回复“继续”：是 / 否
- 是否创建 Git commit：否（配置操作本身不得创建 commit）
