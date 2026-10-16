# Deterministic Skill Execution

## Ownership and Call Chain

Production execution has one fixed chain:

`path Skill -> path launcher -> shared Runner -> real production entry -> current run-group validation`

| Path | Unique launcher | Fixed mode | Real entry |
|---|---|---|---|
| Zotero Desktop | `node skills/paperecho-zotero-desktop/scripts/run.mjs` | `desktop` | `workflow/tools/stage0/main.mjs` with `ZOTERO_BACKEND=cli` |
| Zotero Web API | `node skills/paperecho-zotero-web/scripts/run.mjs` | `web` | `workflow/tools/stage0/main.mjs` with `ZOTERO_BACKEND=web_api` |
| Standalone Local | `node skills/paperecho-local/scripts/run.mjs` | `local` | `workflow/tools/local/main.mjs` |

The launcher fixes its mode, uses an argv array with `process.execPath`, and never selects another path. The shared Runner owns argument parsing, preflight, the single production-entry invocation, waiting, current-run validation, and a safe summary. It never copies Stage1–Stage5 or invokes the main Skill as a second process.

## Intent Routing

- Explicit production intent must invoke the selected path's launcher. If required parameters are present, use `--run`; the Runner always performs preflight first.
- Development or code-review intent must not invoke a production launcher. Use the nearest mock or targeted test.
- Explanation intent may explain the contract or use `--check`; it must not use `--run`.
- Loading a Skill is not production intent and causes no production side effect.
- “继续” means rerun the same launcher and a fresh preflight. It does not reuse old readiness, wait for configuration in the background, or switch paths.

## Arguments and Profiles

