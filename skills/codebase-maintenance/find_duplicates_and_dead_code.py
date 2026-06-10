#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "skylos",
# ]
# ///
"""
Detect duplicate code blocks (jscpd) and dead code (skylos).

Usage:
    uv run find_duplicates_and_dead_code.py <directory> [options]

Combines two language-agnostic static analysis tools in one pass:

- jscpd (via npx): copy/paste / token-level duplicate detection across
  150+ languages. npx downloads jscpd on first use; no install step.
- skylos (via ``skylos`` on PATH, or ``uv run --with skylos skylos`` as
  fallback): unused functions, classes, and imports across Python,
  TypeScript, JavaScript, Java, Go, PHP, Rust, and Dart.

Both tools respect the shared .ignore file (see find_large_files.py for
format details). Duplicate findings are grouped into three categories —
cross-file, same-file, and generated-file — with generated findings
summarised by default (use --show-generated to list them).

Tool-specific ignore mapping:

- jscpd's --ignore-pattern accepts comma-separated globs, so every active
  pattern is passed through (trailing ``/`` is stripped because jscpd
  globs match both files and directories).
- skylos only exposes --exclude-folder NAME, which is a directory name and
  not a glob. Patterns ending in ``/`` and bare directory names map cleanly;
  file-level globs like ``*.min.js`` cannot be expressed and are reported on
  stderr (add a project-level skylos config to extend coverage).

Arguments:
    directory              Root directory to scan (required)
    --max-findings N       Cap findings per section (default 50; 0 = unlimited)
    --min-lines N          jscpd: minimum duplicated lines per block (default 8)
    --min-tokens N         jscpd: minimum duplicated tokens per block (default 70)
    --confidence N         skylos: minimum confidence 0-100 (default 60)
    --exclude-reasons REASONS
                           skylos: comma-separated reason substrings to exclude
                           (e.g. "unused import,unused variable") — findings
                           whose trailing reason text matches a substring are
                           dropped (default: none — all reasons shown)
    --show-generated       Include generated-file duplicate details in output
                           (hidden by default; generated files include lock
                           files, .min.* assets, and node_modules/)
    --verify-dead-code     Cross-reference skylos findings by searching for
                           the reported symbol across the codebase. Findings
                           whose symbol is referenced elsewhere are flagged as
                           likely false positives.
    --skip-duplicates      Run only skylos
    --skip-dead-code       Run only jscpd

Output:
    Duplicate findings are grouped into two sections:

        === Cross-file duplicates — 52 ===
          path/A.py:1-12 ~ path/B.py:1-12  12L 64T
          ...

        === Same-file duplicates — 91 blocks in 28 files ===
          stats-service.test.ts  12 blocks 238L
          ...

    Cross-file pairs show individual locations with line/token counts.
    Same-file duplicates are grouped by file with block count and total lines.
    Generated-file duplicates appear as a one-line size summary.

    Dead-code findings:

        === Dead code — 167 (63 unused import, 38 unused variable, 13 unused function, ...) ===
          extension/src/webview/panel/file-path.tsx  L14 unused function, L35 unused function, ...
          extension/src/host/session-service/events.ts  12 import
          ...

    Non-trivial findings (function, class, file) are grouped by file with
    line numbers. Trivial findings (import, variable) are aggregated by
    file with counts. A category summary appears in the header.

    With --verify-dead-code, only verified (likely dead) findings are printed
    and likely false positives are suppressed.

    Skipped sections print "=== Section — skipped ===". Sections with
    no findings print "=== Section — none ===". If a section
    exceeds --max-findings, a one-line remainder summary is printed.

Exit codes:
    0  no findings, or findings only (tool exit 1 remapped to 0)
    2  tool itself errored, missing dependency, or bad arguments
"""

import importlib.util
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# Re-use the shared ignore-file logic from find_large_files.py
# ---------------------------------------------------------------------------
_MODULE_PATH = Path(__file__).parent / "find_large_files.py"
try:
    _SPEC = importlib.util.spec_from_file_location("_find_large_files", _MODULE_PATH)
    _MOD = importlib.util.module_from_spec(_SPEC)  # type: ignore[arg-type]
    _SPEC.loader.exec_module(_MOD)  # type: ignore[union-attr]
except (FileNotFoundError, AttributeError) as exc:
    print(f"Error: could not load {_MODULE_PATH}: {exc}", file=sys.stderr)
    sys.exit(2)

