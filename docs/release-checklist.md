# Public Release Checklist

- [ ] 全仓库无真实 API key
- [ ] Git 历史无泄露密钥，或已清理并 rotate
- [ ] `.env` 未被提交
- [ ] `.env.example` 已提供
- [ ] 私有配置文件未被提交
- [ ] README 包含安装、配置、运行、安全说明
- [ ] 示例配置可运行到合理的错误提示或 dry-run
- [ ] 日志不会打印密钥
- [ ] 个人路径、邮箱、Zotero 私有 ID 已移除或模板化
- [ ] 缓存、运行输出、论文列表等隐私数据未被提交

## 建议发布前复查命令

- 关键字扫描：`rg -n --hidden "api[_-]?key|token|secret|password|authorization|bearer|cookie|session|sk-" .`
- 路径扫描：`rg -n --hidden "/Users/|C:\\Users\\" .`
- 邮箱扫描：`rg -n --hidden "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}" .`
- Zotero 标识扫描：`rg -n --hidden "library_id|collection_id|zotero.*id" .`

## PaperEcho v2.1 — Reliability Release

状态：开发与本地 release gate 已完成。

### 检索可靠性与来源状态

- RSS 2.0/Atom 使用 `fast-xml-parser` 正式解析 namespace、CDATA 和 entity，并支持 ETag、Last-Modified 与 304。
- PubMed/PMC 支持完整分页、分块详情及 EDAT/CRDT 重叠窗口；OpenAlex 支持 cursor paging 和免费日期重叠获取。
- source state 按 profile/source/canonical query hash 隔离，weekly 与未来 Radar 状态分离；完整分页和 retrieval artifact 原子落盘后才推进水位，部分失败不误推进。
- availability health 与 yield anomaly 独立记录。

### 断点恢复、通知与兼容

- operation ledger 为副作用保存稳定幂等键；`--resume <runId>` 通过原 launcher/Runner 执行 Zotero、shared index 和文件 reconciliation，已验证操作不重复执行。
- 人工修改或 object version 不一致进入 `conflict`；run lease 阻止同一 runId 并发恢复。
- Stage1–4 失败通知独立于 Stage5。receipt 状态为 `pending/accepted/unknown/failed`，使用稳定 dedupe key/Message-ID；accepted 不重发，SMTP 模糊结果按 unknown 保守处理且默认不自动重发。
- 单来源或 LLM 连续两次降级才通知，同一降级周期不重复，恢复只通知一次；系统不会自动停用来源。
- Runner 保持 schema v1 原行为；schema v2 提供可靠性配置，新通知默认关闭，Radar 不会自动启用，也未增加自动迁移工具。

### 已知限制与未包含范围

- 真实 RSS/PubMed/OpenAlex smoke 尚未执行：仓库没有已提交的安全窄查询 acceptance 配置。
- 在线 `npm audit --omit=dev --json` 报告 3 个 production-tree advisory（2 moderate、1 high）。high `brace-expansion` 位于 `exceljs -> archiver/readdir-glob -> minimatch` 传递路径；当前 PaperEcho 入口未发现受影响 glob pattern expansion 的可达触发面。`uuid` advisory 对应的受影响 API 未被当前仅使用 `uuid.v4` 的路径调用。v2.1 接受该已知风险，未升级依赖，也未执行 `npm audit fix`；这些 advisory 未被修复。
- 真实 SMTP、Zotero 写入及其他外部服务副作用未纳入本次 RC 在线验收。
- 本版本不包含每日 Radar、Weekly queue merge、撤稿/勘误/关注声明监测、PDF 下载、全文分析或内容总结。v2.2 性能优化见下节。

## PaperEcho v2.2 — Performance Release

状态：三路径性能优化与本地 release gate 已完成；真实外部服务验收仍保留为已知风险。

### Web 更省 Zotero 请求

- 过去同一条文献涉及多个集合操作时，可能重复读取当前 Zotero 状态。现在会复用一次读取取得的 object version 与集合状态，计算完整集合并集后再安全批量写入，减少重复读取和不必要的 API round-trip。
- 固定 cold benchmark 的总请求从 511 降至 263，减少 48.5%；其中 reads 从 489 降至 248，writes 从 22 降至 15。候选和最终业务结果没有减少。
- object version guard、collection/conflict protection、批量失败降级和既有写后验证语义均保留；请求下降不是通过少处理文献、少执行 guard、跳过分页或放宽副作用验证取得。

### Local 的 upsert 热点更快

- Local 优先使用自己的内存去重索引，并复用一次身份规范化结果，避免 warm run 对共享记录反复线性扫描。upsert cold hotspot 从 5.666 ms 降至 3.425 ms，改善约 39.5%；warm 从 8.553 ms 降至 2.926 ms，改善约 65.8%。
- 以上是热点内部收益，不是整条 Local 路径的提升百分比。整条路径 cold total median 从 31.638 ms 变为 33.827 ms，约有 6.9% 的 benchmark 波动性回退；warm 从 38.092 ms 变为 36.409 ms，约改善 4.4%。明确收益集中在 upsert 热点。

