# Stage Contracts

| Stage | Owner and responsibility | Inputs | Outputs | Paths | Must not do |
|---|---|---|---|---|---|
| Stage0 | `workflow/tools/stage0/main.mjs`; interval gate, backend readiness, ordered execution and final report | CLI/env/runtime config | orchestrator report and stage outcomes | Desktop, Web | Duplicate stage business logic or manually stitch child scripts |
| Stage1 | `workflow/tools/stage1/main.mjs`; retrieval/import boundary, normalization, identity dedupe, feedback learning, rule/LLM grading and audit artifacts | source config or injected Local candidates, previous feedback, standards | `triaged_items.json`, `writeback_ready_items.json`, `preference_learning_audit.json`, run report data | All three | Perform Zotero mutation; expand candidates from semantic neighbors |
| Stage2 | `workflow/tools/stage2/main.mjs`; guarded Zotero create, exact dedupe, collection routing, recovery and shared-index refresh | current-run admitted items and selected backend | `zotero_writeback_summary.json`, exact created keys and routing audit | Desktop, Web only | Run in Local; add new items to root `文献池`; mutate outside guard scope |
| Stage3 | `workflow/tools/stage3/main.mjs`; consume shared title translations, write and verify Zotero `shortTitle`, bounded pool scan | Stage2-admitted items/recent allowed scan candidates, shared translation cache | `abc_translation_backfill.json`, metadata verification | Desktop, Web only | Run in Local; become a second translation generator/cache; write outside admitted/scan scope |
| Stage4 | `workflow/tools/stage4/main.mjs` and export steps; map current results to user-facing workbook/monthly output and export audit | current-run sources, preference audit, Stage2/3 outcome as applicable | `周报.xlsx`, optional `月报-*.docx`, export audit/run summary | All three | Fetch literature, mutate Zotero, or infer historical attachments |
| Stage5 | `workflow/tools/stage5/main.mjs`; format Run Summary, generate/cache title overview, validate current-run attachments, send SMTP and persist receipt | Run Summary, current-run literature titles, recipient, run state root | notification result, `stage5/email_receipt.json`, `stage5/literature_overview.json` | All three after Stage4 | Import Zotero, scan history for attachments, expose secrets, or roll back prior stages |

## Cross-stage gates

- Desktop/Web Stage2 requires successful current-run Stage1 artifacts and backend readiness.
- Stage3 requires a successful/current Stage2 summary. Stage4 requires the configured Stage3 completion semantics.
- Local calls real Stage1 with `skipZotero: true`, then shared translation generation, then Stage4; its Zotero boundary counters must remain zero.
- Stage5 is outside Stage1-Stage4 rollback semantics. No recipient is `skipped`; a configured recipient with invalid SMTP is an explicit notification failure.

## Minimum regression category

- Research feedback: `research_evaluation_service.mjs` owns the existing events plus protected run-scoped preparation artifact. Stage0 prepares only after execution admission, publishes after verified Radar business or Weekly Stage4, and never waits for notification. Resume reuses prepared results and retries idempotent publication before notification recovery and after business reconciliation. Unknown in-flight generation is held, never automatically sent again. Approval/apply remains in the existing unified suggestion/RuleSuggestionService owners.

- Stage1 semantics: Stage1 artifact, dedupe, grading, and preference-learning tests closest to the change.
- Stage2/3 semantics: backend contract plus Desktop and Web adapter tests; use real benchmarks only with explicit authorization.
- Stage4 mapping: export-source/spreadsheet adapter tests and the path integration using it.
- Stage5: notification, overview, run-state, Run Summary, and relevant entry integration tests with mocks.
- Cross-path shared changes: Desktop/Web integration plus Local poison-boundary tests.
