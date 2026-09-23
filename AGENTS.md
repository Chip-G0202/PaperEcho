# Medical Literature Workflow Agent Reference

## General Execution Environment And Permission Boundaries

- Default to completing tasks within the current repository/workspace.
- Recommended sandbox permission is Workspace write.
- Use Read only mode for auditing and planning work.
- Full access is a temporary exception only. Before requesting it, report exact paths, reason, scope of impact, risk, and rollback method, then wait for user approval.
- Keep project files, generated artifacts, temporary files, and test outputs inside the workspace.
- Prefer workspace runtime, project-local configuration, or standard user-level cache directories for Node, dependencies, and caches.
- Do not access, copy, index, or expose unrelated sensitive paths, including SSH private keys, browser data, Desktop, Downloads, personal Documents, or system configuration directories.
- Before network access, dependency installation, Zotero access, external API calls, global configuration changes, or reading/writing files outside workspace, report exact commands, necessity, impact scope, rollback availability, and whether a workspace-local alternative exists, then wait for approval.
- Before each major modification round, run `git status --short`; if the working tree is not clean, report existing changes first.
- Suggest creating a branch before large or high-risk modifications.
- Never reset, checkout, clean, delete, or overwrite existing user changes without explicit permission.
- If `node`/`npm`/`python` or other runtimes are not executable or lack permission, classify as an environment failure, not a business test failure.
- Prioritize diagnosing `PATH` and runtime paths, and prioritize workspace-provided or project-approved runtimes. Do not request Full access only because one path is not executable.

## Goal

Operate a weekly medical literature pipeline with parallel entry channels:

- RSS ingestion
- PubMed/PMC retrieval via direct NCBI requests in the scripts

Then run unified dedup, triage, Zotero writeback, translation backfill, and workbook export in the existing Research OS structure.

Cadence defaults:
- Full pipeline interval: every 7 days (`review_results_RUN_INTERVAL_DAYS=7`)
- Force override: `FORCE_review_results_RUN=true` or `review_results_FORCE_RUN=true`
- Report label: `周报`
- Synthesis interval: month-end synthesis on the last due run of each month
- Synthesis label: `月报`
- If interval not reached and no force flag: skip full stages and emit skip report fields (`skipped_due_to_interval`, `next_eligible_run_at`)
- Interval gate uses `Asia/Shanghai` 15:00 planned slot semantics; the 7-day comparison is based on planned slots, not actual start/end/Stage4 times.

## Capability Delegation and Existing Tool Boundary

- Prefer existing capabilities first. If a capability already exists in plugins, skills, MCP servers, existing adapters, CLI/scripts, library functions, or documented workflow contracts, reuse that capability instead of re-implementing it.
- Do not bypass abstraction layers. When an upper-layer interface already owns a capability, call that interface instead of jumping to lower-level internals.
- Do not duplicate internals of existing tools. If MCP already provides semantic search, do not independently build embedding generation, vector indexing, or vector similarity logic in pipeline business code.
- Before adding new code, determine capability ownership:
  - plugin
  - skill
  - MCP server
  - existing adapter
  - existing CLI/script
  - existing library function
  - documented workflow contract
- If ownership already exists, prefer:
  - thin adapter integration
  - explicit degrade path
  - auditable report fields
  - mock tests
- Only add new implementation when existing capability is unavailable or unverified. In that case:
  - explain why reuse is not possible
  - keep new code as a thin adapter
  - keep degradation + audit signals
  - avoid parallel competing implementations
- If interface name/shape is unknown:
  - do not fabricate APIs or success claims
  - do not bypass to lower-level services
  - degrade safely and report blocked/unverified state
- Rationale:
  - avoid duplicate implementations and config drift
  - avoid inconsistent results from double call chains
  - preserve plugin/MCP caching, indexing, permission and audit boundaries
  - keep module responsibilities clear
  - lower maintenance and debugging costs

## Git Version Control Rules

- **Commit 习惯**：完成有意义的变更后，主动建议用户 commit。
- **Commit 前检查**：先运行 `git status --short` 确认变更范围。
- **Commit message 规范**：简洁说明改了什么，例如："新增跨平台支持"、"修复标题规范化"。
- **不要自动 commit**：除非用户明确要求，否则不要自动执行 `git commit`。
- **大变更分批 commit**：如果改动涉及多个独立功能，建议分多次 commit。
- **Commit 后确认**：执行 commit 后，运行 `git log --oneline -1` 确认成功。

## Reproducibility Baseline

- Required runtime: **Node.js >= 18.0.0** and **PowerShell 7 (pwsh) >= 7.0.0**.
- This repository has committed `package.json` and `package-lock.json`; run `npm install` in a fresh environment before workflow execution.
- Repository launchers and checks run with the Node binary, for example `node skills/paperecho-zotero-desktop/scripts/run.mjs --check` or `node --test workflow/tests/*.test.mjs`.
- If local tests are runnable, the narrow default verification command is `node --test workflow/tests/*.test.mjs`.
- Reproducibility currently depends on the documented runtime versions, committed npm metadata, `.env.example`, and local Node-built-in test execution.

## Hard Constraints

- PowerShell gate requires `pwsh >= 7.0.0` (exact pinning like `7.6.1` is not allowed unless explicitly required by a future task).
- Never use Windows PowerShell 5.1.
- Never directly edit `<YOUR_ZOTERO_DATA_DIR>\zotero.sqlite`.
- PubMed/PMC only for database retrieval.
- Do not use Google Scholar/CNKI/IEEE/ACM in this workflow.
- Do not fabricate references, page numbers, doses, stats, or experimental outcomes.
- PDF acquisition is out of automation scope. Users handle PDFs manually in Zotero.
- Title translation secrets must come only from `TITLE_TRANSLATION_API_KEY` in the environment, a local `.env`, or injected automation secret storage.
- Non-secret title translation parameters live in `config/title_translation.config.json`.
- The default translation model lives in `config/title_translation.config.json`, and `TITLE_TRANSLATION_MODEL` can override it.
- The title translation prompt lives in `config/prompt-title-translation.md` and uses `${sourceText}` substitution.
- Default translation rate limits are RPM `100` and TPM `10,000,000`.
- Title translation non-stream request bodies currently use `max_tokens`; if a real provider/model/key is not configured in the active environment, verification must stay mock/local, and end-to-end success must not be claimed.
- Never write title translation secrets into config files, prompts, memory, reports, stdout, or stderr.

## Directory Model

- Pipeline state root: `review_results/`
- Pipeline state layout: `review_results/pipeline/<yy.M.d>`
- Final workbook export root: `<YOUR_PROJECT_ROOT>/review_results/文献评价`
- User-editable RSS sources: `config/rss_sources.json`
- User-editable PubMed/PMC search conditions: `config/pubmed_pmc_search.json`
- User-editable workflow triage/feedback rule config: `config/review-workflow-rules.json`
- Long-lived screening standard text: `review_results/文献评价/screening_standards.md`
- User-facing manual review root: `review_results/文献评价`
- One-off historical archive root: `review_results/literature_archive`
- Dry-run/apply manifests: `review_results/run_manifests`

Final workbook exports (desktop month folder):
- `月报-*.docx`

Final workbook exports (day folder):
- `周报.xlsx`

Pipeline artifacts kept in `review_results/.../pipeline`:
- `run_report.json`
- `triaged_items.json`
- `triaged_export_items.json`
- `writeback_ready_items.json`
- `zotero_writeback_summary.json`
- `abc_translation_backfill.json`
- other audit/state JSON files

