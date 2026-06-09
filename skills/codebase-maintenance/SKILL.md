---
name: codebase-maintenance
description: >
  Use this skill when the task is refactoring, or a maintenance related task, or when the task is adding new features. Uses programatic tools and methodologies to identify and report on code quality.
---

# Codebase Maintenance

Script paths below (e.g. `codebase-maintenance/find_large_files.py`) are relative
to the skill directory — resolve them against the path containing this SKILL.md
before running. For example, from a project root with `skills/codebase-maintenance/`,
the invocation becomes `uv run skills/codebase-maintenance/find_large_files.py`.

Execute these steps sequentially:

- Run tests, type checks and linters, check codebase documentation / files for commands to use. Fix the reported issues, then re-run this step until no findings remain.

- Run `uv run codebase-maintenance/find_large_files.py <directory>` to find source files that exceed a line-count threshold.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `[max_lines]` — line threshold; files over this are reported (default: 500)

    - After running, scan each file sequentially, analyse the file and make a call if the file size is justified or not.
    - Files that are single concern, and cannot be cleanly split into smaller modules may be justified in being large.
    - If a file is deemed to be unjustifiably large, refactor it into smaller modules before proceeding.

  After performing the refactors, run this step again, if there are no unjustifiably large files, proceed to the next step.

- Run `uv run codebase-maintenance/detect_smells.py <directory> [options]` to
  detect code smells and potential bugs via semgrep static analysis.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `--max-findings N` — cap printed findings (default: 50; 0 = unlimited)
  - `--exclude-categories CATEGORIES` — comma-separated categories to exclude
    (default: none — all findings shown)

  Fix the reported issues, then re-run this step until no findings remain.

- Run `uv run codebase-maintenance/analyze_complexity.py <directory> [options]` to
  measure file-level code complexity and quality scores via Qualitas.
  Note: Qualitas reports at the **file level**, not per-function. Extracting
  helpers within the same file won't reduce scores. Only moving code to
  separate modules improves file-level metrics. The `name` and `line` in
  output identify the primary flagged function, but scores reflect the
  whole file's identifiers and control flow.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `--max-findings N` — cap printed flagged functions (default: 50; 0 = unlimited)
  - `--min-grade GRADE` — minimum grade to show: A, B, C, D, F
    (default: `C` — shows C, D, F only)

  Review each flagged item. Refactor where practical -- extracting code to
  separate files, simplifying control flow, or splitting multi-concern modules.
  Domain-appropriate complexity (such as a request dispatcher or data
  transformation pipeline) is acceptable and need not be eliminated.

- Run `uv run codebase-maintenance/find_duplicates_and_dead_code.py <directory> [options]`
  to detect copy/paste duplicates (jscpd, 150+ languages) and unused code
  (skylos, Python/TS-JS/Java/Go/PHP/Rust/Dart) in a single pass. Use
  `--skip-duplicates` or `--skip-dead-code` to run only one tool.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `--max-findings N` — cap findings per section (default: 50; 0 = unlimited)
  - `--min-lines N` — jscpd: minimum duplicated lines per block (default: 5)
  - `--min-tokens N` — jscpd: minimum duplicated tokens per block (default: 50)
  - `--confidence N` — skylos: minimum confidence 0-100 (default: 60)
  - `--exclude-reasons REASONS` — skylos: comma-separated reason substrings to
    exclude (e.g. `"unused import,unused variable"`); findings whose trailing
    reason text matches a substring are dropped (default: none)
  - `--skip-duplicates` — run only skylos
  - `--skip-dead-code` — run only jscpd

  Review each duplicate and judge whether it is justified. Remove unused
  exports/files outright; for code intentionally retained (plugin re-exports,
  dynamic dispatch), add a `// skylos-ignore` annotation per the skylos docs.

  jscpd is downloaded on first run via npx and cached under `~/.npm/_npx/`;
  skylos is installed automatically by `uv run` via PEP 723 metadata. Both
  dependencies are transparent to callers. skylos's `--exclude-folder`
  accepts directory names only, so file-glob patterns from `.ignore`
  cannot be honoured — add a project-level skylos config to extend coverage.

## Ignoring files:

Make additions when you get cache, build or other similar 'noise' or non code files in the output of the above steps. \

- Patterns live in `codebase-maintenance/.ignore`.

- Patterns before any `context` line apply to every scan.

- Patterns after `context <working-directory>` only apply when the directory passed to the
script matches that working-directory path or glob.

- Ignore patterns are then evaluated relative to the scan root, and patterns ending in `/` match
directories.