load_ignore_patterns = _MOD.load_ignore_patterns
collect_active_ignore_patterns = _MOD.collect_active_ignore_patterns
matches_ignore_patterns = _MOD.matches_ignore_patterns

# ---------------------------------------------------------------------------
# Tool installation hints (mirrors detect_smells.py style)
# ---------------------------------------------------------------------------
NPX_HINT = (
    "Error: npx not found in PATH.\n"
    "jscpd is downloaded on first use via npx, which ships with Node.js/npm.\n"
    "Install Node.js from https://nodejs.org/ and re-run this script."
)
SKYLOS_HINT = (
    "Error: skylos not found in PATH and uv not found for fallback.\n"
    "Recommended: install uv (https://docs.astral.sh/uv/) and this script "
    "will use `uv run --with skylos skylos` automatically.\n"
    "Alternatively: pip install --user skylos, then re-run this script.\n"
    "Use --skip-dead-code to run duplicates only."
)

# Strip ANSI color escapes that skylos may emit even with --no-tips on some
# terminals. The concise format uses plain text but defensive trimming is cheap.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")

# Pattern for recognising generated / vendored / lock files.
_GENERATED_FILE_RE = re.compile(
    r'(?:^|/)('
    r'package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|poetry\.lock'
    r')$'
    r'|\.min\.(js|mjs|css)$'
    r'|(?:^|/)node_modules/'
)


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------
def to_rel_posix(raw: str, directory: Path) -> str:
    """Return *raw* as a posix path relative to *directory* when possible.

    Falls back to the file name when *raw* is not under *directory*. Mixed
    `\\` / `/` separators are normalised. Returns an empty string if no
    usable name can be extracted.
    """
    if not raw:
        return ""
    cleaned = raw.replace("\x00", "").strip().strip('"').strip("'")
    if not cleaned:
        return ""
    p = Path(cleaned)
    try:
        return p.resolve().relative_to(directory.resolve()).as_posix()
    except (ValueError, OSError):
        return p.name or cleaned


def _find_binary(name: str) -> str | None:
    """Find *name* on PATH, falling back to the user Scripts directory on Windows.

    Returns the absolute path if found, or None.
    """
    found = shutil.which(name)
    if found is not None:
        return found
    # On Windows, pip install --user puts scripts in a directory that may not
    # be on PATH. Check the user site-packages Scripts directory.
    if sys.platform == "win32":
        import site
        user_base = site.getsitepackages()[0] if site.getusersitepackages() else None
        # site.getusersitepackages() returns something like
        # C:\\Users\\<user>\\AppData\\Roaming\\Python\\Python311\\site-packages
        # The Scripts directory is two levels up in ..\\..\\Scripts
        user_site = site.getusersitepackages()
        if user_site:
            scripts_dir = Path(user_site).parent.parent / "Scripts"
            candidate = scripts_dir / f"{name}.exe"
            if candidate.is_file():
                return str(candidate)
    return None


def _is_generated_path(path: str) -> bool:
    """Return True if *path* looks like a generated or vendored file."""
    return bool(_GENERATED_FILE_RE.search(path))


def _extract_filepath(formatted: str) -> str:
    """Extract the file path from a formatted string like 'src/foo.py:1-12'."""
    idx = formatted.rfind(":")
    return formatted[:idx] if idx > 0 else formatted


# ---------------------------------------------------------------------------
# jscpd — duplicate detection
# ---------------------------------------------------------------------------
def _ignore_patterns_for_jscpd(active_patterns: list[str]) -> list[str]:
    """Translate shared .ignore patterns to jscpd --ignore-pattern globs.

    jscpd's --ignore-pattern accepts a comma-separated list of glob patterns
    (passed as a single value). Patterns ending in `/` are stripped because
    jscpd globs match both files and directories.
    """
    out: list[str] = []
    for p in active_patterns:
        if not p:
            continue
        # Strip directory marker — jscpd matches both files and dirs.
        out.append(p.rstrip("/"))
    return out


