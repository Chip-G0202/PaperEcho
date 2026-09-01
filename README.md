# PaperEcho

一个面向多学科研究的文献工作流：持续发现、筛选和整理新文献，并按需交付到 Zotero 或本地报告。

[快速开始](#快速开始) | [V2.3 更新](#更新内容) | [目录结构](#目录结构) | [English](#english-version)

## 这是什么

> **听见文献回声，找到值得追随的研究线索。**

新的文献不断出现，重要的不只是收集得更多，还要从持续更新的信息中，及时发现与自己研究相关的变化。

PaperEcho 是一套面向长期科研工作的文献追踪与整理工具。它持续获取新文献，完成去重、筛选、分级和整理，再将结果写入 Zotero 或生成本地报告，让值得关注的研究不被信息流淹没。

你可以选择 Zotero Desktop、Zotero Web API，或者完全脱离 Zotero 的 Standalone Local 路径；也可以根据研究方向配置 OpenAlex、PubMed/PMC、RSS 或本地数据。

PaperEcho 不替代研究者作出判断。它负责整理不断传来的文献回声，把更多时间留给阅读、思考，以及下一步研究。

## 更新内容

**PaperEcho V2.3** 新增 Daily Radar、Weekly 接管与文献完整性监测，同时沿用同一套身份、恢复和安全更新边界。

- **Daily Radar 每天发现重要变化。** 默认按 Asia/Shanghai 每天 15:00 决策，周末和节假日照常；Weekly 到期日由 Weekly 接管。Radar 使用独立 watermark，只发现、判断和提醒，不写 Zotero，也不生成 XLSX。urgent A 依赖可靠 grading；LLM 不可用时进入独立 review backlog，不使用 rule-only 结果告警。
- **Weekly 安全接管 Radar 队列。** Weekly 保持自己的 retrieval，并按 canonical identity 合并 urgent queue、review backlog 与本轮候选。classification fingerprint 变化或缺失会重新 grading；claim 不等于 consume，只有 Zotero 写入及 operation ledger 验证后才消费队列。恢复执行不会重复创建，周报只使用 verified business writes。
- **监测撤稿、更正和关注声明。** 监测范围仅包括 shared index 中仍存在于 Zotero 且有 DOI 或 PMID 的文献；证据只来自 Crossref REST 和 PubMed structured relations，不按标题或自由文本猜测。撤稿先验证加入 `文献池/待删除`，再移除其他 PaperEcho-managed collection ID；用户集合、标签、item 和附件保留。更正与关注声明只追加状态标签，完整性变化仅进入 Weekly summary。
- **安全升级边界延续到 V2.3。** `paperecho-update` 可从 V2.2 安全升级；Radar 与 Integrity 运行状态属于 persistent/protected，用户 `.env`、配置、state、ledger 和 receipt 不会被发布文件覆盖。

本版本已通过本地定向测试、no-write/no-XLSX、crash/resume、updater fixture，以及 Crossref/PubMed 生产接口只读验收。真实 Zotero 写入、真实 SMTP、真实 LLM Radar、长期 OS scheduler 和长期 rate-limit 环境尚未验收。V2.3 仍不包含 PDF 下载、全文阅读或内容总结。

### V2.2

**PaperEcho V2.2** 聚焦三条路径的可验证性能改进，并新增安全更新能力。

- **Web 路径显著减少 Zotero 请求。** 固定 cold benchmark 的总请求从 511 降至 263，其中读取从 489 降至 248、写入从 22 降至 15；候选数量、业务结果和副作用计划保持一致。
- **Local 热点更快。** Local upsert 的 cold/warm hotspot 分别改善约 39.5% 和 65.8%。这是局部热点收益，不代表整条 Local 路径获得同等比例提升；Desktop 没有发现值得承担风险的稳定热点，因此没有强行修改。
- **外部调用具备受控自适应并发。** Source HTTP、LLM 和 Zotero Web API 分别使用独立的有界控制器，遇到 429、`Retry-After`、`Backoff`、连续失败或延迟恶化时降低并发，恢复时缓慢增加且不超过原有安全上限。
- **新增安全更新 Skill。** `paperecho-update` 只从官方 `Chip-G0202/PaperEcho` 选择最新 stable tag，不跟随 `main`。check 默认不写入，apply 必须显式执行；用户配置、secret、运行状态和输出受保护，managed 本地修改或活动任务会阻塞升级，目标版本先在 staging 验证，失败时执行并验证 rollback。

V2.2 不改变检索、分级、Zotero 写回、恢复、通知和报告语义，也不包含每日 Radar、Weekly queue merge、撤稿/勘误监测、PDF 下载或全文分析。

### V2.1

**PaperEcho V2.1** 聚焦检索、写入和通知过程的可靠性，让长期自动运行更不容易漏文献、重复操作或覆盖人工修改。

- **文献获取更完整。** RSS 2.0/Atom 改用正式 XML 解析并支持 ETag、Last-Modified 和 304；PubMed/PMC 会完整翻页、分批获取详情，并用 EDAT/CRDT 重叠窗口降低延迟收录造成的遗漏；OpenAlex 会沿 cursor 取完结果，并为免费接口保留日期重叠。
- **检索进度更安全。** 每个来源和查询分别保存进度；只有完整分页和本次检索记录安全落盘后才推进水位，部分失败不会把未完成的结果误记为成功。
- **失败后可以接着运行。** 通过原 launcher 使用 `--resume <runId>` 可从持久化任务记录恢复。PaperEcho 会先核对 Zotero、索引和已生成文件，已经完成且仍有效的操作不会重复执行；遇到人工修改或版本冲突时不会直接覆盖。
- **通知更可信。** Stage1–4 中途失败也可独立通知；无法确认邮件是否送达时会保守记录，不会假装成功或默认重复发送。来源或 LLM 连续两次异常才告警，恢复后只通知一次。
- **老配置继续可用。** schema v1 保持原有行为；schema v2 提供新的可靠性配置，新增通知默认关闭，Radar 不会自动启用。

V2.1 不包含每日 Radar、Weekly queue merge、撤稿/勘误监测或 PDF/全文功能；Desktop/Web/Local 性能优化见上方 V2.2。

### V2.0

**PaperEcho V2.0** 面向不同的研究环境，扩展了运行方式，也补齐了长期自动运行所需的能力。

- **从单一 Zotero Desktop 扩展为三条路径。** 原有的 Desktop 工作方式继续保留；新增的 Zotero Web API 路径无需保持桌面客户端运行；Standalone Local 则完全脱离 Zotero，通过本地 JSON/JSONL 和报告文件完成处理与交付。
- **Desktop 从 MCP 迁移至 CLI。** Desktop 减少了中间通信，Web 直接使用 Zotero Web API，Local 在本地独立运行。三条路径共用核心工作流，不再依赖 MCP。
- **新增邮件通知。** 工作流完成后可按需发送运行结果和报告附件，周期任务结束后不必再手动查看。
- **加入定期清理，并优化整体性能。** PaperEcho 会清理到期的临时运行产物，同时通过批量读写、减少重复调用和缩短执行链路提升效率。

## 核心特色

| 特色 | 说明 |
| --- | --- |
| Zotero Desktop | 继续使用本机 Zotero 文献库，通过 CLI 完成文献写入和整理。 |
| Zotero Web API | 连接 Zotero 云端文献库，无需保持桌面客户端运行。 |
| Standalone Local | 完全脱离 Zotero，通过本地文件完成文献处理和报告交付。 |
| 多学科文献发现 | 根据研究领域组合 OpenAlex、PubMed/PMC、RSS 或本地文献数据，并完整处理分页和重叠查询边界。 |
| 自动去重与分级 | 识别重复文献，完成 A/B/C/D 分级，把需要判断的内容留给研究者。 |
| Zotero 写回 | Desktop 和 Web 路径支持集合整理、批量写入和标题翻译回填。 |
| 本地独立交付 | Local 路径使用 JSON/JSONL 输入，在本地完成处理并生成报告。 |
| 反馈持续学习 | 将文章反馈和长期筛选标准用于后续筛选，减少重复调整。 |
| 任务恢复 | 中途失败后可按 runId 继续，并在恢复前核对已完成操作和人工修改。 |
| 报告与邮件 | 生成周报和到期月报；既可发送完成通知，也可在 Stage1–4 失败时按配置告警。 |
| 自动维护 | 定期清理到期运行产物，同时保护长期配置、反馈和正式报告。 |

## Skills

| Skill | 作用 | 一句话说明 |
| --- | --- | --- |
| `paperecho-workflow` | 共享能力 | 为三条路径提供文献发现、筛选、报告、通知和定期维护。 |
| `paperecho-zotero-desktop` | Zotero Desktop | 适合继续使用本机 Zotero 文献库的用户，通过 CLI 执行读写。 |
| `paperecho-zotero-web` | Zotero Web API | 适合使用 Zotero 云端文献库、无需保持桌面客户端运行的用户。 |
| `paperecho-local` | Standalone Local | 适合不使用 Zotero、希望通过本地文件完成全部处理和交付的用户。 |
| `paperecho-update` | 安全更新 | 检查并部署官方最新 stable release，同时保护配置、状态和用户输出。 |

在 Codex 中选择与你的使用方式对应的 Skill，即可进入相应路径。

## 目录结构

```text
├── README.md
├── LICENSE
├── AGENTS.md
├── .env.example
├── package.json
├── package-lock.json
├── config/
│   ├── paperecho.config.example.json
│   ├── rss_sources.json
│   ├── pubmed_pmc_search.json
│   ├── source_selection.json
│   ├── review-workflow-rules.json
│   ├── title_translation.config.json
│   ├── preference_learning.config.json
│   └── README.md
├── docs/
│   ├── configuration.md
│   ├── paperecho-setup-template.md
│   ├── contract-workflow.md
│   ├── contract-writeback.md
│   ├── contract-export.md
│   └── ...
├── skills/
│   ├── paperecho-workflow/
│   ├── paperecho-zotero-desktop/
│   │   └── scripts/run.mjs
│   ├── paperecho-zotero-web/
│   │   └── scripts/run.mjs
│   ├── paperecho-local/
│   │   └── scripts/run.mjs
│   └── paperecho-update/
│       └── scripts/update.mjs
├── tests/
│   ├── full_workflow_benchmark/
│   └── helpers/
└── workflow/
    ├── tests/
    └── tools/
        ├── runner/
        │   ├── main.mjs
        │   ├── config_loader.mjs
        │   ├── preflight.mjs
        │   └── result_validation.mjs
        ├── stage0/main.mjs
        ├── local/main.mjs
        ├── stage1/
        ├── stage2/
        ├── stage3/
        ├── stage4/
        ├── stage5/
        ├── maintenance/
        └── lib/
```

## 快速开始

### 1. 准备环境

安装 Node.js >= 18、npm 和 PowerShell 7 (`pwsh`)。如果选择 Desktop 路径，还需要 Zotero Desktop；如果选择 Web 路径，需要 Zotero API key；Local 路径无需 Zotero。

### 2. 下载并安装依赖

```bash
git clone https://github.com/Chip-G0202/PaperEcho.git
cd PaperEcho
npm install
```

### 3. 创建本地配置

```powershell
Copy-Item config/paperecho.config.example.json config/paperecho.config.json
Copy-Item .env.example .env
```

在 `config/paperecho.config.json` 中选择 Desktop、Web 或 Local，并按研究领域配置 OpenAlex、PubMed/PMC、RSS 或本地输入。API key、SMTP 密码等 secret 只写入本机 `.env`。完整字段见 [`docs/configuration.md`](docs/configuration.md)。

### 4. 检查并运行

在 Codex 中使用对应的路径 Skill：

```text
使用 $paperecho-zotero-desktop，读取 config/paperecho.config.json，先检查配置，再运行完整流程。
使用 $paperecho-zotero-web，读取 config/paperecho.config.json，先检查配置，再运行完整流程。
使用 $paperecho-local，读取 config/paperecho.config.json，先检查配置，再运行本地流程。
```

也可以直接检查选定路径：

```powershell
node skills/paperecho-zotero-desktop/scripts/run.mjs --check --config config/paperecho.config.json
node skills/paperecho-zotero-web/scripts/run.mjs --check --config config/paperecho.config.json
node skills/paperecho-local/scripts/run.mjs --check --config config/paperecho.config.json
```

检查通过后，将所选命令中的 `--check` 改为 `--run`。

检查官方 stable 更新可使用 `$paperecho-update`，或运行：

```powershell
node skills/paperecho-update/scripts/update.mjs --check --json
```

只有明确需要部署且检查结果为 `safeToApply=true` 时，才将 `--check` 改为 `--apply`。

## 支持项目

如果 PaperEcho 帮你减少了重复筛选、整理和汇报的时间，可以请我喝杯咖啡，或随手赞赏支持后续维护。

<img width="600" alt="Support PaperEcho" src="https://github.com/user-attachments/assets/a30216d0-9bde-4be5-8c9f-216b08ec3b98" />

## 付费安装配置与研究方向配置包

PaperEcho 本身采用 MIT License，你可以自由下载、修改和自部署。付费服务面向希望节省配置时间、快速落地三路径工作流，或希望为特定研究方向准备筛选配置的用户。

联系信息：g2269204031@163.com

### 定制安装配置服务

适合希望尽快把流程跑起来，但不想自行处理运行环境和配置细节的用户。

- Node.js、PowerShell、Zotero 与路径依赖检查
- Desktop、Web 或 Local 路径选择与统一配置
- `.env`、标题翻译、偏好学习和 SMTP 配置
- Codex 定时任务、运行前检查与首次运行排查

### 研究方向配置包

适合已有明确研究方向，希望获得一套可维护、可审计配置模板的用户。

- OpenAlex、PubMed/PMC、RSS 与本地数据源策略
- A/B/C/D 分级规则与边界设计
- `screening_standards.md` 初始结构
- 标题翻译、偏好学习、周报/月报和自动化运行清单

## 免责声明

本项目用于文献检索、信息整理、研究筛选与学术写作辅助，不替代专业研究判断、同行评议或对原始文献的核查。

自动分级、翻译和 AI 生成内容仅供参考。涉及医学、法律、工程安全或其他高风险领域时，不应将 PaperEcho 的输出直接作为诊断、决策或操作依据。

## License

MIT License. See [LICENSE](LICENSE).

---

# English Version

# PaperEcho

A multidisciplinary literature workflow for continuously discovering, screening, and organizing research, with delivery to Zotero or local reports.

[Quick Start](#quick-start) | [Update](#update) | [Support](#support-the-project) | [License](#license-1)

## What is this?

> **Hear the echoes of research. Find the signals worth following.**

New papers arrive constantly. The challenge is not simply collecting more of them, but noticing which changes matter to your research.

PaperEcho is a literature tracking and organization tool for long-term research. It continuously collects new literature, removes duplicates, screens and grades results, then writes them to Zotero or produces local reports so relevant work is less likely to disappear into the stream.

Choose Zotero Desktop, Zotero Web API, or the fully independent Standalone Local path. Sources can include OpenAlex, PubMed/PMC, RSS, or local data, depending on the research field.

PaperEcho does not make research judgments for you. It handles the recurring organization work, leaving more time for reading, thinking, and deciding what to study next.

## Update

**PaperEcho V2.3** adds a daily Radar, verified Weekly takeover, and structured literature-integrity monitoring while preserving the existing identity, recovery, and update boundaries.

- **Daily Radar:** runs on the 15:00 Asia/Shanghai decision slot, including weekends and holidays, while Weekly takes over on due days. Radar has an isolated watermark and performs discovery, grading, and notification only—no Zotero or XLSX writes. Unavailable LLM grading goes to a separate review backlog rather than producing a rule-only urgent alert.
- **Verified Weekly takeover:** Weekly keeps its own retrieval and merges Radar queue/backlog entries by canonical identity. Changed or missing classification fingerprints trigger regrading. A claim is consumed only after verified Zotero and ledger evidence; resume does not duplicate creation, and reports use verified business writes.
- **Structured integrity monitoring:** only active Zotero records with a DOI or PMID are checked through Crossref REST and PubMed structured relations. Retractions are verified into `文献池/待删除` before other PaperEcho-managed memberships are removed. User collections, tags, items, and attachments remain intact; corrections and expressions of concern use additive tags.
- **Safe V2.2 → V2.3 updates:** Radar and integrity runtime state remain persistent/protected alongside user configuration, state, ledgers, and receipts.

Local targeted tests, no-write/no-XLSX behavior, crash/resume, updater fixtures, and read-only production Crossref/PubMed parsing have been validated. Real Zotero writes, SMTP, LLM Radar, long-running OS scheduling, and sustained real-world rate limits remain unverified. V2.3 does not include PDF download, full-text reading, or content summarization.

### V2.2

**PaperEcho V2.2** focuses on measurable performance improvements across the three paths and adds a safe update mechanism.

- **Fewer Zotero requests on Web:** the fixed cold benchmark drops from 511 total requests to 263, with reads reduced from 489 to 248 and writes from 22 to 15, while preserving candidate volume, business output, and side-effect plans.
- **A faster Local hotspot:** Local upsert improves by about 39.5% cold and 65.8% warm. These are hotspot gains rather than equivalent end-to-end speedups. Desktop showed no stable, low-risk hotspot worth forcing into this release.
- **Bounded adaptive concurrency:** Source HTTP, LLM, and Zotero Web API use independent controllers that reduce concurrency on 429, `Retry-After`, `Backoff`, repeated failures, or sustained latency degradation, then recover gradually without exceeding existing safety caps.
- **Safe official updates:** `paperecho-update` selects only the latest stable tag from `Chip-G0202/PaperEcho` and never follows `main`. Checks are read-only by default; apply is explicit. User configuration, secrets, runtime state, and outputs are protected, while managed-file drift or an active run blocks deployment. Targets are validated in staging and critical failures trigger verified rollback.

V2.2 preserves retrieval, grading, Zotero writeback, resume, notification, and reporting semantics. It does not add daily Radar, weekly queue merging, retraction/correction monitoring, PDF downloads, or full-text analysis.

### V2.1

**PaperEcho V2.1** focuses on reliable retrieval, recovery, and notification for long-running workflows.

- **More complete retrieval:** RSS 2.0/Atom now uses a proper XML parser with ETag, Last-Modified, and 304 support. PubMed/PMC exhausts result pages, fetches details in batches, and uses overlapping EDAT/CRDT windows. OpenAlex follows cursor pagination and retains an overlapping publication-date window for the free API path.
- **Safer progress tracking:** source progress is isolated by source and query, and advances only after complete pagination and durable retrieval artifacts. Partial failures do not falsely advance the boundary.
- **Resume after failure:** run the original launcher with `--resume <runId>`. PaperEcho verifies existing Zotero changes, indexes, and generated files before deciding what still needs to run, and reports conflicts instead of overwriting manual edits.
- **More trustworthy alerts:** Stage1–4 failures can notify independently of Stage5. Ambiguous mail outcomes are not reported as successful or automatically resent. Source or LLM degradation alerts only after two consecutive observations, with one recovery notice.
- **Backward-compatible configuration:** schema v1 keeps its existing behavior; schema v2 exposes the reliability settings, while new notifications and Radar remain off by default.

V2.1 does not include daily Radar, weekly queue merging, retraction/correction monitoring, or PDF/full-text features. The Desktop/Web/Local performance work is described above under V2.2.

### V2.0

**PaperEcho V2.0** adds new ways to run the workflow and the maintenance features needed for long-term automation.

- **From one Zotero Desktop path to three paths:** the original Desktop workflow remains available, joined by a Zotero Web API path that does not require the desktop client to stay open and a Standalone Local path that works entirely through local JSON/JSONL files and reports without Zotero.
- **A more direct execution model:** Desktop moves from MCP to CLI, Web connects directly through the Zotero Web API, and Local runs independently on the filesystem. All three share the same core workflow without depending on MCP.
- **Email notification:** completed runs can send result notifications and report attachments when requested.
- **Scheduled cleanup and performance improvements:** expired temporary run artifacts are cleaned automatically, while batch operations, fewer repeated calls, and shorter execution paths improve overall efficiency.

## Quick Start

1. Install Node.js 18+, npm, and PowerShell 7+. Desktop also requires Zotero Desktop; Web requires a Zotero API key; Local requires no Zotero installation.
2. Clone the repository and run `npm install`.
3. Copy `config/paperecho.config.example.json` to `config/paperecho.config.json` and `.env.example` to `.env`. Choose one path and configure OpenAlex, PubMed/PMC, RSS, or local input for your field.
4. Use `$paperecho-zotero-desktop`, `$paperecho-zotero-web`, or `$paperecho-local` in Codex. Run the selected launcher with `--check`, then change it to `--run` after the check passes.

To check for an official stable update, use `$paperecho-update` or run `node skills/paperecho-update/scripts/update.mjs --check --json`. Use `--apply` only after an explicit update request and a `safeToApply=true` result.

## Support the Project

If PaperEcho saves you time, you can buy me a coffee or send a small appreciation to support continued maintenance.

<img width="600" alt="Support PaperEcho" src="https://github.com/user-attachments/assets/a30216d0-9bde-4be5-8c9f-216b08ec3b98" />

## Paid Setup & Research Direction Packs

PaperEcho is available under the MIT License. Paid support is intended for users who want faster setup or a maintainable direction-specific configuration pack.

Contact: g2269204031@163.com

### Custom installation & setup

Runtime checks, Desktop/Web/Local configuration, secret setup, scheduled Codex tasks, pre-run checks, and first-run troubleshooting.

### Research direction configuration pack

OpenAlex, PubMed/PMC, RSS, and local-source strategy design, A/B/C/D screening rules, screening standards, translation, feedback learning, and recurring report configuration.

## Disclaimer

PaperEcho supports literature discovery, information organization, research screening, and academic writing. It does not replace professional judgment, peer review, or verification against original sources. Its output must not be used directly for medical, legal, engineering-safety, or other high-risk decisions.

## License

MIT License. See [LICENSE](LICENSE).