Read-only diagnostics use `node workflow/tools/runner/main.mjs --doctor [--config <json>]` or packaged `PaperEcho-headless.cmd --doctor`. This exclusive branch shares System Health's Doctor service, never invokes a production launcher/entry and does not change `--check`. PASS/WARN exit 0, FAIL exit 2, UNKNOWN exit 3. Runtime bootstrap/config resolution must use the existing owner's read-only option. See [Doctor contract](../../../docs/configuration.md#doctor--system-health).

The shared arguments are `--check` or `--run` (exactly one), optional `--config <json>`, `--profile standard|complete` (default `standard`), optional `--email <recipient>`, `--force-resend`, and `--require-llm`. Local additionally requires `--input <file-or-directory>` and `--output-root <path>` from CLI or unified config, with optional `--feedback <jsonl>`. Arguments containing spaces remain separate argv entries; do not construct shell command strings.

`standard` permits the production code's existing safe degradation: Stage5 skips without a recipient, missing SMTP does not block when mail was not requested, allowed LLM fallback is reported, a monthly report may be `NOT_DUE`, and Local Stage2/Stage3 are `NOT_APPLICABLE`. `complete` only strengthens features explicitly requested by the user: requested mail must be sent, and `--require-llm` must have real configuration plus observable non-fallback evidence. It never makes Zotero stages applicable to Local or forces a monthly report before it is due.

## Unified Configuration Resolution

The Runner loads schema v1 JSON from CLI `--config`, then `PAPERECHO_CONFIG`, then the optional `config/paperecho.config.json`. Absence of a unified file preserves legacy direct Runner behavior when `--mode` is explicit. Value precedence is CLI -> unified config -> environment/`.env` -> existing domain config/defaults; the unified file does not copy Stage1 search/rule or translation/preference parameter owners.

Mode precedence is direct Runner CLI `--mode`, config `mode`, then exactly one path section with `enabled=true`. Multiple enabled sections without a config mode and no identifiable path both block. Residual `ZOTERO_API_KEY`, `ZOTERO_BACKEND`, SMTP, or LLM values never select a mode. Each path launcher adds an internal fixed-mode marker; a configured different mode is a hard conflict, and the launcher never switches adapters.

Preflight exposes only `common` plus the selected path in `missingBySection`. Secret JSON fields contain environment-variable names, while summaries contain only names and configured booleans. On “继续”, rerun the same launcher with the same `--config` so the file is read again before preflight. Field definitions and examples live in the [configuration guide](../../../docs/configuration.md).

### Applying a filled setup template

When a user supplies the filled [setup template](../../../docs/paperecho-setup-template.md), Codex must:

1. Validate the common answers, count enabled path modules, and resolve one mode. Stop on no selection or an unresolved multi-path conflict; never use residual backend, API, SMTP, or LLM variables to guess.
2. Read and configure only `common` plus the selected path. A fixed path Skill keeps its own mode and must block a conflicting configured path rather than switch launchers.
3. Write non-secret Runner settings only to the machine-local `config/paperecho.config.json`. Write search/rule/model parameters only to their existing domain config owners; never add a second schema or put personal configuration in a Skill, source file, generated state, or manifest.
4. Keep secret values out of JSON, Markdown, chat, arguments, logs, and Git. If a user has not configured a secret locally, report only the environment-variable name. When explicitly authorized to update `.env` from a safe local source, preserve unknown keys, change only named keys, and never echo their values.
5. Run the selected launcher with `--check --config config/paperecho.config.json`. If blocked, report only sanitized missing items. If ready or warning, stop when the user selected check-only; invoke `--run` only when the filled intent explicitly authorizes production after preflight.
6. Do not stage or commit machine-local configuration. Documentation/template maintenance is a separate development task and may commit only validated non-personal files.

## Preflight and Blocked Recovery

`--check` performs only local reads: runtime/version, environment-variable presence, config parsing, file existence/readability, output-root writability, and executable location. It must not create a run or manifest, call Zotero/Web/LLM/SMTP/network, mutate state, run retention or ephemeral cleanup, or create a commit.

The schema v1 preflight model reports `ready`, `warning`, or `blocked`; required, feature, and optional missing lists; readiness; sanitized entry/arguments; `canRun`; warnings; and a secret-free retry command. Configuration errors list names and purposes, never values. Desktop checks the app and CLI bridge locally; Web requires `ZOTERO_API_KEY` but does not probe the API; Local validates JSON/JSONL input and a safe writable output root without checking any Zotero setting. SMTP becomes blocking only when a recipient is requested. Real LLM credentials become blocking only with `--require-llm`.

When blocked, do not invoke the production entry. Report only remaining missing items and the retry command. After the user supplies configuration outside chat and says “继续”, run the same launcher again; never assume the blocker was resolved or bypass preflight.

## Current-Run Validation

After the real entry exits, the Runner extracts that invocation's run ID and reads exactly `<runRoot>/<runId>/run_group.json`. It must not scan historical directories or guess the newest run. Success requires the original entry exit code, schema v1 completed manifest, matching run ID/mode, required Stage status, current XLSX registration, Stage5 `sent` or allowed `skipped`, and no explicitly requested feature failure. The summary also reports housekeeping warnings, ephemeral cleanup counters, and monthly `GENERATED`, `UPDATED`, `NOT_DUE`, or Local `NOT_APPLICABLE`.

Local always reports Stage2, Stage3, monthly Zotero behavior, and Zotero calls as `NOT_APPLICABLE`; its execution plan strips Zotero backend variables. Desktop and Web never auto-fallback to the other backend.

## Exit Codes and Safety

| Code | Meaning |
|---|---|
| `0` | success |
| `2` | missing/invalid configuration |
| `3` | invalid input or arguments |
| `4` | dependency not ready |
| `5` | production pipeline failed |
| `6` | current-run result validation failed |
| `7` | canceled by signal/user |

The launcher returns the Runner child exit code unchanged. The Runner preserves the production exit code in its failure summary while mapping the category above. Never print environment dumps, recipient values, passwords, API keys, or tokens. Do not ask users to paste secrets into chat. Production execution may write the documented runtime state and outputs but must not edit code, stage files, create commits, bypass client command approval, or claim background/asynchronous waiting.

Validate Runner or launcher changes with `node --test workflow/tests/runner_config.test.mjs`, `node --test workflow/tests/skill_execution_runner.test.mjs`, `node --check` for every changed Runner/launcher module, and temporary roots plus mock child processes only. Validate affected Skill changes with `quick_validate.py`; use an isolated `%TEMP%` venv when `PyYAML` is unavailable and never add it to project dependencies. These checks must not run a real production entry or access Zotero, SMTP, LLM, or network services.
