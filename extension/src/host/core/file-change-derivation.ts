import type { FileChangeEntry, ChatMessage } from '../../shared/protocol';

// ─── Derive file changes from existing transcript ──────────────────────────

interface ToolCallLikeInput {
  id: string;
  name: string;
  input: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Count the number of lines in a string. Empty string → 0, no trailing-newline inflation. */
function countLines(text: string): number {
  if (text === '') return 0;
  // A trailing newline doesn't add an extra logical line
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

function computeLineStats(input: unknown, toolName: string): { additions: number; deletions: number } | null {
  if (!isRecord(input)) return null;

  // write/create: all lines are additions
  if (looksLikeWriteTool(toolName)) {
    const content = input.content ?? input.text ?? input.data;
    if (typeof content === 'string') {
      const lines = countLines(content);
      return lines > 0 ? { additions: lines, deletions: 0 } : null;
    }
    return null;
  }

  // edit with single oldText/newText
  if (typeof input.oldText === 'string' && typeof input.newText === 'string') {
    const oldLines = countLines(input.oldText);
    const newLines = countLines(input.newText);
    if (oldLines === 0 && newLines === 0) return null;
    return { additions: newLines, deletions: oldLines };
  }

  // edit with edits[] array (each entry has oldText/newText)
  if (Array.isArray(input.edits)) {
    let additions = 0;
    let deletions = 0;
    for (const edit of input.edits) {
      if (isRecord(edit)) {
        if (typeof edit.oldText === 'string') {
          deletions += countLines(edit.oldText);
        }
        if (typeof edit.newText === 'string') {
          additions += countLines(edit.newText);
        }
      }
    }
    if (additions > 0 || deletions > 0) return { additions, deletions };
    return null;
  }

  return null;
}

function extractFilePath(input: unknown): string | null {
  if (typeof input === 'string') return input.trim() || null;
  if (!isRecord(input)) return null;
  const pathKeys = ['path', 'filePath', 'file', 'filepath', 'target', 'targetPath'];
  for (const key of pathKeys) {
    const val = input[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
  }
  return null;
}

function looksLikeFileModifyingTool(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.includes('edit') ||
    n.includes('write') ||
    n.includes('create') ||
    n.includes('delete') ||
    n.includes('remove') ||
    n.includes('rename') ||
    n.includes('move') ||
    n === 'bash'
  );
}

function looksLikeWriteTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('write') || n.includes('create') || n === 'write' || n === 'create_file';
}

function looksLikeDeleteTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('delete') || n.includes('remove') || n === 'delete_files' || n === 'delete_file';
}

function looksLikeEditTool(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('edit') || n.includes('update') || n.includes('replace') || n.includes('patch');
}

function describeEdit(input: unknown): string {
  if (!isRecord(input)) return 'edited';
  if (typeof input.oldText === 'string' && typeof input.newText === 'string') {
    return 'edited';
  }
  if (Array.isArray(input.edits) && input.edits.length > 0) {
    return `${input.edits.length} edits`;
  }
  return 'edited';
}

export function deriveFileChangeFromToolCall(
  tool: ToolCallLikeInput,
  messageId: string,
  timestamp: string,
): FileChangeEntry | null {
  console.log('[pie:fileChanges] deriveFileChangeFromToolCall', { name: tool.name, inputKeys: isRecord(tool.input) ? Object.keys(tool.input as Record<string, unknown>) : typeof tool.input, looksFileModifying: looksLikeFileModifyingTool(tool.name) });
  const name = (tool.name || '').toLowerCase().trim();
  if (!looksLikeFileModifyingTool(name)) return null;

  const filePath = extractFilePath(tool.input);
  if (!filePath) return null;

  let kind: FileChangeEntry['kind'];
  let description: string;

  if (looksLikeWriteTool(name)) {
    kind = 'created';
    description = 'created';
  } else if (looksLikeDeleteTool(name)) {
    kind = 'deleted';
    description = 'deleted';
  } else if (looksLikeEditTool(name)) {
    kind = 'modified';
    description = describeEdit(tool.input);
  } else {
    kind = 'modified';
    description = `${name}`;
  }

  const stats = computeLineStats(tool.input, name);

  return {
    path: filePath,
    kind,
    toolCallId: tool.id,
    messageId,
    description,
    timestamp,
    ...(stats && { additions: stats.additions, deletions: stats.deletions }),
  };
}

export function deriveFileChangesFromTranscript(
  transcript: ChatMessage[],
): FileChangeEntry[] {
  const seen = new Map<string, FileChangeEntry>();
  const createdPaths = new Set<string>();

  for (const message of transcript) {
    if (message.role !== 'assistant') continue;
    const toolCalls = message.toolCalls ?? [];
    for (const tool of toolCalls) {
      if (tool.status === 'failed') continue;
      const entry = deriveFileChangeFromToolCall(
        { id: tool.id, name: tool.name, input: tool.input },
        message.id,
        message.createdAt,
      );
      if (!entry) continue;

      if (entry.kind === 'created') {
        createdPaths.add(entry.path);
      } else if (entry.kind === 'deleted' && createdPaths.has(entry.path)) {
        // File was created in this session and then deleted — net no-op.
        seen.delete(entry.path);
        continue;
      }

      const existing = seen.get(entry.path);
      if (existing) {
        // Accumulate stats across edits to the same file
        const additions = (existing.additions ?? 0) + (entry.additions ?? 0);
        const deletions = (existing.deletions ?? 0) + (entry.deletions ?? 0);
        if (additions > 0) entry.additions = additions;
        else delete entry.additions;
        if (deletions > 0) entry.deletions = deletions;
        else delete entry.deletions;
      }
      seen.set(entry.path, entry);
    }
  }

  return [...seen.values()];
}
