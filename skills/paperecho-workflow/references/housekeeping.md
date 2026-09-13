# Housekeeping Reference

## Run groups

- Owner: `workflow/tools/lib/runtime_housekeeping.mjs`.
- Manifest: `<runtime-root>/runs/<runId>/run_group.json`, schema v1.
- Desktop/Web runtime root is the Research OS runtime with runs under the review root; Local runtime root and runs are under its configured output root.
- Manifest fields establish run identity, path mode, running/completed/failed status, timestamps, registered artifacts, retention class, and monthly aggregation protection.
- Retention classes are `protected`, `30d`, and `ephemeral`. Only registered `30d` artifacts of an eligible run group are age-deletion candidates.

## Retention contract

- `PAPERFLOW_CLEANUP_ENABLED` defaults to `true`.
- `PAPERFLOW_RETENTION_DAYS` defaults to `30`; `0` disables age deletion.
- The cutoff is strict: exactly 30 days old is retained, older completed runs may be eligible.
- Full scans run after the current manifest is created and before Stage1, at most once per 24 hours unless forced.
- Current, running/locked, unfinished, within-retention, and monthly-aggregation-pending runs are protected.
- Cleanup errors become warnings and do not change the Stage1-Stage5 business result.

## Protection and safety

Permanent/protected content includes every `月报-*.docx`, the three fixed screening-standard DOCX names, Local papers/learning/feedback state, shared and legacy/reserved index names (including `dedupe-index.json` when present), translation/runtime caches, `.env`, config, tests, fixtures, and README. User input and unregistered files are never inferred to be disposable.

Safety gates:

- Refuse an empty root, filesystem root, home directory, or repository root.
- Require every candidate to be a strict child of an allowed root.
- Reject symlinks and real paths that escape the allowed root; do not follow junction/symlink-like indirection.
- Refuse an artifact tree containing a protected name.
- Refuse a path shared with a protected run.
- Delete only manifest-owned paths; do not use a broad glob, name resemblance, date, or directory scan as ownership proof.

## Ephemeral cleanup

`workflow/tools/lib/ephemeral_registry.mjs` accepts only explicit files under allowed roots and never performs discovery. A registration records its owner stage, cleanup condition, closed/consumed state, and failure-preservation rule.

Current intended immediate candidates include closed `zotero-cli-import-*.json`, a Local `local_export_source.json` consumed by successful Stage4, and current-operation atomic `.tmp`/`.lock` files. Lookalikes that were not registered are untouched.

## Maintenance and resend

Preview the default run root without deletion:

```powershell
node workflow/tools/maintenance/cleanup_runs.mjs --dry-run --force
```

`--apply` is the explicit deletion switch. `--runs-dir`, `--retention-days`, and `--json` are maintenance overrides parsed by the CLI. Run-scoped Stage5 receipt/overview and retained attachments disappear with their run group, so resend is supported only while required artifacts remain.

## Required tests

Use temporary roots to cover config parsing, strict cutoff, grouped deletion, current/running/monthly protection, protected names, dangerous roots, path escape, symlink fail-closed, 24-hour marker/lock, dry-run versus apply, Local/Desktop/Web integration, and registry-only immediate cleanup.
# Control Center protected feedback

`paper_feedback.json` and `research_evaluations/` contain long-lived user feedback, not ephemeral run output. Preserve them during run retention. The optional Control Center does not own cleanup, scheduler state or run lifecycle; see [Control Center](../../../docs/control-center.md).
