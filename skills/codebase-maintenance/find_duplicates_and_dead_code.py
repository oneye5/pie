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
- skylos (via uv run PEP 723 metadata): unused functions, classes, and
  imports across Python, TypeScript, JavaScript, Java, Go, PHP, Rust,
  and Dart. uv run installs it automatically into an isolated venv.

Both tools respect the shared .ignore file (see find_large_files.py for
format details). Output is grouped into two clearly-labeled sections.

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
    --min-lines N          jscpd: minimum duplicated lines per block (default 5)
    --min-tokens N         jscpd: minimum duplicated tokens per block (default 50)
    --confidence N         skylos: minimum confidence 0-100 (default 60)
    --exclude-reasons REASONS
                           skylos: comma-separated reason substrings to exclude
                           (e.g. "unused import,unused variable") — findings
                           whose trailing reason text matches a substring are
                           dropped (default: none — all reasons shown)
    --skip-duplicates      Run only skylos
    --skip-dead-code       Run only jscpd

Output:
    Two sections, each beginning with a === header that includes a count:

        === Duplicates (jscpd) — 5 found ===
        path/A.py:1-12 ~ path/B.py:1-12  (12 lines, 64 tokens)
        ...

        === Dead code (skylos) — 3 found ===
        path/foo.py:42  unused function
        ...

    Skipped sections print "=== Tool (name) — skipped ===". Sections with
    no findings print "=== Tool (name) — no findings ===". If a section
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
    "Error: skylos not found in PATH.\n"
    "The PEP 723 metadata in this script declares skylos as a dependency — "
    "uv run will install it automatically. Use --skip-dead-code to run "
    "duplicates only."
)

# Strip ANSI color escapes that skylos may emit even with --no-tips on some
# terminals. The concise format uses plain text but defensive trimming is cheap.
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")


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
) -> int:
    """Print duplicate findings; return the total number of duplicate pairs found.

    Returns 0 when no duplicates exist or none could be formatted.
    """
    if not duplicates:
        print("=== Duplicates (jscpd) \u2014 no findings ===")
        return 0

    # Sort by line count descending (worst-first), tie-break on tokens desc.
    pairs: list[tuple[str, str, int, int]] = []
    for dup in duplicates:
        formatted = format_duplicate(dup, directory)
        if formatted is not None:
            pairs.append(formatted)
    pairs.sort(key=lambda p: (p[2], p[3]), reverse=True)

    print(f"=== Duplicates (jscpd) \u2014 {len(pairs)} found ===")

    shown = pairs[:max_findings] if max_findings > 0 else pairs
    remaining = len(pairs) - len(shown)

    for a, b, lines, tokens in shown:
        print(f"{a} ~ {b}  ({lines} lines, {tokens} tokens)")

    if remaining > 0:
        # Group the remainder by line-bucket for a compact summary.
        buckets: dict[str, int] = {}
        for _a, _b, lines, _tokens in pairs[len(shown):]:
            if lines >= 50:
                key = "50+ lines"
            elif lines >= 20:
                key = "20-49 lines"
            else:
                key = "<20 lines"
            buckets[key] = buckets.get(key, 0) + 1
        parts = [f"{v} {k}" for k, v in sorted(buckets.items(), reverse=True)]
        print(f"... {remaining} more duplicate(s): {', '.join(parts)}")

    return len(pairs)


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
    skylos_bin: str,
    confidence: int,
    exclude_folders: list[str],
) -> list[str]:
    """Run skylos --format concise and return the (already-trimmed) finding lines."""
    cmd: list[str] = [
        skylos_bin,
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


def print_dead_code(
    skylos_lines: list[str], directory: Path, max_findings: int,
) -> int:
    """Print dead-code findings; return the total number of findings found.

    Returns 0 when no findings exist or none could be normalised.
    """
    if not skylos_lines:
        print("=== Dead code (skylos) \u2014 no findings ===")
        return 0

    rewritten = list(filter(None, [_normalise_skylos_line(l, directory) for l in skylos_lines]))

    print(f"=== Dead code (skylos) \u2014 {len(rewritten)} found ===")

    shown = rewritten[:max_findings] if max_findings > 0 else rewritten
    remaining = len(rewritten) - len(shown)

    for line in shown:
        print(line)

    if remaining > 0:
        # Tally by reason (the trailing word after the second column).
        buckets: dict[str, int] = {}
        for line in rewritten[len(shown):]:
            tail = line.split("  ", 1)[-1].strip()
            buckets[tail] = buckets.get(tail, 0) + 1
        parts = [f"{v} {k}" for k, v in sorted(buckets.items(), key=lambda x: x[1], reverse=True)]
        print(f"... {remaining} more finding(s): {', '.join(parts)}")

    return len(rewritten)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def parse_args() -> tuple[Path, int, int, int, int, bool, bool, set[str]]:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        if len(sys.argv) < 2:
            print(
                "usage: find_duplicates_and_dead_code.py <directory> "
                "[--max-findings N] [--min-lines N] [--min-tokens N] "
                "[--confidence N] [--exclude-reasons REASONS] "
                "[--skip-duplicates] [--skip-dead-code]",
                file=sys.stderr,
            )
        sys.exit(2)

    directory = Path(sys.argv[1]).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {sys.argv[1]}", file=sys.stderr)
        sys.exit(2)

    max_findings = 50
    min_lines = 5
    min_tokens = 50
    confidence = 60
    skip_duplicates = False
    skip_dead_code = False
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
    )


def _locate_jscpd() -> list[str]:
    """Return the argv prefix for invoking jscpd via npx.

    jscpd is an npm package — not a Python dep, so the PEP 723 metadata
    can't install it. We invoke it via ``npx --yes jscpd`` which downloads
    the package on first use and caches it under ``~/.npm/_npx/``. This
    matches the convention used by analyze_complexity.py for Qualitas and
    means callers don't need to install anything beyond Node.js itself.
    """
    npx = shutil.which("npx")
    if npx is None:
        print(NPX_HINT, file=sys.stderr)
        sys.exit(2)
    # On Windows, ``npx`` is a ``.cmd`` shim and Python's subprocess does
    # not auto-resolve the ``.cmd`` extension when invoked with a list.
    # ``shutil.which`` returns the full path including the extension.
    return [npx, "--yes", "jscpd"]


def _locate_skylos() -> str:
    skylos = shutil.which("skylos")
    if skylos:
        return skylos
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
    ) = parse_args()

    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)
    active_patterns = collect_active_ignore_patterns(
        directory, global_patterns, context_patterns,
    )

    # --- Duplicates (jscpd) ---
    if skip_duplicates:
        print("=== Duplicates (jscpd) \u2014 skipped ===")
    else:
        jscpd_argv = _locate_jscpd()
        jscpd_ignore = _ignore_patterns_for_jscpd(active_patterns)
        duplicates = run_jscpd(
            directory, jscpd_argv, min_lines, min_tokens, jscpd_ignore,
        )
        print_duplicates(duplicates, directory, max_findings)

    # --- Dead code (skylos) ---
    print()
    if skip_dead_code:
        print("=== Dead code (skylos) \u2014 skipped ===")
    else:
        skylos_bin = _locate_skylos()
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
            directory, skylos_bin, confidence, exclude_folders,
        )
        if exclude_reasons:
            findings = [l for l in findings if l.split("  ", 1)[-1].strip() not in exclude_reasons]
        print_dead_code(findings, directory, max_findings)


if __name__ == "__main__":
    main()
