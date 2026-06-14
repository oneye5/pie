#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "requests",
# ]
# ///
"""
Find markdown files and check for document drift — stale internal references
and broken external URLs.

Usage:
    uv run find_markdown_drift.py <directory> [options]

Recursively finds all ``.md`` / ``.mdx`` files under *directory*, then checks
every reference found in each document:

- **Internal file references** — relative paths (with optional ``#anchor``)
  are resolved against the document's directory.  Missing files or anchors
  that don't exist in the target document are counted as broken.

- **External URLs** — ``http://`` and ``https://`` links are fetched with a
  HEAD request (falling back to GET).  Any non-2xx/3xx response counts as
  broken.  ``localhost`` / ``127.0.0.1`` URLs are always skipped.

Output is sorted by the file's last-modified timestamp (oldest first) so
that the most stale documents surface at the top.

Respects the shared ``.ignore`` file (see ``find_large_files.py`` for format
details).

Arguments:
    directory              Root directory to scan (required)
    --timeout SECONDS      HTTP request timeout per URL (default: 10)
    --max-urls N           Maximum external URLs to check (default: 200;
                          0 = unlimited).  When the limit is hit, remaining
                          URLs are reported as ``skipped``.
    --skip-external        Skip all external URL checks (only check internal
                          references).
    --check-anchors        Validate ``#anchor`` fragments against the target
                          file's heading IDs (adds overhead for large docs).
    -v, --verbose          Print each reference as it is checked.

Output:
    Tabular listing sorted by last-modified time (oldest first):

        === Markdown document drift ===
        path/to/old-doc.md        3 broken refs   modified 2024-01-15
        path/to/recent-doc.md     0 broken refs   modified 2024-11-02
        ...

    Followed by a detail section listing every broken reference per file:

        --- Broken references ---
        path/to/old-doc.md
          [internal] ./missing-file.md (file not found)
          [internal] ./README.md#removed-section (anchor not found)
          [external] https://example.com/dead (HTTP 404)
        ...

    If no markdown files are found, prints ``no markdown files found``.
"""

from __future__ import annotations

import argparse
import fnmatch
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.parse import urlparse

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

MARKDOWN_EXTENSIONS: frozenset[str] = frozenset({".md", ".mdx"})

SKIP_DIRS: frozenset[str] = frozenset({
    ".git", ".hg", ".svn",
    "__pycache__", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".hypothesis",
    "node_modules",
    "venv", ".venv", "env", ".env",
    "target",           # Rust / Maven build output
    "dist", "build", "out", ".next", ".nuxt", ".output",
    "vendor",           # Go / PHP vendored deps
    ".idea", ".vscode",
    "coverage", ".coverage",
    "eggs", ".eggs", "*.egg-info",
})

IGNORE_FILE_NAMES: tuple[str, ...] = (".ignore", ".codebase-ignore")

# Regex that matches markdown link/image destinations.
# Handles: [text](url), ![alt](url), [text](<url with spaces>)
# Captures group 1 = link text, group 2 = <url>, group 3 = bare url.
_MD_LINK_RE = re.compile(
    r"""
    !?                                  # optional image marker
    \[([^\]]*)\]                        # link text
    \(\s*                               # opening paren
      (?:                               #   start URL alternation
        <([^>]*)>                       #     <url-with-spaces>
      |                                 #     —or—
        ([^)\s]+)                       #     bare url (no spaces, no <>)
      )                                 #   end URL alternation
    \s*(?:                              # closing paren + optional title
      "([^"]*)"                         #   optional title string
    )?\s*\)
    """,
    re.VERBOSE,
)

# Matches the ``#anchor`` fragment at the end of a path.
_ANCHOR_RE = re.compile(r"#(.+)$")

# Matches markdown ATX headings and converts them to plausible anchor IDs
# (GitHub-style: lowercase, spaces→hyphens, strip punctuation).
_HEADING_RE = re.compile(r"^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$", re.MULTILINE)


