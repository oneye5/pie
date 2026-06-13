---
name: codebase-maintenance
description: >
  Use this skill when the task is refactoring, or a maintenance related task, or after making significant changes (ie after a major feature addition or architectural change). Uses programatic tools and methodologies to identify and report on code quality.
---

# Codebase Maintenance

This skill provides a structured static analysis workflow for improving code quality and maintainability.
Scripts are used to identify issues for review, you will then review the flagged issues and make informed
judgements on whether to refactor or ignore each item, flagging ambiguous cases for human review via the
ask user tool. This would look something like the following:
"The file at src/save.py exceeds the line threshold, however it is a single-concern module that may be
better left as is. Which of the following approaches should we take?"

Script paths below (e.g. `codebase-maintenance/find_large_files.py`) are relative to the skill directory.
Run any script with `--help` to see full argument documentation.

## Ignoring files

Make additions when you get cache, build or other similar 'noise' or non-code files in the output of the
above steps.

- Patterns live in `codebase-maintenance/.ignore`.
- Patterns before any `context` line apply to every scan.
- Patterns after `context <working-directory>` only apply when the directory passed to the script matches
  that working-directory path or glob.
- Ignore patterns are evaluated relative to the scan root; patterns ending in `/` match directories.

## Execution order

Execute the following steps sequentially:

### 1. Dead code

```bash
uv run codebase-maintenance/find_dead_code.py <directory> [options]
```

Dead code is the easiest win — unused functions, classes, imports, and files can often be removed
outright. Use `--verify-dead-code` to suppress false positives. For intentionally retained code
(plugin re-exports, dynamic dispatch), add a `// skylos-ignore` annotation.

**After removing dead code, re-run this script** to confirm findings are resolved. Then run your
project's type-checker and linter immediately — dead-code removal often exposes `unused-import` or
`no-unused-vars` violations that the scanner missed. Fix those before proceeding.

### 2. Code smells

```bash
uv run codebase-maintenance/detect_smells.py <directory> [options]
```

Semgrep detects bugs and code smells. Fix findings, then re-run until clean. Use
`--exclude-categories` to suppress noise.

### 3. Duplicates

```bash
uv run codebase-maintenance/find_duplicates.py <directory> [options]
```

Copy/paste duplicates across files (jscpd). Review each duplicate, some are
justified (shared config, test fixtures). Genuine duplicates should be extracted into shared
utilities. Use `--show-generated` to inspect lock-file / minified duplicates.

### 4. Complexity

```bash
uv run codebase-maintenance/analyze_complexity.py <directory> [options]
```

Quality scores via Qualitas. Note: Qualitas reports at the **file level** — extracting helpers
within the same file won't reduce scores. Only moving code to separate modules improves
file-level metrics. Domain-appropriate complexity (dispatchers, pipelines) need not be eliminated.

### 5. Large files

```bash
uv run codebase-maintenance/find_large_files.py <directory> [max_lines]
```

Files exceeding the line threshold (default: 500). Evaluate each — single-concern modules may
be fine as-is. Only refactor files that are genuinely multi-concern. Re-run after refactoring
to confirm all large files are justified.

### 6. Lint and test verification

Run the project's existing tests, type checks, and linters. Fix any regressions introduced by
earlier refactors, then re-run until clean.

### 7. .gitignore updates

Check for any new 'noise' files that should be ignored. Add clear cut cases to the `.ignore` file, and flag ambiguous cases for human review using the ask user tool.
