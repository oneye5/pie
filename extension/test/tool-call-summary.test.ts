import assert from 'node:assert/strict';
import test from 'node:test';

import { getToolCallPresentation, summarizeToolCall } from '../src/webview/panel/tool-call-summary';
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

test('summarizeToolCall prefers command snippets', () => {
  const summary = summarizeToolCall(makeToolCall({
    name: 'bash',
    input: { command: 'npm test   -- --watch' },
  }));

  assert.equal(summary, 'npm test -- --watch');
});

test('summarizeToolCall falls back to file-oriented inputs', () => {
  const summary = summarizeToolCall(makeToolCall({
    name: 'read_file',
    input: { filePath: 'src/webview/panel/transcript.tsx', startLine: 1, endLine: 20 },
  }));

  assert.equal(summary, 'src/webview/panel/transcript.tsx');
});

test('getToolCallPresentation renders skill reads as skill loads', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read_file',
    input: {
      filePath: 'C:\\Users\\ocjla\\AppData\\Local\\Programs\\Microsoft VS Code\\resources\\app\\extensions\\copilot\\assets\\prompts\\skills\\frontend-design\\SKILL.md',
      startLine: 1,
      endLine: 47,
    },
  }));

  assert.deepEqual(presentation, {
    name: 'Load skill frontend-design',
    summary: null,
    variant: 'skill-load',
  });
});

test('getToolCallPresentation makes in-workdir file paths relative and clickable', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read_file',
    input: {
      filePath: 'D:\\Projects\\StandAloneProjects\\pi-config\\main.java',
      startLine: 1,
      endLine: 20,
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pi-config',
  });

  assert.deepEqual(presentation, {
    name: 'read_file',
    summary: 'main.java',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pi-config\\main.java',
  });
});

test('getToolCallPresentation keeps out-of-workdir file paths absolute', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read_file',
    input: {
      filePath: 'D:\\Projects\\Elsewhere\\main.java',
      startLine: 1,
      endLine: 20,
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pi-config',
  });

  assert.deepEqual(presentation, {
    name: 'read_file',
    summary: 'D:\\Projects\\Elsewhere\\main.java',
    summaryPath: 'D:\\Projects\\Elsewhere\\main.java',
  });
});

test('getToolCallPresentation resolves read tool path inputs against cwd', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read',
    input: {
      path: 'src\\main.java',
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pi-config',
  });

  assert.deepEqual(presentation, {
    name: 'read',
    summary: 'src\\main.java',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pi-config\\src\\main.java',
  });
});

test('getToolCallPresentation handles non-read filePath fields the same way', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'create_file',
    input: {
      filePath: 'D:\\Projects\\StandAloneProjects\\pi-config\\src\\generated.ts',
      content: 'export const value = 1;',
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pi-config',
  });

  assert.deepEqual(presentation, {
    name: 'create_file',
    summary: 'src\\generated.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pi-config\\src\\generated.ts',
  });
});

test('getToolCallPresentation handles rename-style file path fields', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'rename_file',
    input: {
      oldPath: 'D:\\Projects\\StandAloneProjects\\pi-config\\src\\old.ts',
      newPath: 'D:\\Projects\\StandAloneProjects\\pi-config\\src\\new.ts',
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pi-config',
  });

  assert.deepEqual(presentation, {
    name: 'rename_file',
    summary: 'src\\old.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pi-config\\src\\old.ts',
  });
});

test('summarizeToolCall includes agent context for single subagent tasks', () => {
  const summary = summarizeToolCall(makeToolCall({
    name: 'subagent',
    input: { agent: 'Explore', task: 'Find collapsed header rendering path in the transcript panel' },
  }));

  assert.equal(summary, 'Explore: Find collapsed header rendering path in the transcript panel');
});

test('summarizeToolCall compresses multi-task subagent input', () => {
  const summary = summarizeToolCall(makeToolCall({
    name: 'subagent',
    input: {
      tasks: [
        { agent: 'scout', task: 'Trace collapsed tool-card rendering' },
        { agent: 'reviewer', task: 'Verify the summary stays subtle' },
      ],
    },
  }));

  assert.equal(summary, 'scout: Trace collapsed tool-card rendering +1 more');
});

test('summarizeToolCall uses explanation before raw patch payloads', () => {
  const summary = summarizeToolCall(makeToolCall({
    name: 'apply_patch',
    input: {
      explanation: 'Update collapsed tool-call headers',
      input: '*** Begin Patch\n*** Update File: src/example.ts\n...',
    },
  }));

  assert.equal(summary, 'Update collapsed tool-call headers');
});