# ---------------------------------------------------------------------------
# Ignore-file loading  (mirrors find_large_files.py)
# ---------------------------------------------------------------------------


def normalize_path_token(value: str, *, strip_trailing_slash: bool) -> str:
    normalized = value.strip().replace("\\", "/")
    while "//" in normalized:
        normalized = normalized.replace("//", "/")
    if normalized.startswith("./"):
        normalized = normalized[2:]
    if strip_trailing_slash:
        normalized = normalized.rstrip("/")
    return normalized


def load_ignore_patterns(
    script_dir: Path,
) -> tuple[list[str], list[tuple[str, list[str]]]]:
    global_patterns: list[str] = []
    context_patterns: list[tuple[str, list[str]]] = []

    ignore_file = next(
        (script_dir / name for name in IGNORE_FILE_NAMES if (script_dir / name).exists()),
        None,
    )
    if ignore_file is None:
        return global_patterns, context_patterns

    current_context: str | None = None
    for line in ignore_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("context "):
            ctx = normalize_path_token(line[len("context "):], strip_trailing_slash=True)
            current_context = ctx
            context_patterns.append((ctx, []))
        else:
            pattern = normalize_path_token(line, strip_trailing_slash=False)
            if current_context is not None:
                context_patterns[-1][1].append(pattern)
            else:
                global_patterns.append(pattern)

    return global_patterns, context_patterns


def scan_root_matches_context(scan_root: Path, context_path: str) -> bool:
    normalized_context = normalize_path_token(context_path, strip_trailing_slash=True)
    if not normalized_context:
        return False
    normalized_root = normalize_path_token(
        scan_root.resolve().as_posix(), strip_trailing_slash=True,
    )
    if fnmatch.fnmatch(normalized_root, normalized_context):
        return True
    return normalized_root == normalized_context or normalized_root.endswith(f"/{normalized_context}")


def collect_active_ignore_patterns(
    scan_root: Path,
    global_patterns: list[str],
    context_patterns: list[tuple[str, list[str]]],
) -> list[str]:
    active_patterns = list(global_patterns)
    for context_path, patterns in context_patterns:
        if scan_root_matches_context(scan_root, context_path):
            active_patterns.extend(patterns)
    return active_patterns


def matches_ignore_pattern(file_rel_path: str, pattern: str) -> bool:
    normalized_path = normalize_path_token(file_rel_path, strip_trailing_slash=True)
    if not normalized_path:
        return False
    path_parts = [p for p in PurePosixPath(normalized_path).parts if p not in ("", ".")]
    if not path_parts:
        return False
    basename = path_parts[-1]
    dir_paths: list[str] = []
    current_parts: list[str] = []
    for part in path_parts[:-1]:
        current_parts.append(part)
        dir_paths.append("/".join(current_parts))
    normalized_pattern = normalize_path_token(pattern, strip_trailing_slash=False)
    if not normalized_pattern:
        return False
    if normalized_pattern.endswith("/"):
        directory_pattern = normalized_pattern.rstrip("/")
        if any(fnmatch.fnmatch(dp, directory_pattern) for dp in dir_paths):
            return True
        if "/" not in directory_pattern:
            return any(fnmatch.fnmatch(part, directory_pattern) for part in path_parts[:-1])
        return False
    if fnmatch.fnmatch(normalized_path, normalized_pattern):
        return True
    if fnmatch.fnmatch(basename, normalized_pattern):
        return True
    if any(fnmatch.fnmatch(dp, normalized_pattern) for dp in dir_paths):
        return True
    if "/" not in normalized_pattern:
        return any(fnmatch.fnmatch(part, normalized_pattern) for part in path_parts)
    return False


def matches_ignore_patterns(file_rel_path: str, active_patterns: list[str]) -> bool:
    return any(matches_ignore_pattern(file_rel_path, p) for p in active_patterns)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def is_skipped(file: Path, base: Path) -> bool:
    try:
        rel_parts = file.relative_to(base).parts
    except ValueError:
        return False
    return any(part in SKIP_DIRS for part in rel_parts[:-1])


