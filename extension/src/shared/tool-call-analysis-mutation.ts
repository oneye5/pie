import type { ToolCall } from './protocol';
import { isRecord, normalizeToolCallName } from './tool-call-analysis-summary';

export interface FileMutationDelta {
  writeCount: number;
  editCount: number;
  deleteCount: number;
  renameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
}

type SizeHintPrefix = '+' | '-' | '~';

interface EditSizeStats {
  additions: number;
  deletions: number;
  modifications: number;
}

const DIRECT_FILE_PATH_KEYS = [
  'filePath',
  'fileUri',
  'sessionPath',
  'oldPath',
  'newPath',
  'requestedPath',
  'targetPath',
  'sourcePath',
  'destinationPath',
  'old_path',
  'new_path',
  'requested_path',
  'target_path',
  'source_path',
  'destination_path',
] as const;

const GENERIC_PATH_KEYS = [
  'path',
] as const;

const WRITE_CONTENT_KEYS = [
  'content',
  'contents',
  'text',
  'body',
  'value',
] as const;

const TEXT_CONTAINER_KEYS = [
  'content',
  'contents',
  'text',
  'output',
  'result',
  'body',
  'value',
  'markdown',
] as const;

const EMPTY_FILE_MUTATION_DELTA: FileMutationDelta = {
  writeCount: 0,
  editCount: 0,
  deleteCount: 0,
  renameCount: 0,
  touchedFileCount: 0,
  lineAdditions: 0,
  lineDeletions: 0,
  lineModifications: 0,
};

function countTextLines(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  const normalized = text.replace(/\r\n?/g, '\n');
  const withoutTrailingNewline = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  return withoutTrailingNewline.split('\n').length;
}

function toNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  const integer = Math.floor(value);
  return integer >= 0 ? integer : null;
}

function toPositiveInteger(value: unknown): number | null {
  const integer = toNonNegativeInteger(value);
  return integer && integer > 0 ? integer : null;
}

function lineCountFromRange(start: unknown, end: unknown): number | null {
  const startLine = toNonNegativeInteger(start);
  const endLine = toNonNegativeInteger(end);
  if (startLine === null || endLine === null || endLine < startLine) {
    return null;
  }

  const count = (endLine - startLine) + 1;
  return count > 0 ? count : null;
}

function hasTextLikeValue(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') {
    return true;
  }

  if (Array.isArray(value)) {
    return value.some((entry) => hasTextLikeValue(entry, depth + 1));
  }

  if (!isRecord(value) || depth >= 2) {
    return false;
  }

  return TEXT_CONTAINER_KEYS.some((key) => hasTextLikeValue(value[key], depth + 1));
}

function lineCountFromTextLike(value: unknown, depth = 0): number | null {
  if (typeof value === 'string') {
    const lineCount = countTextLines(value);
    return lineCount > 0 ? lineCount : null;
  }

  if (Array.isArray(value)) {
    let total = 0;
    let foundAny = false;
    for (const entry of value) {
      const lineCount = lineCountFromTextLike(entry, depth + 1);
      if (lineCount) {
        total += lineCount;
        foundAny = true;
      }
    }
    return foundAny && total > 0 ? total : null;
  }

  if (!isRecord(value) || depth >= 2) {
    return null;
  }

  for (const key of TEXT_CONTAINER_KEYS) {
    const lineCount = lineCountFromTextLike(value[key], depth + 1);
    if (lineCount) {
      return lineCount;
    }
  }

  return null;
}

function lineCountFromRecordKeys(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const lineCount = lineCountFromTextLike(record[key]);
    if (lineCount) {
      return lineCount;
    }
  }

  return null;
}

function formatLineHint(prefix: SizeHintPrefix, lineCount: number | null): string | null {
  if (!lineCount || lineCount <= 0) {
    return null;
  }

  const lineLabel = lineCount === 1 ? 'line' : 'lines';
  return `${prefix}${lineCount} ${lineLabel}`;
}

function combineEditStats(current: EditSizeStats, next: EditSizeStats): EditSizeStats {
  return {
    additions: current.additions + next.additions,
    deletions: current.deletions + next.deletions,
    modifications: current.modifications + next.modifications,
  };
}

