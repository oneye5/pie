/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

const FILE_PATH_SUMMARY_MAX_LENGTH = 240;

function truncateString(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 3).trimEnd()}...`
    : text;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Path normalization ───────────────────────────────────────────────────

export function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

export function trimTrailingPathSeparators(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value;
  }
  return value.replace(/\/+$/, '');
}

export function isAbsoluteFsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.startsWith('//');
}

export function normalizeComparablePath(value: string): string {
  const normalized = trimTrailingPathSeparators(normalizePathSeparators(value));
  if (/^[A-Za-z]:/.test(normalized)) {
    return `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
  }
  if (normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

export function toFileSystemPath(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'file:') {
      return null;
    }
    let pathname = decodeURIComponent(parsed.pathname);
    if (/^\/[A-Za-z]:/.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return parsed.host ? `//${parsed.host}${pathname}` : pathname;
  } catch {
    return null;
  }
}

export function joinFileSystemPath(basePath: string, relativePath: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/';
  const base = basePath.replace(/[\\/]+$/, '');
  const relative = relativePath.replace(/^[\\/]+/, '');

  if (!base) {
    return basePath.startsWith('/') ? `/${relative}` : relative;
  }

  return `${base}${separator}${relative}`;
}

export function relativePathFromBase(targetPath: string, basePath: string): string | null {
  const comparableTarget = normalizeComparablePath(targetPath);
  const comparableBase = normalizeComparablePath(basePath);
  if (!comparableTarget || !comparableBase || comparableTarget === comparableBase) {
    return null;
  }

  const prefix = comparableBase.endsWith('/') ? comparableBase : `${comparableBase}/`;
  if (!comparableTarget.startsWith(prefix)) {
    return null;
  }

  const normalizedTarget = trimTrailingPathSeparators(normalizePathSeparators(targetPath));
  const normalizedBase = trimTrailingPathSeparators(normalizePathSeparators(basePath));
  return normalizedTarget.slice(normalizedBase.length + 1) || null;
}

export function convertPathSeparators(value: string, separator: string): string {
  return separator === '\\' ? value.replace(/\//g, '\\') : value;
}

function truncatePathParentFromLeft(parentPath: string, maxLength: number): string {
  if (parentPath.length <= maxLength) {
    return parentPath;
  }

  if (maxLength <= 0) {
    return '';
  }

  const sliceStart = Math.max(0, parentPath.length - maxLength);
  const slicedParentPath = parentPath.slice(sliceStart);
  const nextSeparatorOffset = slicedParentPath.search(/[\\/]/);
  if (nextSeparatorOffset < 0) {
    return slicedParentPath.replace(/^[\\/]+/, '');
  }

  const pathSuffix = slicedParentPath.slice(nextSeparatorOffset + 1);
  return pathSuffix || slicedParentPath.replace(/^[\\/]+/, '');
}

export function truncatePathText(value: string): string {
  if (value.length <= FILE_PATH_SUMMARY_MAX_LENGTH) {
    return value;
  }

  const lastSeparatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0 || lastSeparatorIndex >= value.length - 1) {
    return truncateString(value, FILE_PATH_SUMMARY_MAX_LENGTH);
  }

  const separator = value[lastSeparatorIndex] === '\\' ? '\\' : '/';
  const fileSection = value.slice(lastSeparatorIndex + 1);
  if (!fileSection) {
    return truncateString(value, FILE_PATH_SUMMARY_MAX_LENGTH);
  }

  const parentPath = value.slice(0, lastSeparatorIndex).replace(/[\\/]+$/, '');
  const fullParentBudget = FILE_PATH_SUMMARY_MAX_LENGTH - fileSection.length - separator.length;
  if (parentPath.length <= fullParentBudget) {
    return `${parentPath}${separator}${fileSection}`;
  }

  const clippedPathMarker = `...${separator}`;
  const truncatedParentBudget = FILE_PATH_SUMMARY_MAX_LENGTH - fileSection.length - clippedPathMarker.length - separator.length;
  if (truncatedParentBudget <= 0) {
    return truncateString(fileSection, FILE_PATH_SUMMARY_MAX_LENGTH);
  }

  const truncatedParentPath = truncatePathParentFromLeft(parentPath, truncatedParentBudget);
  return truncatedParentPath
    ? `${clippedPathMarker}${truncatedParentPath}${separator}${fileSection}`
    : `${clippedPathMarker}${fileSection}`;
}