def strip_code_blocks(content: str) -> str:
    """Remove fenced code blocks and inline code spans from markdown content.

    This prevents false-positive link detection inside code examples.
    Fenced blocks are replaced with blank lines to preserve line numbering;
    inline code spans are replaced with spaces.
    """
    # Remove fenced code blocks (``` or ~~~)
    # Process line-by-line to avoid complex regex backtracking.
    lines = content.split("\n")
    in_fence = False
    fence_marker = ""
    result_lines: list[str] = []
    for line in lines:
        stripped = line.lstrip()
        if not in_fence:
            # Check for opening fence (3+ backticks or tildes, optional info string)
            fence_match = re.match(r"^[ \t]{0,3}(`{3,}|~{3,})", line)
            if fence_match:
                in_fence = True
                fence_marker = fence_match.group(1)[0]  # ` or ~
                fence_len = len(fence_match.group(1))
                result_lines.append("")
            else:
                result_lines.append(line)
        else:
            # Check for closing fence (same character, at least as many)
            close_match = re.match(r"^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$", line)
            if close_match and close_match.group(1)[0] == fence_marker and len(close_match.group(1)) >= fence_len:
                in_fence = False
                result_lines.append("")
            else:
                result_lines.append("")  # blank out code content
    result = "\n".join(result_lines)
    # Remove inline code spans (backtick-delimited)
    result = re.sub(r"(`+)(?!`)(.+?)(?<!`)\1(?!`)", lambda m: " " * len(m.group(0)), result)
    return result


def _extract_reference_definitions(content: str) -> dict[str, str]:
    """Extract reference-style link definitions from markdown content.

    Parses lines like ``[id]: url`` or ``[id]: <url>`` and returns a mapping
    of ``{label: url}``.
    """
    definitions: dict[str, str] = {}
    # Reference definitions: [label]: <url> or [label]: url  (with optional title)
    _REF_DEF_RE = re.compile(
        r"""^\s{0,3}\[([^\]]+)\]:\s+(?:<([^>]+)>|([^\s]+))(?:\s+(?:'[^']*'|\"[^\"]*\"|\([^)]*\)))?\s*$""",
        re.MULTILINE,
    )
    for m in _REF_DEF_RE.finditer(content):
        label = m.group(1).lower().strip()
        url = (m.group(2) or m.group(3) or "").strip()
        if label and url:
            definitions[label] = url
    return definitions


def extract_references(content: str) -> list[str]:
    """Extract all link/image destinations from markdown *content*."""
    cleaned = strip_code_blocks(content)
    refs: list[str] = []
    for match in _MD_LINK_RE.finditer(cleaned):
        # Group 2 = <url>, group 3 = bare url
        url = match.group(2) or match.group(3) or ""
        url = url.strip()
        if url:
            refs.append(url)
    # Also extract URLs from reference-style link definitions
    for _label, url in _extract_reference_definitions(cleaned).items():
        refs.append(url)
    # Extract autolinks: <https://example.com> (CommonMark §6.6)
    _AUTOLINK_RE = re.compile(r"<(https?://[^>]+)>")
    for m in _AUTOLINK_RE.finditer(cleaned):
        url = m.group(1).strip()
        if url:
            refs.append(url)
    return refs


def classify_reference(ref: str, *, check_anchors: bool = False) -> str:
    """Return ``'external'``, ``'internal'``, ``'anchor'``, or ``'skip'``.

    When *check_anchors* is True, same-document anchors (``#heading``) are
    classified as ``'anchor'`` so they can be validated. Otherwise they are
    skipped.
    """
    lower = ref.lower()
    # Scheme-based classification
    if lower.startswith(("http://", "https://")):
        parsed = parsed_hostname(ref)
        if parsed in ("localhost", "127.0.0.1", "::1"):
            return "skip"
        return "external"
    # Pure anchors within the same document
    if ref.startswith("#"):
        return "anchor" if check_anchors else "skip"
    # Protocol-relative
    if ref.startswith("//"):
        return "external"
    # Mailto, tel, data URIs
    if re.match(r"^(mailto:|tel:|data:|javascript:)", ref, re.IGNORECASE):
        return "skip"
    return "internal"


