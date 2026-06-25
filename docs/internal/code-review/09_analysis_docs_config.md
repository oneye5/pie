# Code Review 09 — analysis/, scripts/, docs/, skills/, root config

Reviewer: skeptical senior-engineer scout pass (read-only). Scope per task brief.
Date: 2026-06-25. No fixes applied; findings only.

## Files reviewed

### analysis/scripts/ (6,701 LOC total)
- `source.ts` — 1,075 LOC (incl. ~400 LOC coercion block duplicated in extension)
- `duckdb.ts` — 961 LOC (schema CREATE TABLE/VIEW at 578+, query view registry 22-28)
- `contracts.ts` — 940 LOC
- `site-data.ts` — 900 LOC
- `prepare.ts` — 677 LOC
- `stratified-ranker.ts` — 458 LOC (13 exports; ranks models in bands, assigns buckets)
- `leaderboard.ts` — 424 LOC (global analytics leaderboard; single `createModelLeaderboard` export)
- `pricing.ts` 159, `source-auto.ts` 159, `serve-site.ts` 178
- `leaderboard-scoring.ts` 74 (shared constants; imported by leaderboard.ts AND site/app.ts)
- `complexity-scoring.ts` 128 (shared primitives; imported by stratified-ranker + app.ts)
- `model-family.ts` 102, `load-models.ts` 66, `cli.ts` 104, `build-db.ts` 35, `build-site.ts` 29, `export-site-data.ts` 40, `validate-site-data.ts` 82, `serve-site-paths.ts` 30, `query.ts` 43, `fs-utils.ts` 19, `hash.ts` 18

### analysis/test/ (5,916 LOC total)
- stratified-ranker.test.ts 1,175 / pipeline-e2e.test.ts 1,013 / leaderboard.test.ts 957 / prepare.test.ts 464 / source-reader.test.ts 450 / pricing.test.ts 294 / site-data.test.ts 230 / pruning-signals.test.ts 214 / dashboard-model-family.test.ts 187 / dashboard-leaderboard.test.ts 177 / complexity-scoring.test.ts 118 / source-auto.test.ts 137 / model-family.test.ts 102 / cost-charts.test.ts 90 / chart-stats.test.ts 83 / duckdb-query.test.ts 59 / serve-site.test.ts 62 / helpers.ts 30

### analysis/queries/ (8 SQL files)
- 001_core_runs.sql, model_leaderboard.sql, model_quality.sql, timeline.sql, tool_failures.sql, tool_usage.sql, treatment_comparison.sql, verification_impact.sql

### analysis/site/ (6,724 LOC)
- `app.ts` — **4,467 LOC** (single browser bundle entry)
- `charts/*.ts` (cost 276, questions 308, pruning 201, throughput 212, efficiency 203, settings 187, filetypes 104, interruptions 82, errors 75, inputs 51, toolduration 57, index 35)
- `lib.ts` 249, `chart-stats.ts` 217, `index.html` (17.5KB), `style.css` 9.5KB
- `dist/app.js` (2.0 MB) + `dist/app.js.map` (4.8 MB) — **NOT git-tracked** (gitignored `/analysis/site/dist/`)
- `data/*.json` (13 files incl. `pruning-impact.json` 1.34 MB) — **NOT git-tracked** (gitignored `/analysis/site/data/`)

### scripts/ (1,107 LOC, .mjs)
- run-tests.mjs 452, split-protocol.mjs 218, test-reporter.mjs 203, extract-reducer-handlers.mjs 156, replace-isrecord.mjs 78

### docs/ + docs/internal/ (1,900 LOC)
- CHANGED-FILES-UI-PLAN.md 513, EXPANDED-SECTION-UI-PLAN.md 326, ARCHITECTURE.md 222, internal/model-token-pricing-sources.md 273, internal/ollama-pro-cloud-models-ranked.md 113, internal/ARCH-OVERVIEW.md 151, internal/copilot-model-pricing.md 165, INDEX.md 43, STATE_CONTRACT.md 74, IDEAS.md 20

