---
name: codebase-maintenance
description: >
  Use this skill when the task is refactoring, or a maintenance related task, or when the task is adding new features. Uses programatic tools and methodologies to identify and report on code quality.
---

# Codebase Maintenance

Execute these steps sequentially:

- Run tests, type checks and linters, check codebase documentation / files for commands to use. Fix the reported issues, then re-run this step until no findings remain.

- Run `uv run codebase-maintenance/find_large_files.py <directory>` to find source files that exceed a line-count threshold.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `[max_lines]` — line threshold; files over this are reported (default: 500)

    - After running, scan each file sequentially, analyse the file and make a call if the file size is justified or not.
    - Files that are single consern, and cannot be cleanly split into smaller modules may be justified in being large.
    - If a file is deemed to be unjustifiably large, refactor it into smaller modules before proceeding.

  After performing the refactors, run this step again, if there are no unjustifiably large files, proceed to the next step.

- Run `uv run codebase-maintenance/detect_smells.py <directory> [options]` to
  detect code smells and potential bugs via semgrep static analysis.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `--max-findings N` — cap printed findings (default: 50; 0 = unlimited)
  - `--exclude-categories CATEGORIES` — comma-separated categories to exclude
    (default: `security`)

  Fix the reported issues, then re-run this step until no findings remain.

- Run `uv run codebase-maintenance/analyze_complexity.py <directory> [options]` to
  measure function-level code complexity and quality scores via Qualitas.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `--max-findings N` — cap printed flagged functions (default: 50; 0 = unlimited)
  - `--min-grade GRADE` — minimum grade to show: A, B, C, D, F
    (default: `C` — shows C, D, F only)

  Fix the reported issues, then re-run this step until no findings remain.


## Ignoring files:

Make additions when you get cache, build or other similar 'noise' or non code files in the output of the above steps. \

- Patterns live in `codebase-maintenance/.ignore`.

- Patterns before any `context` line apply to every scan.

- Patterns after `context <working-directory>` only apply when the directory passed to the
script matches that working-directory path or glob.

- Ignore patterns are then evaluated relative to the scan root, and patterns ending in `/` match
directories.
