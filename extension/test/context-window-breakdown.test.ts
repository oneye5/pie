import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatMessage, SystemPromptEntry } from '../src/shared/protocol';
import { buildContextWindowBreakdown } from '../src/webview/panel/context-window-breakdown';

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
      makePrompt({ source: 'user', text: 'abcde' }),
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
  });

  const byLabel = new Map(breakdown.entries.map((entry) => [entry.label ?? entry.key, entry]));
  const footer = new Map(breakdown.footerEntries.map((entry) => [entry.key, entry]));

  // System prompt (harness 'abcd' ~1 + user 'abcde' ~2 = ~3 tokens)
  assert.equal(byLabel.get('System prompt')?.kind, 'estimated');

  // User message
  assert.equal(byLabel.get('User message')?.kind, 'estimated');
  // Preview of 'abcd' message
  assert.ok(byLabel.get('User message')?.note?.includes('abcd'));

  // Other is derived (exact usage known)
  assert.equal(byLabel.get('Other')?.kind, 'derived');

  // Window stats in footerEntries
  assert.equal(footer.get('window.total')?.value, '100');
  assert.equal(footer.get('window.used')?.value, '20');
  assert.equal(footer.get('window.remaining')?.value, '80');
  assert.equal(footer.get('window.total')?.kind, 'exact');
  assert.equal(footer.get('window.used')?.kind, 'exact');
  assert.equal(footer.get('window.remaining')?.kind, 'exact');

  // Entries are sorted descending by token count (largest first)
  const tokenValues = breakdown.entries
    .filter((e) => e.key !== 'other')
    .map((e) => parseInt(e.value.replace(/[^0-9]/g, ''), 10) || 0);
  for (let i = 1; i < tokenValues.length; i++) {
    assert.ok(tokenValues[i - 1] >= tokenValues[i], `Entry ${i - 1} should have >= tokens than entry ${i}`);
  }

  // Tooltip text contains exact PI totals and labeled estimated rows.
  assert.match(breakdown.title, /^Context window/m);
  assert.match(breakdown.title, /Used: 20/m);
  assert.match(breakdown.title, /Remaining: 80/m);
  assert.match(breakdown.title, /System prompt: ~3 estimated/m);
  assert.match(breakdown.title, /Note: Used and remaining values are reported by PI\./m);
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
            input: { filePath: '/home/user/skills/verification-before-completion/SKILL.md' },
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
  });

  const readFileEntry = breakdown.entries.find(
    (e) => (e.label ?? e.key) === 'Read file',
  );
  assert.ok(readFileEntry, 'Read file entry should exist');
  assert.match(readFileEntry.note ?? '', /src\/backend\/index\.ts/);

  const skillEntry = breakdown.entries.find(
    (e) => (e.label ?? e.key) === 'Skill',
  );
  assert.ok(skillEntry, 'Skill entry should exist');
  assert.equal(skillEntry.note, 'verification-before-completion');

  // bash goes to Other (estimated, no exact usage)
  const otherEntry = breakdown.entries.find((e) => e.key === 'other');
  assert.ok(otherEntry);
  assert.equal(otherEntry.kind, 'estimated');
  assert.match(breakdown.title, /Read file: ~/m);
  assert.match(breakdown.title, /Skill: ~/m);
  assert.match(breakdown.title, /Note: Estimated rows use the chars\/4 heuristic\./m);
});

test('buildContextWindowBreakdown caps native tooltip rows and truncates long path notes', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: 120,
      contextWindow: 1000,
      percent: 12,
    },
    effectiveContextWindow: 1000,
    systemPrompts: [],
    transcript: [
      makeMessage({
        id: 'msg-many',
        role: 'assistant',
        markdown: '',
        toolCalls: Array.from({ length: 8 }, (_, index) => ({
          id: `tool-${index}`,
          name: 'read_file',
          input: { filePath: `very/long/path/to/a/deeply/nested/location/${index}/with-a-very-very-long-file-name-${index}.ts` },
          result: 'abcdefghijklmnopqrstuvwxyz',
          status: 'completed' as const,
        })),
      }),
    ],
  });

  assert.match(breakdown.title, /more rows omitted\./m);
  assert.doesNotMatch(
    breakdown.title,
    /very\/long\/path\/to\/a\/deeply\/nested\/location\/0\/with-a-very-very-long-file-name-0\.ts/m,
  );
  assert.match(breakdown.title, /very\/long\/path\/to\/a\/deeply\/nested\/location\/0\/with-a-very-very-l/m);
});

test('buildContextWindowBreakdown keeps footer unknown without a session usage snapshot', () => {
  const breakdown = buildContextWindowBreakdown({
    contextUsage: {
      tokens: null,
      contextWindow: 200000,
      percent: null,
    },
    effectiveContextWindow: 200000,
    systemPrompts: [makePrompt({ source: 'user', availability: 'missing', text: '' })],
    transcript: [],
  });

  const footer = new Map(breakdown.footerEntries.map((e) => [e.key, e]));
  assert.equal(footer.get('window.used')?.value, 'unknown');
  assert.equal(footer.get('window.remaining')?.value, 'unknown');

  // Other is estimated (no exact usage)
  const otherEntry = breakdown.entries.find((e) => e.key === 'other');
  assert.ok(otherEntry);
  assert.equal(otherEntry.kind, 'estimated');

  assert.match(breakdown.title, /Note: PI reports used and remaining after the first response\./m);
  assert.match(breakdown.title, /Used: unknown/m);
  assert.match(breakdown.title, /Remaining: unknown/m);
  assert.match(breakdown.title, /Total: 200,000/m);
});