### skills/ (4,047 LOC)
- codebase-maintenance/: find_dead_code.py 746, find_markdown_drift.py 732, find_duplicates.py 667, analyze_complexity.py 494, find_large_files.py 379, detect_smells.py 321, SKILL.md 109
- diagnose/SKILL.md 116, grill-with-docs/SKILL.md 83 + DECISION-FORMAT.md 47 + DOC-FORMAT.md 50, tdd/SKILL.md 109 + 4 supporting .md

### root config
- package.json 1,712 B, settings.json 714 B, models.json 23,087 B, model-profiles.yaml 9,279 B, install.sh 6,035 B, install.ps1 18,839 B, AGENTS.md 1,863 B, README.md 5,437 B, TODO.md 260 LOC, APPEND_SYSTEM.md 821 B, auth.json 590 B (gitignored, NOT tracked), nul 246 B (Windows null-device artifact, gitignored)

## Notable issues

### Critical

**C1 — Destructive codemod with no idempotency / no backup.** `scripts/split-protocol.mjs:156-159` overwrites the source `protocol.ts` with a 1-line barrel on every run. If the `domainMap` (lines 7-100) misses an export, it is silently dropped and the original is gone (only VCS recovers). No backup file is written. A second run after a partial success would compound damage. Why it matters: a single-shot refactor script left in-tree as a footgun; any contributor re-running it loses code.

**C2 — Fragile brace-counting parser.** `scripts/replace-isrecord.mjs:34-50` counts braces to delimit the `isRecord` body but does not ignore braces inside strings, regex literals, template literals, or comments. Any `isRecord` body containing a closing brace in those contexts mis-terminates and corrupts output. Why it matters: silent source corruption on edge cases.

**C3 — Dead instructions in `skills/diagnose/SKILL.md`.** Line 29 references `scripts/hitl-loop.template.sh` (does not exist anywhere in repo — find returns nothing). Line 117 references the `improve-codebase-architecture` skill (only 4 skills exist: codebase-maintenance, diagnose, grill-with-docs, tdd). Why it matters: an agent following the diagnose skill will fail at step 29 and chase a nonexistent skill.

**C4 — Missing doc referenced from 3 live locations.** `docs/INSTALLATION_INFRA_PLAN.md` is cited by `package.json:4` (workspaces comment), `install.sh:13` and `install.sh:160`, but the file does not exist under `docs/` or `docs/internal/`. Historical analytics runs also logged ENOENT for it. Why it matters: dangling pointer in the canonical package manifest and the installer; the workspace-enablement rationale is undocumented.

### High

**H1 — Acknowledged ~400-LOC coercion duplication with manual-sync requirement.** `extension/src/host/run-analytics/coercion-rollups.ts` header (lines 1-9) states it is "a thin duplicate of the equivalent coercion logic in `analysis/scripts/source.ts` ... Keep constants and logic synchronized." Both files independently define `LEGACY_RESULT_ISSUE_KIND_MAP`, `TOOL_FAILURE_KINDS`, `createEmptyToolUsageRollup`, `splitRawFailureKindRecord`, `coerceToolUsageRollup` etc. (source.ts:92,176,303,401; coercion-rollups.ts ~46,~110,~190,~270). There is no shared module or test asserting equivalence. Why it matters: the failure-kind taxonomy and the legacy-remap logic can (and will) drift between the CLI and the extension UI, producing divergent dashboards. This is the real duplication the task brief flagged — *not* the leaderboard/complexity code, which is correctly shared via `complexity-scoring.ts` and `leaderboard-scoring.ts`.

**H2 — `docs/ARCHITECTURE.md` carries multiple stale file/contract references.**
- §5 step 2 names `backend-client.ts` as the backend line parser; no such file exists — the real parser is `extension/src/host/backend/client.ts` (`attachJsonlLineReader`, line ~230).
- §8 "Adding a new Command" step 6 points to `extension/src/host/extension-host.ts` for webview-to-Command conversion; actual conversion is in `extension/src/host/core/message-router.ts` (`MessageRouter.handle`); `extension-host.ts:481` only delegates.
- §8 "Adding a new Effect type" example namespace is `Notification`; the real namespace is `PostImperative` (`effects.ts:137-139`).
- §10 module map `extensions/` row lists 4 extensions (subagent, skill-pruner, cwd-skills, safeguard) but omits `ask-user` (5 exist).
- §2 & §11 reference `docs/internal/archive/ARCH-MIGRATION-PLAN.md` as a path; `docs/internal/archive/` does not exist (INDEX correctly says archived plans were removed to git history).
Why it matters: the architecture doc is the onboarding entry point and is wrong about file locations and the effect namespace; `docs/internal/ARCH-OVERVIEW.md` is internally inconsistent with it (ARCH-OVERVIEW uses the correct `PostImperative` and `message-router.ts`).

