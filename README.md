# PaperEcho

一个面向多学科研究的文献工作流：持续发现、筛选和整理新文献，并按需交付到 Zotero 或本地报告。

[快速开始](#快速开始) | [V2.3 更新](#更新内容) | [目录结构](#目录结构) | [English](#english-version)

开发者导航：[Repository map 与测试定位](docs/repository-map.md) · [文档索引](docs/README.md) · [Config map](config/README.md) · [执行约束 AGENTS.md](AGENTS.md)。

## 这是什么

> **听见文献回声，找到值得追随的研究线索。**

新的文献不断出现，重要的不只是收集得更多，还要从持续更新的信息中，及时发现与自己研究相关的变化。

PaperEcho 是一套面向长期科研工作的文献追踪与整理工具。它持续获取新文献，完成去重、筛选、分级和整理，再将结果写入 Zotero 或生成本地报告，让值得关注的研究不被信息流淹没。

你可以选择 Zotero Desktop、Zotero Web API，或者完全脱离 Zotero 的 Standalone Local 路径；也可以根据研究方向组合 OpenAlex、Semantic Scholar、PubMed、Europe PMC、Crossref、RSS 或本地数据。

PaperEcho 不替代研究者作出判断。它负责整理不断传来的文献回声，把更多时间留给阅读、思考，以及下一步研究。

## 更新内容

### Unified Control Center（v2.4 开发版）

推荐通过本地 **PaperEcho Control Center** 浏览最近 Weekly、提交论文反馈和研究评价、处理规则建议与管理常用设置。Windows 在项目目录双击 **PaperEcho.exe**；macOS 双击 **PaperEcho.app**。启动器等待服务就绪后打开默认浏览器，再次双击复用同一工作区实例。仍需已安装 Node.js 18+ 和项目依赖；macOS 包装当前仅通过静态检查，Finder 实机验证待完成。诊断入口及关闭方法见 [启动说明](docs/control-center.md#启动与使用)。

XLSX、`screening_standards.docx` 和直接配置编辑继续作为兼容入口。Credentials 支持本地凭据状态、替换和清除；规则建议只有在正式文件写入成功后才显示为已接受，无法安全定位的变更仍待确认。使用范围与升级边界见 [Control Center 使用与兼容说明](docs/control-center.md)。

### v2.3 稳定基线

**PaperEcho V2.3** 让文献追踪从“每周整理一次”，变成更持续、更可靠的研究工作流：平时发现值得关注的新线索，每周统一整理入库，同时关注已收藏文献的撤稿、勘误等重要变化。

- **每日 Radar，更早发现值得关注的新研究。** 每天轻量扫描，筛出值得及时关注的新文献；正式整理和 Zotero 入库仍由周度流程统一完成，避免日常提醒打乱已有文献库。
- **每周整理更完整，也更可靠。** 每日发现、周度检索和历史待处理结果在正式入库前统一去重、筛选和整理。长流程中断后保留已确认进度，恢复时核对实际状态，尽量避免重复写入或重复整理。
- **持续关注撤稿、勘误和重要状态变化。** 对已经进入文献库的研究，继续检查公开的结构化更新信息；发现重要变化时保守标记和整理，保留用户已有文献和附件，不直接删除。
- **多源检索，降低单一数据库漏召回的影响。** 根据研究领域采用合适的检索方式，组合 OpenAlex、Semantic Scholar、PubMed、Europe PMC、Crossref 等来源补充结果并统一去重。复杂检索不会仅因某个来源返回零条结果，就被当成“没有文献”。
- **长时间任务更可观察、更可控。** Desktop 处理大量历史反馈时持续显示进度，为耗时查询设置安全边界；超时或中断会明确报告未完成并停止后续操作，保留已确认结果，避免把未完成任务误报为成功。

每日 Radar 和文献状态监测可按需启用。PaperEcho 不包含 PDF 下载、全文阅读或内容总结。

### V2.2

**PaperEcho V2.2** 让三条使用路径更轻快，也让日常更新更省心。

- **Web 路径更高效。** PaperEcho 会减少与 Zotero 之间不必要的重复通信。处理较多文献时等待更少，原有的筛选结果和写入规则保持不变。
- **Local 路径更流畅。** 本地导入、去重和重复运行时的处理效率得到改善，适合长期积累文献的项目。Desktop 路径继续以稳定为先，不为追求数字改变现有体验。
- **面对服务波动更从容。** 当文献来源、AI 服务或 Zotero 暂时繁忙时，PaperEcho 会自动放慢请求；服务恢复后再逐步提速，减少频繁失败和手动重试。
- **更新版本更安心。** 新增 `paperecho-update`，可以检查并安装官方稳定版本。更新前会保护本地配置、运行记录和已有报告；发现文件被修改或任务仍在运行时会主动停止，更新失败也会尽量恢复原来的可用版本。

## 核心特色

| 特色 | 说明 |
| --- | --- |
| Zotero Desktop | 继续使用本机 Zotero 文献库，通过 CLI 完成文献写入和整理。 |
| Zotero Web API | 连接 Zotero 云端文献库，无需保持桌面客户端运行。 |
| Standalone Local | 完全脱离 Zotero，通过本地文件完成文献处理和报告交付。 |
| 每日 Radar | 每天轻量发现新文献和重要研究线索；正式 Zotero 入库仍由周度流程统一完成。 |
| 多源文献发现 | 根据研究领域组合 OpenAlex、Semantic Scholar、PubMed、Europe PMC、Crossref、RSS 或本地数据，通过多源补充和统一去重降低单一来源漏召回的影响。 |
| 自动去重与分级 | 识别重复文献，完成 A/B/C/D 分级，把需要判断的内容留给研究者。 |
| Zotero 写回 | Desktop 和 Web 路径支持集合整理、批量写入和标题翻译回填。 |
| 本地独立交付 | Local 路径使用 JSON/JSONL 输入，在本地完成处理并生成报告。 |
| 反馈持续学习 | 将文章反馈和长期筛选标准用于后续筛选，减少重复调整。 |
| 文献状态监测 | 持续关注已入库文献的撤稿、勘误等公开状态变化，并以保守方式提醒和整理。 |
| 任务恢复 | 长流程中断或超时后保留已确认进度，恢复时核对实际状态，减少重复写入和误操作。 |
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

在 `config/paperecho.config.json` 中选择 Desktop、Web 或 Local，并按研究领域选择合适的文献源或本地输入。API key、SMTP 密码等 secret 只写入本机 `.env`。完整字段见 [`docs/configuration.md`](docs/configuration.md)。

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

未来配置每日系统调度时，每天北京时间 15:00 只调用一个选定路径的计划入口，例如 `node skills/paperecho-zotero-desktop/scripts/run.mjs --run --scheduled-daily --config config/paperecho.config.json`（Web 路径使用对应 Web launcher）。入口按最近一次成功 Weekly 的计划时隙选择 Weekly 或 Radar：首次有效时隙运行 Weekly，之后第 1～6 天运行 Radar，第 7 天起再次运行 Weekly；漏跑不补历史 Radar。15:00 前调用不占用当天时隙。Weekly 的 `standard` / `complete` 配置只决定到期时所用模式。仅在 Stage4 正式导出成功后推进 Weekly 周期；邮件失败由既有 receipt/recovery 流程处理。失败且同日已占位时，入口优先识别原 runId；状态不确定会明确要求恢复，不另起业务运行。本版本不注册 Windows/macOS 系统定时任务。

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

Choose Zotero Desktop, Zotero Web API, or the fully independent Standalone Local path. Depending on your field, combine OpenAlex, Semantic Scholar, PubMed, Europe PMC, Crossref, RSS, or local data.

PaperEcho does not make research judgments for you. It handles the recurring organization work, leaving more time for reading, thinking, and deciding what to study next.

## Update

**PaperEcho V2.3** makes literature tracking a more continuous workflow: lightweight daily discovery, reliable weekly organization, ongoing status monitoring for saved papers, and broader multi-source discovery.

- **Daily Radar for timely discoveries.** Lightweight scans surface research worth noticing between weekly runs. Formal organization and Zotero imports remain part of the weekly workflow, so daily alerts do not disrupt your library.
- **More reliable weekly organization and recovery.** Daily discoveries, weekly search results, and pending items are deduplicated and screened together before import. Interrupted work retains confirmed progress; recovery checks the actual state to reduce duplicate imports and repeated work.
- **Status monitoring for saved literature.** PaperEcho checks public structured updates for retractions, corrections, and other important changes. It flags and organizes affected papers conservatively while preserving your existing items and attachments.
- **Stronger multi-source discovery.** Search methods are tailored to the field and source, combining appropriate results from OpenAlex, Semantic Scholar, PubMed, Europe PMC, Crossref, and RSS. Results are deduplicated across sources, and a zero result from one database is not treated as proof that no relevant literature exists.
- **Better visibility during long Desktop tasks.** Large historical-feedback jobs show progress and place time limits on slow lookups. A timeout or interruption is clearly reported as unfinished work and stops subsequent operations, while retaining confirmed results.

Daily Radar and literature status monitoring can be enabled as needed. PaperEcho does not download PDFs, read full texts, or summarize their contents.

### V2.2

**PaperEcho V2.2** makes all three ways of using PaperEcho feel lighter and makes future updates safer.

- **A more efficient Web path:** PaperEcho avoids unnecessary back-and-forth with Zotero, reducing wait time when handling larger batches without changing screening or writeback behavior.
- **A smoother Local path:** local imports, deduplication, and repeat runs now handle growing libraries more efficiently. Desktop continues to prioritize stability and keeps its familiar workflow.
- **More graceful recovery from busy services:** when a literature source, AI service, or Zotero is temporarily overloaded, PaperEcho slows down automatically and picks up speed gradually when the service recovers.
- **Safer product updates:** the new `paperecho-update` skill checks and installs official stable releases while protecting local configuration, run history, and existing reports. It stops when local changes or an active task make updating unsafe, and can restore the previous working version if an update fails.

## Quick Start

1. Install Node.js 18+, npm, and PowerShell 7+. Desktop also requires Zotero Desktop; Web requires a Zotero API key; Local requires no Zotero installation.
2. Clone the repository and run `npm install`.
3. Copy `config/paperecho.config.example.json` to `config/paperecho.config.json` and `.env.example` to `.env`. Choose one path and select suitable literature sources or local input for your field.
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