function editStatsFromReplacement(oldText: string, newText: string): EditSizeStats {
  const oldLineCount = countTextLines(oldText);
  const newLineCount = countTextLines(newText);

  if (oldLineCount === 0 && newLineCount === 0) {
    return { additions: 0, deletions: 0, modifications: 0 };
  }

  if (oldLineCount === 0) {
    return { additions: newLineCount, deletions: 0, modifications: 0 };
  }

  if (newLineCount === 0) {
    return { additions: 0, deletions: oldLineCount, modifications: 0 };
  }

  return { additions: 0, deletions: 0, modifications: Math.max(oldLineCount, newLineCount) };
}

function editStatsFromEntry(value: unknown): EditSizeStats | null {
  if (!isRecord(value)) {
    return null;
  }

  const oldText = typeof value.oldText === 'string' ? value.oldText
    : typeof value.old_text === 'string' ? value.old_text
    : null;
  const newText = typeof value.newText === 'string' ? value.newText
    : typeof value.new_text === 'string' ? value.new_text
    : null;

  if (oldText === null && newText === null) {
    return null;
  }

  return editStatsFromReplacement(oldText ?? '', newText ?? '');
}

function editStatsFromPatchText(patchText: string): EditSizeStats | null {
  let additions = 0;
  let deletions = 0;
  let modifications = 0;
  let runAdditions = 0;
  let runDeletions = 0;

  const flushRun = () => {
    if (runAdditions > 0 && runDeletions > 0) {
      modifications += Math.max(runAdditions, runDeletions);
    } else if (runAdditions > 0) {
      additions += runAdditions;
    } else if (runDeletions > 0) {
      deletions += runDeletions;
    }

    runAdditions = 0;
    runDeletions = 0;
  };

  for (const line of patchText.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\+\+\+[ \t]/.test(line) || /^---[ \t]/.test(line)) {
      flushRun();
      continue;
    }

    if (line.startsWith('+')) {
      runAdditions += 1;
      continue;
    }

    if (line.startsWith('-')) {
      runDeletions += 1;
      continue;
    }

    flushRun();
  }

  flushRun();

  if (additions === 0 && deletions === 0 && modifications === 0) {
    return null;
  }

  return { additions, deletions, modifications };
}

function formatEditSizeHint(stats: EditSizeStats | null): string | null {
  if (!stats) {
    return null;
  }

  const total = stats.additions + stats.deletions + stats.modifications;
  if (total <= 0) {
    return null;
  }

  if (stats.additions > 0 && stats.deletions === 0 && stats.modifications === 0) {
    return formatLineHint('+', stats.additions);
  }

  if (stats.deletions > 0 && stats.additions === 0 && stats.modifications === 0) {
    return formatLineHint('-', stats.deletions);
  }

  return formatLineHint('~', total);
}

function looksLikeReadTool(toolName: string): boolean {
  return /(?:^|[_-])read(?:$|[_-])/.test(toolName);
}

function looksLikeCreateTool(toolName: string): boolean {
  return /(?:^|[_-])(create|write)(?:$|[_-])/.test(toolName);
}

function looksLikeEditTool(toolName: string): boolean {
  return /(?:^|[_-])(edit|update|replace|patch)(?:$|[_-])/.test(toolName) || toolName === 'apply_patch';
}

function looksLikeDeleteTool(toolName: string): boolean {
  return /(?:^|[_-])(delete|remove|unlink)(?:$|[_-])/.test(toolName);
}

function looksLikeRenameTool(toolName: string): boolean {
  return /(?:^|[_-])(rename|move)(?:$|[_-])/.test(toolName);
}

function readSizeHintFromToolCall(toolCall: ToolCall): string | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const requestedLineCount =
    lineCountFromRange(toolCall.input.startLine, toolCall.input.endLine)
    ?? lineCountFromRange(toolCall.input.start_line, toolCall.input.end_line)
    ?? toPositiveInteger(toolCall.input.limit)
    ?? toPositiveInteger(toolCall.input.maxLines)
    ?? toPositiveInteger(toolCall.input.max_lines)
    ?? toPositiveInteger(toolCall.input.lineCount)
    ?? toPositiveInteger(toolCall.input.line_count);
  const hasResolvedResultText = toolCall.status !== 'failed' && hasTextLikeValue(toolCall.result);
  const resultLineCount = toolCall.status === 'failed' ? null : lineCountFromTextLike(toolCall.result);
  if (hasResolvedResultText && !resultLineCount) {
    return null;
  }

  const lineCount =
    requestedLineCount && resultLineCount
      ? Math.min(requestedLineCount, resultLineCount)
      : requestedLineCount ?? resultLineCount;

  return formatLineHint('~', lineCount);
}

