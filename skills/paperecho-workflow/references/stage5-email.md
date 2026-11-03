# Stage5 Email Reference

## Request and SMTP contract

Recipient priority is CLI `--email`, then `PAPERFLOW_REPORT_TO`, then legacy `NOTIFICATION_EMAIL`. No recipient returns `skipped: recipient_not_configured` before SMTP validation or transport creation.

`notification/policy.mjs` gates automatic delivery first: `common.email.enabled=false` or the current Radar/Weekly event preference disabled means no delivery requirement, no notification recovery operation, and normal business success. CLI recipient overrides do not enable a disabled channel/event. Schema v4 keeps event preferences under `common.notifications.radar/weekly`, separate from Email/SMTP configuration. Missing preferences retain prior enabled behavior.

SMTP is the only provider. PaperEcho supplies no relay.

| Setting | Contract |
|---|---|
| `SMTP_HOST` | required |
| `SMTP_USER` | required login account |
| `SMTP_PASS` | required secret; never log or persist |
| `SMTP_PORT` | optional; default `465`; integer 1-65535 |
| `SMTP_SECURE` | optional strict boolean; absent means true for 465 and false otherwise |
| `SMTP_FROM` | optional validated address; absent/empty falls back to `SMTP_USER` |

An explicit recipient with missing/invalid SMTP fails Stage5 clearly. It does not delete or roll back Stage1-Stage4 results. Tests inject a transport or Nodemailer loader and never connect to a real server.

## Control Center Email channel

- `lib/control_notification_service.mjs` owns the minimal application contract for the real Email channel. ConfigService owns ordinary settings, SecretService owns configured/writable status and Replace/Clear, and raw secrets never enter GET responses.
- Readiness means configuration is complete/incomplete/invalid; it does not claim verified SMTP connectivity. Disabled Email retains its settings and credentials.
- Explicit test notification is allowed with configured Email even while disabled. It renders `notification_test` content via `test_notification_report.mjs` and the shared layout, then calls existing delivery/receipt/SMTP owners. It does not enable Email, run business stages, change schedules, or write business ledger operations.
- Test receipts use the existing receipt schema at `<receipt-root>/tests/<requestId>.json`; the same request retains accepted/unknown no-repeat semantics. Application and UI both guard in-flight tests. Recent channel status is a sanitized projection of existing Weekly/Radar/test receipts; there is no second delivery-history store.

## Run Summary and formatter

- Run Summary schema v1 is built by `workflow/tools/lib/run_summary.mjs` for `desktop`, `web`, or `local`.
- Counts and grades are from literature created in the current run, not cumulative repository totals.
- `notification_content.mjs` owns Radar/Weekly content projection. `report_summary.mjs` retains its public formatter/view-model exports; `radar_report.mjs` renders Radar. Both HTML and plain text consume the same content, and `email_layout.mjs` owns the shared branded frame and escaping.
- Radar shows this message's actual selected recommendation count separately from complete candidate grades. Stage1 supplies `candidateCount` and `candidateGrades` from all `triagedItems`, including D; content accepts the distribution only for the matching Radar run with nonnegative integer counts totaling the denominator. Missing/invalid counts omit the grade block rather than inferring it from recommendations. Sending remains urgent-selection-only and silent for no urgent items. Rendering does not fetch, translate or regrade. Saved summary views keep their original replay rendering.
- Current body order is: created count -> A/B/C/D grades -> literature overview -> warnings -> footer.
- Attachments are carried by the mail transport but are intentionally not rendered as a body section.
- The body omits updated, feedback, translated, duration, deduped, SMTP, recipient, cache/internal state, absolute paths, and exact finish time.
- Warnings may summarize human-review items and pending screening-rule suggestions; path-like content is redacted.

## Literature overview

- Input is every normalized, title-deduplicated A/B/C title from the current-run created set. D titles, abstracts, and full text are excluded.
- Regular input uses one LLM call. Inputs over `OVERVIEW_INPUT_MAX_CHARS` are deterministically batched and then merged without dropping titles.
- Output is cleaned and capped by the production hard limit. The prompt requests a short Chinese overall summary, not per-paper summaries.
- `stage5/literature_overview.json` is schema v2 and keyed by the complete input hash. A force resend reuses the same cached overview.
- Missing/failed LLM uses a deterministic title fallback and does not block email.

## Attachments and state

- Weekly XLSX is no longer attached; its review takes place in the Control Center. Only the optional current-run `monthly_docx` may be attached.
- At most one attachment and 20 MiB total; it must be a real file inside Run Summary `outputRoot` with the expected extension.
- Stage5 never scans historical directories or guesses an attachment. A force resend after retained artifacts expire reports the missing/expired artifact.
- State root is `<runtime-root>/runs/<runId>/stage5/`: `email_receipt.json`, its short-lived lock, and `literature_overview.json`.
- Receipt schema v2 stores a recipient hash, not the address; v1 remains readable on the existing compatibility paths. Accepted/unknown receipts keep their existing no-repeat semantics.

## Notification-only resume

- `recovery/notification_recovery.mjs` is called by the existing formal `--resume` owner after lease, config and business artifact validation, before business reconcilers. Business stages must be verified (Radar write/export stages skipped); conflicting or incomplete evidence does not authorize mail retry.
- New business-email receipts optionally retain the shared content model and attachment hashes. No second receipt or ledger is created. No SMTP credentials or recipient address enter that replay data.
- Recovery renders the saved content with the shared renderer and verifies the original payload hash, deterministic message identity, ledger operation and recipient hash. Unchanged attachments are reused; retrieval, grading, LLM calls, Zotero writes and export are not rerun.
- `notification/delivery.mjs` remains the retry/lock owner and `stage5/email_sender.mjs` remains SMTP-only. Accepted receipts are adopted without sending; unknown or interrupted-after-attempt receipts are held. Missing replay content, changed payload/recipient/attachments and mismatched evidence fail closed, including old failed receipts without replay content.
- Successful recovery updates the existing ledger, Stage5 status and run manifest; Radar also records the existing selected fingerprints through its state owner. Repeated resume does not produce another effective send. A notification failure leaves completed business stages and their outputs intact; it keeps the delivery/run recovery status pending or failed until resolved.

## Required tests

Cover no-recipient skip, SMTP defaults/errors, formatter redaction/order, overview selection/batching/cache/fallback, attachment guards, run-scoped state, idempotency/force resend, Desktop/Web/Local entry integration, and secret absence. Use mock SMTP and mock LLM only.