**H3 — `docs/internal/ARCH-OVERVIEW.md` references a non-existent file and a stale transport model.**
- Spine Files table, glossary, and "Where To Make Changes" all reference `backend-event-parser.ts` in `extension/src/host/core/` — does not exist. Parsing is in `backend/client.ts`, dispatch in `core/event-dispatch.ts`.
- Glossary "ArchState source" lists `host/core/reducer.ts`; the interface is defined in `extension/src/host/core/arch-state.ts:314`.
- Flow diagram + glossary describe a `Patch{sessionPath, ops}` per-session-revision transport, but `STATE_CONTRACT.md` (the authoritative doc) explicitly states "Transport is snapshots-only. Full snapshots carry the complete ViewState." ARCHITECTURE §3 agrees with STATE_CONTRACT. ARCH-OVERVIEW is the outlier and contradicts the contract.
- "Webview State Rules" still lists Token-rate telemetry as webview-local; STATE_CONTRACT and `extension/src/host/token-rate-service.ts` put it host-side (webview "just displays" `ViewState.tokenRateBySession`).
Why it matters: ARCH-OVERVIEW is wrong on the single most load-bearing contract (transport) and on the canonical file for ArchState; new contributors reading it first build a wrong mental model.

**H4 — `docs/EXPANDED-SECTION-UI-PLAN.md` status header is stale.** Header reads "Status: Open (planning). Not yet implemented." but the core is implemented: `expandedSectionMaxHeight` lives in `shared/protocol/settings.ts:124` (ChatPrefs), `:211` (DEFAULT 240), `protocol-validation.ts:151` (range 80-1600), `app-body.tsx:425` sets `--expanded-section-max-height`, `composer/ui-appearance-settings.tsx:365-374` has the slider, and `TurnActiveContext`/`turnActive` reads (D5) are gone. Only D8 is labeled "Implemented" inline; the rest is done but unlabeled. Why it matters: the doc presents finished work as a TODO, misleading planning.

**H5 — `install.sh` vs `install.ps1` feature asymmetry.** `install.sh` header (lines 11-13) admits it does NOT migrate sessions, does NOT patch `settings.json` `sessionDir`, and does NOT build/install the VS Code extension — all three are done by `install.ps1` (~120-180 sessions, ~180-235 settings, ~290-end extension build+vsix). Why it matters: macOS/Linux users get an incomplete install (no extension build, no session migration) vs Windows.

**H6 — `install.sh` uses `shasum` (BSD/macOS-only) for the auth-relocation checksum.** Lines 108-109 call `shasum -a 256`; on Linux without the Perl `shasum` script this is absent, and `set -euo pipefail` aborts the move mid-flight (after copy, before cleanup) with no `sha256sum` fallback. The script's own header claims "macOS / Linux". Why it matters: broken Linux install path for the auth-relocation step.

**H7 — `install.ps1` extension-build failure is reported as a warning, not a failure.** The whole extension build+vsix-install block is wrapped in try/catch that only `Write-Warning`s, so the script exits 0 even if `npm install` / `npm run build` / `npm run package` / `code --install-extension` fail. The most important step (installing the extension the user actually wants) can silently no-op. Why it matters: users believe the install succeeded with no extension.

**H8 — Codemods are CWD-relative and mutate source.** `scripts/extract-reducer-handlers.mjs`, `replace-isrecord.mjs`, `split-protocol.mjs` read/write via relative paths with no `repoRoot` resolution (contrast `run-tests.mjs:9` which derives root from `import.meta.url`). Run from the wrong directory → `readFileSync` throws or writes to the wrong place. `extract-reducer-handlers.mjs:47,84` uses whitespace-sensitive `src.includes(blockString)` and exits "Done" successfully even when it no-ops. Why it matters: easy to silently corrupt or no-op on source from outside the repo root.