function createSizeHintFromToolCall(toolCall: ToolCall): string | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const inputLineCount = lineCountFromRecordKeys(toolCall.input, WRITE_CONTENT_KEYS);
  return formatLineHint('+', inputLineCount);
}

function editSizeHintFromToolCall(toolCall: ToolCall): string | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const directEditStats = editStatsFromEntry(toolCall.input);
  if (directEditStats) {
    return formatEditSizeHint(directEditStats);
  }

  const editEntries = Array.isArray(toolCall.input.edits) ? toolCall.input.edits
    : Array.isArray(toolCall.input.changes) ? toolCall.input.changes
    : Array.isArray(toolCall.input.replacements) ? toolCall.input.replacements
    : null;
  if (editEntries) {
    let combinedStats: EditSizeStats = { additions: 0, deletions: 0, modifications: 0 };
    let foundAny = false;

    for (const entry of editEntries) {
      const stats = editStatsFromEntry(entry);
      if (!stats) {
        continue;
      }

      combinedStats = combineEditStats(combinedStats, stats);
      foundAny = true;
    }

    if (foundAny) {
      return formatEditSizeHint(combinedStats);
    }
  }

  const patchText = typeof toolCall.input.input === 'string' ? toolCall.input.input
    : typeof toolCall.input.patch === 'string' ? toolCall.input.patch
    : typeof toolCall.input.diff === 'string' ? toolCall.input.diff
    : null;
  return patchText ? formatEditSizeHint(editStatsFromPatchText(patchText)) : null;
}

function hasPathLikeValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
    || Array.isArray(value) && value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
}

function hasToolCallPathInput(toolCall: ToolCall): boolean {
  if (!isRecord(toolCall.input)) {
    return false;
  }

  for (const key of DIRECT_FILE_PATH_KEYS) {
    if (hasPathLikeValue(toolCall.input[key])) {
      return true;
    }
  }

  for (const key of GENERIC_PATH_KEYS) {
    if (hasPathLikeValue(toolCall.input[key])) {
      return true;
    }
  }

  return false;
}

export function getToolCallSizeHint(toolCall: ToolCall): string | null {
  if (toolCall.status === 'failed') {
    return null;
  }

  const normalizedToolName = normalizeToolCallName(toolCall.name);
  const hasPathInput = hasToolCallPathInput(toolCall);

  if (looksLikeReadTool(normalizedToolName) && hasPathInput) {
    return readSizeHintFromToolCall(toolCall);
  }

  if (looksLikeCreateTool(normalizedToolName) && hasPathInput) {
    return createSizeHintFromToolCall(toolCall);
  }

  if (looksLikeEditTool(normalizedToolName)) {
    return editSizeHintFromToolCall(toolCall);
  }

  return null;
}

function parsePatchOperations(patchText: string): Pick<FileMutationDelta, 'writeCount' | 'editCount' | 'deleteCount' | 'renameCount' | 'touchedFileCount'> {
  let writeCount = 0;
  let editCount = 0;
  let deleteCount = 0;
  let renameCount = 0;

  for (const line of patchText.replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('*** Add File:')) {
      writeCount += 1;
      continue;
    }

    if (line.startsWith('*** Update File:')) {
      editCount += 1;
      continue;
    }

    if (line.startsWith('*** Delete File:')) {
      deleteCount += 1;
      continue;
    }

    if (line.startsWith('*** Move to:') || line.startsWith('rename to ')) {
      renameCount += 1;
    }
  }

  const explicitFileOps = writeCount + editCount + deleteCount;
  const touchedFileCount = explicitFileOps > 0 ? explicitFileOps : renameCount;
  return { writeCount, editCount, deleteCount, renameCount, touchedFileCount };
}

function buildFileMutationDelta(partial: Partial<FileMutationDelta>): FileMutationDelta {
  return {
    writeCount: partial.writeCount ?? 0,
    editCount: partial.editCount ?? 0,
    deleteCount: partial.deleteCount ?? 0,
    renameCount: partial.renameCount ?? 0,
    touchedFileCount: partial.touchedFileCount ?? 0,
    lineAdditions: partial.lineAdditions ?? 0,
    lineDeletions: partial.lineDeletions ?? 0,
    lineModifications: partial.lineModifications ?? 0,
  };
}

