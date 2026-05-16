import type { ToolCall } from '../../shared/protocol';
import {
  getSkillNameFromToolCall as getSharedSkillNameFromToolCall,
  getToolCallSizeHint as getSharedToolCallSizeHint,
  normalizeToolCallName,
  summarizeSubagentToolCallInput as summarizeSharedSubagentToolCallInput,
} from '../../shared/tool-call-analysis';
import { DIRECT_FILE_PATH_KEYS, GENERIC_PATH_KEYS } from '../../shared/tool-call-analysis/mutation-tools';

const TOOL_CALL_SUMMARY_MAX_LENGTH = 80;
const TOOL_CALL_PATH_SUMMARY_MAX_LENGTH = 240;

export interface ToolCallPresentation {
  name: string;
  summary: string | null;
  summaryPath?: string;
  sizeHint?: string;
  variant?: 'skill-load';
}

export interface ToolCallPresentationOptions {
  workingDirectory?: string | null;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxLength = TOOL_CALL_SUMMARY_MAX_LENGTH): string {
  return text.length > maxLength
    ? `${text.slice(0, maxLength - 3).trimEnd()}...`
    : text;
}

function summarizeText(text: string, maxLength = TOOL_CALL_SUMMARY_MAX_LENGTH): string | null {
  const normalized = normalizeText(text);
  return normalized ? truncateText(normalized, maxLength) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function trimTrailingPathSeparators(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value;
  }

  return value.replace(/\/+$/, '');
}

function isAbsoluteFsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/') || value.startsWith('//');
}