### Desktop、共享热点与自适应并发

- Desktop benchmark 没有发现稳定、可控、值得承担风险单独修改的路径级热点，因此继续沿用已有批量化和共享实现，没有为了凑性能 commit 强行改动。
- 共享热点优化尝试因收益不稳定而撤回；没有找到稳定、可重复、值得单独提交的共享路径级热点，因此没有制造无效优化。
- Source HTTP、LLM 与 Zotero Web API 分别使用独立的有界自适应并发控制。外部服务出现 429、`Retry-After`、`Backoff`、连续失败或明显延迟恶化时会降低并发，恢复后只缓慢增加，并且不超过既有安全上限。
- 已验证控制行为不增加请求、retry 或 429，且不改变业务结果；没有独立 Before/After 证据证明自适应并发本身显著降低整体 wall time，因此本版本只声明新增受控自适应并发能力。

### 安全更新与部署

- 新增独立的 `paperecho-update` Skill，官方来源固定为 `Chip-G0202/PaperEcho`。最新版只按数值语义版本选择最新 stable tag，不跟随 `main`、预发布 tag 或其他仓库，也不自动 downgrade。
- Windows 与 macOS 每次运行都会重新进行有限范围的安装探测；多个可信候选不会自动选择，可用 `--install-dir` 明确指定。check 是默认行为且不写 live，apply 必须显式请求并通过相同 preflight。
- release 自带的 update contract 区分 managed 程序文件与 persistent 用户状态。`.env`、真实 config、source state、ledger、receipt、lease、artifact、输出和工作文件均受保护；`config/` 中只有明确列出的 example/template 可由 updater 管理。
- managed 文件采用 OLD/LOCAL/NEW 三方保护，本地修改、目标新增文件碰撞或被修改的删除目标都会阻塞升级。活动中的 PaperEcho run、resume/lease 或另一个 updater lock 同样阻塞，updater 不结束进程。
- 目标 stable tag 先进入 staging，并校验官方来源、tag/commit、contract、schema 兼容、依赖和最小语法/import smoke。schema 不兼容时不自动迁移；lockfile 不变时不安装依赖，变化时只允许确定性的 `npm ci`。
- live 修改前建立最小、manifest-backed rollback snapshot；关键失败会恢复 managed 文件与受保护的 tracked persistent 文件，并验证旧版本。只有验证成功才报告已恢复，最近只保留 updater 自己拥有的少量 snapshot。
- `paperecho-update` 是发布与部署能力，不属于 Stage1–5 文献工作流，也不改变检索、分级、Zotero、副作用、resume、ledger、receipt、adaptive concurrency 或 benchmark 语义。

### 正确性、已知风险与未包含范围

- cold/warm 三路径的 canonical business output hash 与 normalized side-effect hash 保持一致；LLM 调用量没有增加。比较器排除 runId、时间戳和临时路径等非业务字段，不以文件字节完全相同作为唯一等价标准。
- literature identity、retrieval results、dedupe、A/B/C grading、metadata、Zotero mutation plan、collections、exports、notification decisions、source watermark 与 schema v1/v2 行为保持不变；v2.1 的 operation ledger、`--resume <runId>`、reconciliation、conflict protection、lease 和 notification receipt 继续有效。
- 真实 Zotero、真实 SMTP、真实生产检索来源以及真实网络限流条件下的 adaptive concurrency 尚未执行 production acceptance；本次 release 不使用生产配置补做压测。
- 当前依赖树仍存在 2 moderate、1 high advisory；本版本未处理依赖升级，未执行 `npm audit fix`，这些 advisory 未被修复。
- 本版本不包含每日 Radar、Weekly queue merge、撤稿/勘误/关注声明、PDF 下载、全文分析或内容总结。

## PaperEcho v2.3 — Radar, Integrity, and Retrieval Recall Release

状态：Daily Radar、Weekly 接管、文献完整性监测与多源检索召回增强已完成本地 release gate；真实有副作用的生产验收仍保留为已知风险。

### Daily Radar

- Radar 使用 Asia/Shanghai 每天 15:00 的计划时隙，周末和节假日照常决策；Weekly 到期日由 Weekly 接管，同一天不会再开启独立 Radar 业务运行。
- Daily 与 Weekly 使用隔离的 watermark。Radar 只负责发现、判断和提醒，Zotero write 与 XLSX write 均为 0。
- urgent A 需要可靠 grading。LLM 不可用时不以 rule-only A 触发业务告警，而是进入独立 review backlog；review backlog 与 urgent queue 分开保存和处理。
- 通知按稳定身份和 fingerprint 去重；仅完整性状态变化不会重新触发 Daily Radar 通知。