def run_jscpd(
    directory: Path,
    jscpd_argv: list[str],
    min_lines: int,
    min_tokens: int,
    ignore_globs: list[str],
) -> list[dict]:
    """Run jscpd and return its parsed ``duplicates`` array (possibly empty)."""
    with tempfile.TemporaryDirectory(prefix="jscpd-") as tmp:
        report_dir = Path(tmp)
        cmd: list[str] = [
            *jscpd_argv,
            "--silent",
            "--no-tips",
            "--reporters", "json",
            "--output", str(report_dir),
            "--min-lines", str(min_lines),
            "--min-tokens", str(min_tokens),
        ]
        if ignore_globs:
            cmd += ["--ignore-pattern", ",".join(ignore_globs)]
        cmd.append(str(directory))

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=600,
            )
        except subprocess.TimeoutExpired:
            print("Error: jscpd scan timed out after 600 s", file=sys.stderr)
            sys.exit(2)
        except OSError as exc:
            print(f"Error: could not run jscpd: {exc}", file=sys.stderr)
            sys.exit(2)

        # Read the JSON report while the temp dir still exists; the
        # ``with`` block tears it down as soon as we return.
        duplicates = _read_jscpd_report(report_dir) or []

    if result.returncode >= 2:
        if duplicates:
            return duplicates
        print(
            f"jscpd error (exit {result.returncode}): "
            f"{result.stderr.strip()[:500]}",
            file=sys.stderr,
        )
        sys.exit(result.returncode)

    return duplicates


def _read_jscpd_report(report_dir: Path) -> list[dict] | None:
    """Return the parsed ``duplicates`` list from jscpd's JSON report, if any.

    Returns ``None`` only when no report file could be read at all (so the
    caller can distinguish "no file" from "file present but empty"). Returns
    an empty list when a report file is present and parses but contains zero
    duplicates.
    """
    candidates = [
        report_dir / "jscpd-report.json",
        *report_dir.glob("**/jscpd-report.json"),
    ]
    seen: set[Path] = set()
    for path in candidates:
        if path in seen or not path.is_file():
            continue
        seen.add(path)
        try:
            data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        except (OSError, json.JSONDecodeError):
            continue
        duplicates = data.get("duplicates") or []
        return duplicates if isinstance(duplicates, list) else []
    return None


def format_duplicate(
    dup: dict, directory: Path,
) -> tuple[str, str, int, int] | None:
    """Extract (path1, path2, lines, tokens) from one jscpd duplicate record."""
    first = dup.get("firstFile") or {}
    second = dup.get("secondFile") or {}
    p1 = to_rel_posix(first.get("name", ""), directory)
    p2 = to_rel_posix(second.get("name", ""), directory)
    if not p1 or not p2:
        return None
    s1 = first.get("start") or first.get("startLoc", {}).get("line") or "?"
    e1 = first.get("end") or first.get("endLoc", {}).get("line") or "?"
    s2 = second.get("start") or second.get("startLoc", {}).get("line") or "?"
    e2 = second.get("end") or second.get("endLoc", {}).get("line") or "?"
    lines = int(dup.get("lines") or 0)
    tokens = int(dup.get("tokens") or 0)
    return (f"{p1}:{s1}-{e1}", f"{p2}:{s2}-{e2}", lines, tokens)