def parsed_hostname(url: str) -> str:
    try:
        return urlparse(url).hostname or ""
    except Exception:
        return ""


def github_style_anchor(heading_text: str) -> str:
    """Convert heading text to a GitHub-style anchor ID.

    Lowercase, strip punctuation (except hyphens), spaces→hyphens.
    """
    text = heading_text.strip().lower()
    # Remove everything that isn't alphanumeric, spaces, or hyphens
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"\s+", "-", text)
    return text


def extract_anchors(content: str) -> set[str]:
    """Extract all heading anchors from markdown *content*."""
    anchors: set[str] = set()
    for match in _HEADING_RE.finditer(content):
        heading_text = match.group(2).strip()
        anchors.add(github_style_anchor(heading_text))
    return anchors


# ---------------------------------------------------------------------------
# Reference checking
# ---------------------------------------------------------------------------


@dataclass
class BrokenRef:
    ref: str
    kind: str  # "internal" or "external"
    reason: str


@dataclass
class MarkdownReport:
    rel_path: str
    broken_refs: list[BrokenRef] = field(default_factory=list)
    mtime: float = 0.0  # seconds since epoch

    @property
    def broken_count(self) -> int:
        return len(self.broken_refs)


def check_internal_ref(
    ref: str,
    doc_path: Path,
    check_anchors: bool,
) -> BrokenRef | None:
    """Return a ``BrokenRef`` if *ref* is broken, else ``None``."""
    # A bare "#" is a top-of-page link — always valid.
    if ref == "#":
        return None

    # Separate anchor from path
    anchor: str | None = None
    path_part = ref
    anchor_match = _ANCHOR_RE.search(ref)
    if anchor_match:
        anchor = anchor_match.group(1)
        path_part = ref[: anchor_match.start()]

    # Resolve the path relative to the document's directory
    if path_part:
        target = (doc_path.parent / path_part).resolve()
        # If the target is a directory, try adding index.md / README.md.
        # If no index file is found, the directory itself is a valid target
        # (many markdown renderers link to directory listings).
        if target.is_dir():
            for index in ("index.md", "index.mdx", "README.md", "readme.md"):
                if (target / index).is_file():
                    target = target / index
                    break
            else:
                # Directory exists — treat as valid, no file-not-found error.
                # Anchor check against a directory is skipped (no content to scan).
                if anchor and check_anchors:
                    # Can't validate anchors against a directory; skip silently.
                    pass
                return None
        if not target.is_file():
            return BrokenRef(ref, "internal", "file not found")
    else:
        # Pure anchor — the target is the current document
        target = doc_path

    # Anchor validation
    if anchor and check_anchors:
        try:
            content = target.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            return BrokenRef(ref, "internal", f"cannot read target file for anchor #{anchor}")

        anchors = extract_anchors(content)
        # GitHub also strips leading/trailing hyphens from the generated id
        normalized_anchor = anchor.strip().lower().strip("-")
        if normalized_anchor not in anchors:
            return BrokenRef(ref, "internal", f"anchor #{anchor} not found")

    return None


