# Stage5 Email Reference

## Request and SMTP contract

Recipient priority is CLI `--email`, then `PAPERFLOW_REPORT_TO`, then legacy `NOTIFICATION_EMAIL`. No recipient returns `skipped: recipient_not_configured` before SMTP validation or transport creation.

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

## Run Summary and formatter

- Run Summary schema v1 is built by `workflow/tools/lib/run_summary.mjs` for `desktop`, `web`, or `local`.
- Counts and grades are from literature created in the current run, not cumulative repository totals.
- HTML and plain text share `buildStage5ViewModel` in `report_summary.mjs`.
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
- Receipt schema v1 stores a recipient hash, not the address. A successful run ID plus recipient hash is idempotent unless `--force-resend` is supplied.

## Required tests

Cover no-recipient skip, SMTP defaults/errors, formatter redaction/order, overview selection/batching/cache/fallback, attachment guards, run-scoped state, idempotency/force resend, Desktop/Web/Local entry integration, and secret absence. Use mock SMTP and mock LLM only.