function normalizeComparablePath(value: string): string {
  const normalized = trimTrailingPathSeparators(normalizePathSeparators(value));
  if (/^[A-Za-z]:/.test(normalized)) {
    return `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
  }
  if (normalized.startsWith('//')) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function toFileSystemPath(value: string): string | null {
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

function joinFileSystemPath(basePath: string, relativePath: string): string {
  const separator = basePath.includes('\\') ? '\\' : '/';
  const base = basePath.replace(/[\\/]+$/, '');
  const relative = relativePath.replace(/^[\\/]+/, '');

  if (!base) {
    return basePath.startsWith('/') ? `/${relative}` : relative;
  }

  return `${base}${separator}${relative}`;
}

function relativePathFromBase(targetPath: string, basePath: string): string | null {
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

function convertPathSeparators(value: string, separator: string): string {
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

function truncatePathText(value: string): string {
  if (value.length <= TOOL_CALL_PATH_SUMMARY_MAX_LENGTH) {
    return value;
  }

  const lastSeparatorIndex = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (lastSeparatorIndex < 0 || lastSeparatorIndex >= value.length - 1) {
    return truncateText(value, TOOL_CALL_PATH_SUMMARY_MAX_LENGTH);
  }

  const separator = value[lastSeparatorIndex] === '\\' ? '\\' : '/';
  const fileSection = value.slice(lastSeparatorIndex + 1);
  if (!fileSection) {
    return truncateText(value, TOOL_CALL_PATH_SUMMARY_MAX_LENGTH);
  }

  const parentPath = value.slice(0, lastSeparatorIndex).replace(/[\\/]+$/, '');
  const fullParentBudget = TOOL_CALL_PATH_SUMMARY_MAX_LENGTH - fileSection.length - separator.length;
  if (parentPath.length <= fullParentBudget) {
    return `${parentPath}${separator}${fileSection}`;
  }

  const clippedPathMarker = `...${separator}`;
  const truncatedParentBudget = TOOL_CALL_PATH_SUMMARY_MAX_LENGTH - fileSection.length - clippedPathMarker.length - separator.length;
  if (truncatedParentBudget <= 0) {
    return truncateText(fileSection, TOOL_CALL_PATH_SUMMARY_MAX_LENGTH);
  }

  const truncatedParentPath = truncatePathParentFromLeft(parentPath, truncatedParentBudget);
  return truncatedParentPath
    ? `${clippedPathMarker}${truncatedParentPath}${separator}${fileSection}`
    : `${clippedPathMarker}${fileSection}`;
}

function summarizePathCandidate(rawValue: string, workingDirectory?: string | null): { summary: string; summaryPath?: string } | null {
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

function summarizeFieldPathCandidate(
  fieldValue: unknown,
  workingDirectory?: string | null,
): { summary: string; summaryPath?: string } | null {
  if (typeof fieldValue === 'string') {
    return summarizePathCandidate(fieldValue, workingDirectory);
  }

  const firstEntry = firstStringInList(fieldValue);
  return firstEntry ? summarizePathCandidate(firstEntry, workingDirectory) : null;
}

function looksLikeDirectFileTool(toolName: string): boolean {
  return /(?:^|[_-])(read|open|create|write|update|rename|delete|edit)(?:$|[_-])/.test(toolName);
}

function summarizeToolCallPath(toolCall: ToolCall, workingDirectory?: string | null): { summary: string; summaryPath?: string } | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const normalizedToolName = normalizeToolCallName(toolCall.name);
  for (const key of DIRECT_FILE_PATH_KEYS) {
    const summary = summarizeFieldPathCandidate(toolCall.input[key], workingDirectory);
    if (summary) {
      return summary;
    }
  }

  if (normalizedToolName === 'read' || looksLikeDirectFileTool(normalizedToolName)) {
    for (const key of GENERIC_PATH_KEYS) {
      const summary = summarizeFieldPathCandidate(toolCall.input[key], workingDirectory);
      if (summary) {
        return summary;
      }
    }
  }

  return null;
}

function summarizeStringList(value: unknown, maxItems = 3): string | null {
  if (!Array.isArray(value)) return null;

  const items = value
    .filter((item): item is string => typeof item === 'string')
    .map(normalizeText)
    .filter((item) => item.length > 0);

  if (items.length === 0) return null;

  const preview = items.slice(0, maxItems).join(', ');
  const suffix = items.length > maxItems ? ` +${items.length - maxItems} more` : '';
  return summarizeText(`${preview}${suffix}`);
}

function summarizeTaskEntries(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;

  const first = value[0];
  if (!isRecord(first)) return null;

  const task = typeof first.task === 'string' ? summarizeText(first.task, 48) : null;
  if (!task) return null;

  const agent = typeof first.agent === 'string' ? normalizeText(first.agent) : '';
  const suffix = value.length > 1 ? ` +${value.length - 1} more` : '';
  return summarizeText(`${agent ? `${agent}: ` : ''}${task}${suffix}`);
}

function summarizeUnknown(value: unknown): string | null {
  if (typeof value === 'string') return summarizeText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const listSummary = summarizeStringList(value);
    if (listSummary) return listSummary;

    const firstRecord = value.find(isRecord);
    return firstRecord ? summarizeObject(firstRecord) : null;
  }

  if (isRecord(value)) return summarizeObject(value);
  return null;
}

function summarizeObject(value: Record<string, unknown>): string | null {
  const multiTaskSummary = summarizeTaskEntries(value.tasks ?? value.chain);
  if (multiTaskSummary) return multiTaskSummary;

  const directFields = [
    value.command,
    value.task,
    value.query,
    value.prompt,
    value.explanation,
    value.text,
    value.goal,
    value.description,
    value.element,
    value.url,
    value.path,
    value.filePath,
    value.dirPath,
    value.fileUri,
    value.includePattern,
    value.workspaceFolder,
    value.symbol,
    value.expression,
    value.commandId,
    value.selector,
  ];

  for (const field of directFields) {
    const preview = summarizeUnknown(field);
    if (preview) return preview;
  }

  const listSummary = summarizeStringList(value.packageList ?? value.urls ?? value.paths ?? value.args);
  if (listSummary) return listSummary;

  for (const entry of Object.values(value)) {
    if (typeof entry === 'string' || Array.isArray(entry) || isRecord(entry)) {
      const preview = summarizeUnknown(entry);
      if (preview) return preview;
    }
  }

  const compact = summarizeText(JSON.stringify(value));
  return compact === '{}' ? null : compact;
}

function formatPresentationSizeHint(sizeHint: string | null | undefined): string | undefined {
  if (!sizeHint) {
    return undefined;
  }

  if (/^[~+-]/.test(sizeHint)) {
    return sizeHint;
  }

  if (/\bline(?:s)?\b/i.test(sizeHint)) {
    return `~${sizeHint}`;
  }

  return sizeHint;
}

export function getToolCallPresentation(
  toolCall: ToolCall,
  options: ToolCallPresentationOptions = {},
): ToolCallPresentation {
  const sizeHint = formatPresentationSizeHint(getSharedToolCallSizeHint(toolCall));
  const skillName = getSharedSkillNameFromToolCall(toolCall);
  if (skillName) {
    return {
      name: `Load skill ${skillName}`,
      summary: null,
      ...(sizeHint ? { sizeHint } : {}),
      variant: 'skill-load',
    };
  }

  const pathSummary = summarizeToolCallPath(toolCall, options.workingDirectory);
  if (pathSummary) {
    return {
      name: toolCall.name,
      summary: pathSummary.summary,
      ...(pathSummary.summaryPath ? { summaryPath: pathSummary.summaryPath } : {}),
      ...(sizeHint ? { sizeHint } : {}),
    };
  }

  return {
    name: toolCall.name,
    summary: summarizeToolCall(toolCall),
    ...(sizeHint ? { sizeHint } : {}),
  };
}

export function summarizeToolCall(toolCall: ToolCall): string | null {
  return toolCall.name === 'subagent'
    ? summarizeSharedSubagentToolCallInput(toolCall.input)
    : summarizeUnknown(toolCall.input);
}