def print_duplicates(
    duplicates: list[dict], directory: Path, max_findings: int,
    show_generated: bool = False,
) -> int:
    """Print duplicate findings in a compact, agent-friendly format.

    Cross-file duplicates are listed individually.  Same-file duplicates are
    grouped by file with block counts and total lines.  Generated-file
    duplicates are shown as a one-line size summary by default.

    Returns the total number of duplicate pairs found (across all categories).
    Returns 0 when no duplicates exist or none could be formatted.
    """
    if not duplicates:
        print("=== Cross-file duplicates \u2014 none ===")
        print("=== Same-file duplicates \u2014 none ===")
        return 0

    # Sort by line count descending (worst-first), tie-break on tokens desc.
    pairs: list[tuple[str, str, int, int]] = []
    for dup in duplicates:
        formatted = format_duplicate(dup, directory)
        if formatted is not None:
            pairs.append(formatted)
    pairs.sort(key=lambda p: (p[2], p[3]), reverse=True)

    # Classify pairs into three categories.
    cross_file: list[tuple[str, str, int, int]] = []
    same_file: list[tuple[str, str, int, int]] = []
    generated: list[tuple[str, str, int, int]] = []

    for pair in pairs:
        a, b, lines, tokens = pair
        a_path = _extract_filepath(a)
        b_path = _extract_filepath(b)
        if _is_generated_path(a_path) or _is_generated_path(b_path):
            generated.append(pair)
        elif a_path == b_path:
            same_file.append(pair)
        else:
            cross_file.append(pair)

    total = len(pairs)

    # --- Cross-file: one line per pair ---
    if cross_file:
        print(f"=== Cross-file duplicates \u2014 {len(cross_file)} ===")
        shown = cross_file[:max_findings] if max_findings > 0 else cross_file
        for a, b, lines, tokens in shown:
            print(f"  {a} ~ {b}  {lines}L {tokens}T")
        remaining = len(cross_file) - len(shown)
        if remaining > 0:
            _print_bucket_summary(cross_file, len(shown), max_findings)
    else:
        print("=== Cross-file duplicates \u2014 none ===")

    # --- Same-file: grouped by file ---
    if same_file:
        print(f"=== Same-file duplicates \u2014 {len(same_file)} blocks in {_count_unique_files(same_file)} files ===")
        # Group by file path, sorted by total duplicated lines desc.
        file_groups: dict[str, list[tuple[str, str, int, int]]] = {}
        for pair in same_file:
            a_path = _extract_filepath(pair[0])
            file_groups.setdefault(a_path, []).append(pair)
        # Sort groups by total duplicated lines descending.
        sorted_groups = sorted(
            file_groups.items(),
            key=lambda item: sum(p[2] for p in item[1]),
            reverse=True,
        )
        shown_groups = sorted_groups[:max_findings] if max_findings > 0 else sorted_groups
        for filepath, group in shown_groups:
            total_lines = sum(p[2] for p in group)
            print(f"  {filepath}  {len(group)} blocks {total_lines}L")
        remaining = len(sorted_groups) - len(shown_groups)
        if remaining > 0:
            print(f"  ... {remaining} more files")
    else:
        print("=== Same-file duplicates \u2014 none ===")

    # --- Generated: conditional display ---
    if generated:
        if show_generated:
            buckets: dict[str, int] = {}
            for _a, _b, lines, _tokens in generated:
                if lines >= 50:
                    key = "50+L"
                elif lines >= 20:
                    key = "20-49L"
                else:
                    key = "<20L"
                buckets[key] = buckets.get(key, 0) + 1
            parts = [f"{v} {k}" for k, v in sorted(buckets.items(), reverse=True)]
            print(f"=== Generated-file duplicates \u2014 {len(generated)} ({', '.join(parts)}) ===")
        else:
            print(f"=== Generated-file duplicates \u2014 {len(generated)} (use --show-generated for details) ===")

    return total


def _count_unique_files(pairs: list[tuple[str, str, int, int]]) -> int:
    """Count unique file paths in a list of duplicate pairs."""
    seen: set[str] = set()
    for a, b, _lines, _tokens in pairs:
        seen.add(_extract_filepath(a))
        seen.add(_extract_filepath(b))
    return len(seen)


def _print_bucket_summary(
    pairs: list[tuple[str, str, int, int]],
    shown_count: int,
    max_findings: int,
) -> None:
    """Print a compact line-bucket summary for pairs beyond the cap."""
    remainder = pairs[shown_count:]
    buckets: dict[str, int] = {}
    for _a, _b, lines, _tokens in remainder:
        if lines >= 50:
            key = "50+L"
        elif lines >= 20:
            key = "20-49L"
        else:
            key = "<20L"
        buckets[key] = buckets.get(key, 0) + 1
    parts = [f"{v} {k}" for k, v in sorted(buckets.items(), reverse=True)]
    print(f"  ... {len(remainder)} more: {', '.join(parts)}")


# ---------------------------------------------------------------------------
# skylos — dead-code detection
# ---------------------------------------------------------------------------
def _patterns_for_skylos(active_patterns: list[str]) -> tuple[list[str], list[str]]:
    """Split shared .ignore patterns into (exclude_folders, dropped_globs).

    skylos exposes only ``--exclude-folder NAME`` (a directory name, not a
    glob) and ``--file-filter PATTERN`` (which is an **include** filter, not
    an exclude). The shared .ignore file mixes directory markers, bare
    directory names, and file-level globs like ``*.min.js`` — only the first
    two categories can be expressed. Glob patterns are returned in the
    second tuple so the caller can warn that they cannot be honoured by
    skylos, and so users can decide whether to live with the gap or add a
    project-level skylos config.
    """
    folders: list[str] = []
    dropped: list[str] = []
    for p in active_patterns:
        if not p:
            continue
        if p.endswith("/"):
            folders.append(p.rstrip("/"))
        elif any(ch in p for ch in "*?["):
            # Glob pattern — skylos has no file-level exclude.
            dropped.append(p)
        else:
            # Bare name with no glob chars — treat as a directory.
            folders.append(p)
    return folders, dropped


