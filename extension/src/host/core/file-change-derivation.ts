import os from 'node:os';
import path from 'node:path';
import type { FileChangeEntry, ChatMessage } from '../../shared/protocol';
import { isRecord } from '../../shared/type-guards';

// ─── Derive file changes from existing transcript ──────────────────────────

interface ToolCallLikeInput {
  id: string;
  name: string;
  input: unknown;
}

/** Minimal structural types for subagent result traversal (pi-ai Message shape). */
interface SubagentContentPart {
  type: string;
  name?: string;
  arguments?: unknown;
}

interface SubagentMessage {
  role: string;
  content?: SubagentContentPart[];
}

interface SubagentSingleResult {
  messages?: SubagentMessage[];
}

interface SubagentDetails {
  results?: SubagentSingleResult[];
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

function looksLikeBashTool(name: string): boolean {
  const n = name.toLowerCase();
  return n === 'bash' || n === 'shell' || n === 'execute_bash' || n === 'run_command' || n === 'execute_command';
}

// ─── Bash/shell deletion parsing ───────────────────────────────────────────
//
// Files are frequently deleted through the bash tool (`rm path`) rather than a
// dedicated delete tool. The bash input is `{ command: "..." }` with no `path`
// field, so `extractFilePath` cannot see them. These helpers scan the command
// string for deletion commands and recover the targeted paths.

function looksLikeGlob(p: string): boolean {
  return /[*?\[\]]/.test(p);
}

/** Tokenize a single shell segment, honoring single/double quotes and
 *  backslash escapes. Stops at the first redirect/pipe operator — anything
 *  after `|`, `>`, or `<` is not a target of the preceding command. */
function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  const s = segment.trim();
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    if (/[|<>]/.test(s[i])) break;
    let tok = '';
    while (i < s.length && !/\s/.test(s[i])) {
      const ch = s[i];
      if (ch === '"' || ch === "'") {
        const quote = ch;
        i++;
        while (i < s.length && s[i] !== quote) {
          tok += s[i];
          i++;
        }
        if (i < s.length) i++;
      } else if (ch === '\\') {
        i++;
        if (i < s.length) {
          tok += s[i];
          i++;
        }
      } else {
        tok += ch;
        i++;
      }
    }
    if (tok !== '') tokens.push(tok);
  }
  return tokens;
}

/** Expand a leading `~` or `~user` to the user's home directory.
 *  `~` alone → home dir; `~/foo` → home/foo; `~user/foo` is left as-is
 *  (resolving another user's home requires a passwd lookup we don't do). */
function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  if (p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  // `~user/...` — can't resolve without passwd; leave as-is.
  return p;
}

/** Expand the first brace-expression in a token into a list of strings.
 *  `file{1,2,3}.ts` → `file1.ts file2.ts file3.ts`
 *  `src/{a,b}/x.ts` → `src/a/x.ts src/b/x.ts`
 *  Supports nested braces and multiple comma options. Only the outermost
 *  leftmost brace group is expanded; any remaining braces in the expanded
 *  pieces are expanded recursively. */
