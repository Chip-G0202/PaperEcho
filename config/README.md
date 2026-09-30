# 用户可编辑配置

日常配置推荐使用 [PaperEcho Control Center](../docs/control-center.md) 的 Settings。schemaVersion 3/4/5/6 的 `config/paperecho.config.json` 是非敏感 application configuration 的 canonical owner。Settings 的固定字段 registry 仍由 `workflow/tools/lib/control_config_service.mjs` 管理，共享解析层为 `workflow/tools/lib/application_config.mjs`；Runner 继续由 `workflow/tools/runner/config_loader.mjs` 解析运行路径。保存只更新 canonical owner，不同步写回旧领域 JSON。

## v6 与旧版本迁移

translation（标题翻译）与 preference（智能评审/偏好学习）仍是独立 capability，可分别设置模型、endpoint、temperature 等。Research Feedback 与普通 Runner 使用同一 Settings 配置。单次 Runner 调用可显式传入 `--preference-config <file>` 或 `--translation-config <file>`；覆盖只影响该 invocation，不写回 Settings，下一次普通调用恢复 canonical 配置。

非敏感配置按显式 invocation override → canonical → legacy compatibility/defaults 解析。迁移前沿用 v1/v2 的优先级；迁移会把旧模型配置和 legacy non-secret env 的有效值固化进相应 section。迁移后，旧模型 env 不再覆盖 Settings。运行路径的现有 CLI 语义和执行期控制参数保持不变。

在目标项目使用 `node workflow/tools/maintenance/migrate_application_config.mjs --root <项目根目录>`。集中 migration owner 为 `workflow/tools/lib/application_config_migration.mjs`，支持无主配置及 schema v1/v2/v3/v4/v5 → v6；重复迁移当前 v6 不写入，未知未来 schema 拒绝处理。v1/v2 迁移读取指定根下的 `.env`，外部环境优先；secret 值不进入主配置或迁移 metadata。v3/v4 升级只读取 canonical 配置，保留 Email/SMTP 与其他领域值，v3 补齐默认开启的 Radar/Weekly 通知偏好；v5 增加 `common.notifications.channels.qq: { enabled: false }`，不生成凭据或目标占位值。原主配置保留为固定 `.v3-backup` / `.v4-backup`。v3 安装只保存 Email/事件设置仍兼容升级到 v4；保存 QQ 设置则通过集中升级函数进入 v5。

迁移先构造并校验 candidate，保留旧领域文件，将原主配置保留为固定 `.legacy-backup`，再临时写入、回读校验并原子替换。备份冲突或校验/写入失败时不替换原主配置。最小迁移 metadata 位于主配置 `migration`，只包含版本、结果、来源类别和时间。尚未迁移的安装保留 legacy compatibility；迁移成功后旧 JSON 仅作为保留的迁移来源，不再正常写入。

SecretService、受管 `.env` 和 external secret environment 保持独立，外部 secret 优先；GET 只返回配置状态。Runtime/User State（feedback、建议及其决策历史、ledger、receipt、queue、reports、logs）不进入主配置。长期研究规则正文继续由 `screening_standards.md` 管理，prompt Markdown 也保持独立；结构化机器规则进入 `review` section。

Credentials 继续由环境/项目 `.env` 管理，网页支持 allowlist 本地凭据的状态、Replace、Clear，绝不回显原值；外部环境覆盖时只读。SecretService 保留其他 entries，严格检查可支持的单行格式后原子写入；不支持的格式保持原文件。Email/QQ/微信/飞书/企业微信群机器人显式测试由 Channel Service 复用正式发送链路，其他凭据不提供连接测试。缺少既有配置文件时页面显示“尚未初始化”；首次保存通知设置通过集中迁移建立 canonical 配置。Weekly 调度间隔只读；PubMed keyword groups 由现有 owner 生成 query，不能通过 raw query 绕开它。

## 通知偏好与出站渠道

Settings → 通知与推送分别提供通知偏好、邮箱、QQ、微信、飞书、企业微信群机器人、凭据。`common.email.enabled` 是唯一 Email channel 开关；SMTP 普通参数仍在 `common.email.smtp`，密码仍由 SecretService 管理。QQ 的非敏感字段为 `common.notifications.channels.qq.enabled/appId/targetType/targetId`；`targetType` 为 `user` 或 `group`，目标是该机器人对应的 OpenID，不是 QQ 号码。AppSecret 仅由 SecretService / 环境中的 `QQ_BOT_APP_SECRET` 管理。事件偏好独立存于 `common.notifications.radar.enabled` / `weekly.enabled`，既有 failure/health 偏好及默认值保持原 owner。`workflow/tools/notification/policy.mjs` 解析是否需要 delivery；渠道或事件关闭时业务正常完成，不产生新的 notification operation 或待恢复发送。