def run_skylos(
    directory: Path,
    skylos_argv: list[str],
    confidence: int,
    exclude_folders: list[str],
) -> list[str]:
    """Run skylos --format concise and return the (already-trimmed) finding lines."""
    cmd: list[str] = [
        *skylos_argv,
        "--format", "concise",
        "--confidence", str(confidence),
    ]
    for folder in exclude_folders:
        cmd += ["--exclude-folder", folder]
    cmd.append(str(directory))

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
    except subprocess.TimeoutExpired:
        print("Error: skylos scan timed out after 600 s", file=sys.stderr)
        sys.exit(2)
    except OSError as exc:
        print(f"Error: could not run skylos: {exc}", file=sys.stderr)
        sys.exit(2)

    # skylos exit 0 = clean, 1 = findings (not an error).
    if result.returncode >= 2:
        print(
            f"skylos error (exit {result.returncode}): "
            f"{result.stderr.strip()[:500]}",
            file=sys.stderr,
        )
        sys.exit(result.returncode)

    lines: list[str] = []
    for raw in result.stdout.splitlines():
        line = _ANSI_RE.sub("", raw).rstrip()
        if line.strip():
            lines.append(line)
    return lines


def _normalise_skylos_line(line: str, directory: Path) -> str | None:
    """Rewrite a skylos concise line so the path is relative to *directory*.

    Skylos prints ``<abs_path>:<line>  <reason>``. We keep the format but
    replace the absolute prefix with a relative posix path. Lines that don't
    match the expected shape are returned unchanged.
    """
    m = re.match(r"^(?P<path>.+?):(?P<line>\d+)(?P<rest>.*)$", line)
    if not m:
        return line
    abs_path = m.group("path")
    rel = to_rel_posix(abs_path, directory)
    if rel and rel != abs_path:
        return f"{rel}:{m.group('line')}{m.group('rest')}"
    return line


def _extract_symbol_from_line(line_text: str) -> str | None:
    """Extract the identifier name from a source line.

    Looks for common declaration keywords (function, class, const, etc.)
    followed by an identifier. Returns the identifier, or None if no
    recognisable pattern is found.
    """
    patterns = [
        r'(?:async\s+)?function\s+([A-Za-z_]\w*)',
        r'class\s+([A-Za-z_]\w*)',
        r'(?:const|let|var)\s+([A-Za-z_]\w*)',
        r'interface\s+([A-Za-z_]\w*)',
        r'type\s+([A-Za-z_]\w*)',
        r'enum\s+([A-Za-z_]\w*)',
        r'export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)',
        r'export\s+(?:default\s+)?class\s+([A-Za-z_]\w*)',
        r'export\s+(?:const|let|var)\s+([A-Za-z_]\w*)',
        r'def\s+([A-Za-z_]\w*)',
    ]
    for pat in patterns:
        m = re.search(pat, line_text)
        if m:
            return m.group(1)
    return None