### Weekly Merge

- Weekly 保持独立 retrieval，并按 canonical literature identity 合并 urgent queue、review backlog 与本轮候选；不会用 Daily 候选替代 Weekly 检索。
- classification fingerprint 的任一语义因素变化或缺失都会重新 grading，旧 Radar A 不能覆盖当前 Weekly 结果。
- queue claim 只表示本轮取得处理权，不等于 consume。只有 Zotero business write 与 operation ledger 均已验证后才消费；重复调度和 crash/resume 不重复创建文献。
- Weekly report 的数据范围只包含 verified business writes，报告身份集合必须与 verified write 身份集合一致。

### Literature Integrity Monitoring

- 只监测 shared index 中具有活动 `presence.zotero` 且至少有 DOI 或 PMID 的记录。Crossref 使用 production REST 的结构化更新关系，PubMed 使用 `CommentsCorrections` 结构化关系；不根据标题、自由文本或 LLM 猜测撤稿。
- relation direction 已按 subject/object 归一化：指向原文的 `updated-by` / PubMed `*In` 才能更新原文状态；notice 自身的 `update-to` / `*Of`、`*For`、`*From` 不会被误判为被撤稿对象。
- Retraction Watch 同 record-id 的矛盾证据 fail-closed；独立 publisher 或 PubMed 证据仍可确认。已确认撤稿默认保持 sticky，不会因空结果、来源故障或后续冲突自动反转；retracted-and-republished 进入人工复核。
- 撤稿处置先使用稳定 item/collection ID 验证加入 `文献池/待删除`，再移除其他 PaperEcho-managed collection ID。用户 collection/tag、Zotero item、note、attachment 与 PDF 均保留；部分移除失败保留 `pending_delete` 并由原 operation ledger/reconcile/resume 继续处理。
- correction 与 expression of concern 只追加状态标签，不覆盖用户标签。证据状态与 mutation application 状态分别记录；本周新增确认、已应用和待继续处理的完整性变化只进入 Weekly summary。
- Bootstrap 有界、可 checkpoint、可恢复且幂等；成功空结果与 provider outage/timeout/parse/partial 明确区分，只有成功检查才推进 `lastCheckedAt`。

### Retrieval Recall Hardening

- 查询先解析为统一 Search Intent IR，保留隐式 AND、布尔嵌套、短语、排除项、概念组、日期、文献类型与领域提示；每个来源再使用自己的语法编译，不把一条原始字符串直接转发给所有数据库。
- OpenAlex 是通用主题主来源，具备查询/URL 长度门禁、确定性分块、零结果探针与仅在 primary zero 后触发的语义救援。Semantic Scholar 使用 bulk search 作为通用补充，并维持独立并发、重试、分页与 incomplete 状态。
- Crossref 只使用高信息量书目锚点处理通用主题低召回，不作为宽泛主检索。PubMed 是生物医学主来源；Europe PMC 仅在生物医学低召回路径补充，生产 Tier 2 中贡献 97 个 canonical unique candidates，因而保留。Unpaywall 不承担 discovery。
- 所有来源汇入同一 canonical dedupe；跨 DOI/PMID 的传递身份可合并，来源 provenance 被保留但不改变 A/B/C grading。单一来源 zero 只触发诊断/救援，不解释为“没有文献”；只有各适用来源均无结果才记录 confirmed multi-source zero。
- 生产 Tier 2 使用 45 组公开脏查询与 13 组 known-hit（5 通用、5 生物医学、3 跨学科；每组 3 个公开 ID）。6 个单来源零结果全部被其他来源救援，confirmed multi-source zero 为 0；union known-hit recall 为 18/39，不低于最佳单一来源的 10/39。
- Tier 2 来源概况：OpenAlex zero rate 9.76%（41/42 成功，0 个 429）；Semantic Scholar zero rate 27.27%（22/42 成功，6 个 429，存在瞬时 5xx）；PubMed zero rate 6.67%（15/15 成功）；Crossref 与 Europe PMC zero rate 均为 0。union unique candidates 为 11,184，单查询最多 3 个请求。
- 在 Tier 2 稳定后执行 120 组确定性变体：200 个请求，healthy query rate 92.5%，单查询最多 2 个请求。持续公开无 key 压力下 OpenAlex 出现 57 个 429，Semantic Scholar 出现 3 个 429及少量 5xx/timeout；适配器保留 Retry-After/backoff、来源隔离和失败不推进状态，但这不等于长期 rate-limit 生产验收。
- 召回门禁证明多源 union 不劣于本组最佳单一来源，并能识别和救援单来源 zero；它不证明数据库覆盖完整，也不承诺绝对无遗漏。

### Updater and Compatibility

