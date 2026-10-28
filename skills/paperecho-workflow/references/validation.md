# Validation Reference

## Targeted matrix

| Change area | Minimum checks |
|---|---|
| Shared identity/index | `node --test workflow/tests/shared_literature_index.test.mjs` plus the nearest Stage1/Stage2 dedupe test |
| Desktop adapter | syntax check changed files; Desktop backend/contract test; Stage2 Desktop benchmark only when explicitly authorized |
| Web adapter | `node --test workflow/tests/zotero_backend.test.mjs` and nearest writeback test; real Web benchmark only when explicitly authorized |
| Local pipeline | `node --test workflow/tests/local_pipeline.test.mjs`; shared identity/translation/Stage4 test if touched; verify Zotero poison calls stay zero |
| Translation generation/cache | `node --test workflow/tests/title_translation_generation.test.mjs` and relevant cache/backfill test |
| Stage4 export | nearest export-source/spreadsheet compatibility test and affected path integration |
| Stage5 | `stage5_notification.test.mjs`, `literature_overview.test.mjs`, `stage5_run_state.test.mjs`, `run_summary.test.mjs`, and affected entry integration |
| Housekeeping | `runtime_housekeeping.test.mjs`, `cleanup_runs.test.mjs`, `ephemeral_registry.test.mjs`, and affected path integration |
| Documentation/Skill only | Skill validator, YAML/frontmatter parse, local Markdown links, stale-term search, `git diff --check` |

Do not hard-code test counts. Do not run full CI, full lint, all tests, a live Zotero workflow, SMTP, or real LLM unless the task requires it and the user authorizes external side effects.

## Safety assertions

Windows ACL/runtime changes require `workflow/tests/credential_acl_runtime.test.mjs`, credential and startup-location regressions, plus the existing packaging/ZIP/release tests. The packager validates the official self-contained PowerShell archive and includes its licenses; packaged GUI/Headless bind it before protected startup reads. Verify the final ZIP on an isolated Windows user without external `pwsh` discovery; a development-host runtime probe is not Guest evidence. Keep unavailable runtime, failed inspection and confirmed unsafe DACL failures distinct and fail closed.

- SMTP and overview tests inject mocks; no network request is allowed.
- Local tests poison Zotero readiness, backend factory, launcher, Stage2, and Stage3 boundaries.
- Filesystem lifecycle tests use temporary directories and never point cleanup at real runtime/user roots.
- Real backend benchmarks require an immutable input, unique run ID, exact recovery ownership, two cleanup checks, and restored local-state hashes.

## Documentation and Skill checks

Run the standard repo-local Skill validator from the installed `skill-creator` skill against each changed Skill. Then verify:

1. `SKILL.md` frontmatter contains only `name` and `description`.
2. `agents/openai.yaml` parses and its `default_prompt` names `$paperecho-workflow` for the main Skill.
3. Every local Markdown link and AGENTS navigation path exists.
4. No outdated alternate mail provider, six-required-SMTP, truncated/non-title overview, shared Stage5 state, or 14-day/keep-N cleanup rule remains in current docs.
5. `git diff --name-only` contains no production `.mjs`, fixture, lockfile, runtime data, or unrelated user change introduced by the task.

## Commit gate

Inspect `git diff --check`, `git diff --stat`, `git diff --name-only`, the final targeted diff, and `git status --short`. Stage only explicit task files or hunks. If a required check fails after one minimum repair, stop without committing.
