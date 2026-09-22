# PaperEcho 配置指南

## 用户实际需要处理的文件

### 必须查看

- [`docs/paperecho-setup-template.md`](paperecho-setup-template.md)：交给用户填写、再交给 Codex 应用的问卷；不是运行时配置。
- 本文档：字段、优先级、缺失行为、文件职责和模板映射的事实来源。

### 复制后填写

- [`config/paperecho.config.example.json`](../config/paperecho.config.example.json) -> `config/paperecho.config.json`：统一运行配置；Runner 兼容 schema v1/v2，提交的示例使用 schema v2。后者只保存在本机且已被 Git 忽略。

### 本地 Secret

- [`.env.example`](../.env.example) -> `.env`：只在需要环境变量时创建。API key、SMTP password 和 token 只放本机 `.env`、进程环境或 secret store，不写入 JSON/Markdown。

### 按路径提供

- Desktop：Zotero executable（无法自动发现时）和可用的 CLI/JS bridge。
- Web：本机环境中的 Zotero API key；user ID 可选。
- Local：可读的 JSON/JSONL input 和安全、可写的 output root；feedback JSONL 可选。

### 共享领域配置

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

## 真实配置来源清单

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

将 [`config/paperecho.config.example.json`](../config/paperecho.config.example.json) 复制为本机的 `config/paperecho.config.json`，只填写 `common` 和要使用的一条路径。真实配置已被 `.gitignore` 精确忽略。也可用 `--config <path>` 或 `PAPERECHO_CONFIG` 指向其他 JSON 文件；配置中的相对路径均相对于该 JSON 所在目录解析。

统一配置只负责 Runner、路径选择和跨路径运行参数。检索源、筛选规则、翻译与偏好学习的领域参数仍由 `config/rss_sources.json`、`config/pubmed_pmc_search.json`、`config/review-workflow-rules.json`、`config/title_translation.config.json` 和 `config/preference_learning.config.json` 各自管理，不在统一文件中复制。

## 1. 通用/共用配置

| 配置项 | 配置文件字段 | 环境变量 | 必需条件 | 默认值 | Secret | 说明 |
|---|---|---|---|---|---|---|
| schema | `schemaVersion` | - | 始终 | 示例为 `2` | 否 | 支持整数 `1`（兼容）和 `2`（可靠性能力） |
| profile | `profile` | - | 可选 | `standard` | 否 | `standard` 或 `complete` |
| 项目/共享根 | `common.projectRoot` | `ZOTERO_PROJECT_ROOT` | Desktop/Web 输出或 Local 共享索引需要覆盖时 | 当前项目根 | 否 | JSON 值优先于环境变量 |
| LLM 开关 | `common.llm.enabled` | - | 可选 | 路径现有默认 | 否 | `false` 强制禁用；Local 未声明时保持旧默认 `disabled` |
| LLM mode | `common.llm.mode` | `LLM_MODE` | 可选 | 路径现有默认 | 否 | `disabled`、`mock`、`real` |
| 强制真实 LLM | `common.llm.requireRealModel` | CLI `--require-llm` | 明确要求真实模型时 | `false` | 否 | 缺 key 时 preflight 阻塞 |
| 偏好学习 key 引用 | `common.llm.preferenceApiKeyEnv` | 指向的变量，通常 `PREFERENCE_LEARNING_API_KEY` | 真实偏好学习 | - | 引用否/值是 | JSON 只保存环境变量名 |
| 翻译 key 引用 | `common.llm.translationApiKeyEnv` | 指向的变量，通常 `TITLE_TRANSLATION_API_KEY` | 真实标题翻译 | - | 引用否/值是 | JSON 只保存环境变量名 |
| LLM 参数文件 | `common.llm.preferenceConfig` / `translationConfig` | `PREFERENCE_LEARNING_CONFIG_PATH` / `TITLE_TRANSLATION_CONFIG_PATH` | 覆盖默认文件时 | `config/*.config.json` | 否 | 领域参数仍由对应 JSON 管理 |
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
| `rss_sources.json` | `sources[].name/url/enabled` | 缺失为空；`enabled=false` 或空 URL 不运行该条 | `loadRssSources` |
| `pubmed_pmc_search.json` | `databases`、`days_back`、`retmax`、`sort`、`datetype`、`query`、`keyword_groups`，以及受支持的 `adaptive_query` | days_back 10、retmax 300、PubMed/date/pdat；无效值 warning + fallback | `loadPubMedPmcSearchConfig` |
| `openalex_search.json` | `enabled`、`query`、`days_back`、`per_page`、`mailto`、`filters`、`sort`、`select` | 默认 disabled；per_page 最大 200；空 query warning/空结果 | `loadOpenAlexConfig` |
| `review-workflow-rules.json` | `triage`、`llm_review`、`manual_standard_evaluation`、`feedback_learning` | 缺失用代码内保守规则；解析错误失败 | `loadWorkflowRules`、classifier、quality gate、feedback learning |
| `title_translation.config.json` | endpoint/model、temperature/top_p、stream/thinking、timeout/retries、batch/concurrency、user_id、fallback、rate_limit、prompt | 字段缺失/非法时使用代码默认；API key 只来自环境 | `title_translation_support.mjs` |
| `preference_learning.config.json` | endpoint/model、sampling、stream/thinking、timeout/retries/tokens、user_id、response format、prompt、key fallback order | 字段缺失/非法时使用代码默认；首选 preference key、再用 translation key | `preference_learning_support.mjs` |
| 两个 prompt Markdown | prompt text 与 `${sourceText}` 等既有占位 | 使用领域 config 指向的文件 | 对应 LLM owner |
| `screening_standards.md` | 用户长期筛选边界与理由 | 缺失初始化中文基线；是长期标准唯一来源 | Stage1 preference learning |

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
