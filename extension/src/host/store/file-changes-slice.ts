import * as nodePath from 'node:path';

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import type { FileChangeEntry, ChatMessage } from '../../shared/protocol';

export interface FileChangesState {
  bySession: Record<string, FileChangeEntry[]>;
}

const fileChangesSlice = createSlice({
  name: 'fileChanges',
  initialState: { bySession: {} } as FileChangesState,
  reducers: {
    setFileChanges(
      state,
      action: PayloadAction<{ sessionPath: string; changes: FileChangeEntry[] }>,
    ) {
      state.bySession[action.payload.sessionPath] = action.payload.changes;
    },
    addFileChange(
      state,
      action: PayloadAction<{ sessionPath: string; change: FileChangeEntry }>,
    ) {
      const list = (state.bySession[action.payload.sessionPath] ??= []);
      const existingIdx = list.findIndex(
        (entry) => entry.path === action.payload.change.path,
      );
      if (existingIdx !== -1) {
        list[existingIdx] = action.payload.change;
      } else {
        list.push(action.payload.change);
      }
    },
    removeFileChange(
      state,
      action: PayloadAction<{ sessionPath: string; path: string }>,
    ) {
      const list = state.bySession[action.payload.sessionPath];
      if (!list) return;
      const target = nodePath.normalize(action.payload.path);
      state.bySession[action.payload.sessionPath] = list.filter(
        (entry) => nodePath.normalize(entry.path) !== target,
      );
    },
    clearFileChanges(state, action: PayloadAction<string>) {
      delete state.bySession[action.payload];
    },
  },
});

export const fileChangesReducer = fileChangesSlice.reducer;
export const fileChangesActions = fileChangesSlice.actions;

// ─── Derive file changes from existing transcript ──────────────────────────

interface ToolCallLikeInput {
  id: string;
  name: string;
  input: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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

  return {
    path: filePath,
    kind,
    toolCallId: tool.id,
    messageId,
    description,
    timestamp,
  };
}

export function deriveFileChangesFromTranscript(
  transcript: ChatMessage[],
): FileChangeEntry[] {
  const seen = new Map<string, FileChangeEntry>();

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
      if (entry) {
        // Last write wins per file path
        seen.set(entry.path, entry);
      }
    }
  }

  return [...seen.values()];
}
