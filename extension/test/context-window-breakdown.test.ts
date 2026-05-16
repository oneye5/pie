import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, SystemPromptEntry } from '../src/shared/protocol';
import { buildContextWindowBreakdown } from '../src/webview/panel/context-window/breakdown';

function makePrompt(overrides: Partial<SystemPromptEntry> = {}): SystemPromptEntry {
  return {
    source: 'user',
    title: 'User system prompt',
    text: 'abcd',
    summary: 'abcd',
    availability: 'available',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'message-1',
    role: 'user',
    createdAt: new Date().toISOString(),
    markdown: '',
    status: 'completed',
    ...overrides,
  };
}

test('buildContextWindowBreakdown sorts top contributors first, uses derived Other when exact usage is known', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: 20,
      contextWindow: 100,
      percent: 20,
    },
    effectiveContextWindow: 100,
    systemPrompts: [
      makePrompt({ source: 'provider', availability: 'unknown', text: '' }),
      makePrompt({ source: 'harness', text: 'abcd' }),
      makePrompt({ source: 'user', title: 'System append', text: 'abcde' }),
      makePrompt({ source: 'user', title: 'Repo prompt', text: 'abcdefgh' }),
    ],
    transcript: [
      makeMessage({ role: 'user', markdown: 'abcd' }),
      makeMessage({
        id: 'message-2',
        role: 'assistant',
        markdown: 'abcdefgh',
        thinking: 'abcd',
        toolCalls: [{
          id: 'tool-1',
          name: 'run',
          input: 'abcd',
          result: 'abcdefgh',
          status: 'completed',
        }],
      }),
      makeMessage({ id: 'message-3', role: 'system', markdown: 'ab' }),
    ],
    isPartial: false,
  });

  const byLabel = new Map(breakdown.entries.map((entry) => [entry.label ?? entry.key, entry]));
  const footer = new Map(breakdown.footerEntries.map((entry) => [entry.key, entry]));

  assert.equal(byLabel.get('System prompt')?.kind, 'estimated');
  assert.equal(byLabel.get('User message')?.kind, 'estimated');
  assert.ok(byLabel.get('User message')?.note?.includes('abcd'));
  assert.equal(byLabel.get('Other')?.kind, 'derived');

  assert.deepEqual(breakdown.summary, {
    usedTokens: 20,
    usedKind: 'exact',
    remainingTokens: 80,
    remainingKind: 'exact',
    totalWindow: 100,
  });

  assert.equal(footer.get('window.total')?.value, '100');
  assert.equal(footer.get('window.used')?.value, '20');
  assert.equal(footer.get('window.remaining')?.value, '80');

  assert.match(breakdown.title, /Used: 20/m);
  assert.match(breakdown.title, /Remaining: 80/m);
  assert.match(breakdown.title, /System prompt: ~5 estimated/m);
});

test('buildContextWindowBreakdown classifies read_file tool calls individually', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: null,
    effectiveContextWindow: 200000,
    systemPrompts: [],
    transcript: [
      makeMessage({
        id: 'msg-1',
        role: 'assistant',
        markdown: '',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'read_file',
            input: { filePath: 'src/backend/index.ts' },
            result: 'abcdefghijklmnopqrstuvwxyz',
            status: 'completed',
          },
          {
            id: 'tool-2',
            name: 'read_file',
            input: { filePath: '/home/user/skills/frontend-design/SKILL.md' },
            result: 'abcdefgh',
            status: 'completed',
          },
          {
            id: 'tool-3',
            name: 'bash',
            input: { command: 'ls' },
            result: 'file1\nfile2',
            status: 'completed',
          },
        ],
      }),
    ],
    isPartial: false,
  });

  const readFileEntry = breakdown.entries.find((entry) => (entry.label ?? entry.key) === 'Read file');
  assert.ok(readFileEntry);
  assert.match(readFileEntry.note ?? '', /src\/backend\/index\.ts/);

  const skillEntry = breakdown.entries.find((entry) => (entry.label ?? entry.key) === 'Skill');
  assert.ok(skillEntry);
  assert.equal(skillEntry.note, 'frontend-design');

  const otherEntry = breakdown.entries.find((entry) => entry.key === 'other');
  assert.ok(otherEntry);
  assert.equal(otherEntry.kind, 'estimated');
});

test('buildContextWindowBreakdown estimates footer values without a PI usage snapshot', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: null,
      contextWindow: 200000,
      percent: null,
    },
    effectiveContextWindow: 200000,
    systemPrompts: [makePrompt({ source: 'user', availability: 'missing', text: '' })],
    transcript: [],
    isPartial: false,
  });

  const footer = new Map(breakdown.footerEntries.map((entry) => [entry.key, entry]));
  assert.equal(footer.get('window.used')?.value, '0');
  assert.equal(footer.get('window.remaining')?.value, '~200,000');
  assert.equal(footer.get('window.total')?.value, '200,000');
});

test('buildContextWindowBreakdown suppresses contributor rows when transcript is partial', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: 64000,
      contextWindow: 200000,
      percent: 32,
    },
    effectiveContextWindow: 200000,
    systemPrompts: [makePrompt({ text: 'system' })],
    transcript: [
      makeMessage({ id: 'msg-user', role: 'user', markdown: 'hello' }),
      makeMessage({ id: 'msg-assistant', role: 'assistant', markdown: 'world' }),
    ],
    isPartial: true,
  });

  assert.deepEqual(breakdown.entries, []);
  assert.equal(breakdown.summary.usedTokens, 64000);
  assert.equal(breakdown.summary.usedKind, 'exact');
  assert.match(breakdown.title, /partial transcript window is loaded/i);
});
