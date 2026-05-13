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
    sizeHint: '~47 lines',
    variant: 'skill-load',
  });
});

test('getToolCallPresentation makes in-workdir file paths relative and clickable', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read_file',
    input: {
      filePath: 'D:\\Projects\\StandAloneProjects\\pie\\main.java',
      startLine: 1,
      endLine: 20,
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'read_file',
    summary: 'main.java',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\main.java',
    sizeHint: '~20 lines',
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
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'read_file',
    summary: 'D:\\Projects\\Elsewhere\\main.java',
    summaryPath: 'D:\\Projects\\Elsewhere\\main.java',
    sizeHint: '~20 lines',
  });
});

test('getToolCallPresentation keeps file names visible when long paths are truncated', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read',
    input: {
      path: 'very/long/path/to/a/deeply/nested/location/with/more/segments/than/usual/docs/IDEAS.md',
    },
  }));

  assert.equal(presentation.name, 'read');
  assert.ok(presentation.summary?.startsWith('.../'));
  assert.ok(presentation.summary?.endsWith('/IDEAS.md'));
});

test('getToolCallPresentation resolves read tool path inputs against cwd', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read',
    input: {
      path: 'src\\main.java',
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'read',
    summary: 'src\\main.java',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\main.java',
  });
});

test('getToolCallPresentation skips read hints for non-file open tools', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'open_url',
    input: {
      url: 'https://example.com/docs',
    },
    result: 'line one\nline two\n',
  }));

  assert.deepEqual(presentation, {
    name: 'open_url',
    summary: 'https://example.com/docs',
  });
});

test('getToolCallPresentation estimates limit-based read sizes', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read',
    input: {
      path: 'src\\main.java',
      offset: 40,
      limit: 12,
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'read',
    summary: 'src\\main.java',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\main.java',
    sizeHint: '~12 lines',
  });
});

test('getToolCallPresentation clamps read size hints to the returned content', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read_file',
    input: {
      filePath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\short.ts',
      startLine: 1,
      endLine: 20,
    },
    result: 'one\ntwo\nthree\nfour\nfive\n',
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'read_file',
    summary: 'src\\short.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\short.ts',
    sizeHint: '~5 lines',
  });
});

test('getToolCallPresentation suppresses read size hints for empty returned content', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read_file',
    input: {
      filePath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\empty.ts',
      startLine: 1,
      endLine: 20,
    },
    result: '',
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'read_file',
    summary: 'src\\empty.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\empty.ts',
  });
});

test('getToolCallPresentation omits size hints for failed file tools', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'read_file',
    status: 'failed',
    input: {
      filePath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\missing.ts',
      startLine: 1,
      endLine: 20,
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'read_file',
    summary: 'src\\missing.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\missing.ts',
  });
});

test('getToolCallPresentation handles non-read filePath fields the same way', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'create_file',
    input: {
      filePath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\generated.ts',
      content: 'export const value = 1;',
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'create_file',
    summary: 'src\\generated.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\generated.ts',
    sizeHint: '+1 line',
  });
});

test('getToolCallPresentation handles rename-style file path fields', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'rename_file',
    input: {
      oldPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\old.ts',
      newPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\new.ts',
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'rename_file',
    summary: 'src\\old.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\old.ts',
  });
});

test('getToolCallPresentation marks replacement edits as approximate changes', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'edit',
    input: {
      path: 'D:\\Projects\\StandAloneProjects\\pie\\src\\main.ts',
      edits: [
        {
          oldText: 'const a = 1;\nconst b = 2;\n',
          newText: 'const a = 10;\nconst b = 20;\n',
        },
      ],
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'edit',
    summary: 'src\\main.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\main.ts',
    sizeHint: '~2 lines',
  });
});

test('getToolCallPresentation marks pure deletions as subtractive edits', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'edit',
    input: {
      path: 'D:\\Projects\\StandAloneProjects\\pie\\src\\obsolete.ts',
      edits: [
        {
          oldText: 'line one\nline two\nline three\n',
          newText: '',
        },
      ],
    },
  }), {
    workingDirectory: 'D:\\Projects\\StandAloneProjects\\pie',
  });

  assert.deepEqual(presentation, {
    name: 'edit',
    summary: 'src\\obsolete.ts',
    summaryPath: 'D:\\Projects\\StandAloneProjects\\pie\\src\\obsolete.ts',
    sizeHint: '-3 lines',
  });
});

test('getToolCallPresentation adds patch size hints even without file-path summaries', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'apply_patch',
    input: {
      explanation: 'Update collapsed tool-call headers',
      input: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old summary\n+new summary\n+extra detail\n*** End Patch',
    },
  }));

  assert.deepEqual(presentation, {
    name: 'apply_patch',
    summary: 'Update collapsed tool-call headers',
    sizeHint: '~2 lines',
  });
});

test('getToolCallPresentation treats raw patch replacements as touched-line estimates', () => {
  const presentation = getToolCallPresentation(makeToolCall({
    name: 'apply_patch',
    input: {
      explanation: 'Rename one line',
      input: '*** Begin Patch\n*** Update File: src/example.ts\n@@\n-old summary\n+new summary\n*** End Patch',
    },
  }));

  assert.deepEqual(presentation, {
    name: 'apply_patch',
    summary: 'Rename one line',
    sizeHint: '~1 line',
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