### Medium

**M1 — `analysis/site/app.ts` is a 4,467-LOC single file.** The task brief flagged "oversized scripts (stratified-ranker, leaderboard)" but those are moderate (458 / 424 LOC) and well-factored. The genuine oversize problem is `app.ts` — one browser bundle entry holding the entire dashboard: it imports the shared scoring constants (`leaderboard-scoring.ts`, `complexity-scoring.ts`) and re-implements the leaderboard composite client-side. Also oversized: `source.ts` 1,075, `duckdb.ts` 961, `contracts.ts` 940, `site-data.ts` 900. Why it matters: app.ts is unmaintainable and is the browser entry — every change re-bundles the 2 MB output; no test file covers it directly (only chart-stats/cost-charts tests touch pieces).

**M2 — `analysis/README.md` silent on the stratified leaderboard and complexity scoring.** README documents the query set and site-data file list (both verified accurate vs `duckdb.ts:22-28` and `site-data.ts:622-630`) but does not mention `stratified-ranker.ts`, `complexity-scoring.ts`, or the distinction between the global analytics leaderboard and the stratified leaderboard — both of which `AGENTS.md` treats as first-class. Why it matters: a new contributor reading README to understand the pipeline misses half of it.

**M3 — `docs/internal/copilot-model-pricing.md` is self-superseded and dated.** Self-marked "Last updated: 2026-05-16" with a note that token pricing has been ingested into `models.json` and that `model-token-pricing-sources.md` is authoritative; the legacy multiplier-derived `cost` is "a fallback only." It also lists models not in the current ledger (GPT-5.4 nano, fine-tuned Raptor mini / Goldeneye). Why it matters: a stale reference doc still in the tree invites misreading as current pricing.

**M4 — `install.ps1` rewrites `settings.json` via JSON round-trip, losing key order/formatting.** Lines ~195,~215 do `ConvertFrom-Json | ConvertTo-Json -Depth 100`; the round-trip drops formatting, reorders keys, and `-Depth 100` is arbitrary. Backups (`*.session-dir.<guid>.bak`) make it recoverable but the diff is noisy. Why it matters: spurious settings churn and review noise.

**M5 — `install.ps1` VS Code path probe only checks the User install.** `Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'` does not probe the System install (`C:\Program Files\Microsoft VS Code\bin\code.cmd`) or Insiders before falling back to bare `code`. Why it matters: users with a system-wide VS Code install may silently use the wrong `code`.

**M6 — `install.ps1` ACL-hardening ordering.** In the auth-relocation block, `Remove-Item` (delete source) happens *before* `Set-Acl` is applied to the target; if `Set-Acl` throws under StrictMode, the source is already gone but the target has loose-ish ACL state. Why it matters: failed ACL on a credentials file left in a recoverable-but-not-locked state.

**M7 — `scripts/run-tests.mjs` has no per-child-process timeout.** Lines 237-255 spawn `tsx --test` children with no kill timer; a hung test stalls the runner indefinitely. Why it matters: CI hangs instead of failing.

**M8 — `scripts/run-tests.mjs` coverage thresholds are hardcoded per package (lines 16-54)** and drift from any `package.json`/`.nycrc` source of truth. Why it matters: thresholds silently decay from intent.

**M9 — `skills/grill-with-docs/DOC-FORMAT.md` references nonexistent example files.** Lists "Existing examples: `model-scoring-methodology.md`, `subagent-model-selection-v2.md`" — neither exists in `docs/`. Why it matters: the skill that teaches doc discipline cites nonexistent exemplars.