- v2.2 的 `paperecho-update` 可按既有 stable-tag/update-contract 路径安全升级到 v2.3。Radar 与 Integrity runtime state 位于 persistent/protected 范围。
- 用户 `.env`、真实 config、source state、shared index、operation ledger、notification receipt 和输出不会被 updater 覆盖；managed 文件冲突、活动任务或 schema 不兼容仍会阻塞升级。
- unified config schema v1 不能静默启用 Radar/Integrity；schema v2 只有显式开启时才启用，缺省保持关闭。

### Production Hardening Invariants

- Windows atomic JSON rename 仅对 `EPERM`、`EACCES`、`EBUSY` 做有限指数退避重试；仍保持临时文件加原子 rename，不退化为直接覆盖。
- operation ledger 的 `verified` 是终态并在 resume 时直接 `skipped_verified`；已证明无需执行的 metadata operation 以 verified no-op evidence 闭合。
- 不确定的 Zotero create 默认 fail closed 并等待 reconciliation；collection membership 在 backend 边界统一为 stable key，大批量 Zotero JavaScript 只经 stdin 传输。
- RSS namespace 合并会去除规范化后相同的文本片段但保留真实不同片段；未翻译或失败时中文标题保持为空，不用英文 fallback 冒充翻译成功。
- Weekly XLSX 只有通过 independent-reader 的 sheet、header、blank cell 与 formula-error 校验后才能 promote；首选 writer 失败时丢弃中间产物，并从 pristine source 进入既有 fallback chain。

### 已验证边界

- 已验证：Phase A/B/C fixture 与定向测试；Phase D source-specific compiler、共享 dedupe、来源健康诊断、45 组公开脏查询与 120 组确定性变体；Radar no-Zotero-write/no-XLSX；Weekly takeover、verified-before-consume、代表性 crash/resume 与重复创建防护；Crossref production REST 只读解析；PubMed production EFetch 只读解析；Retraction Watch 冲突保护；updater v2.2→v2.3 fixture；配置 v1/v2 兼容。
- Crossref/PubMed production acceptance 仅验证公开接口的真实结构化响应可被 parser 正确归一化，没有执行 Zotero mutation，也不等同于生产写入验收。
- 未验证：真实 Zotero write、真实 SMTP、真实 LLM Radar、长期实际 OS scheduler、真实长期 rate-limit 环境。Phase D 公开源只读验收也不构成“生产环境已全面验证”或“检索绝对无遗漏”。
- 本版本不包含 PDF 下载、全文阅读或内容总结。
# Historical feedback enrichment safeguards

- Preserve every historical feedback row. Deduplicate remote lookup work with the shared title normalization and run-scoped query/detail caches; never persist a remote-title cache as identity authority.
- Use verified adapter capabilities only. Without a safe library enumeration contract or explicit concurrency evidence, use serial deduplicated searches. Partial local coverage never proves a remote miss; ambiguous/capped search results require review.
- Resolve stable keys and shared-index identity evidence before title searches; deduplicate normalized query variants before dispatch. Only reliable zero-match responses may trigger another variant. Read details only for missing correction evidence and cache exact successful aliases within the run.
- Validated CLI enrichment reads use a dedicated maximum of two workers (`PAPERECHO_FEEDBACK_READ_CONCURRENCY`, clamped to 1–2); other backends stay serial. Require isolated process/retry/cancellation fixtures and a successful read-only Production parity probe before acceptance. Record search, detail, retry and alias-cache counters separately.
- `PAPERECHO_FEEDBACK_ENRICHMENT_TIMEOUT_MS` is a run-scoped optional positive millisecond override (default 30 minutes). It is independent of the CLI request timeout. Phase start, periodic progress, and completion/failure are recorded atomically in timing and feedback progress artifacts.
- Timeout, interruption, or incomplete enrichment must prevent collection discovery/application and downstream writeback preparation. Only a completed enrichment may build a consumable correction plan; verify zero correction mutations with timeout fixtures.
- `PAPERECHO_RUNNER_WATCHDOG_TIMEOUT_MS` optionally bounds the production child (default at least 2 hours and four times the enrichment budget; explicit values must exceed that budget). Runner requests cooperative cancellation, then terminates only its owned child tree after a bounded grace period. Never kill processes by executable name.
- SIGINT/SIGTERM propagate through launcher/Runner to production. Interrupted/timed-out runs must exit nonzero, retain last-phase evidence, and never report verified completion. Existing verified side effects remain ledger facts and are not automatically rolled back.
- Run-group and ledger summaries must preserve terminal workflow failure priority. An empty ledger records zero operations and cannot establish workflow completion; reconciliation must not turn a timed-out workflow into success.
- Release acceptance requires focused cancellation/cache fixtures, full development regression, and one controlled production run. A timed-out production run is a safe failure, not release acceptance; do not automatically rerun or move the release tag.
