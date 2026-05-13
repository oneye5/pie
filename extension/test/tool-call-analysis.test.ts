import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analyzeToolCall,
  getToolCallSizeHint,
  summarizeSubagentToolCallInput,
  type FileMutationDelta,
} from '../src/shared/tool-call-analysis';
import type { ToolCall } from '../src/shared/protocol';

function makeToolCall(overrides: Partial<ToolCall>): ToolCall {
  return {
    id: 'tool-1',
    name: 'bash',
    input: {},
    status: 'completed',
    ...overrides,
  };
}

function expectMutation(delta: FileMutationDelta, expected: Partial<FileMutationDelta>): void {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(delta[key as keyof FileMutationDelta], value);
  }
}

test('analyzeToolCall classifies verification commands across common categories', () => {
  const testTool = analyzeToolCall(makeToolCall({
    input: { command: 'npm test -- --runInBand' },
  }));
  const lintTool = analyzeToolCall(makeToolCall({
    input: { command: 'pnpm lint' },
  }));
  const typecheckTool = analyzeToolCall(makeToolCall({
    input: { command: 'tsc --noEmit -p tsconfig.json' },
  }));
  const buildTool = analyzeToolCall(makeToolCall({
    input: { command: 'vite build' },
  }));
  const otherTool = analyzeToolCall(makeToolCall({
    input: { command: 'cargo check' },
  }));

  assert.deepEqual(testTool.verificationKinds, ['test']);
  assert.deepEqual(lintTool.verificationKinds, ['lint']);
  assert.deepEqual(typecheckTool.verificationKinds, ['typecheck']);
  assert.deepEqual(buildTool.verificationKinds, ['build']);
  assert.deepEqual(otherTool.verificationKinds, ['other']);
});

test('analyzeToolCall ignores non-command explanation text when classifying verification activity', () => {
  const analysis = analyzeToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      explanation: 'validate collapsed tool-call headers before release',
      input: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch',
    },
  }));

  assert.deepEqual(analysis.verificationKinds, []);
});

test('analyzeToolCall captures subagent usage details', () => {
  const analysis = analyzeToolCall(makeToolCall({
    name: 'subagent',
    input: {
      tasks: [
        { agent: 'scout', task: 'Find prompt factor sources' },
        { agent: 'reviewer', task: 'Check analytics diffs' },
      ],
    },
  }));

  assert.equal(analysis.subagentCallCount, 1);
  assert.equal(analysis.subagentTaskCount, 2);
  assert.deepEqual(analysis.subagentAgentNames, ['scout', 'reviewer']);
});

test('analyzeToolCall extracts mutation rollups from edit and patch tools', () => {
  const editAnalysis = analyzeToolCall(makeToolCall({
    name: 'edit',
    input: {
      path: '/workspace/src/main.ts',
      edits: [{
        oldText: 'const value = 1;\n',
        newText: 'const value = 2;\nconst next = 3;\n',
      }],
    },
  }));
  const patchAnalysis = analyzeToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      input: [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+export const created = true;',
        '*** Update File: src/main.ts',
        '@@',
        '-const value = 1;',
        '+const value = 2;',
        '*** Delete File: src/old.ts',
        '*** End Patch',
      ].join('\n'),
    },
  }));

  expectMutation(editAnalysis.fileMutation, {
    editCount: 1,
    touchedFileCount: 1,
    lineModifications: 2,
  });
  expectMutation(patchAnalysis.fileMutation, {
    writeCount: 1,
    editCount: 1,
    deleteCount: 1,
    touchedFileCount: 3,
    lineAdditions: 1,
    lineModifications: 1,
  });
});

test('analyzeToolCall does not double-count touched files for rename patches with updates', () => {
  const renamePatchAnalysis = analyzeToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      input: [
        '*** Begin Patch',
        '*** Update File: src/main.ts',
        '@@',
        '-const value = 1;',
        '+const value = 2;',
        '*** Move to: src/main-renamed.ts',
        '*** End Patch',
      ].join('\n'),
    },
  }));

  expectMutation(renamePatchAnalysis.fileMutation, {
    editCount: 1,
    renameCount: 1,
    touchedFileCount: 1,
    lineModifications: 1,
  });
});

test('getToolCallSizeHint and summarizeSubagentToolCallInput stay aligned with transcript UI expectations', () => {
  const sizeHint = getToolCallSizeHint(makeToolCall({
    name: 'write',
    input: {
      path: '/workspace/generated.ts',
      content: 'export const value = 1;\nexport const next = 2;\n',
    },
  }));

  const summary = summarizeSubagentToolCallInput({
    agent: 'planner',
    task: 'Capture prompt and tool metadata before transport lowering',
  });

  assert.equal(sizeHint, '+2 lines');
  assert.equal(summary, 'planner: Capture prompt and tool metadata before transport lowering');
});

test('getToolCallSizeHint suppresses hints for failed tool calls', () => {
  const readHint = getToolCallSizeHint(makeToolCall({
    name: 'read_file',
    status: 'failed',
    input: {
      filePath: '/workspace/src/missing.ts',
      startLine: 1,
      endLine: 25,
    },
  }));

  const editHint = getToolCallSizeHint(makeToolCall({
    name: 'edit',
    status: 'failed',
    input: {
      path: '/workspace/src/main.ts',
      edits: [{
        oldText: 'const value = 1;\n',
        newText: 'const value = 2;\n',
      }],
    },
  }));

  assert.equal(readHint, null);
  assert.equal(editHint, null);
});