**M10 — Heavy copy-paste of ignore-file loading across the Python skill scripts.** `find_large_files.py` defines `load_ignore_patterns`/`normalize_path_token`/`scan_root_matches_context`/`collect_active_ignore_patterns`/`matches_ignore_pattern(s)`. `find_dead_code.py` (~50-200) and `find_duplicates.py` (~40-180) and `find_markdown_drift.py` (~60-150) copy-paste the same ~100+ LOC verbatim, while `analyze_complexity.py` and `detect_smells.py` instead `importlib`-load from `find_large_files.py` (lines 27-43). Inconsistent: 2 import, 3 duplicate. Why it matters: ignore-matching logic can (and likely will) drift across the duplicated copies.

**M11 — `find_large_files.py` `SKIP_DIRS` membership bug.** `SKIP_DIRS` contains `"*.egg-info"` but is checked via exact membership `part in SKIP_DIRS` (in `is_skipped`), not `fnmatch`, so `*.egg-info` can never match a literal directory part. Why it matters: the documented skip is dead.

**M12 — `find_duplicates.py` dead variable.** `_find_binary` computes `user_base = site.getsitepackages()[0] if site.getusersitepackages() else None` but never uses it (only `user_site` is used). `find_dead_code.py:_find_binary` does NOT have this dead line — divergence between the two duplicated helpers. Why it matters: copy-paste rot signal.

**M13 — `find_markdown_drift.py` coverage gap.** `_MD_LINK_RE` handles inline links and reference definitions (`[id]: url`) but not reference-style *uses* (`[text][id]`); the definition is extracted but the consuming reference `[see][missing]` is never resolved/checked, so broken reference links pass. Why it matters: a markdown-drift checker that misses a class of broken links.

### Low

**L1 — `models.json` (23 KB) and `model-profiles.yaml` (9 KB) are complementary, not duplicated.** The yaml header explicitly states "models.json remains the pricing authority via pricing.ts" and profiles only carry eligibility / thinking-level allowlists / fallback cost. So the task brief's "both define models?" suspicion is unfounded — this is an intentional split. Residual risk: two files both keyed by model id with no validator enforcing they agree on the id universe (a model in one but not the other is silent). Noting as Low because the design is sound, not duplicated.

**L2 — `TODO.md` is 260 LOC but actively maintained.** Latest commit 2026-06-25 (`f33934f`), many entries marked "DONE 2026-06-25" inline. Not stale, but it mixes live work-plans with completed entries; periodic pruning would help. The task brief's "size/age" concern is largely answered: it is large but current, not aged.

**L3 — `auth.json` present on disk (590 B) but NOT tracked** (`git check-ignore -v auth.json` → `.gitignore:2`). The task brief's "security (auth.json committed?)" flag is a non-issue. Good hygiene.

**L4 — Build artifacts NOT tracked and properly gitignored.** `analysis/site/dist/app.js` (2.0 MB), `app.js.map` (4.8 MB), and `analysis/site/data/*.json` (13 files, incl. 1.34 MB `pruning-impact.json`) are all covered by `.gitignore:37` (`/analysis/site/dist/`) and `.gitignore:67` (`/analysis/site/data/`). The task brief's "should they be committed?" concern is answered: they are not committed, and should not be. Good hygiene. The only residual smell is the 6.8 MB of generated output checked into the working tree locally (rebuildable).

**L5 — `nul` file committed-on-disk artifact.** A 246-B file named `nul` exists at root (Windows null-device redirect target) and is explicitly gitignored (`.gitignore` "Windows null device" comment). Not tracked. Cosmetic only.

**L6 — Three codemods are dated one-shots with no archival marker.** `extract-reducer-handlers.mjs`, `replace-isrecord.mjs`, `split-protocol.mjs` target completed refactors (extract-reducer-handlers, isrecord-to-isObjectRecord, protocol split) with no idempotency, no guards, no README. Candidates for deletion/archival to `scripts/one-shot/` or git history.

**L7 — `find_large_files.py` lacks PEP 723 metadata** while the other 5 Python scripts have `# /// script` blocks. `SKILL.md` documents `python find_large_files.py` vs `uv run` for the others — intentional but inconsistent runnability.

**L8 — `find_large_files.py` `CODE_EXTENSIONS` lists `.m` twice** (Objective-C `.m,.mm` and MATLAB `.m`); frozenset dedups harmlessly but signals copy-paste error and makes `.m` language ambiguous.