## Repository Automation Entry

- Codex 和普通交互式生产执行必须使用固定链路：Path Skill -> Path Launcher -> Shared Runner -> Preflight -> Production Entry -> Current-run Validation。
- Desktop、Web、Local launcher 分别是 `skills/paperecho-zotero-desktop/scripts/run.mjs`、`skills/paperecho-zotero-web/scripts/run.mjs`、`skills/paperecho-local/scripts/run.mjs`；三者都调用 `workflow/tools/runner/main.mjs`，不得自动切换 mode。
- Desktop/Web 的底层 production entry 是 `workflow/tools/stage0/main.mjs`；Local 的底层 production entry 是 `workflow/tools/local/main.mjs`。
- `workflow/tools/stage0/main.mjs` 仅可由 scheduled automation、已知外部调度器、维护/测试场景或明确承担配置、preflight、错误处理和结果验证责任的调用者直接运行。Codex 默认交互式执行不得绕过 launcher/Runner。
- Workflow scripts load project `.env` via `workflow/tools/lib/env_file_bootstrap.mjs`; do not require Node's `--env-file` flag.
- 禁止由 Agent 手工拼接 Stage 脚本，禁止扫描历史目录或按 mtime 猜测本次结果。

The stable three-path architecture, Stage1-Stage5 contracts, Stage5 notification, and lifecycle rules are authoritative in [PaperEcho Canonical Architecture](#paperecho-canonical-architecture). Detailed implementation guidance is progressively loaded from `skills/paperecho-workflow/`.

## Triage Labels

- `A课题相关`: directly relevant to the current core project question.
- `B专题相关`: clearly relevant to the current subtopic or adjacent topic, but not the core project question.
- `C领域相关`: relevant at the broader field level, with lower short-term priority.
- `D无关`: low relevance; audit only and never written back to Zotero.

## Weekly Run Checklist

1. Runtime gate:
   - `pwsh` version >= `7.0.0`
   - console encoding == `utf-8`
2. Read previous-cycle feedback:
   - `feedback` non-empty
   - `处理状态 != 已学习`
   - use `标题翻译` as primary article context when interpreting row-level `feedback`; fallback to English title if translation missing
   - `每日反馈` only requires a `feedback` column; `comment` / `备注` is optional legacy context and must not block learning when absent
   - use `review_results/文献评价/screening_standards.md` as the only long-lived preference source
   - rows without explicit feedback are excluded from preference learning
  - previous feedback lookup order: `<YOUR_PROJECT_ROOT>/review_results/文献评价/<week>/<day>/周报.xlsx` first
  - legacy fallback order only when primary not found: desktop root then project legacy root
   - accepted feedback column aliases: `feedback`, `Feedback`, `反馈`, `用户反馈`
   - accepted optional comment column aliases: `comment`, `Comment`, `备注`, `评价备注`
   - accepted English title aliases: `英文标题`, `title`, `Title`, `English Title`
   - accepted translation aliases: `标题翻译`, `中文标题`, `translated_title`, `title_translation`
   - `周报.xlsx` exports the mutually exclusive user-facing worksheets `每日反馈` and `需人工复核`; machine audit stays in JSON artifacts
   - every med-query-learning run must execute the long-lived refinement chain:
     - row-level `feedback/title` -> article direction evidence, with optional `comment` as auxiliary context only
     - markdown rationale from `screening_standards.md` -> primary rationale and boundary context
     - evidence -> preference clusters
     - clusters -> screening preference rules
   - evidence, cluster, and rule are separate layers and must remain separately auditable
   - a single feedback row is evidence only; it must not be written directly as a stable screening preference
   - Stage1 must not load any xlsx preference store; long-lived preference context comes from `screening_standards.md` and previous feedback workbooks only
   - every run must preserve evidence traceability (`source_file`, `source_row`, feedback/title context, optional comment, and standards-file source path) and must not discard historical evidence
   - every run must recompute cluster counts/status/confidence:
     - `evidence_count`
     - `positive_evidence_count`
     - `negative_evidence_count`
     - `confidence`
     - `status`
   - allowed cluster/rule status values are:
     - `stable`
     - `tentative`
     - `ambiguous`
     - `needs_more_feedback`
   - a single evidence row may become `tentative` or `needs_more_feedback`, but never `stable`
   - conflicting positive/negative evidence on the same topic family must be represented as `ambiguous`, not silently generalized
   - negative preferences must remain bounded by caveats such as study type, evidence level, or disease context; do not broadly exclude an entire topic without repeated scoped evidence
   - output machine-readable audit file: `review_results/pipeline/<yy.M.d>/preference_learning_audit.json`
   - previous-cycle workbook must be read via unified Node/JS reader (`workflow/tools/lib/review_workbook_reader.mjs`) shared by formal flow and dry-run/diagnostic flow
   - Python is not the primary path for feedback workbook reading; `python_failed` must not block preference learning
   - `feedback_column_missing` can be reported only after workbook read succeeded and headers were detected
   - when learning is skipped/degraded, record concrete blockers (file missing / workbook unreadable / columns missing / fallback failure / preference write failure), not only a generic degrade word
3. LLM preference refinement (weak evidence only):
   - Formal workflow is LLM-only: `runLlmPreferenceLearning` is the only supported preference-refinement path
   - default runtime remains script-first and in-process
   - compatibility-only report fields may remain for older artifacts, but they must stay false/null and carry `removed_llm_workflow`; they do not define a fallback path
   - semantic results must not expand today's candidate pool
   - feedback neighbors or similar titles are not pseudo-labeled feedback samples
4. Build PubMed/PMC query pack:
   - read `config/pubmed_pmc_search.json`
   - default `days_back` is `10` when missing or invalid
   - date range must be present in PubMed/PMC request parameters (`datetype`, `mindate`, `maxdate`), not only applied after import
   - positive terms / negative terms / MeSH terms / study type filters may be maintained in the config as the search strategy evolves
5. Parallel retrieval:
   - RSS channel reads `config/rss_sources.json`
   - PubMed/PMC channel reads `config/pubmed_pmc_search.json`
6. Merge + dedup:
   - DOI > PMID/PMCID > URL > normalized title
7. A/B/C/D triage:
   - `周报.xlsx` excludes `D无关`
   - `triaged_items.json` and `run_report.json` retain `D无关` for audit
   - **周报数据源规则**：`desktop_daily_review_source.json` 必须只包含当天 Stage2 实际写入 Zotero 的条目（来自 `zotero_writeback_summary.writeback_items`），不得包含文献池去重跳过的重复条目。Stage1 全量 ABC 是候选池，不是周报数据源。
     - Stage 2 完成后，orchestrator 用 writeback itemKey 过滤 desktop source
     - Stage 2 失败或 backend readiness 未通过时，Stage3/Stage4 不执行，不得声称仍会生成最终 XLSX
   - **周报两 sheet 互不重叠**：
     - "需人工复核"：仅 `needs_human_review=true` 的条目
     - "每日反馈"：当天写入的剩余 ABC 条目（排除已进入复核的）
     - 两个 sheet 合计 = 当天实际写入 Zotero 的全部 ABC 条目
   - 翻译补翻（pool scan）只静默补翻译，不混入周报数据源
   - `周报.xlsx` "每日反馈" sheet uses three grade columns: 规则等级, 语义等级, 最终等级
     - 规则等级: rule system initial grade
     - 语义等级: semantic review suggested grade
     - 最终等级: system-adopted final grade
     - All three columns output only grade letters (A/B/C/D), no explanatory text like "C领域相关"
   - `周报.xlsx` "需人工复核" sheet only contains written-back items where `needs_human_review=true`; candidates with semantic grade D remain in Stage1 audit and are held before Zotero writeback
     - Auto-adopted adjustments (B→A, C→B, B→C) are visible in 每日反馈 via 规则等级/语义等级/最终等级 columns but do NOT enter 人工复核
     - Users fill "人工确认等级" column; rule/semantic grades are read-only evidence
     - Only one review sheet; no separate "语义捞回" or "语义降权提醒" sheets
   - `周报.xlsx` "反馈" column (renamed from `feedback`) and "评价" column (renamed from `comment`)
   - Removed columns: 来源等级, 已处理时间, 处理状态, 备注
   - "期刊/来源" column should be cleaned to pure journal name (remove RSS/feed/platform suffixes)
8. Zotero writeback and translation backfill
   - The shared Stage1-Stage5 contracts and collection semantics are backend-independent; transport, readiness, retry, and version behavior belong to the selected backend.
   - Use the single authoritative `PaperEcho Canonical Architecture` section below for Desktop/Web/Local selection and shared boundaries; load the linked adapter Skill for transport-specific batching, recovery, and validation details.
   - Prefer the backend-specific Stage2 benchmark for writeback work; run the complete dual-backend workflow only for final acceptance.
   - Journal quality cache lives at `review_results/journal_quality_cache.json`; it is a runtime cache and must not be committed. Local/live index remains the dedupe source of truth, not root `文献池` membership.
   - Pool scan runs by default every 14 days (`ZOTERO_TRANSLATION_POOL_SCAN_INTERVAL_DAYS=14`), i.e. every two 7-day automation runs
   - Pool scan window defaults to 14 days (`ZOTERO_TRANSLATION_POOL_SCAN_WINDOW_DAYS=14`)
   - Legacy items in 文献池 are not re-scanned; only recent date subcollections are checked for missing shortTitle
   - Pool scan limit defaults to 50 candidates (`ZOTERO_TRANSLATION_POOL_SCAN_LIMIT`)
   - `write_metadata` for title backfill is allowed only for Stage 2 admitted items or recent allowed-pool-scan candidates
9. Update weekly and root assets (final xlsx export only after Stage2/Stage3 success)
10. Zotero collection placement:
   - root collection: `文献池`
   - create daily date collection `YYYY-MM-DD`
   - under date collection create `RSS订阅` and `数据库检索`
   - under date collection create `A课题相关`, `B专题相关`, `C领域相关`
   - every newly admitted item is added to exactly one daily source collection and one daily grade collection
   - newly admitted items are not force-added to root `文献池`; the root remains a managed anchor for legacy items, `待删除`, collection guard, and historical dedupe scope
   - do not leave items only in root `文献池`
   - do not place items directly in date collection itself
   - Zotero backend mutation guard:
     - allowed collection scope is the unique top-level `文献池` subtree plus the unique top-level `值得精读`
     - required managed collections are auto-created when missing: top-level `文献池`, `文献池/待删除`, and top-level `值得精读`
     - `待删除` is valid only as `文献池/待删除`; top-level `待删除` is out of scope
     - `值得精读` is valid only as a top-level sibling of `文献池`; `文献池/值得精读` is out of scope
     - `add_items_to_collection`, `remove_items_from_collection`, `create_collection`, `delete_collection`, and metadata writes must fail closed or skip when scope is outside this allowed set
     - if required managed collections are ambiguous or created at the wrong position, the corresponding mutation must not call Zotero backend
     - every blocked mutation records `collection_scope_blocked_count` and `collection_scope_blocked_samples`
   - dedup policy before writeback:
     - read/build duplicate indexes for `文献池`, `文献池/待删除`, and `值得精读`
     - exact normalized match priority: `DOI > PMID > PMCID > arXiv > OpenAlex > URL > exact normalized title`
     - title normalization must cover Unicode/punctuation/spacing variants (NFKC/NFKD, quote/dash unification, fullwidth mapping, combining-mark removal, control/zero-width cleanup)
     - if duplicate in any of those collections: skip create and skip all add-to-collection operations for current-day routing
     - if not duplicate: create the item and add it to daily source/grade collections only; do not force-add new items to root pool
     - record `skipped_duplicate_in_pool`, `skipped_duplicate_in_trash`, `skipped_duplicate_in_worthy`, and created/add counters in writeback summary
11. Historical collection modification:
   - ordinary Stage 1 reads previous feedback and applies item actions by default when CLI backend and collection guard are ready
   - set `APPLY_FEEDBACK_ITEM_ACTIONS=false` only for plan-only feedback item actions
   - explicit correction command: `node workflow/tools/maintenance/zotero_feedback_collection_corrections.mjs`
   - feedback correction must use Zotero backend only; never access `zotero.sqlite`, move PDFs, delete attachments, or fetch RSS/PubMed/PMC
   - feedback correction must stay inside the allowed collection scope: `文献池` subtree, `文献池/待删除`, and top-level `值得精读`
   - match priority for correction: stable itemKey/ID from local pipeline JSON, then translated title, then English title, then Zotero backend `search_library` exact English-title fallback
   - if local pipeline records contain duplicate title matches, resolve only when Zotero backend exact title search returns a single item; otherwise keep conflict/manual review
   - `drop` correction target is `文献池/待删除`: add the item there, then remove it from the original day grade collection; do not delete the Zotero item automatically unless a separate explicit delete mode is requested and verified
   - `keep` is no-op; `upgrade`/`downgrade` add to target grade collection and remove from original grade collection
   - all correction runs must emit `review_results/run_manifests` JSON/CSV audit files with status counts and safety flags
12. Star migration (rated items → `值得精读`):
   - enabled by default; controlled by `ZOTERO_STAR_MIGRATION_MODE` (`expand` / `legacy` / `disabled`)
   - window: `ZOTERO_STAR_MIGRATION_WINDOW_DAYS` (default `10`); threshold: `ZOTERO_STAR_MIGRATION_MIN_STARS` (default `4`)
   - `expand` mode scans A + B + C grade collections; `legacy` mode scans A + B only
   - migration target collection: `值得精读` (top-level, sibling of `文献池`)
   - migration flow per eligible item:
     1. add item to `值得精读`
     2. remove item from date subcollections (source collections + grade collections)
     3. remove item from root `文献池` — **mandatory** to keep root and date subcollections in sync
   - if any removal step fails, log the error and continue with next item; do not abort the migration
   - audit fields in `migration_stats`: `eligible_items`, `moved_to_worthy`, `already_in_worthy`, `removed_from_source_collections`, `removed_from_grade_collections`, `removed_from_root_pool`, `removal_failures`, `add_failures`
   - invariant: after each run, every item in `值得精读` must NOT be in `文献池` root, and must NOT be in any date grade/source subcollection
   - code location: `workflow/tools/stage2/main.mjs` → `migrateRatedItems` function

## Monthly Review Checklist

1. Verify trend quality in the monthly `月报-*.docx` report.
2. Verify machine audit JSON for unresolved items, contradiction evidence, and preference drift when needed.
3. If historical run records are missing, the report should state “记录不足” rather than inventing data.

## One-off Historical Feedback Archive

- Use `node workflow/tools/maintenance/archive_history_by_feedback.mjs` for one-off historical feedback archive dry-runs.
- The command must not be part of the default scheduled/manual literature workflow.
- Default mode is dry-run and writes `review_results/run_manifests/historical_feedback_archive_dry_run.json`.
- Actual archive materialization requires explicit `--apply`.
- The archive command reads existing local pipeline JSON and review workbooks only; it must not fetch RSS/PubMed/PMC, write Zotero, start workflow dependencies or external services, access `zotero.sqlite`, delete files, or overwrite existing targets.

## Degradation Policy

- If PubMed/PMC retrieval fails: continue with RSS and log the failure.
- If Desktop/Web Zotero backend startup or readiness fails: skip Stage2, Stage3, and Stage4, record the exact blocker, and do not claim a final XLSX. Runner preflight must block detectable configuration/readiness errors before production entry.
- If translation fails for some ABC items: keep the English title for export, log failures, and continue.
- If previous-day title translation is missing for some feedback rows: fallback to English title and mark uncertainty in preference-learning summary (do not over-generalize).
- Compatibility-only semantic fields/parsing may remain, but they must stay inert and must not become a runtime dependency or fallback.
- Negative feedback must be learned as conditional exclusion hints first; do not broadly reject an entire topic without repeated evidence.

## Global XLSX Export Policy

- For all Research OS `.xlsx` outputs, default export path is the Codex spreadsheet capability via the unified spreadsheet adapter.
- Scope is limited to final user-facing outputs: `周报.xlsx` plus the monthly `月报-*.docx` report.
- Export fallback order is fixed and auditable:
  1. `codex_spreadsheet`
  2. `node_fallback`
  3. `python_spawn_legacy`
  4. `manual_required`
- `python_spawn_legacy` is compatibility fallback only and must not be the default or sole export path.
- Every export must record method and outcome in `run_report.json` (or equivalent audit JSON): `export_method`, `export_skill`, `output_path`, `input_files`, `generated_at`, `fallback_chain`, and error/degrade fields when applicable.
- If the Codex spreadsheet capability is not callable in the current execution context, report the unavailability reason and degrade using the fallback chain. Never claim spreadsheet-capability usage when it was not used.
- The Codex spreadsheet capability is responsible for workbook generation only; it does not perform triage, Zotero writeback, metadata backfill, semantic learning/search, preference updates, 7-day migration, or candidate ranking.
- XLSX export root remains: `<YOUR_PROJECT_ROOT>/review_results/文献评价`.

## Feedback Learning Audit Baseline

- `med-query-learning` must emit explicit audit fields for previous-day feedback lookup, column detection, sample counts, and preference execution outcome.
- The long-lived preference source is `screening_standards.md`, not xlsx stores or secondary markdown files.
- Every run must read `<YOUR_PROJECT_ROOT>/review_results/文献评价/screening_standards.md` as the only long-lived screening-standard source.
- If `screening_standards.md` is missing, initialize it with the Chinese baseline standard and continue.
- Before using the standards file, normalize previous display markup: red additions become plain text; blue strikethrough deletions are removed.
- Daily standard changes are written back to clean `screening_standards.md`; `screening_standards.docx` is regenerated as the human revision display, with current additions in red and current deletions in blue strikethrough.
- `screening_standards.docx` workspace conventions:
  - The evaluation area ("评价") and "Pending Rule Suggestions" table are consumable workspaces; Stage 1 reads and processes them by default.
  - The evaluation area may be cleared only after AI rule rewrite succeeds; if the AI key is missing or LLM processing fails, user input must remain in docx and the blocker must be audited.
  - `PREFERENCE_LEARNING_API_KEY` is the direct key for AI rule rewrite; `TITLE_TRANSLATION_API_KEY` is the fallback key. Reports must record whether a key is configured and whether the source is direct or fallback, but never record the key value.
  - After processing, only unresolved pending suggestions may remain.
  - Suggestions with status `accepted`/`rejected`/`revise` or with `processed_at` must not be written back into the next docx round.
  - "Preserved User Content" is reserved for genuinely unclassifiable user-authored content only; it must not contain Format Notes, Status options, Pending Rule Suggestions, old evaluation text, old Preserved User Content blocks, or other system template content, to prevent recursive pollution.
  - Auto-maintained docx must not generate unbounded timestamp backups by default; at most one fixed backup file (`screening_standards.backup.docx`) is kept, overwriting on each run. Historical timestamp backups are not currently maintained; if future audit needs arise, a separate opt-in mechanism may be implemented.
- Every `周报.xlsx` export must include the mutually exclusive user-facing sheets `每日反馈` and `需人工复核`; detailed audit remains in JSON.
- Detailed audit fields must stay in `preference_learning_audit.json` and `run_report.json`, not in `周报.xlsx`.
- Missing `当前筛选标准摘要` is expected for new exports and must not block preference learning.
- Users can train the system through two feedback channels:
  - article-level `feedback` as direction plus strength (`keep` = no-op/weak positive, `upgrade` = positive, `downgrade` = weaker negative, `drop` = stronger negative); `comment` is optional auxiliary context
  - standards-file text in `screening_standards.md` as the primary rationale source for preference boundaries
- Feedback item actions are enabled by default: `drop` items move to `文献池/待删除`, and `upgrade` / `downgrade` items update the corresponding grade collections. `keep` is a no-op. Set `APPLY_FEEDBACK_ITEM_ACTIONS=false` only when you want a plan-only run.
- Standards-file feedback must remain conservative: row feedback updates evidence/clusters, while standards-file changes document and constrain the evolving rules.
- Legacy `当前筛选标准摘要` / `我的评价` and English summary feedback columns may be read only as backward-compatible fallback when old workbooks contain them.
- Allowed cluster corrections from standards feedback include reinforce, weaken, split-suggested, mark ambiguous, retire, narrow scope, broaden scope, add caveat, and needs-more-feedback.
- Preference audit JSON must preserve cluster-level rules, evidence details, and ambiguous clusters that should not strongly affect triage.
- Every med-query-learning run must use `screening_standards.md` rationale plus current feedback evidence; it must not depend on xlsx preference stores.
- Every med-query-learning run must emit cluster-level audit signals in addition to row-level evidence signals.
- Minimum required fields include:
  - `previous_feedback_lookup_paths`
  - `selected_previous_feedback_file`
  - `previous_feedback_file_found`
  - `previous_feedback_headers`
  - `feedback_column_detected`
  - `comment_column_detected`
  - `title_columns_detected`
  - `rows_with_feedback`
  - `rows_with_comment`
  - `feedback_samples_used`
  - `feedback_samples_ignored`
  - `positive_feedback_samples`
  - `negative_feedback_samples`
  - `ambiguous_feedback_samples`
  - `evidence_total`
  - `evidence_positive`
  - `evidence_negative`
  - `evidence_ambiguous`
  - `evidence_ignored`
  - `new_evidence_count`
  - `historical_evidence_count`
  - `clusters_total`
  - `clusters_existing_matched`
  - `clusters_created`
  - `clusters_updated`
  - `clusters_stable`
  - `clusters_tentative`
  - `clusters_ambiguous`
  - `clusters_needing_more_feedback`
  - `clustering_executed`
  - `clustering_warning`
  - `evidence_to_cluster_map_available`
  - `preference_learning_executed`
  - `preferences_added`
  - `preferences_updated`
  - `preferences_reinforced`
  - `preferences_marked_ambiguous`
  - `preferences_needing_more_feedback`
  - `screening_standards_path`
  - `screening_standards_loaded`
  - `screening_standards_cleaned`
  - `screening_standards_primary_rationale_source`
  - `screening_standards_change_markup_applied`
  - `screening_standards_additions_count`
  - `screening_standards_deletions_count`
  - `signals.previous_feedback_missing`
  - `signals.feedback_columns_missing`
  - `signals.no_feedback_rows`
  - `signals.preference_not_updated`
  - `signals.score_delta_unavailable`
  - `preference_learning_audit_path`
  - `preference_learning_summary_exported`
  - `preference_learning_sheets_exported`

## Pwsh Gate Audit Rule

- Gate minimum is `7.0.0`.
- `7.0.0`, `7.4.x`, `7.6.2`, `7.7.x`, `8.x`, and future major versions `>=7` are acceptable.
- `5.1`, `6.x`, and all versions with major `<7` fail the minimum gate.
- Unknown version output must be audited (`pwsh_version_unknown=true`, raw output captured) and must not be treated as automatic hard failure by itself.

## Cross-Platform Principle

**Different OS → different commands → same functional behavior.**

The Desktop/Web pipeline must produce identical outcomes on Windows and macOS: same Preflight -> Stage1 -> Stage2 -> Stage3 -> Stage4 -> Stage5 -> run summary -> run-group manifest -> housekeeping -> ephemeral cleanup contract, same artifacts, same report status values, and same Zotero collection structure. The implementation uses platform-specific system commands only at the Desktop process boundary:

| Operation | Windows | macOS | Linux |
|---|---|---|---|
| Launch Zotero | `powershell Start-Process zotero` (system command, no hard path) | `open -a Zotero` (system command) | `zotero` (direct command) |
| Detect Zotero process | `tasklist` + `findstr zotero` | `ps -A -o comm=` | `ps -A -o comm=` |
| Kill process (strong recovery) | `taskkill /f /im zotero.exe` | `pkill -x Zotero` | `pkill -f zotero` |

Everything else (Zotero backend probe, RSS fetch, PubMed query, triage, dedup, writeback, translation, export) is platform-independent Node.js code.

The Stage 2/3 gate is readiness of the explicitly selected backend. Desktop requires `zotero-cli app ping` plus JS bridge readiness; Web requires an authenticated Web API readiness probe and must not start Desktop. Process existence is a Desktop diagnostic signal only, not a shared gate.

## Cross-Platform Preflight Rules

- Desktop mode may launch Zotero with the selected platform's local command and communicates only through the CLI/JS bridge backend. Web mode uses only the authenticated Zotero Web API and must not launch Desktop.
- Windows-only process commands must remain in win32 code paths; macOS/Linux must use their own process launch/detection commands.
- Process existence is diagnostic evidence, not backend readiness. Stage2/Stage3 require the explicitly selected backend's successful readiness probe.
- Desktop and Web validation must fail closed on their own backend; neither path may switch to the other backend.

## Workflow and Manifest Status Values

Desktop/Web workflow reports use the exact terminal values below. Local returns `ok: true` or throws; its run-group manifest still uses the shared manifest states.

| Status | Scope | Meaning | Successful full run | Artifact handling |
|---|---|---|---:|---|
| `running` | run-group manifest | Current run is open | no | Keep the lock and current artifacts |
| `completed` | workflow/manifest | Required work completed; Stage5 may be an allowed `skipped` when no recipient was requested | yes | Keep registered artifacts |
| `completed_with_warnings` | workflow | Stage4 completed but a permitted partial failure/warning remains | yes, with warnings | Keep artifacts and warnings |
| `completed_stage1_only` | workflow | Explicit maintenance/test Stage1-only execution | no | Keep diagnostic artifacts; do not claim full workflow success |
| `degraded_due_to_zotero_backend_unavailable` | workflow | Backend readiness failed; Stage2, Stage3, and Stage4 were skipped | no | Keep diagnostics; do not claim XLSX success |
| `skipped` / `skipped_due_to_interval` | workflow | Interval gate did not admit business stages | no | Keep skip report; do not treat as failure |
| `failed_stage1` | workflow | Stage1 or its current-run artifact guard failed | no | Keep failure evidence |
| `failed_stage2_writeback` | workflow | Stage2 writeback failed | no | Preserve completed upstream evidence; do not run later stages |
| `failed_stage3_translation` | workflow | Stage3 hard failure; `partial_failed` is handled as warning, not this status | no | Preserve completed upstream evidence |
| `failed_stage4_export` | workflow | Stage4 export or current-run postcheck failed | no | Preserve completed upstream evidence |
| `failed_due_to_config_or_dependency` | workflow | Startup/configuration/dependency failed | no | Keep diagnostics; no downstream success claim |
| `failed_stage5_notification` | workflow | Stage4 succeeded but Stage5 notification failed | no | Preserve Stage1-Stage4 outputs; retry notification only with current-run state |
| `failed_unhandled` | run-group completion | An uncaught Desktop/Web orchestration error escaped | no | Close the manifest as failed and preserve diagnostics |
| `failed` | run-group manifest | The business run did not complete | no | Keep registered failure artifacts |

Stage records may be `completed`, `partial_failed`, `failed`, or `skipped`. Runner presentation values `SKIPPED`, `PARTIAL`, `NOT_APPLICABLE`, and `NOT_DUE` are not failures. Local Stage2/Stage3 are always `NOT_APPLICABLE`; a monthly report that is not due is `NOT_DUE`.

## Stale Artifact Protection

- `inspectArtifact` compares artifact `mtime` against `stageStartedAt`. If `mtime < stageStartedAt`, artifact is marked `stale: true, currentRun: false`.
- Stale `zotero_writeback_summary.json` or `abc_translation_backfill.json` must not be treated as current-run success artifacts.
- Orchestrator checks `artifacts.writeback_summary.currentRun` and `artifacts.translation_backfill.currentRun` before proceeding to next stage.
- **Stage1 artifact guard**: after Stage1 completes with exitCode=0, orchestrator verifies `writeback_ready_items.json` exists and is fresh (`currentRun=true`). If missing or stale, remaining stages are skipped with `failed_stage1`. This prevents interval race conditions where Stage1 internally skips but returns exitCode=0.
- Each report includes `runId` for cross-run artifact correlation.

## macOS Parity Test Commands

```bash
# Syntax check all key modules
node --check workflow/tools/lib/ensure_zotero_backend_ready.mjs
node --check workflow/tools/lib/runtime_config.mjs
node --check workflow/tools/stage0/check_zotero_backend_ready.mjs
node --check workflow/tools/stage0/main.mjs

# Run backend contract tests (mock-based, no real Zotero/CLI)
node --test workflow/tests/zotero_backend.test.mjs

# Stage 1-only smoke test (no Zotero CLI needed)
node workflow/tools/stage0/main.mjs --stage1-only

# Zotero backend readiness probe
node workflow/tools/stage0/check_zotero_backend_ready.mjs
```

## Zotero Backend Preflight Contract

- Interactive Desktop/Web runs must enter through the selected path launcher and shared Runner. The Runner performs zero-write preflight before the Stage0 production entry; scheduled automation that directly invokes Stage0 must own equivalent configuration, failure handling, and result validation.
- Stage0 evaluates the interval gate before startup. If startup/configuration fails, it skips all business stages and reports `failed_due_to_config_or_dependency` with startup diagnostics.
- After Stage1, the selected backend readiness gate controls Stage2. If that gate fails, Stage2, Stage3, and Stage4 are skipped and the workflow reports `degraded_due_to_zotero_backend_unavailable`; no final XLSX success may be claimed.
- Stage outputs must not treat stale `zotero_writeback_summary.json` or stale `abc_translation_backfill.json` as current-run artifacts.
- All Zotero-facing scripts must call the shared helper `workflow/tools/lib/ensure_zotero_backend_ready.mjs` before the first Zotero read/write request.
- Zotero scripts must not bypass the backend adapter: Desktop operations go through the CLI backend and Web operations through the Web API backend.
- Zotero executable resolution must not depend on a single hardcoded path. Prefer `ZOTERO_EXE`, then standard install locations and bounded fallbacks (`ProgramFiles`, `ProgramFiles(x86)`, `LOCALAPPDATA`, `D:/Zotero`, `C:/Zotero`, `where.exe`, bare `zotero`).
- If executable resolution fails, desktop backend scripts must stop before Zotero access and report attempted sources plus `ZOTERO_EXE` guidance.
- If preflight or backend readiness fails, reports must record the exact blocker and must not claim writeback/backfill/export success.
- Desktop validation uses `ZOTERO_BACKEND=cli`; Web validation uses `ZOTERO_BACKEND=web_api` plus `ZOTERO_API_KEY`. Never allow an implicit fallback during backend-specific validation.
- Scheduled automation may invoke `node workflow/tools/stage0/main.mjs --trigger=scheduled`; it must honor `skipped`/`interval_not_reached`, validate the emitted run, and must not prewarm or retry by switching backend.

## LLM-only Review Contract

- Preference refinement formal path: `runLlmPreferenceLearning`
- Title-grade review formal path: `reviewGradesWithLlm`
- Rule-context formal path: `buildLlmRuleContextSummary`
- The formal workflow uses only the in-process LLM review paths above. The semantic backend is removed and must not be restored; compatibility-only fields stay false/null with `removed_llm_workflow` and define no fallback.
- Default grade review remains full coverage; `--max-grade-review-items` / `review_results_MAX_GRADE_REVIEW_ITEMS` are debug or validation overrides only

## Semantic Review Eligibility

- Semantic review (`rule_grade → semantic_grade → final_grade`) only processes **B** and **C** items.
- **A** items are not reviewed (already highest grade, no upgrade path).
- **D** items are not reviewed, including those with `flags.uncertain=true`.
- The eligibility check is: `ruleGrade === "B" || ruleGrade === "C"`.
- 周报 and human review still operate on all ABC items; D items are excluded from daily review as before.
- C→D semantic downgrade does **not** auto-adopt: `final_grade` stays C, `needs_human_review=true`, `disagreement_type=semantic_downgrade_review`. Any ABC candidate reviewed as D remains in Stage1 audit but is held from Zotero writeback and the writeback-derived Weekly review.
- All other 1-level adjustments (C→B, B→A, B→C) auto-adopt. 2+ level differences keep `rule_grade` and flag `needs_human_review=true`.

## 脚本入口与验证约定

- 交互式生产入口固定为对应 Path Skill/launcher；launcher 调用 `workflow/tools/runner/main.mjs`，Runner 再调用 Desktop/Web Stage0 或 Local main。
- Desktop/Web 完整链路为 Preflight -> Stage1 -> Stage2 -> Stage3 -> Stage4 -> Stage5 -> run summary -> run-group manifest -> housekeeping -> ephemeral cleanup。
- Local 完整链路为 Preflight -> Stage1 -> shared title translation generation -> Local state persistence -> Stage4 -> Stage5 -> run summary -> run-group manifest -> housekeeping -> ephemeral cleanup；禁止调用 Stage2/Stage3 或构造 Zotero backend。
- 诊断工具包括 `workflow/tools/stage0/check_zotero_backend_ready.mjs`。
- 详细脚本角色、是否可直接运行、是否可能写入 Zotero、是否默认需要 dry-run / `--apply`，请参考 `docs/script-inventory.md`。
- 只做语法验证时，优先使用：
  - `node --check workflow/tools/stage0/main.mjs`
  - `node --check workflow/tools/stage1/main.mjs`
  - `node --check workflow/tools/stage2/main.mjs`
  - `node --check workflow/tools/stage3/main.mjs`
  - `node --check workflow/tools/stage4/main.mjs`
  - `node --check workflow/tools/stage5/main.mjs`
  - `node --check workflow/tools/runner/main.mjs`


## Stage1 内部模块边界

- `workflow/tools/stage1/main.mjs`：Stage1 编排入口，负责主流程编排、report 汇总和异常兜底。
- `workflow/tools/stage1/preference_refinement.mjs`：偏好学习对外入口，导出 `buildFeedbackSemanticSamples`、`buildPreferenceStoreSheets`、`definePreferencesFromSemantic`、`buildPreferenceLearningAudit`。
- Stage1 helper 模块只承接具体步骤或纯逻辑；外部调用应优先依赖入口文件公开 API 或明确 owner 模块。
- 修改偏好学习逻辑时优先运行：
  - `node --test workflow/tests/preference_refinement.test.mjs`
  - `npm run check`
  - 必要时 `npm test`

## 模块归属与 CLI Wrapper 约定

- **Local Control Center**：`workflow/tools/web/server.mjs` 只承接 loopback HTTP/static；业务走 `workflow/tools/lib/control_application_services.mjs` 组合的 services。禁止 Web handler 直接写 Zotero、规则正文或任意 config JSON。
- **统一反馈与配置入口**：`control_feedback_service.mjs` 持有 canonical paper feedback history/current；`control_config_service.mjs` 持有固定字段 registry，保留原配置文件 owner。Legacy XLSX 单向 import、DOCX evaluation/decision adapter 继续支持，不做双向同步。
- **人工建议与安全**：pending schema/dedup 仍归 `unified_pending_rule_suggestions.mjs`；DOCX/Web formal apply 均经 `control_rule_suggestion_service.mjs`。未验证的 target/change type 必须保持 pending，不能报告成功应用。Credentials 不回显；没有安全写入 owner 时只返回 configured 状态。
- **验证与状态保护**：定向执行 `node --test workflow/tests/control_services.test.mjs workflow/tests/control_http.test.mjs`。新增 state `paper_feedback.json` 与 `research_evaluations/` 属于长期用户反馈，不能作为普通 run artifact 清理；验证只使用工作区 fixtures。

- **CLI wrapper 调 lib owner**：CLI 脚本（`workflow/tools/*.mjs`）只做入口编排，核心逻辑由 `workflow/tools/lib/*.mjs` 提供。
- **thin wrapper 标准**：CLI 不重复定义 lib 中已有的业务逻辑（如 probe、retry、格式化）。
- **唯一 owner 原则**：每项能力有且只有一个 lib 模块作为 owner，避免平行竞争实现。
- **详细归属表**：见 `docs/module-ownership.md`。
- **Zotero backend readiness**：`workflow/tools/stage0/check_zotero_backend_ready.mjs` 直接调用 `ensureZoteroBackendReady()`（默认 probe 由 lib 提供）。
- **LLM review**：由 `workflow/tools/stage1/llm_grade_reviewer.mjs` 和 `workflow/tools/lib/llm_json_support.mjs` 负责正式路径。
- **后续收敛方向**：统一日期格式化函数、MCP 工具函数、`cleanJournalSource` 等重复实现。




## PaperEcho Canonical Architecture

### Project Mission

PaperEcho 持续获取或导入医学文献，使用共享规则和反馈学习完成去重、分级、翻译与导出，并可在成功导出后发送通知。架构固定为一个共享领域核心、两套 Zotero transport adapter 和一套 Local filesystem adapter；正确性、数据安全、幂等和可恢复性优先于便利性与性能。

### Three Paths and Stage Contracts

| Path | Interactive launcher | Production entry | Stage coverage | Adapter boundary |
|---|---|---|---|---|
| Zotero Desktop | `skills/paperecho-zotero-desktop/scripts/run.mjs` | `workflow/tools/stage0/main.mjs`, `ZOTERO_BACKEND=cli` | Preflight -> Stage1 -> Stage2 -> Stage3 -> Stage4 -> Stage5 -> validation | CLI and JS bridge transport |
| Zotero Web API | `skills/paperecho-zotero-web/scripts/run.mjs` | `workflow/tools/stage0/main.mjs`, `ZOTERO_BACKEND=web_api` | Preflight -> Stage1 -> Stage2 -> Stage3 -> Stage4 -> Stage5 -> validation | Web API v3 transport, versions, batching, backoff |
| Standalone Local | `skills/paperecho-local/scripts/run.mjs` | `workflow/tools/local/main.mjs` | Preflight -> Stage1 -> shared translation -> Local state -> Stage4 -> Stage5 -> validation | import, Local state/feedback/timings/exports; no Stage2/Stage3/Zotero backend |

Repo-local path Skills use deterministic production launchers rather than selecting an entry dynamically:

- Desktop: `node skills/paperecho-zotero-desktop/scripts/run.mjs`
- Web: `node skills/paperecho-zotero-web/scripts/run.mjs`
- Local: `node skills/paperecho-local/scripts/run.mjs`

For explicit production intent, the selected path Skill must invoke only its own launcher. Every launcher calls `workflow/tools/runner/main.mjs`; `--run` performs shared zero-write preflight before invoking the production entry once and then validates only that run. `--check` never creates run state or calls Zotero, Web API, LLM, SMTP, network, retention, or cleanup. A blocked preflight must leave the production-entry call count at zero. Development/review intent never invokes a production launcher, while explanation intent may only explain or use `--check`. “继续” reruns the same launcher and a fresh preflight; it does not reuse readiness, switch paths, or wait in the background. Loading a Skill alone has no production side effect, and secrets must stay in environment/secret storage rather than chat. The full contract is [Deterministic Skill Execution](skills/paperecho-workflow/references/execution.md).

| Stage | Stable responsibility | Primary output | Forbidden responsibility |
|---|---|---|---|
| Stage1 | retrieval/injected import boundary, normalization, shared-identity dedupe, feedback learning, rules and LLM grading | triage, writeback-ready and preference audit artifacts | Zotero mutation |
| Stage2 | guarded Zotero create, exact dedupe, source/grade routing, recovery and index refresh | `zotero_writeback_summary.json` | Local execution or root-pool insertion of new items |
| Stage3 | shared translation consumption plus Zotero `shortTitle` writeback/readback and bounded pool scan | `abc_translation_backfill.json` | Local execution or a second translation cache |
| Stage4 | current-run workbook/monthly export and export audit | `周报.xlsx`, optional `月报-*.docx`, Run Summary | retrieval or Zotero mutation |
| Stage5 | Run Summary formatting, title overview, current-run attachment validation, SMTP send and receipt | run-scoped notification state | Zotero imports, historical attachment scans, rollback of Stage1-Stage4 |

Detailed inputs, outputs, gates, and tests belong in `skills/paperecho-workflow/references/stage-contracts.md`, not here.

### Non-negotiable Invariants

- Desktop and Web share the same Stage0 orchestration and Stage1-Stage5 contracts; transport details stay in their adapters.
- All paths use `workflow/tools/lib/literature_identity.mjs` and `review_results/shared/current_literature_index.json`; do not create another authoritative dedupe index.
- Identity priority is DOI -> PMID -> PMCID -> arXiv -> OpenAlex -> canonical URL -> exact normalized title.
- Shared index schema is v2. `presence.zotero` and `presence.local` remain isolated; do not fabricate the other path's locator.
- Incomplete/missing Zotero coverage uses backend exact-lookup fallback; complete coverage may avoid a redundant lookup.
- Local is not a Zotero backend: it must not construct one, start Desktop, call Stage2/Stage3, or persist item/collection/attachment/rating fields.
- All paths use `generateLiteratureTitleTranslations`, `translatedTitle`, and `review_results/translation_cache.json`. Stage3 alone owns Zotero metadata writeback.
- Stage5 is SMTP-only, must not import Zotero modules, and must not scan history to guess attachments.
- Each business run has run-scoped Stage5 state and a schema v1 `run_group.json`; housekeeping scan state stays under the runtime housekeeping directory, and long-lived state is never deleted by age.
- Housekeeping deletes only registered, allowed run artifacts. Ephemeral cleanup deletes only explicitly registered closed/consumed files, never lookalikes discovered by glob.
- Never commit `.planning/**`, `review_results/**`, caches, receipts, workbooks, previews, benchmark output, real literature data, `.env`, or credentials.

### State and Artifact Rules

| Class | Canonical examples | Lifecycle |
|---|---|---|
| Shared state | shared literature index | persistent and protected |
| Local state | `state/papers.json`, `state/learning-state.json`, `feedback/events.jsonl` | persistent and protected |
| Shared cache | `review_results/translation_cache.json`, journal/runtime caches | persistent and protected |
| Run state | `runs/<runId>/run_group.json`, timings, Stage5 receipt/overview, diagnostics | registered 30-day group |
| User run output | current-run `周报.xlsx` | registered 30-day group |
| Permanent output | every `月报-*.docx`, fixed screening-standard DOCX files | protected |
| Ephemeral | registered CLI import JSON, consumed Local export source, current atomic `.tmp`/`.lock` | condition-based immediate cleanup |

Desktop/Web run groups live at `review_results/文献评价/runs/<runId>/run_group.json`; Local uses `<outputRoot>/runs/<runId>/run_group.json`. Writes to shared index, translation cache, Local JSON state, run manifests, receipt, and overview must preserve their existing lock/atomic-replace semantics.

### Current-run Result Validation

- Runner 必须从本次 production entry 输出提取 run ID，并且只读取 `<runRoot>/<runId>/run_group.json`。
- 成功验证必须核对 manifest schema version、run ID、mode、`completed` 状态、各适用 Stage、当前 XLSX 注册、Stage5 `sent`/允许的 `skipped`、housekeeping warnings 和 ephemeral cleanup counters。
- 禁止扫描历史目录、按 mtime 选择“最新”run、读取旧 shared Stage5 state，或仅因 production entry exit code 为 0 就忽略 manifest/Stage 状态。
- Stage5 `failed` 必须使当前生产验证失败，但不得回滚或删除已成功生成的 Stage1-Stage4 产物。

### Configuration Contract

- Unified Runner configuration accepts schema v1/v2 JSON. Schema v1 preserves legacy behavior; schema v2 adds the v2.1 reliability settings while new notifications remain disabled by default and Radar/integrity remain inactive. The committed template is `config/paperecho.config.example.json`; the machine-local `config/paperecho.config.json` is precisely gitignored. `--config` overrides `PAPERECHO_CONFIG`, then the optional default local file is loaded when present.
- Configuration is partitioned into `common`, `desktop`, `web`, and `local`. The resolver lives only in `workflow/tools/runner/config_loader.mjs`; do not add path-specific loaders or duplicate the existing Stage1/search/rule/translation domain JSON owners.
- Resolution order is CLI -> unified config -> environment/`.env` -> existing domain files/defaults. Mode order is CLI `--mode` -> config `mode` -> exactly one `enabled=true`; never infer mode from backend or secret residue. Fixed path launchers fail closed on a configured different mode.
- Preflight checks and reports only `common` plus the selected path. Local never requires or probes Zotero; Web never starts Desktop; Desktop never requires Web credentials. On “继续”, the same launcher reloads the config and reruns preflight.
- Unified JSON stores secret environment-variable names only. Secret values remain in environment/`.env`/secret storage and output records presence only. The complete user contract is [PaperEcho Configuration](docs/configuration.md).
- Recipient order: CLI `--email`, `PAPERFLOW_REPORT_TO`, legacy `NOTIFICATION_EMAIL`. Without a recipient, Stage5 skips before SMTP validation or transport creation.
- Required SMTP: `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`. Optional: `SMTP_PORT` default 465; `SMTP_SECURE` inferred true only for 465 unless explicit; `SMTP_FROM` defaults to `SMTP_USER`.
- PaperEcho provides no mail relay. Secrets remain environment-only and never enter logs, errors, summaries, receipts, timing, docs, or Git.
- Stage5 counts/grades use current-run created literature. Overview uses all deduplicated current-run A/B/C titles, no abstracts/full text/D titles; normal input is one LLM call, oversized input is deterministic batches plus merge, and failure falls back deterministically.
- Stage5 email omits the weekly XLSX because review happens in Control Center. The explicit current-run monthly DOCX remains optional; at most one attachment and 20 MiB total. The formatter does not render an attachment body section.
- Receipt/overview live in the run's `stage5/` directory. Successful run ID plus recipient hash is idempotent; `--force-resend` reuses an unchanged overview input hash.
- `PAPERFLOW_CLEANUP_ENABLED` defaults true. `PAPERFLOW_RETENTION_DAYS` defaults 30; `0` disables age deletion. Full scans run at most once per 24 hours unless forced and never change the business result.

### Modification Rules

- Locate the existing capability owner and all direct callers before editing. Shared semantics change once in shared core; path differences change only in the owning adapter.
- Do not add duplicate identity/index, translation cache, formatter, sender, receipt store, cleanup scanner, or path-specific Stage copy.
- A schema/path change must include reader/writer compatibility or migration, atomic/lock behavior, housekeeping protection, tests, and documentation.
- A path change must preserve other-path poison boundaries and synchronize affected integration tests, Stage contracts, state paths, cleanup registration, and Skill reference.
- Use the smallest safe diff. Do not perform unrelated refactors, dependency upgrades, full formatting, or real external operations without explicit scope and authorization.

### Validation Matrix

| Change | Minimum validation category |
|---|---|
| identity/index | shared-index tests plus nearest Stage1/Stage2 dedupe test |
| Desktop/Web adapter | changed-file syntax, backend contract and affected adapter/writeback tests |
| Local | Local pipeline plus touched shared identity/translation/Stage4 tests; Zotero poison calls stay zero |
| Stage4 | export-source/spreadsheet mapping and affected path integration |
| Stage5 | notification, overview, run-state, Run Summary and affected three-path integration; mock SMTP/LLM only |
| housekeeping | runtime housekeeping, maintenance CLI, ephemeral registry and affected path integration using temporary roots |
| Skill execution/config | `workflow/tests/runner_config.test.mjs`, `workflow/tests/skill_execution_runner.test.mjs`, changed Runner/launcher `node --check`, and all affected Skill validators; mock child processes and temporary roots only |
| docs/Skills | Skill validator, YAML/frontmatter, local links, stale-term search and diff hygiene |

Run targeted checks first; test counts are not a contract. If the first key failure permits one minimum fix, apply it and rerun the same check. If it still fails, stop without committing. Real Zotero, SMTP, LLM, network writes, full CI, full lint, and full workflow require explicit need and authorization.

### Commit and Documentation Synchronization

- Commit only a validated, focused change. Stage explicit files or hunks; never use `git add .`.
- Do not commit when required checks fail, remain blocked, or were not run without a stated reason.
- Changes to path boundaries, Stage contracts, identity/schema/path, translation, SMTP/formatter/receipt, retention/protection, or maintenance commands must update this section, the relevant `paperecho-workflow` reference, affected path Skill, and user README/config docs where applicable.
- Do not record commit hashes, one-off test counts, developer absolute paths, real addresses, temporary artifacts, or bug chronology as durable rules.

### Quick Navigation

- Main development Skill: `skills/paperecho-workflow/SKILL.md`
- Architecture: `skills/paperecho-workflow/references/architecture.md`
- Stage contracts: `skills/paperecho-workflow/references/stage-contracts.md`
- Identity/state/translation: `skills/paperecho-workflow/references/identity-and-storage.md`
- Stage5: `skills/paperecho-workflow/references/stage5-email.md`
- Housekeeping: `skills/paperecho-workflow/references/housekeeping.md`
- Validation: `skills/paperecho-workflow/references/validation.md`
- Skill execution: `skills/paperecho-workflow/references/execution.md`
- Adapter details: `skills/paperecho-zotero-desktop/`, `skills/paperecho-zotero-web/`, `skills/paperecho-local/`
- User guide: `README.md`; maintenance entry: `workflow/tools/README.md`
- Configuration guide: `docs/configuration.md`; template: `config/paperecho.config.example.json`

### 测试隔离与完整负载基准约定

- 新测试脚本、fixture、snapshot、manifest、日志和报告默认位于仓库根目录 `tests/`；运行产物仅放在 `tests/runs/` 且不得 commit，不得遗留到业务目录。
- 性能测试必须明确区分 smoke test 与完整负载测试；完整负载不得无说明抽样或截断候选。
- 双后端完整验收使用 `node tests/full_workflow_benchmark/run_dual_backend_benchmark.mjs`；使用同一完整 input snapshot/hash、配置、LLM/翻译模式、通知禁用状态和缓存基线。
- 输入捕获耗时、每端 production entry/Stage1-Stage5、cleanup、restore 和总墙钟分别报告；嵌套耗时不得直接相加。
- 每个后端使用独立 run id、recovery manifest、集合树和输出目录；只按 exact item/collection key 清理，不按标题、名称或日期推断 ownership。
- 每端首次和二次 cleanup、local state hash、正式输出清单与 recovery completion 全部通过后才算恢复完成；Desktop 恢复失败时禁止运行 Web。
- 正常去重热路径使用 local library index，不默认递归扫描 `文献池`、`待删除`、`值得精读`；缓存异常时 exact lookup、显式 reconciliation 或清晰失败，不静默漏判重复。
- 最终报告保留聚合计数、请求/进程数、性能和恢复证据，不输出完整日志、候选、资源 key、缓存或凭据。