function expandBraces(token: string): string[] {
  const start = token.indexOf('{');
  if (start === -1) return [token];

  // Find the matching `}` for the brace at `start`.
  let depth = 0;
  let end = -1;
  for (let i = start; i < token.length; i++) {
    if (token[i] === '{') depth++;
    else if (token[i] === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return [token]; // unbalanced — leave as-is

  const prefix = token.slice(0, start);
  const suffix = token.slice(end + 1);
  const body = token.slice(start + 1, end);

  // Split on top-level commas (commas inside nested braces belong to the
  // nested group, which will be expanded in the recursive call).
  const options: string[] = [];
  let nestedDepth = 0;
  let last = 0;
  for (let i = 0; i <= body.length; i++) {
    const ch = i < body.length ? body[i] : ',';
    if (ch === '{') nestedDepth++;
    else if (ch === '}') nestedDepth--;
    else if (ch === ',' && nestedDepth === 0) {
      options.push(body.slice(last, i));
      last = i + 1;
    }
  }

  if (options.length <= 1) return [token]; // `{x}` or `{}` — literal

  const results: string[] = [];
  for (const opt of options) {
    const piece = prefix + opt + suffix;
    // Recursively expand any remaining brace groups in the piece.
    for (const expanded of expandBraces(piece)) {
      results.push(expanded);
    }
  }
  return results;
}

/** Collect path targets for a single deletion command, skipping flags/globs.
 *  Applies tilde and brace expansion to each candidate path. */
function collectDeletionTargets(cmd: string, args: string[]): string[] {
  const raw: string[] = [];
  if (cmd === 'rm' || cmd === 'rmdir' || cmd === 'unlink') {
    let afterDashDash = false;
    for (const t of args) {
      if (!afterDashDash && t === '--') { afterDashDash = true; continue; }
      if (!afterDashDash && t.startsWith('-')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  } else if (cmd === 'del') {
    // Windows `del`: flags start with `/`
    for (const t of args) {
      if (t.startsWith('/')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  } else if (cmd === 'remove-item' || cmd === 'ri') {
    // PowerShell Remove-Item: flags start with `-`
    for (const t of args) {
      if (t.startsWith('-')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  } else if (cmd === 'trash' || cmd === 'trash-put' || cmd === 'trash-cli') {
    // `trash` CLI: flags start with `-`
    for (const t of args) {
      if (t.startsWith('-')) continue;
      if (looksLikeGlob(t)) continue;
      raw.push(t);
    }
  }

  // Apply brace expansion then tilde expansion to each raw target.
  const out: string[] = [];
  for (const t of raw) {
    for (const expanded of expandBraces(t)) {
      out.push(expandTilde(expanded));
    }
  }
  return out;
}

/** Parse a bash/shell command string and return literal file paths targeted by
 *  a deletion command (`rm`, `rmdir`, `unlink`, `del`, `Remove-Item`, `git rm`,
 *  `trash`). Globs are excluded (the actual deleted paths can't be known
 *  without a filesystem listing), `git rm --cached` is ignored (index-only),
 *  and nested shells (`bash -c "rm file"`) are recursively parsed.
 *  Tilde (`~`) and brace (`{a,b}`) expansion is applied to each path. */
function parseDeletedPathsFromCommand(command: string): string[] {
  if (typeof command !== 'string') return [];
  const trimmed = command.trim();
  if (!trimmed) return [];

  const paths: string[] = [];
  // Split on command separators so `cd d && rm f` and `a; rm b` are covered.
  const segments = trimmed.split(/(?:&&|\|\||;|\n)/);

  for (const seg of segments) {
    const tokens = tokenizeShellSegment(seg);
    if (tokens.length === 0) continue;

    // Skip leading `sudo` / env-var assignments (`FOO=bar`).
    let idx = 0;
    while (idx < tokens.length && (tokens[idx] === 'sudo' || tokens[idx] === 'env' || /^\w+=/.test(tokens[idx]))) {
      idx++;
    }
    if (idx >= tokens.length) continue;
    const cmd = tokens[idx].toLowerCase();

    // Nested shell: `bash -c "rm file"` / `sh -c "..."` / `zsh -c "..."`.
    // Recursively parse the string argument after `-c`.
    if ((cmd === 'bash' || cmd === 'sh' || cmd === 'zsh' || cmd === 'dash') && idx + 2 < tokens.length) {
      let cIdx = idx + 1;
      // Skip flags between the shell command and `-c` (e.g. `bash -e -c "..."`).
      while (cIdx < tokens.length && tokens[cIdx] !== '-c') {
        if (tokens[cIdx].startsWith('-')) { cIdx++; continue; }
        break;
      }
      if (cIdx < tokens.length && tokens[cIdx] === '-c' && cIdx + 1 < tokens.length) {
        const innerCommand = tokens[cIdx + 1];
        paths.push(...parseDeletedPathsFromCommand(innerCommand));
        continue;
      }
    }

    if (cmd === 'git') {
      // Locate the `rm` subcommand, tolerating global git flags that take a
      // value (`-C <path>`, `--git-dir <path>`, `--work-tree <path>`).
      let j = idx + 1;
      while (j < tokens.length) {
        const t = tokens[j].toLowerCase();
        if (t === 'rm') break;
        if (t === '-c' || t === '--git-dir' || t === '--work-tree') {
          j += 2;
          continue;
        }
        if (t.startsWith('-')) { j++; continue; }
        // A non-flag token that isn't `rm` ⇒ different subcommand; bail.
        j = tokens.length;
        break;
      }
      if (j >= tokens.length || tokens[j].toLowerCase() !== 'rm') continue;
      const rmArgs = tokens.slice(j + 1);
      // `--cached` removes from the index only, not the working tree.
      if (rmArgs.some((a) => a === '--cached')) continue;
      paths.push(...collectDeletionTargets('rm', rmArgs));
    } else {
      paths.push(...collectDeletionTargets(cmd, tokens.slice(idx + 1)));
    }
  }

  return paths;
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

/**
 * Derive zero or more file-change entries from a single tool call.
 *
 * This is the plural counterpart to {@link deriveFileChangeFromToolCall} and is
 * the preferred entry point: a single bash invocation (`rm a b c`) can target
 * multiple files, which the singular helper cannot express. Non-bash tools
 * delegate to the singular helper (0 or 1 entry).
 */
export function deriveFileChangesFromToolCall(
  tool: ToolCallLikeInput,
  messageId: string,
  timestamp: string,
): FileChangeEntry[] {
  const name = (tool.name || '').toLowerCase().trim();

  if (looksLikeBashTool(name)) {
    const command = isRecord(tool.input)
      ? (tool.input.command ?? tool.input.cmd ?? tool.input.command_str)
      : null;
    if (typeof command === 'string') {
      const paths = parseDeletedPathsFromCommand(command);
      return paths.map((p) => ({
        path: p,
        kind: 'deleted' as const,
        toolCallId: tool.id,
        messageId,
        description: 'deleted',
        timestamp,
      }));
    }
    return [];
  }

  const single = deriveFileChangeFromToolCall(tool, messageId, timestamp);
  return single ? [single] : [];
}

function accumulateFileChange(
  seen: Map<string, FileChangeEntry>,
  createdPaths: Set<string>,
  entry: FileChangeEntry,
): void {
  if (entry.kind === 'created') {
    createdPaths.add(entry.path);
  } else if (entry.kind === 'deleted' && createdPaths.has(entry.path)) {
    // File was created in this session and then deleted — net no-op.
    seen.delete(entry.path);
    return;
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

/**
 * Derive file changes from a subagent tool result by scanning the inner
 * subagent transcripts for file-modifying tool calls (edit, write, etc.).
 */
export function deriveFileChangesFromSubagentResult(
  result: unknown,
  messageId: string,
  timestamp: string,
  toolCallId: string,
): FileChangeEntry[] {
  if (!isRecord(result)) return [];
  const details = result.details as SubagentDetails | undefined;
  if (!details?.results) return [];

  const changes: FileChangeEntry[] = [];

  for (let rIdx = 0; rIdx < details.results.length; rIdx++) {
    const singleResult = details.results[rIdx];
    if (!singleResult?.messages) continue;

    for (let mIdx = 0; mIdx < singleResult.messages.length; mIdx++) {
      const msg = singleResult.messages[mIdx];
      if (msg.role !== 'assistant') continue;
      if (!Array.isArray(msg.content)) continue;

      for (let cIdx = 0; cIdx < msg.content.length; cIdx++) {
        const part = msg.content[cIdx];
        if (part.type !== 'toolCall') continue;

        const syntheticId = `${toolCallId}-sa${rIdx}-m${mIdx}-c${cIdx}`;
        const entries = deriveFileChangesFromToolCall(
          { id: syntheticId, name: part.name ?? '', input: part.arguments },
          messageId,
          timestamp,
        );
        for (const entry of entries) changes.push(entry);
      }
    }
  }

  return changes;
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

      if (tool.name === 'subagent' && isRecord(tool.result)) {
        const subagentChanges = deriveFileChangesFromSubagentResult(
          tool.result,
          message.id,
          message.createdAt,
          tool.id,
        );
        for (const entry of subagentChanges) {
          accumulateFileChange(seen, createdPaths, entry);
        }
        continue;
      }

      const entries = deriveFileChangesFromToolCall(
        { id: tool.id, name: tool.name, input: tool.input },
        message.id,
        message.createdAt,
      );
      for (const entry of entries) {
        accumulateFileChange(seen, createdPaths, entry);
      }
    }
  }

  return [...seen.values()];
}