def _rg_search_symbol(
    symbol: str, def_file: str, directory: Path, active_patterns: list[str],
) -> bool:
    """Use ripgrep to search for *symbol* as a word-boundary match.

    Returns True if the symbol appears in any file other than *def_file*
    (respecting .ignore patterns).
    """
    try:
        result = subprocess.run(
            ["rg", "-l", "--word-regexp", symbol, str(directory)],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (subprocess.TimeoutExpired, OSError):
        return False

    if result.returncode not in (0, 1):  # 0 = matches, 1 = no matches
        return False

    for line in result.stdout.splitlines():
        if not line.strip():
            continue
        try:
            rel = Path(line.strip()).relative_to(directory).as_posix()
        except (ValueError, OSError):
            rel = line.strip()
        if rel == def_file:
            continue
        if matches_ignore_patterns(rel, active_patterns):
            continue
        return True
    return False


def _python_search_symbol(
    symbol: str, def_file: str, directory: Path, active_patterns: list[str],
) -> bool:
    """Fall back to a pure-Python search for *symbol* as a word-boundary match.

    Returns True if the symbol appears in any file other than *def_file*
    (respecting .ignore patterns).
    """
    pattern = re.compile(r'\b' + re.escape(symbol) + r'\b')
    for path in directory.rglob("*"):
        if not path.is_file():
            continue
        try:
            rel = path.relative_to(directory).as_posix()
        except ValueError:
            continue
        if rel == def_file:
            continue
        if matches_ignore_patterns(rel, active_patterns):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except (OSError, UnicodeDecodeError):
            continue
        if pattern.search(text):
            return True
    return False


def _verify_dead_code(
    findings: list[str], directory: Path, active_patterns: list[str],
) -> tuple[list[str], list[str]]:
    """Verify skylos findings by cross-referencing symbol usage.

    For each finding, parses the path and line number, reads the symbol
    from the source, and searches for it across the codebase. Findings
    whose symbol appears in other files are classified as likely false
    positives.

    Returns (verified_dead, likely_false_positives).
    """
    verified: list[str] = []
    false_positives: list[str] = []

    rg_available = shutil.which("rg") is not None

    for finding in findings:
        # Parse "path:line  reason"
        m = re.match(r"^(.+?):(\d+)\s{2}(.+)$", finding)
        if not m:
            verified.append(finding)
            continue

        file_path_str, line_num_str, _reason = m.groups()
        line_num = int(line_num_str)
        file_path = directory / file_path_str

        try:
            lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except (OSError, IOError):
            verified.append(finding)
            continue

        if line_num < 1 or line_num > len(lines):
            verified.append(finding)
            continue

        source_line = lines[line_num - 1]
        symbol = _extract_symbol_from_line(source_line)
        if symbol is None:
            verified.append(finding)
            continue

        # Search for the symbol across the codebase.
        if rg_available:
            is_used = _rg_search_symbol(symbol, file_path_str, directory, active_patterns)
        else:
            is_used = _python_search_symbol(symbol, file_path_str, directory, active_patterns)

        if is_used:
            false_positives.append(finding)
        else:
            verified.append(finding)

    return verified, false_positives


def print_dead_code(
    skylos_lines: list[str], directory: Path, max_findings: int,
    skip_header: bool = False,
) -> int:
    """Print dead-code findings in a compact, agent-friendly format.

    Prints a one-line category summary, then groups findings:
    - Non-trivial types (function, class, file) are listed by file with
      line numbers.
    - Trivial types (import, variable) are aggregated by file with counts.

    Returns the total number of findings found.
    """
    if not skylos_lines:
        if not skip_header:
            print("=== Dead code \u2014 none ===")
        return 0

    rewritten = list(filter(None, [_normalise_skylos_line(l, directory) for l in skylos_lines]))

    # Classify each finding by type and file.
    # Skylos concise format: "path:line  reason"
    finding_type: dict[str, str] = {}   # line_text -> normalised type
    for line in rewritten:
        tail = line.split("  ", 1)[-1].strip().lower()
        if "function" in tail:
            finding_type[line] = "function"
        elif "class" in tail:
            finding_type[line] = "class"
        elif "file" in tail and ("not imported" in tail or "unused" in tail):
            finding_type[line] = "file"
        elif "import" in tail:
            finding_type[line] = "import"
        elif "variable" in tail:
            finding_type[line] = "variable"
        else:
            finding_type[line] = tail  # keep original for unknown types

    # Category summary line.
    cat_counts: dict[str, int] = {}
    for ft in finding_type.values():
        cat_counts[ft] = cat_counts.get(ft, 0) + 1
    if not skip_header:
        summary_parts = [f"{v} {k}" for k, v in sorted(cat_counts.items(), key=lambda x: x[1], reverse=True)]
        print(f"=== Dead code \u2014 {len(rewritten)} ({', '.join(summary_parts)}) ===")

    # Separate non-trivial (function, class, file) from trivial (import, variable).
    non_trivial = [line for line in rewritten if finding_type.get(line) in ("function", "class", "file")]
    trivial = [line for line in rewritten if finding_type.get(line) not in ("function", "class", "file")]

    # --- Non-trivial: group by file, list with line numbers ---
    if non_trivial:
        file_groups: dict[str, list[str]] = {}
        for line in non_trivial:
            m = re.match(r"^(.+?):(\d+)", line)
            filepath = m.group(1) if m else line.split()[0]
            file_groups.setdefault(filepath, []).append(line)
        # Sort groups by count desc, then filepath.
        sorted_groups = sorted(
            file_groups.items(),
            key=lambda item: (-len(item[1]), item[0]),
        )
        shown_groups = sorted_groups[:max_findings] if max_findings > 0 else sorted_groups
        for filepath, lines in shown_groups:
            # Extract just "line type" for compactness.
            entries = []
            for line in lines:
                m = re.match(r"^.+?:(\d+)\s{2}(.+)", line)
                if m:
                    entries.append(f"L{m.group(1)} {m.group(2).strip()}")
                else:
                    entries.append(line.strip())
            print(f"  {filepath}  {', '.join(entries)}")
        remaining = len(sorted_groups) - len(shown_groups)
        if remaining > 0:
            print(f"  ... {remaining} more files")

    # --- Trivial: aggregate by file with type counts ---
    if trivial:
        file_type_counts: dict[str, dict[str, int]] = {}
        for line in trivial:
            m = re.match(r"^(.+?):(\d+)", line)
            filepath = m.group(1) if m else line.split()[0]
            ft = finding_type.get(line, "other")
            file_type_counts.setdefault(filepath, {})
            file_type_counts[filepath][ft] = file_type_counts[filepath].get(ft, 0) + 1
        # Sort files by total trivial count desc.
        sorted_files = sorted(
            file_type_counts.items(),
            key=lambda item: (-sum(item[1].values()), item[0]),
        )
        shown_files = sorted_files[:max_findings] if max_findings > 0 else sorted_files
        for filepath, type_counts in shown_files:
            tc_parts = [f"{v} {k}" for k, v in sorted(type_counts.items(), key=lambda x: x[1], reverse=True)]
            print(f"  {filepath}  {', '.join(tc_parts)}")
        remaining = len(sorted_files) - len(shown_files)
        if remaining > 0:
            print(f"  ... {remaining} more files")

    return len(rewritten)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> tuple[Path, int, int, int, int, bool, bool, set[str], bool, bool]:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        if len(sys.argv) < 2:
            print(
                "usage: find_duplicates_and_dead_code.py <directory> "
                "[--max-findings N] [--min-lines N] [--min-tokens N] "
                "[--confidence N] [--exclude-reasons REASONS] "
                "[--show-generated] [--verify-dead-code] "
                "[--skip-duplicates] [--skip-dead-code]",
                file=sys.stderr,
            )
        sys.exit(2)

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {sys.argv[1]}", file=sys.stderr)
        sys.exit(2)

    max_findings = 50
    min_lines = 8
    min_tokens = 70
    confidence = 60
    skip_duplicates = False
    skip_dead_code = False
    show_generated = False
    verify_dead_code = False
    exclude_reasons: set[str] = set()

    i = 2
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == "--max-findings" and i + 1 < len(sys.argv):
            try:
                max_findings = int(sys.argv[i + 1])
            except ValueError:
                print("error: --max-findings must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--min-lines" and i + 1 < len(sys.argv):
            try:
                min_lines = int(sys.argv[i + 1])
            except ValueError:
                print("error: --min-lines must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--min-tokens" and i + 1 < len(sys.argv):
            try:
                min_tokens = int(sys.argv[i + 1])
            except ValueError:
                print("error: --min-tokens must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--confidence" and i + 1 < len(sys.argv):
            try:
                confidence = int(sys.argv[i + 1])
            except ValueError:
                print("error: --confidence must be an integer", file=sys.stderr)
                sys.exit(2)
            i += 2
        elif a == "--exclude-reasons" and i + 1 < len(sys.argv):
            exclude_reasons = set(r.strip() for r in sys.argv[i + 1].split(",") if r.strip())
            i += 2
        elif a == "--show-generated":
            show_generated = True
            i += 1
        elif a == "--verify-dead-code":
            verify_dead_code = True
            i += 1
        elif a == "--skip-duplicates":
            skip_duplicates = True
            i += 1
        elif a == "--skip-dead-code":
            skip_dead_code = True
            i += 1
        else:
            print(f"unknown argument: {a}", file=sys.stderr)
            sys.exit(2)

    if skip_duplicates and skip_dead_code:
        print(
            "error: --skip-duplicates and --skip-dead-code cannot both be set "
            "(nothing would run)",
            file=sys.stderr,
        )
        sys.exit(2)
    if min_lines < 1 or min_tokens < 1:
        print("error: --min-lines and --min-tokens must be >= 1", file=sys.stderr)
        sys.exit(2)
    if not 0 <= confidence <= 100:
        print("error: --confidence must be in 0..100", file=sys.stderr)
        sys.exit(2)

    return (
        directory,
        max_findings,
        min_lines,
        min_tokens,
        confidence,
        skip_duplicates,
        skip_dead_code,
        exclude_reasons,
        show_generated,
        verify_dead_code,
    )


def _locate_jscpd() -> list[str]:
    """Return the argv prefix for invoking jscpd via npx.

    jscpd is an npm package — not a Python dep, so the PEP 723 metadata
    can't install it. We invoke it via ``npx --yes jscpd`` which downloads
    the package on first use and caches it under ``~/.npm/_npx/``. This
    matches the convention used by analyze_complexity.py for Qualitas and
    means callers don't need to install anything beyond Node.js itself.
    """
    npx = _find_binary("npx")
    if npx is None:
        print(NPX_HINT, file=sys.stderr)
        sys.exit(2)
    # On Windows, ``npx`` is a ``.cmd`` shim and Python's subprocess does
    # not auto-resolve the ``.cmd`` extension when invoked with a list.
    # ``shutil.which`` returns the full path including the extension.
    return [npx, "--yes", "jscpd"]


def _locate_skylos() -> list[str]:
    """Return the argv prefix for invoking skylos.

    Tries, in order:
      1. ``skylos`` on PATH (fast path, no venv overhead).
      2. ``uv run --with skylos skylos`` (uv downloads skylos into an
         isolated venv on the fly; much friendlier than requiring a
         manual install).
      3. Exits with SKYLOS_HINT if neither is available.
    """
    skylos = _find_binary("skylos")
    if skylos is not None:
        return [skylos]
    uv = _find_binary("uv")
    if uv is not None:
        return [uv, "run", "--with", "skylos", "skylos"]
    print(SKYLOS_HINT, file=sys.stderr)
    sys.exit(2)


def main() -> None:
    (
        directory,
        max_findings,
        min_lines,
        min_tokens,
        confidence,
        skip_duplicates,
        skip_dead_code,
        exclude_reasons,
        show_generated,
        verify_dead_code,
    ) = parse_args()

    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)
    active_patterns = collect_active_ignore_patterns(
        directory, global_patterns, context_patterns,
    )

    # --- Duplicates (jscpd) ---
    if skip_duplicates:
        print("=== Duplicates \u2014 skipped ===")
    else:
        jscpd_argv = _locate_jscpd()
        jscpd_ignore = _ignore_patterns_for_jscpd(active_patterns)
        duplicates = run_jscpd(
            directory, jscpd_argv, min_lines, min_tokens, jscpd_ignore,
        )
        print_duplicates(duplicates, directory, max_findings, show_generated=show_generated)

    # --- Dead code (skylos) ---
    print()
    if skip_dead_code:
        print("=== Dead code \u2014 skipped ===")
    else:
        skylos_argv = _locate_skylos()
        exclude_folders, dropped_globs = _patterns_for_skylos(active_patterns)
        if dropped_globs:
            print(
                f"# note: {len(dropped_globs)} .ignore glob pattern(s) cannot be "
                f"expressed as skylos --exclude-folder and were dropped "
                f"(skylos has no file-level exclude). Add a project-level "
                f"skylos config to extend coverage.",
                file=sys.stderr,
            )
        findings = run_skylos(
            directory, skylos_argv, confidence, exclude_folders,
        )
        if exclude_reasons:
            findings = [l for l in findings if l.split("  ", 1)[-1].strip() not in exclude_reasons]

        if verify_dead_code:
            verified, false_positives = _verify_dead_code(findings, directory, active_patterns)
            total = len(verified) + len(false_positives)
            header = f"=== Dead code \u2014 {len(verified)} verified of {total}"
            if false_positives:
                header += f" ({len(false_positives)} likely false positives suppressed)"
            print(header)
            # Print verified findings using the grouped format.
            if not verified:
                print("  (no verified dead code; all findings were likely false positives)")
            else:
                # Reuse print_dead_code's grouped layout for the verified subset.
                print_dead_code(verified, directory, max_findings, skip_header=True)
        else:
            print_dead_code(findings, directory, max_findings)


if __name__ == "__main__":
    main()