function fileMutationFromPatch(toolCall: ToolCall): FileMutationDelta | null {
  if (!isRecord(toolCall.input)) {
    return null;
  }

  const patchText = typeof toolCall.input.input === 'string' ? toolCall.input.input
    : typeof toolCall.input.patch === 'string' ? toolCall.input.patch
    : typeof toolCall.input.diff === 'string' ? toolCall.input.diff
    : null;
  if (!patchText) {
    return null;
  }

  const fileOps = parsePatchOperations(patchText);
  const stats = editStatsFromPatchText(patchText) ?? { additions: 0, deletions: 0, modifications: 0 };
  const touchedFileCount = fileOps.touchedFileCount > 0 ? fileOps.touchedFileCount : 1;
  const editCount = fileOps.editCount > 0 || fileOps.touchedFileCount === 0 ? Math.max(fileOps.editCount, 1) : 0;

  return buildFileMutationDelta({
    ...fileOps,
    editCount,
    touchedFileCount,
    lineAdditions: stats.additions,
    lineDeletions: stats.deletions,
    lineModifications: stats.modifications,
  });
}

export function getFileMutationFromToolCall(toolCall: ToolCall): FileMutationDelta {
  const normalizedToolName = normalizeToolCallName(toolCall.name);
  const patchDelta = fileMutationFromPatch(toolCall);
  if (patchDelta) {
    return patchDelta;
  }

  const hasPathInput = hasToolCallPathInput(toolCall);
  if (!hasPathInput || !isRecord(toolCall.input)) {
    return { ...EMPTY_FILE_MUTATION_DELTA };
  }

  if (looksLikeRenameTool(normalizedToolName)) {
    return buildFileMutationDelta({ renameCount: 1, touchedFileCount: 1 });
  }

  if (looksLikeDeleteTool(normalizedToolName)) {
    return buildFileMutationDelta({ deleteCount: 1, touchedFileCount: 1 });
  }

  if (looksLikeCreateTool(normalizedToolName)) {
    const lineAdditions = lineCountFromRecordKeys(toolCall.input, WRITE_CONTENT_KEYS) ?? 0;
    return buildFileMutationDelta({
      writeCount: 1,
      touchedFileCount: 1,
      lineAdditions,
    });
  }

  if (looksLikeEditTool(normalizedToolName)) {
    const sizeStats = editStatsFromEntry(toolCall.input);
    const editEntries = Array.isArray(toolCall.input.edits) ? toolCall.input.edits
      : Array.isArray(toolCall.input.changes) ? toolCall.input.changes
      : Array.isArray(toolCall.input.replacements) ? toolCall.input.replacements
      : null;

    let combinedStats = sizeStats;
    if (!combinedStats && editEntries) {
      let accumulator: EditSizeStats = { additions: 0, deletions: 0, modifications: 0 };
      let foundAny = false;
      for (const entry of editEntries) {
        const stats = editStatsFromEntry(entry);
        if (!stats) {
          continue;
        }
        accumulator = combineEditStats(accumulator, stats);
        foundAny = true;
      }
      combinedStats = foundAny ? accumulator : null;
    }

    return buildFileMutationDelta({
      editCount: 1,
      touchedFileCount: 1,
      lineAdditions: combinedStats?.additions ?? 0,
      lineDeletions: combinedStats?.deletions ?? 0,
      lineModifications: combinedStats?.modifications ?? 0,
    });
  }

  return { ...EMPTY_FILE_MUTATION_DELTA };
}

export function mergeFileMutationDelta(
  current: FileMutationDelta,
  next: FileMutationDelta,
): FileMutationDelta {
  return {
    writeCount: current.writeCount + next.writeCount,
    editCount: current.editCount + next.editCount,
    deleteCount: current.deleteCount + next.deleteCount,
    renameCount: current.renameCount + next.renameCount,
    touchedFileCount: current.touchedFileCount + next.touchedFileCount,
    lineAdditions: current.lineAdditions + next.lineAdditions,
    lineDeletions: current.lineDeletions + next.lineDeletions,
    lineModifications: current.lineModifications + next.lineModifications,
  };
}

export function createEmptyFileMutationDelta(): FileMutationDelta {
  return { ...EMPTY_FILE_MUTATION_DELTA };
}
