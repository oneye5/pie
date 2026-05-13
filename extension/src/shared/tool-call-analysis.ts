import type { ToolCall } from './protocol';
import {
  getSkillNameFromToolCall,
  normalizeToolCallName,
  summarizeSubagentToolCallInput,
} from './tool-call-analysis-summary';
import {
  createEmptyFileMutationDelta,
  getFileMutationFromToolCall,
  getToolCallSizeHint,
  mergeFileMutationDelta,
  type FileMutationDelta,
} from './tool-call-analysis-mutation';
import {
  classifyVerificationCommandKindsFromInput,
  extractSubagentUsage,
  type VerificationCommandKind,
} from './tool-call-analysis-verification';

export type { VerificationCommandKind, FileMutationDelta };
export {
  normalizeToolCallName,
  summarizeSubagentToolCallInput,
  getSkillNameFromToolCall,
  getToolCallSizeHint,
  mergeFileMutationDelta,
  createEmptyFileMutationDelta,
};

export interface ToolCallAnalysis {
  normalizedToolName: string;
  skillName: string | null;
  subagentCallCount: number;
  subagentTaskCount: number;
  subagentAgentNames: string[];
  verificationKinds: VerificationCommandKind[];
  fileMutation: FileMutationDelta;
}

function incrementCount(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

export function analyzeToolCall(toolCall: ToolCall): ToolCallAnalysis {
  const normalizedToolName = normalizeToolCallName(toolCall.name);
  const skillName = getSkillNameFromToolCall(toolCall);
  const verificationKinds = classifyVerificationCommandKindsFromInput(toolCall.input);
  const subagentUsage = normalizedToolName === 'subagent'
    ? extractSubagentUsage(toolCall.input)
    : { taskCount: 0, agents: [] };
  const fileMutation = getFileMutationFromToolCall(toolCall);

  return {
    normalizedToolName,
    skillName,
    subagentCallCount: normalizedToolName === 'subagent' ? 1 : 0,
    subagentTaskCount: subagentUsage.taskCount,
    subagentAgentNames: subagentUsage.agents,
    verificationKinds,
    fileMutation,
  };
}

export function incrementNamedCount(record: Record<string, number>, key: string): void {
  incrementCount(record, key);
}
