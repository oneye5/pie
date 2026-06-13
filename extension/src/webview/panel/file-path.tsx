/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { JSX } from 'preact';

const FILE_PATH_SUMMARY_MAX_LENGTH = 240;

function truncateString(text: string, maxLength: number): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 3).trimEnd()}...`
    : text;
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

function looksLikeFileLeaf(value: string): boolean {
  const leaf = value.trim();
  if (!leaf || leaf === '.' || leaf === '..') {
    return false;
  }

  // Treat dotted leaves (settings-menu.tsx, README.md, .gitignore) and
  // conventional extensionless project files (Makefile, Dockerfile, LICENSE)
  // as files. Bare directory names should stay subtle so a trailing folder is
  // not presented with the same emphasis as an actual file target.
  const extensionlessFileNames = new Set(['makefile', 'dockerfile', 'license', 'copying', 'notice']);
  if (extensionlessFileNames.has(leaf.toLowerCase())) return true;

  return leaf.startsWith('.') && leaf.length > 1
    ? !leaf.slice(1).includes('/') && !leaf.slice(1).includes('\\')
    : /\.[A-Za-z0-9_-]{1,12}$/.test(leaf);
}

export function splitSummaryPath(summary: string): { pathSection: string | null; fileSection: string | null } {
  const lastSeparatorIndex = Math.max(summary.lastIndexOf('/'), summary.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0 || lastSeparatorIndex >= summary.length - 1) {
    return looksLikeFileLeaf(summary)
      ? { pathSection: null, fileSection: summary }
      : { pathSection: summary, fileSection: null };
  }

  const leaf = summary.slice(lastSeparatorIndex + 1);
  if (!looksLikeFileLeaf(leaf)) {
    return { pathSection: summary, fileSection: null };
  }

  return {
    pathSection: summary.slice(0, lastSeparatorIndex + 1),
    fileSection: leaf,
  };
}

// ── Shared rendering ─────────────────────────────────────────────────────

export interface ClickablePathButtonProps {
  path: string;
  displayText: string;
  onOpenFile?: (path: string) => void;
}

export function ClickablePathButton({ path, displayText, onOpenFile }: ClickablePathButtonProps): JSX.Element {
  const { pathSection, fileSection } = splitSummaryPath(displayText);
  if (!fileSection) {
    return (
      <span class="transcript-header-path-preview" title={path}>
        <span class="transcript-header-summary-subtle transcript-header-path-prefix">
          <span class="[direction:ltr] [unicode-bidi:isolate]">{pathSection ?? displayText}</span>
        </span>
      </span>
    );
  }
  return (
    <span class="transcript-header-path-preview" title={path}>
      {pathSection ? (
        <span class="transcript-header-summary-subtle transcript-header-path-prefix">
          <span class="[direction:ltr] [unicode-bidi:isolate]">{pathSection}</span>
        </span>
      ) : null}
      {onOpenFile ? (
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
      ) : (
        <span class="transcript-header-summary-emphasis transcript-header-path-target">{fileSection}</span>
      )}
    </span>
  );
}