def check_external_ref(
    ref: str,
    timeout: float,
    verbose: bool,
) -> BrokenRef | None:
    """Return a ``BrokenRef`` if *ref* is broken or uncertain, else ``None``.

    Status code classification:
    - 404, 410: definitively broken (kind ``'external'``)
    - 403, 401: access denied — may be bot-blocking (kind ``'uncertain'``)
    - 5xx, 429: server/rate-limit error — likely transient (kind ``'uncertain'``)
    - other 4xx: treat as broken (kind ``'external'``)
    """
    import requests

    try:
        resp = requests.head(ref, timeout=timeout, allow_redirects=True, headers={
            "User-Agent": "Mozilla/5.0 (compatible; markdown-drift-checker/1.0)",
        })
        if resp.status_code >= 400:
            # Some servers reject HEAD — retry with GET
            resp = requests.get(ref, timeout=timeout, allow_redirects=True, headers={
                "User-Agent": "Mozilla/5.0 (compatible; markdown-drift-checker/1.0)",
            }, stream=True)
        if resp.status_code >= 400:
            # Classify the status code
            if resp.status_code in (403, 401):
                return BrokenRef(ref, "uncertain", f"HTTP {resp.status_code} (access denied; may be bot-blocking)")
            if resp.status_code == 429:
                return BrokenRef(ref, "uncertain", f"HTTP 429 (rate limited; likely transient)")
            if resp.status_code >= 500:
                return BrokenRef(ref, "uncertain", f"HTTP {resp.status_code} (server error; likely transient)")
            return BrokenRef(ref, "external", f"HTTP {resp.status_code}")
    except requests.ConnectionError:
        return BrokenRef(ref, "uncertain", "connection failed")
    except requests.Timeout:
        return BrokenRef(ref, "uncertain", "timeout")
    except requests.TooManyRedirects:
        return BrokenRef(ref, "external", "too many redirects")
    except Exception as exc:
        return BrokenRef(ref, "uncertain", f"error: {exc}")

    if verbose:
        print(f"  [ok] {ref} (HTTP {resp.status_code})", file=sys.stderr)
    return None


# ---------------------------------------------------------------------------
# Core logic
# ---------------------------------------------------------------------------


def find_markdown_files(
    directory: Path,
    global_patterns: list[str],
    context_patterns: list[tuple[str, list[str]]],
) -> list[tuple[Path, str, float]]:
    """Return list of (path, rel_path, mtime) for all markdown files found."""
    active_patterns = collect_active_ignore_patterns(directory, global_patterns, context_patterns)
    results: list[tuple[Path, str, float]] = []

    for file in directory.rglob("*"):
        if not file.is_file():
            continue
        if file.suffix.lower() not in MARKDOWN_EXTENSIONS:
            continue
        if is_skipped(file, directory):
            continue
        try:
            rel_path = str(PurePosixPath(file.relative_to(directory)))
        except ValueError:
            continue
        if matches_ignore_patterns(rel_path, active_patterns):
            continue

        mtime = file.stat().st_mtime
        results.append((file, rel_path, mtime))

    return results


def check_document(
    file: Path,
    rel_path: str,
    mtime: float,
    *,
    check_anchors: bool,
    skip_external: bool,
    timeout: float,
    max_urls: int,
    verbose: bool,
) -> tuple[MarkdownReport, int]:
    """Check a single markdown document for broken references.

    Returns ``(report, external_urls_checked)``.
    """
    report = MarkdownReport(rel_path=rel_path, mtime=mtime)

    try:
        content = file.read_text(encoding="utf-8", errors="ignore")
    except OSError as exc:
        report.broken_refs.append(BrokenRef("(read error)", "internal", str(exc)))
        return report, 0

    refs = extract_references(content)
    external_checked = 0

    for ref in refs:
        kind = classify_reference(ref, check_anchors=check_anchors)
        if kind == "skip":
            continue

        if kind in ("internal", "anchor"):
            # For same-document anchors, pass an empty path part so the
            # resolver treats it as the current document.
            broken = check_internal_ref(ref, file, check_anchors)
            if broken is not None:
                report.broken_refs.append(broken)
            elif verbose:
                print(f"  [ok] {ref}", file=sys.stderr)

        elif kind == "external":
            if skip_external:
                continue
            if max_urls > 0 and external_checked >= max_urls:
                report.broken_refs.append(BrokenRef(ref, "skipped", "not checked (max-urls limit reached)"))
                continue

            broken = check_external_ref(ref, timeout, verbose)
            external_checked += 1
            if broken is not None:
                report.broken_refs.append(broken)

    return report, external_checked


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Find markdown files and check for document drift (stale references).",
    )
    parser.add_argument("directory", type=str, help="Root directory to scan")
    parser.add_argument(
        "--timeout", type=float, default=10,
        help="HTTP request timeout per URL in seconds (default: 10)",
    )
    parser.add_argument(
        "--max-urls", type=int, default=200,
        help="Maximum external URLs to check; 0 = unlimited (default: 200)",
    )
    parser.add_argument(
        "--skip-external", action="store_true",
        help="Skip all external URL checks (only check internal references)",
    )
    parser.add_argument(
        "--check-anchors", action="store_true",
        help="Validate #anchor fragments against heading IDs in target files",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true",
        help="Print each reference as it is checked",
    )
    return parser.parse_args()


