# Identity and Storage Reference

## Canonical identity

- Owner: `workflow/tools/lib/literature_identity.mjs`.
- Match priority: DOI -> PMID -> PMCID -> arXiv -> OpenAlex -> canonical URL -> normalized title.
- Normalization removes URL fragments, normalizes Unicode/punctuation/spacing, and uses exact normalized-title matching as the final fallback.
- Never fabricate an `itemKey`, `local_paper_id`, identifier, or presence namespace to make a match appear complete.

## Shared literature index

- Path: `review_results/shared/current_literature_index.json`.
- Current schema: v2 (`ZOTERO_LIBRARY_INDEX_SCHEMA_VERSION`). Schema v1 is accepted and normalized for compatibility.
- Owner: `workflow/tools/lib/zotero_library_index_store.mjs`.
- `records[*].presence.zotero` and `records[*].presence.local` are independent. Updating one preserves the other.
- `coverage.zotero.complete=true` permits a local miss to avoid an extra backend lookup. Missing or incomplete coverage requires exact backend fallback where the caller provides it.
- The old `review_results/zotero_index/current_library_index.json` is read only as a migration source when the shared file is absent; it is not a second authority.
- Writes take a shared lock, merge protected namespaces, write a same-directory temporary file, and atomically rename it.

## Local persistent state

All Local paths are relative to the configured output root:

| Path | Role | Lifecycle |
|---|---|---|
| `state/papers.json` | Local paper snapshots | persistent/protected |
| `state/learning-state.json` | preference audit pointer and consumed feedback event IDs | persistent/protected |
| `feedback/events.jsonl` | append-only feedback | persistent/protected |
| `runs/<runId>/timings.json` | per-run timing | 30-day run artifact |
| `runs/<runId>/run_group.json` | run ownership/lifecycle manifest | 30-day run state |
| `runs/<runId>/stage5/*` | receipt and overview | 30-day run state |
| `exports/<runId>/周报.xlsx` | user-facing run export | 30-day run artifact |

Local snapshots remove Zotero-only `itemKey`, collections, attachments, and rating. Local lookup keys are rebuilt in memory from `papers.json`; they do not form a second persisted authority beside the shared index.

## Translation state

- Pure generation boundary: `generateLiteratureTitleTranslations` in `workflow/tools/lib/title_translation_generation.mjs`.
- Shared field: `translatedTitle`.
- Shared cache: `review_results/translation_cache.json` from `title_translation_support.mjs`.
- Desktop, Web, and Local use the same generation/cache boundary. Local stores `translatedTitle` and stops; Stage3 writes Zotero `shortTitle` for Desktop/Web.
- Cache writes use a lock, same-directory temporary file, and atomic rename.

## Schema changes

Before changing a shared schema or path, identify readers, writers, legacy migration, lock/atomic-write behavior, housekeeping protection, fixtures, and all three path tests. Add compatibility or an explicit migration; never silently create a new authority beside the old one.
# Control Center feedback boundary

`control_feedback_service.mjs` owns `paper_feedback.json` under the review root. It reuses `literature_identity.mjs`, excludes title-only identity, keeps revision history, and uses lock/atomic replacement. Legacy XLSX import is explicit, one-way and idempotent; uncertain identity blocks import. DOCX remains an input/export adapter. See [Control Center compatibility](../../../docs/control-center.md) for scope and Local JSONL precedence.