`workflow/tools/lib/control_notification_service.mjs` 是通知渠道 application contract owner，返回 enablement、配置完整/不完整/错误、凭据配置/可写状态及脱敏的最近回执状态。配置完整不表示已经验证 SMTP 连接。显式测试允许在 Email 关闭时执行，不启用渠道，不运行论文流程，不写业务 ledger；使用 shared content、Email renderer/layout、原 delivery/receipt 与 SMTP transport。测试回执由原 receipt schema 保存在 receipt root 的 `tests/<requestId>.json`；同一请求沿用 accepted/unknown 不重复发送契约，并限制并发测试。最近发送状态读取原 Weekly/Radar/test receipts，不另建通知历史库。

同一 Channel Service 也负责 QQ readiness、测试和最近状态；QQ 配置完整不等于 provider 已验证。QQ 测试允许渠道关闭时显式发送，回执位于同一 receipt root 的 `tests/qq/<requestId>.json`。业务共用 NotificationContent，由 `notification/channel_delivery.mjs` 分发给既有 Email 路径与 QQ renderer/transport；每个 event/channel 独立 identity、receipt 与 ledger operation。历史无 channel 字段的回执仍按 Email 解释，Email identity 不变。部分通知失败不会回滚 v5 业务成功；正式 `--resume` 只重试失败渠道，accepted 不重发，unknown 保持 fail-closed，恢复不重跑检索、评级、Zotero 或导出。v5 SMTP 不完整是渠道问题，不阻断业务/QQ 的 preflight。

QQ 仅使用官方主动单聊/群聊文本 API，AppID/AppSecret 换取内存 access_token，不运行 inbound/WebSocket daemon。证据：[认证](https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/access-token.html)、[主动消息及频率限制](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)、[单聊](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html)、[群聊](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)。用户可关闭主动消息权限；目标/权限/额度由 provider 决定。没有官方主动发送幂等参数，因此不确定结果不能靠再次发送确认。