export function summarizePathCandidate(
  rawValue: string,
  workingDirectory?: string | null,
): { summary: string; summaryPath?: string } | null {
  const value = rawValue.trim();
  if (!value) {
    return null;
  }

  const fileSystemPath = toFileSystemPath(value);
  if (fileSystemPath) {
    const relativePath = workingDirectory ? relativePathFromBase(fileSystemPath, workingDirectory) : null;
    return {
      summary: truncatePathText(relativePath ?? fileSystemPath),
      summaryPath: fileSystemPath,
    };
  }

  if (isAbsoluteFsPath(value)) {
    const separator = value.includes('\\') ? '\\' : '/';
    const relativePath = workingDirectory ? relativePathFromBase(value, workingDirectory) : null;
    return {
      summary: truncatePathText(relativePath ? convertPathSeparators(relativePath, separator) : value),
      summaryPath: value,
    };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    return null;
  }

  return {
    summary: truncatePathText(value),
    summaryPath: workingDirectory ? joinFileSystemPath(workingDirectory, value) : undefined,
  };
}

export function summarizeFieldPathCandidate(
  fieldValue: unknown,
  workingDirectory?: string | null,
): { summary: string; summaryPath?: string } | null {
  if (typeof fieldValue === 'string') {
    return summarizePathCandidate(fieldValue, workingDirectory);
  }

  function firstStringInList(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return null;
    }
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) {
        return entry;
      }
    }
    return null;
  }

  const firstEntry = firstStringInList(fieldValue);
  return firstEntry ? summarizePathCandidate(firstEntry, workingDirectory) : null;
}

// ── Path detection (adapted from tool-call-card.tsx) ──────────────────────

export function splitQuotedToken(value: string): { text: string; leadingQuote?: string; trailingQuote?: string } {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return {
      text: trimmed.slice(1, -1),
      leadingQuote: trimmed[0],
      trailingQuote: trimmed[trimmed.length - 1],
    };
  }

  return { text: trimmed };
}

export function unwrapQuotedToken(value: string): string {
  return splitQuotedToken(value).text;
}

export function looksLikePathToken(value: string): boolean {
  const token = unwrapQuotedToken(value);
  if (!token || token === '|' || token === '||' || token === '&&' || token === ';' || token.startsWith('-')) {
    return false;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) && !/^file:\/\//i.test(token)) {
    return false;
  }

  return token.includes('/')
    || token.includes('\\')
    || /^\.{1,2}$/.test(token)
    || /^\.{1,2}[\\/]/.test(token)
    || /^~(?:[\\/]|$)/.test(token)
    || /^[A-Za-z]:[\\/]/.test(token)
    || /^file:\/\//i.test(token)
    || /^\\\\/.test(token)
    || /^\.[A-Za-z0-9._-]+$/.test(token)
    || /^[A-Za-z0-9._-]*[A-Za-z_][A-Za-z0-9._-]*\.[A-Za-z0-9_-]{1,8}$/.test(token);
}

export function splitSummaryPath(summary: string): { pathSection: string | null; fileSection: string } {
  const lastSeparatorIndex = Math.max(summary.lastIndexOf('/'), summary.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0 || lastSeparatorIndex >= summary.length - 1) {
    return { pathSection: null, fileSection: summary };
  }

  return {
    pathSection: summary.slice(0, lastSeparatorIndex + 1),
    fileSection: summary.slice(lastSeparatorIndex + 1),
  };
}

// ── Shared rendering ─────────────────────────────────────────────────────

export function renderClickablePathHtml(summaryPath: string, displayText: string): string {
  const { pathSection, fileSection } = splitSummaryPath(displayText);
  const prefixHtml = pathSection
    ? `<span class="transcript-header-summary-subtle transcript-header-path-prefix"><span class="[direction:ltr] [unicode-bidi:isolate]">${escapeHtml(pathSection)}</span></span>`
    : '';
  return (
    `<span class="transcript-header-path-preview">${prefixHtml}` +
    `<button type="button" class="transcript-header-summary-link" data-file-path="${escapeHtml(summaryPath)}">` +
    `<span class="transcript-header-summary-emphasis transcript-header-path-target">${escapeHtml(fileSection)}</span>` +
    `</button></span>`
  );
}

export interface ClickablePathButtonProps {
  path: string;
  displayText: string;
  onOpenFile: (path: string) => void;
}

export function ClickablePathButton({ path, displayText, onOpenFile }: ClickablePathButtonProps): JSX.Element {
  const { pathSection, fileSection } = splitSummaryPath(displayText);
  return (
    <span class="transcript-header-path-preview" title={path}>
      {pathSection ? (
        <span class="transcript-header-summary-subtle transcript-header-path-prefix">
          <span class="[direction:ltr] [unicode-bidi:isolate]">{pathSection}</span>
        </span>
      ) : null}
      <button
        type="button"
        class="transcript-header-summary-link group"
        title={path}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onOpenFile(path);
        }}
      >
        <span class="transcript-header-summary-emphasis transcript-header-path-target">{fileSection}</span>
      </button>
    </span>
  );
}
