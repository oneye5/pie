---
name: codebase-maintenance
description: >
  Use this skill when the task is refactoring, or a maintenance related task, or when the task is adding new features. Uses programatic tools and methodologies to identify and report on code quality.
---

# Codebase Maintenance

Execute these steps sequentially:

- Run tests, type checks and linters. If any fail, fix them before proceeding.

- Run `codebase-maintenance/find_large_files.py <directory> [max_lines]` to find
  source files that exceed a line-count threshold.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `[max_lines]` — line threshold; files strictly over this are reported (default: 500)

  **Output:** Files grouped by directory (largest-first). Directories with no
  over-threshold files are omitted. If no files exceed the threshold, prints
  `none ><N>loc`.

- Run `uv run codebase-maintenance/detect_smells.py <directory> [options]` to
  detect code smells and potential bugs via semgrep static analysis.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `--max-findings N` — cap printed findings (default: 50; 0 = unlimited)
  - `--rules CONFIG` — semgrep rule-set or local path (default: `p/default`)
  - `--exclude-categories CATEGORIES` — comma-separated categories to exclude
    (default: `security`)

  **Prerequisites:** Requires [uv](https://docs.astral.sh/uv/). The script declares
  semgrep as a dependency via PEP 723 inline metadata — `uv run` installs it
  automatically on first use.

  **Output:** One line per finding, sorted worst-first:
  ```
  src/handlers.py:42 [WARNING] Variable 'user' may be null
  src/db.py:108 [ERROR] SQL injection via string concatenation
  ```
  If no findings, prints `no findings`. If more findings exist than
  `--max-findings`, a one-line summary of the remainder is printed.

  **Category filtering:** By default, findings tagged `security` are excluded
  since this is a personal tool, not a distributed application. Pass
  `--exclude-categories ""` to include all categories, or
  `--exclude-categories security,performance` to exclude multiple.

- Run `python codebase-maintenance/analyze_complexity.py <directory> [options]` to
  measure function-level code complexity and quality scores via Qualitas.

  **Arguments:**
  - `<directory>` — root directory to scan (required)
  - `--max-findings N` — cap printed flagged functions (default: 50; 0 = unlimited)
  - `--min-grade GRADE` — minimum grade to show: A, B, C, D, F
    (default: `C` — shows C, D, F only)

  **Prerequisites:** Requires Node.js and npm. Qualitas is invoked via `npx`
  which downloads it on first use. No Python dependencies beyond stdlib.

  **Output:** One primary line per flagged function, sorted worst-first (lowest
  score first), with additional flag details indented below:
  ```
  src/handlers.ts:51 handleBackendRequest [F] score 31 — Cognitive flow complexity is 100 (threshold: 19)
    Halstead effort is 67075 (threshold: 5000)
    Identifier reference complexity is 879.4 (threshold: 71)
  ```
  If no flagged functions meet the grade filter, prints `no flagged functions`.

  **Supported languages:** TypeScript/JS, Python, Rust, Go, Java.

**Ignoring files:** Patterns live in `codebase-maintenance/.ignore`.
Patterns before any `context` line apply to every scan. Patterns after
`context <working-directory>` only apply when the directory passed to the
script matches that working-directory path or glob. Ignore patterns are then
evaluated relative to the scan root, and patterns ending in `/` match
directories.