QQ renderer 使用获准的 **PaperEcho 产品预算 5000 UTF-8 字节**，保留标题/日期、摘要及 canonical 文献前缀，省略时标明剩余文献数；只生成单条文本。依据是[腾讯官方 SDK](https://github.com/tencent-connect/qqbot-nodejs/blob/main/src/protocol/utils/text-chunk.ts) 的“约 5000 字符”说明；**provider 硬上限、计量单位及真实边界仍未验证**，本地预算测试不代表平台边界验收。

v6 集中迁移保留 Email/QQ，新增 `common.notifications.channels.wechat/feishu/wecom: { enabled: false }`；当前 v6 再迁移不写入。支持旧版本到 v6，v5 原配置保存为固定 `.v5-backup`。微信非敏感字段为 `wechat.enabled/uid`，UID 默认遮罩；飞书、企微仅保存 `enabled`。`WXPUSHER_APP_TOKEN`、`FEISHU_WEBHOOK_URL`、可选 `FEISHU_SIGNING_SECRET`、`WECOM_WEBHOOK_URL` 只经 SecretService / secret environment，不能写入 canonical JSON。

`stage5/notification_content.mjs` 唯一投影 Radar/Weekly 业务内容：稳定 ID、既有顺序、最终 grade、标题/译文、期刊/年份/来源和既有推荐理由。`radar_report.mjs`、`report_summary.mjs`（Email，复用 `email_layout.mjs`）及 `notification/*_renderer.mjs` 只负责 presentation；不筛选、排序、评分或调用 LLM。受长度限制时只能 canonical prefix + 剩余数量。`notification/channels.mjs` 集中渠道注册，`channel_delivery.mjs` 负责 fan-out，SMTP / QQ / WxPusher / 飞书 / 企微薄 transport 负责发送。

微信是 **WxPusher 标准 API → 用户 UID → 用户在 WxPusher 客户端绑定的微信 ClawBot**；PaperEcho 不实现 ClawBot 入站或激活。按[官方规则](https://github.com/wxpusher/wxpusher-docs)，每次激活后 24 小时最多 10 条 ClawBot 推送，到期或用完需用户回复任意消息重新激活。配置完整不代表绑定、激活或送达。官方 content 原文限制为 40000 字符与 65535 UTF-8 字节，转换后 HTML 也有字节限制；PaperEcho 采用 `contentType: 1` text、每段 8000 字节、每事件 24000 字节预算，按段落与 Unicode grapheme 安全分段。

飞书使用[官方自定义机器人](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)富文本 `post` 与可选 HMAC-SHA256 签名；产品预算 6000 文本字节、含签名 request 16 KiB。企业微信明确为[群机器人](https://developer.work.weixin.qq.com/document/path/91770)，采用 text：官方上限 2048 UTF-8 字节，产品预算 1800。两种 Webhook 均严格限制官方域名、路径和格式，拒绝 redirect、任意地址、userinfo、额外 query 和 fragment。

所有渠道复用 `notification/delivery.mjs`、`stage5/email_receipt.mjs` 与 `recovery/notification_recovery.mjs`：event + channel 独立 receipt/ledger，accepted 不重发、unknown hold，partial failure 不回滚业务成功，正式 `--resume` 只恢复失败渠道，不重跑检索/评级/Zotero/导出。微信逐段保存 attempt/status/sendRecordId，已接受段不重发；UID/Webhook 不进入 receipt，只保存目标 hash。关闭渠道可显式测试，测试不启用渠道；成功只说明 API 接受，无实际送达证明。

Hermes / Agent / Scheduler 只启动固定 launcher 的 `--run --scheduled-daily`；PaperEcho 自己选择 Radar/Weekly，执行业务并构造、发送通知。无需入站命令、Remote Control、OpenClaw Agent、公开 receiver 或后台 polling daemon。

## Config map

下面的 owner 路径相对 `workflow/tools/`。网页写入统一经过 `lib/control_config_service.mjs`，领域 owner 通过共享解析层取得旧格式的内存对象；“可编辑”不表示所有字段都开放给网页。v3 section 映射为：`source_selection.json` → `sources`、`rss_sources.json` → `rss`、`pubmed_pmc_search.json` → `pubmed`、`openalex_search.json` → `openalex`、`review-workflow-rules.json` → `review`、`title_translation.config.json` → `translation`、`preference_learning.config.json` → `preference`。`common`、`desktop`、`web`、`local` 保留既有字段名，Weekly 间隔存于 `weekly.intervalDays`。以下旧文件名用于字段语义和迁移对照，迁移后的编辑目标是主配置中的相应 section。

| Config | Purpose | 领域 owner | Control Center section | User-editable? | Secret? | Compatibility notes |
|---|---|---|---|---|---|---|
| `paperecho.config.example.json` → 本地 `paperecho.config.json` | mode、运行根、Radar/Integrity、邮件与 Zotero 非密钥参数 | `runner/config_loader.mjs`、`lib/runtime_config.mjs` | 常规、Radar、Weekly、Integrity、Zotero、通知 | 是；示例不作为实际配置保存目标 | 否 | 使用启动时解析的配置路径；mode/根路径属高级设置，Weekly 间隔只读 |

每日计划入口 `--run --scheduled-daily` 仅适用于 Desktop/Web。`profile: standard` 或 `complete` 指定到期 Weekly 的执行模式；是否到期由成功 Weekly 的北京时间 15:00 计划时隙决定。`common.radar.enabled` 只在 Radar 日检查，关闭 Radar 不会把当天改成 Weekly。正式间隔为 7 天；手动运行、force 参数和本地 Local 路径不属于此入口。
| `source_selection.json` | 研究领域与来源策略 | `stage1/source_selection_step.mjs` | 研究与检索 / 来源 | 是 | 否 | 网页管理 domain/override；高级策略字段随 section 迁移 |
| `pubmed_pmc_search.json` | 检索词组、时间和数量限制 | `lib/literature_config.mjs`、`stage1/retrieval_sources.mjs` | 研究与检索 / 检索条件 | 是 | 否 | keyword groups 由 owner 生成 query，不绕过现有规则 |
| `openalex_search.json` | query、启用、时间与分页限制 | `stage1/retrieval_sources.mjs` | 研究与检索 / 检索条件 | 是 | 否 | 额外 filters/select 等高级字段仍保留 |
| `rss_sources.json` | RSS 列表 | `lib/literature_config.mjs`、`stage1/retrieval_sources.mjs` | 研究与检索 / RSS | 是 | 否 | 网页支持增改、禁用、删除及 URL 校验 |
| `review-workflow-rules.json` | 规则、复审、反馈学习 | `lib/literature_config.mjs`、Stage1 分级/学习 owner | 排序与复审 | 是 | 否 | 网页管理常用开关/批大小；完整规则不等于通用 JSON 编辑器 |
| `title_translation.config.json` | 翻译模型非密钥参数 | `lib/title_translation_support.mjs` | 模型、高级 | 是 | 否 | v3 使用 translation section；prompt 独立 |
| `preference_learning.config.json` | 研究评价/偏好模型参数 | `lib/preference_learning_support.mjs` | 模型、高级 | 是 | 否 | Web 文本和 DOCX 评价共享核心；复审/综述复用该模型配置 |
| `prompt-title-translation.md`、`prompt-preference-learning.md` | 提示词模板 | 对应 translation/preference owner | 未开放 | 高级手动编辑 | 否 | 保留模板变量与既有格式，不填 API key |
| `example-force-run.cmd` | 历史强制运行命令示例 | 直接调用 `stage0/main.mjs` | 未开放 | 仅维护参考 | 否 | 绕过 Runner，非推荐交互入口；维护调用者须自行承担预检/验证，普通运行走路径 launcher |
| 根 `.env.example` → `.env` | 本机凭据与环境覆盖 | `lib/env_file_bootstrap.mjs`、`lib/control_credentials_service.mjs` | 凭据 | allowlist Replace/Clear；外部覆盖只读 | 本地 `.env` 是；示例不含真实值 | 不回显；不进入 git，Test 暂不开放 |

以下是 legacy 字段参考；v3 日常配置以 Settings 和对应 canonical section 为准。

- `.env` 只放本机密钥和少数真正需要环境注入的本机覆盖；已经在本目录 JSON 中声明的非密钥参数不要再复制到 `.env`。
- `rss_sources.json`: RSS 订阅源列表。
- `pubmed_pmc_search.json`: PubMed/PMC 检索条件，默认 `days_back` 为 10。
- `review-workflow-rules.json`: 分级标签、关键词、权重、阈值、期刊白名单和 feedback 语义搜索规则说明。
- `title_translation.config.json`: 标题翻译的非密钥参数。
- `preference_learning.config.json`: Web 研究评价与 legacy DOCX 中文评价理解的非密钥参数；密钥优先读 `PREFERENCE_LEARNING_API_KEY`，缺省回退到 `TITLE_TRANSLATION_API_KEY`。

长期筛选标准正文位于配置解析出的 review root 下 `screening_standards.md`（默认 `review_results/文献评价/`）。日常入口推荐 Control Center；`screening_standards.docx` 保留为兼容人工入口，包含偏好规则、检索关键词和评价三部分。
## review-workflow-rules.json 顶层 section

- 	riage：分级/筛选规则（标签、研究重点、优先级规则、分级规则、期刊质量筛选）
- llm_review：LLM 复审配置（启用/批大小/缓存等）
- manual_standard_evaluation：人工标准评价配置
- eedback_learning：反馈学习配置

## source_selection.json

研究领域驱动的检索源选择配置。根据 research_domain 字段决定运行时启用哪些检索源，而不是默认所有源一起跑。

**字段说明：**
- research_domain: 研究领域，可选值：
  - biomedical: 生物医学/临床医学/药学/公共卫生/生物学 -> 默认 PubMed/PMC + RSS
  - non_biomedical_stem: 传统理工/计算机/工程/材料/化学/物理/数学 -> 默认 OpenAlex + RSS
  - education_social_science: 教育/社科/管理/人文/经济/心理 -> 默认 OpenAlex + RSS
  - mixed_biomedical_technical: 混合领域 (medical AI / bioinformatics / health education) -> 显式启用 PubMed/PMC + OpenAlex + RSS
  - unknown: 未知/信息不足 -> 仅 RSS，需人工确认
- domain_options: 各领域的默认配置
- override_enabled_sources: 覆盖启用的源列表（数组），设置后优先级高于领域默认配置
- require_manual_confirmation: 是否需要人工确认（boolean）

**使用方式：**
1. 根据研究方向修改 research_domain
2. 非医学方向切换到 non_biomedical_stem 或 education_social_science
3. 混合领域必须显式设置为 mixed_biomedical_technical
4. 如需完全自定义检索源，使用 override_enabled_sources 字段

## openalex_search.json

OpenAlex works 检索配置。OpenAlex 不要求 API key，可通过 mailto 参数获得更高速率限制。

**字段说明：**
- enabled: 是否启用 OpenAlex 检索（boolean）
- query: 检索词（string）
- days_back: 检索近 N 天的文献（默认 10）
- per_page: 每页返回数量（默认 50，最大 200）
- mailto: 可选邮箱地址，用于获得更高速率限制
- filters: 过滤条件
  - type: 文献类型（默认 "article"）
  - is_oa: 是否仅开放获取（null/true/false）
  - from_publication_date: 起始日期
  - to_publication_date: 结束日期
  - concepts: 概念 ID 列表
- sort: 排序方式（默认 "relevance_score:desc"）
- select: 返回字段

**使用方式：**
1. 设置 enabled: true 启用 OpenAlex
2. 填写 query 检索词
3. 可选填写 mailto 获得更高速率限制
4. 确保 source_selection.json 中 enabled_sources 包含 "openalex"

**注意：**
- disabled 或空 query 时安全返回空结果，不影响其他源
- 不要填写真实邮箱地址