**L9 — `test-reporter.mjs:95` lowercases `failure.file`** — on case-sensitive filesystems could mis-dedupe failures that differ only by path case.

**L10 — `test-reporter.mjs:44,90`** reads `summary.duration_ms`/`details.duration_ms` from Node's internal test-reporter event shape — undocumented and version-fragile.

## Smaller nits

- `tool_usage.sql` correlated subquery for `average_satisfaction_when_unused` (lines 13-23) is correct but O(n²) over `runs`; fine at current scale, worth noting if run volume grows.
- `analysis/queries/model_leaderboard.sql` comment correctly states the TS composite in `leaderboard.ts` is authoritative and the query only mirrors display values — good separation, no SQL correctness bug. All columns referenced (`token_efficiency`, `first_attempt_success`, `verification_state`, `verification_count_bucket`, `started_day`, `verification_usage` table at `duckdb.ts:723`, `tool_usage`/`tool_failures` views at 25-26) exist in the schema. No SQL correctness issues found.
- `CHANGED-FILES-UI-PLAN.md` is marked "Implemented" and verified accurate; only incidental line-number refs are stale (`app-body.tsx:254-255` → actually 215; `arch-state.ts:354` → actually 319/361). Low.
- `docs/STATE_CONTRACT.md` verified consistent with code (`WEBVIEW_PROTOCOL_VERSION` `shared/protocol/core.ts:16`, `protocolVersion`/`hostInstanceId` `webview.ts:123-124`, `tokenRateBySession` `webview.ts:68`, host-side `TokenRateService`, snapshots-only transport). No drift.
- `docs/INDEX.md` every referenced doc exists; archived-plan entries correctly marked removed.
- `scripts/run-tests.mjs:13` hardcodes `npxCommand = 'npx'`; relies on `tsx` resolvable per-package. Low.
- `skills/diagnose/SKILL.md`, `skills/grill-with-docs/SKILL.md`, `skills/tdd/SKILL.md` references to `docs/ARCHITECTURE.md`, `docs/STATE_CONTRACT.md`, `AGENTS.md` all resolve. OK.
- Neither install script uses a download-and-pipe-to-shell pattern; both are local-only. No hardcoded `C:/Users/ocjla/...` user paths in scripts or installers (all env-derived: `$HOME`, `$env:USERPROFILE`, `$env:LOCALAPPDATA`, `$env:APPDATA`). Good.

## Summary of the task brief's hypotheses vs evidence

- **"committed build artifacts (dist/app.js + .map and data/*.json)?"** — No. Properly gitignored (`.gitignore:37,67`). Non-issue.
- **"security (auth.json committed?)"** — No. Gitignored (`.gitignore:2`), untracked. Non-issue.
- **"root config duplication (models.json + model-profiles.yaml both define models?)"** — Not duplication; intentional split (yaml = profiles/eligibility, json = providers+pricing). Low residual risk on id-universe sync. Non-issue.
- **"duplicated scoring logic between analysis/scripts and extension/src/host"** — Real (H1): coercion-rollups.ts ↔ source.ts, ~400 LOC, manual-sync acknowledged. The *scoring* logic (complexity/leaderboard) is correctly shared, not duplicated.
- **"oversized scripts (stratified-ranker, leaderboard)"** — Misframed; those are moderate (458/424) and well-factored. The real oversize is `app.ts` 4,467 + `source.ts` 1,075 + `duckdb.ts` 961 (M1).
- **"SQL query correctness"** — No bugs found; all referenced columns/tables/views exist; `model_leaderboard.sql` correctly defers to TS composite.
- **"docs drift vs code"** — Extensive (H2, H3, H4, M2, M3): ARCHITECTURE.md, ARCH-OVERVIEW.md, EXPANDED-SECTION-UI-PLAN.md, analysis/README.md, copilot-model-pricing.md.
- **"TODO.md size/age"** — Large but current (L2).
- **"install scripts quality"** — Multiple (H5-H8, M4-M6): feature asymmetry, `shasum` Linux breakage, silent extension-build failure, settings round-trip.
- **"dead/dated docs"** — copilot-model-pricing.md (M3), three one-shot codemods (L6), dead skill refs (C3, M9).