def main() -> None:
    # Ensure stdout can handle Unicode on Windows consoles (cp1252)
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if hasattr(sys.stderr, "reconfigure"):
        try:
            sys.stderr.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

    args = parse_args()
    directory = Path(args.directory).resolve()
    if not directory.is_dir():
        print(f"error: not a directory: {args.directory}", file=sys.stderr)
        sys.exit(1)

    script_dir = Path(__file__).parent.resolve()
    global_patterns, context_patterns = load_ignore_patterns(script_dir)

    md_files = find_markdown_files(directory, global_patterns, context_patterns)
    if not md_files:
        print("no markdown files found")
        return

    # Sort by mtime (oldest first — most stale surfaces at top)
    md_files.sort(key=lambda t: t[2])

    reports: list[MarkdownReport] = []
    total_external_checked = 0

    for file, rel_path, mtime in md_files:
        report, ext_checked = check_document(
            file, rel_path, mtime,
            check_anchors=args.check_anchors,
            skip_external=args.skip_external,
            timeout=args.timeout,
            max_urls=args.max_urls,
            verbose=args.verbose,
        )
        reports.append(report)
        total_external_checked += ext_checked

    # --- Summary (sorted by last-modified, oldest first) ---
    print("=== Markdown document drift ===")

    max_path_len = max(len(r.rel_path) for r in reports)
    for report in reports:
        mod_date = datetime.fromtimestamp(report.mtime, tz=timezone.utc).strftime("%Y-%m-%d")
        # Split counts: "skipped" items are informational, not problems
        definite = sum(1 for br in report.broken_refs if br.kind not in ("uncertain", "skipped"))
        uncertain = sum(1 for br in report.broken_refs if br.kind == "uncertain")
        skipped = sum(1 for br in report.broken_refs if br.kind == "skipped")
        parts: list[str] = []
        if definite:
            label = "broken ref" if definite == 1 else "broken refs"
            parts.append(f"{definite} {label}")
        if uncertain:
            label = "uncertain" if uncertain == 1 else "uncertain"
            parts.append(f"{uncertain} {label}")
        if skipped:
            parts.append(f"{skipped} skipped")
        status = ", ".join(parts) if parts else "ok"
        print(
            f"  {report.rel_path:<{max_path_len}}  "
            f"{status}  "
            f"modified {mod_date}"
        )

    total_definite = sum(
        sum(1 for br in r.broken_refs if br.kind not in ("uncertain", "skipped"))
        for r in reports
    )
    total_uncertain = sum(
        sum(1 for br in r.broken_refs if br.kind == "uncertain")
        for r in reports
    )
    total_docs = len(reports)
    docs_with_broken = sum(1 for r in reports if r.broken_count > 0)
    print()
    print(
        f"Total: {total_docs} docs, {docs_with_broken} with issues, "
        f"{total_definite} broken, {total_uncertain} uncertain"
    )
    if not args.skip_external:
        print(f"External URLs checked: {total_external_checked}")

    # --- Detail section ---
    docs_with_detail = [r for r in reports if r.broken_count > 0]
    if docs_with_detail:
        print()
        print("--- Broken references ---")
        for report in docs_with_detail:
            print(report.rel_path)
            for br in report.broken_refs:
                print(f"  [{br.kind}] {br.ref} ({br.reason})")


if __name__ == "__main__":
    main()