import type { ToolCall } from '../protocol';
import {
  getSkillNameFromToolCall,
  isRecord,
  normalizeToolCallName,
  summarizeSubagentToolCallInput,
} from './summary';
import {
  createEmptyFileMutationDelta,
  getFileExtensionFromToolCall,
  getFileMutationFromToolCall,
  getToolCallSizeHint,
  mergeFileMutationDelta,
  type FileExtensionAnalysis,
  type FileMutationDelta,
} from './mutation';
import {
  classifyVerificationCommandKindsFromInput,
  createEmptySubagentTaskScoreRollup,
  extractSubagentUsage,
  type SubagentTaskScoreRollup,
  type VerificationCommandKind,
} from './verification';

export type { VerificationCommandKind, FileMutationDelta, SubagentTaskScoreRollup, FileExtensionAnalysis };
export {
  normalizeToolCallName,
  summarizeSubagentToolCallInput,
  getSkillNameFromToolCall,
  getToolCallSizeHint,
  getFileExtensionFromToolCall,
  mergeFileMutationDelta,
  createEmptyFileMutationDelta,
  createEmptySubagentTaskScoreRollup,
};

export type ToolFailureKind =
  | 'unavailable_tool'
  | 'invalid_tool_arguments'
  | 'missing_file_or_path'
  | 'shell_command_error'
  | 'probe_no_match'
  | 'verification_project_failure'
  | 'timeout'
  | 'nonzero_exit'
  | 'unknown';

export interface ToolFailureDetails {
  kind: ToolFailureKind;
  exitCode: number | null;
  errorExcerpt: string;
}

export interface ToolCallAnalysis {
  normalizedToolName: string;
  skillName: string | null;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentNames: string[];
  subagentScoredTaskCount: number;
  subagentTaskScores: SubagentTaskScoreRollup;
  verificationKinds: VerificationCommandKind[];
  fileMutation: FileMutationDelta;
  fileExtension: FileExtensionAnalysis | null;
  failure: ToolFailureDetails | null;
}

function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function extractCommandText(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (!isRecord(input)) {
    return '';
  }
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key];
    if (typeof value === 'string') {
      return value;
    }
  }
  if (Array.isArray(input.args) && input.args.every((item) => typeof item === 'string')) {
    return input.args.join(' ');
  }
  return '';
}

function stringifyResultText(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }
  if (isRecord(result)) {
    const content = result.content;
    if (Array.isArray(content)) {
      const parts = content
        .filter(isRecord)
        .map((part) => typeof part.text === 'string' ? part.text : '')
        .filter((text) => text.length > 0);
      if (parts.length > 0) {
        return parts.join('\n');
      }
    }
    for (const key of ['message', 'error', 'stderr', 'stdout']) {
      const value = result[key];
      if (typeof value === 'string' && value.trim()) {
        return value;
      }
    }
  }
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    return String(result ?? '');
  }
}

function extractExitCode(result: unknown, text: string): number | null {
  if (isRecord(result)) {
    for (const key of ['exitCode', 'code', 'status']) {
      const value = result[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.trunc(value);
      }
    }
  }
  const match = text.match(/(?:Command exited with code|exit code|exited with code)\s+(-?\d+)/i);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function formatErrorExcerpt(text: string, maxLength = 240): string {
  const normalized = text
    // eslint-disable-next-line no-control-regex -- intentionally matching ANSI ESC sequences
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return '';
  }
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3).trimEnd()}...` : normalized;
}

function isProbeNoMatch(command: string, text: string, exitCode: number | null): boolean {
  if (exitCode !== 1) {
    return false;
  }
  const normalizedCommand = command.trim().toLowerCase();
  if (!/(^|\s)(rg|grep|find|ps|test|\[)(\s|$)/.test(normalizedCommand)) {
    return false;
  }
  const normalizedText = text.replace(/Command exited with code\s+1/ig, '').replace(/\(no output\)/ig, '').trim();
  return normalizedText.length === 0;
}

function classifyToolFailure(
  toolCall: ToolCall,
  verificationKinds: VerificationCommandKind[],
): ToolFailureDetails | null {
  if (toolCall.status !== 'failed') {
    return null;
  }

  const normalizedToolName = normalizeToolCallName(toolCall.name) || toolCall.name;
  const command = extractCommandText(toolCall.input);
  const resultText = stringifyResultText(toolCall.result);
  const combinedText = `${command}\n${resultText}`;
  const exitCode = extractExitCode(toolCall.result, resultText);
  const lower = combinedText.toLowerCase();

  let kind: ToolFailureKind = 'unknown';
  if (/tool\s+[^\s]+\s+not found/i.test(resultText)) {
    kind = 'unavailable_tool';
  } else if (/command timed out|timed out after|timeout/i.test(resultText)) {
    kind = 'timeout';
  } else if (verificationKinds.length > 0) {
    kind = 'verification_project_failure';
  } else if (isProbeNoMatch(command, resultText, exitCode)) {
    kind = 'probe_no_match';
  } else if (/enoent|no such file or directory|cannot find path|cannot access|filenotfounderror/.test(lower)) {
    kind = 'missing_file_or_path';
  } else if (
    normalizedToolName === 'edit'
    && /validation failed|oldtext|old text|exact text|occurrences|unique|overlap|must not be empty|must be object/.test(lower)
  ) {
    kind = 'invalid_tool_arguments';
  } else if (normalizedToolName === 'read' && /offset .* beyond end of file|invalid|must be/.test(lower)) {
    kind = 'invalid_tool_arguments';
  } else if (/syntax error|unexpected token|command not found|not recognized|parsererror|parsefile/.test(lower)) {
    kind = 'shell_command_error';
  } else if (exitCode !== null) {
    kind = 'nonzero_exit';
  }

  return {
    kind,
    exitCode,
    errorExcerpt: formatErrorExcerpt(resultText),
  };
}

export function analyzeToolCall(toolCall: ToolCall): ToolCallAnalysis {
  const normalizedToolName = normalizeToolCallName(toolCall.name);
  const skillName = getSkillNameFromToolCall(toolCall);
  const verificationKinds = classifyVerificationCommandKindsFromInput(toolCall.input);
  const subagentUsage = normalizedToolName === 'subagent'
    ? extractSubagentUsage(toolCall.input, toolCall.result)
    : { taskCount: 0, agents: [] as string[], scoredTaskCount: 0, taskScores: createEmptySubagentTaskScoreRollup() };
  const fileMutation = getFileMutationFromToolCall(toolCall);
  const fileExtension = getFileExtensionFromToolCall(toolCall);

  return {
    normalizedToolName,
    skillName,
    subagentCallCount: normalizedToolName === 'subagent' ? 1 : 0,
    subagentTaskCount: subagentUsage.taskCount,
    subagentAgentNames: subagentUsage.agents,
    subagentScoredTaskCount: subagentUsage.scoredTaskCount,
    subagentTaskScores: subagentUsage.taskScores,
    verificationKinds,
    fileMutation,
    fileExtension,
    failure: classifyToolFailure(toolCall, verificationKinds),
  };
}

export function incrementNamedCount(record: Record<string, number>, key: string): void {
  incrementCount(record, key);
}
