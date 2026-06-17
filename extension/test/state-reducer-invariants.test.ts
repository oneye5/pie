/**
 * Tests targeting state/reducer invariants, edge cases, and consistency across
 * the arch reducer, CQRS arch state, and selectViewState projection.
 *
 * Fills gaps in existing coverage: SessionClosed cleanup, cross-session
 * isolation, UI slice deep merges, settings empty-refresh preservation,
 * ViewState consistency, and slice-specific edge cases.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { produce } from 'immer';
import { reducer, initialArchState, type ArchState } from '../src/host/core/reducer';
import { createInitialArchState } from '../src/host/core/arch-state';
import { selectViewState } from '../src/host/core/projection';
import type { Event } from '../src/host/core/events';
import type { ModelInfo } from '../src/shared/protocol';
import { CHAT_PREF_MENU_SECTIONS } from '../src/webview/panel/chat-prefs';

// A state with backendReady=true — needed because the Send Command handler
// queues into backendReadyQueueBySession when !backendReady (Phase 3 chunk 2).
const readyState: ArchState = {
  ...initialArchState,
  settings: { ...initialArchState.settings, backendReady: true },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function archStateWithSession(path: string): ArchState {
  return {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, interruptInFlightBySession: { [path]: false } },
  };
}

function archStateWithPending(
  corrId: string,
  op: { kind: 'send' | 'edit'; sessionPath: string; localId: string; previousSummary?: any },
): ArchState {
  return {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      ops: {
        ...initialArchState.pending.ops,
        [corrId]: { ...op, previousSummary: op.previousSummary ?? null },
      },
    },
  };
}

// ─── Arch reducer: SessionClosed ──────────────────────────────────────────────

test('arch: SessionClosed removes per-session arch state but preserves other sessions', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: {
      ...initialArchState.sessions,
      interruptInFlightBySession: {
        '/s/a': true,
        '/s/b': false,
      },
    },
    pending: {
      ...initialArchState.pending,
      currentTurnBySession: {
        '/s/a': { requestId: 'req-1', firstMessageId: 'msg-1' },
        '/s/b': { requestId: 'req-2', firstMessageId: 'msg-2' },
      },
    },
  };

  const result = reducer(state, { kind: 'SessionClosed', sessionPath: '/s/a' });

  assert.equal(result.state.sessions.interruptInFlightBySession['/s/a'], undefined);
  assert.equal(result.state.sessions.interruptInFlightBySession['/s/b'], false);
  assert.equal(result.state.pending.currentTurnBySession['/s/a'], undefined);
  assert.deepEqual(result.state.pending.currentTurnBySession['/s/b'], {
    requestId: 'req-2',
    firstMessageId: 'msg-2',
  });
  assert.deepEqual(result.effects, []);
});

test('arch: SessionClosed removes pending operations belonging to the closed session', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      ops: {
        'c1': { kind: 'send', sessionPath: '/s/a', localId: 'loc-1', previousSummary: null },
        'c2': { kind: 'edit', sessionPath: '/s/b', localId: 'loc-2', previousSummary: null },
        'c3': { kind: 'send', sessionPath: '/s/a', localId: 'loc-3', previousSummary: null },
      },
    },
  };

  const result = reducer(state, { kind: 'SessionClosed', sessionPath: '/s/a' });

  assert.equal(result.state.pending.ops['c1'], undefined);
  assert.equal(result.state.pending.ops['c3'], undefined);
  assert.deepEqual(result.state.pending.ops['c2'], {
    kind: 'edit',
    sessionPath: '/s/b',
    localId: 'loc-2',
    previousSummary: null,
  });
});

test('arch: SessionClosed on unknown session is a no-op', () => {
  const result = reducer(initialArchState, {
    kind: 'SessionClosed',
    sessionPath: '/nonexistent',
  });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Arch reducer: cross-session isolation ────────────────────────────────────

test('arch: concurrent sends across different sessions do not interfere', () => {
  const state = reducer(readyState, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-a',
      sessionPath: '/s/a',
      text: 'text-a',
      inputs: [],
      composedText: 'text-a',
      localId: 'loc-a',
      userParts: [],
      previousSummary: null,
      timestamp: 1,
    },
  }).state;

  const result = reducer(state, {
    kind: 'Command',
    cmd: {
      kind: 'Send',
      corrId: 'c-b',
      sessionPath: '/s/b',
      text: 'text-b',
      inputs: [],
      composedText: 'text-b',
      localId: 'loc-b',
      userParts: [],
      previousSummary: null,
      timestamp: 1,
    },
  });

  assert.deepEqual(result.state.pending.ops['c-a'], {
    kind: 'send',
    sessionPath: '/s/a',
    localId: 'loc-a',
    previousSummary: null,
  });
  assert.deepEqual(result.state.pending.ops['c-b'], {
    kind: 'send',
    sessionPath: '/s/b',
    localId: 'loc-b',
    previousSummary: null,
  });
});

test('arch: Interrupt on one session does not affect another session', () => {
  const state: ArchState = archStateWithSession('/s/b');

  const result = reducer(state, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c1', sessionPath: '/s/a' },
  });

  assert.equal(result.state.sessions.interruptInFlightBySession['/s/a'], true);
  assert.equal(result.state.sessions.interruptInFlightBySession['/s/b'], false);
});

// ─── Arch reducer: Edit edge cases ────────────────────────────────────────────

test('arch: EditResult for unknown corrId is a no-op', () => {
  const result = reducer(initialArchState, {
    kind: 'EditResult',
    corrId: 'unknown',
    sessionPath: '/s',
    ok: true,
  });
  assert.deepEqual(result.state, initialArchState);
  assert.deepEqual(result.effects, []);
});

// ─── Arch reducer: MessageStarted variations ──────────────────────────────────

test('arch: MessageStarted without modelId still creates turn and assistant message in transcript', () => {
  const result = reducer(initialArchState, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-1',
    requestId: 'req-1',
    timestamp: 1,
  });

  assert.deepEqual(result.state.pending.currentTurnBySession['/s'], {
    requestId: 'req-1',
    firstMessageId: 'msg-1',
  });
  // Assistant message created directly in transcript
  const msg = result.state.transcript.bySession['/s']?.find(m => m.id === 'msg-1');
  assert.ok(msg, 'assistant message should exist in transcript');
  assert.equal(msg!.role, 'assistant');
  assert.equal(msg!.status, 'streaming');
  assert.equal(msg!.modelId, undefined);
  assert.equal(msg!.thinkingLevel, undefined);
  // No SyncEffects
  assert.equal(result.effects.length, 0);
});

test('arch: MessageStarted with different requestId starts a new turn', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      currentTurnBySession: {
        '/s': { requestId: 'req-old', firstMessageId: 'msg-old' },
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-new',
    requestId: 'req-new',
    timestamp: 1,
  });

  assert.deepEqual(result.state.pending.currentTurnBySession['/s'], {
    requestId: 'req-new',
    firstMessageId: 'msg-new',
  });
  // New assistant message created in transcript
  const msg = result.state.transcript.bySession['/s']?.find(m => m.id === 'msg-new');
  assert.ok(msg, 'new assistant message should exist');
  assert.equal(msg!.role, 'assistant');
});

test('arch: MessageStarted without requestId does not change current turn', () => {
  const state: ArchState = {
    ...initialArchState,
    pending: {
      ...initialArchState.pending,
      currentTurnBySession: {
        '/s': { requestId: 'req-1', firstMessageId: 'msg-1' },
      },
    },
  };

  const result = reducer(state, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'msg-2',
    // no requestId
    timestamp: 1,
  });

  // currentTurnBySession unchanged because no requestId
  assert.deepEqual(result.state.pending.currentTurnBySession['/s'], {
    requestId: 'req-1',
    firstMessageId: 'msg-1',
  });
});

// ─── Arch reducer: MessageFinished without alias ──────────────────────────────

test('arch: MessageFinished on canonical (non-aliased) ID upserts message directly in transcript', () => {
  const message = {
    id: 'direct-msg',
    role: 'assistant' as const,
    createdAt: '',
    markdown: 'content',
    status: 'completed' as const,
  } as any;

  const result = reducer(initialArchState, {
    kind: 'MessageFinished',
    sessionPath: '/s',
    message,
  });

  // Message upserted directly in transcript
  const msg = result.state.transcript.bySession['/s']?.find(m => m.id === 'direct-msg');
  assert.ok(msg, 'message should exist in transcript');
  assert.equal(msg!.status, 'completed');
  // No SyncEffects
  assert.equal(result.effects.length, 0);
});

// ─── Arch reducer: ToolCall with unknown messageId ────────────────────────────

test('arch: ToolCall with unknown messageId produces no effect (message not in transcript)', () => {
  const tc = { id: 'tc-1', name: 'read', input: { path: 'f.txt' }, status: 'running' as const };
  const result = reducer(initialArchState, {
    kind: 'ToolCall',
    sessionPath: '/s',
    messageId: 'unknown-msg',
    toolCall: tc,
  });

  // Message not in transcript, so tool call is silently ignored.
  // No state change and no SyncEffects.
  assert.equal(result.effects.length, 0);
});

// ─── Arch reducer: Backend event scheduling consistency ───────────────────────

test('arch: every streaming event mutates state directly (no SyncEffects)', () => {
  // Seed a streaming message for the delta/thinking/toolcall events
  const seedResult = reducer(initialArchState, {
    kind: 'MessageStarted',
    sessionPath: '/s',
    messageId: 'm1',
    requestId: 'r1',
    timestamp: 1,
  });
  const seededState = seedResult.state;

  const events: Event[] = [
    { kind: 'MessageStarted', sessionPath: '/s', messageId: 'm1', requestId: 'r1', timestamp: 1 },
    { kind: 'MessageDelta', sessionPath: '/s', messageId: 'm1', delta: 'hi' },
    { kind: 'MessageThinking', sessionPath: '/s', messageId: 'm1', thinking: 'plan' },
    { kind: 'ToolCall', sessionPath: '/s', messageId: 'm1', toolCall: { id: 't1', name: 'bash', input: {}, status: 'running' } },
  ];

  // MessageStarted uses initial state, others use seeded state
  for (const event of events) {
    const state = event.kind === 'MessageStarted' ? initialArchState : seededState;
    const result = reducer(state, event);
    // All streaming events now mutate state directly — no SyncEffects
    assert.equal(
      result.effects.length,
      0,
      `${event.kind} should not produce SyncEffects`,
    );
  }
});

// ─── selectViewState consistency ──────────────────────────────────────────────

test('selectViewState: workspaceCwd is null when not set', () => {
  const vs = selectViewState(initialArchState);
  assert.equal(vs.workspaceCwd, null);
});

test('selectViewState: workspaceCwd propagates when set', () => {
  const state = produce(initialArchState, draft => {
    draft.sessions.workspaceCwd = '/project';
  });
  const vs = selectViewState(state);
  assert.equal(vs.workspaceCwd, '/project');
});

test('selectViewState: busy is false when no active session even if sessions are running', () => {
  const state = produce(initialArchState, draft => {
    draft.sessions.runningSessionPaths = ['/s'];
    draft.sessions.activeSessionPath = null;
  });
  const vs = selectViewState(state);
  assert.equal(vs.busy, false);
});

test('selectViewState: systemPrompts is empty when no active session', () => {
  const vs = selectViewState(initialArchState);
  assert.deepEqual(vs.systemPrompts, []);
});

test('selectViewState: fileChanges returns empty when no active session', () => {
  const vs = selectViewState(initialArchState);
  assert.deepEqual(vs.fileChanges, []);
});

test('selectViewState: editingMessageId, showOutcomeDialog, pendingExtensionUIRequest are null/false initially', () => {
  const vs = selectViewState(initialArchState);
  assert.equal(vs.editingMessageId, null);
  assert.equal(vs.showOutcomeDialog, false);
  assert.equal(vs.pendingExtensionUIRequest, null);
  assert.deepEqual(vs.pendingExtensionUIRequestsBySession, {});
});

test('selectViewState: availableExtensions propagates from state', () => {
  const extensions = [{ id: 'ext1', label: 'Ext 1', description: 'Extension 1' }];
  const state = produce(initialArchState, draft => {
    draft.settings.availableExtensions = extensions;
  });
  const vs = selectViewState(state);
  assert.deepEqual(vs.availableExtensions, extensions);
});

test('selectViewState: pruningResult is null when showPruningMessages is false', () => {
  const state = produce(initialArchState, draft => {
    draft.settings.prefs.showPruningMessages = false;
    draft.sessions.activeSessionPath = '/s';
    draft.transcript.bySession['/s'] = [{
      id: 'prune-msg',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      customType: 'pruning-result' as const,
      customDetails: {
        includedSkills: ['skill-a'],
        excludedSkills: ['skill-b'],
        includedTools: ['tool-1', 'tool-2'],
        excludedTools: ['tool-3'],
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
    }];
  });
  const vs = selectViewState(state);
  assert.equal(vs.pruningResult, null);
});

test('selectViewState: pruningResult is derived when showPruningMessages is enabled', () => {
  const state = produce(initialArchState, draft => {
    draft.settings.prefs.showPruningMessages = true;
    draft.sessions.activeSessionPath = '/s';
    draft.transcript.bySession['/s'] = [{
      id: 'prune-msg',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
      customType: 'pruning-result' as const,
      customDetails: {
        includedSkills: ['skill-a'],
        excludedSkills: ['skill-b'],
        includedTools: ['tool-1', 'tool-2'],
        excludedTools: ['tool-3'],
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
    }];
  });
  const vs = selectViewState(state);
  assert.ok(vs.pruningResult);
  assert.equal(vs.pruningResult?.skillsKept, 1);
  assert.equal(vs.pruningResult?.skillsTotal, 2);
  assert.equal(vs.pruningResult?.toolsKept, 2);
  assert.equal(vs.pruningResult?.toolsTotal, 3);
  assert.equal(vs.pruningResult?.tokensSaved, 150);
  assert.equal(vs.pruningResult?.hasSkillPruning, true);
  assert.equal(vs.pruningResult?.hasToolPruning, true);
});

test('selectViewState: contextUsage is null when no active session', () => {
  const vs = selectViewState(initialArchState);
  assert.equal(vs.contextUsage, null);
});

test('selectViewState: multi-session isolation — transcript for one session does not leak to another', () => {
  let state = produce(initialArchState, draft => {
    draft.transcript.bySession['/a'] = [{
      id: 'msg-a',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
    }];
    draft.transcript.bySession['/b'] = [{
      id: 'msg-b',
      role: 'assistant' as const,
      createdAt: '',
      markdown: '',
      status: 'completed' as const,
    }];
  });

  // Active session is /a
  state = produce(state, draft => {
    draft.sessions.activeSessionPath = '/a';
    draft.sessions.sessions = [
      { path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 },
    ];
  });
  let vs = selectViewState(state);
  assert.equal(vs.transcript.length, 1);
  assert.equal(vs.transcript[0]?.id, 'msg-a');

  // Switch to /b
  state = produce(state, draft => {
    draft.sessions.activeSessionPath = '/b';
    draft.sessions.sessions = [
      { path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 },
      { path: '/b', name: 'B', cwd: '/', modifiedAt: '', messageCount: 0 },
    ];
  });
  vs = selectViewState(state);
  assert.equal(vs.transcript.length, 1);
  assert.equal(vs.transcript[0]?.id, 'msg-b');
});

test('selectViewState: availableModels is session-scoped', () => {
  const modelsA: ModelInfo[] = [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text'] }];
  const modelsB: ModelInfo[] = [{ id: 'claude', name: 'Claude', provider: 'anthropic', reasoning: true, inputKinds: ['text'] }];

  let state = produce(initialArchState, draft => {
    draft.settings.availableModelsBySession['/a'] = modelsA;
    draft.settings.availableModelsBySession['/b'] = modelsB;
  });

  state = produce(state, draft => {
    draft.sessions.activeSessionPath = '/a';
    draft.sessions.sessions = [{ path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 }];
  });
  assert.deepEqual(selectViewState(state).availableModels, modelsA);

  state = produce(state, draft => {
    draft.sessions.activeSessionPath = '/b';
    draft.sessions.sessions = [
      { path: '/a', name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 },
      { path: '/b', name: 'B', cwd: '/', modifiedAt: '', messageCount: 0 },
    ];
  });
  assert.deepEqual(selectViewState(state).availableModels, modelsB);
});

test('selectViewState exposes session-derived pruning catalog as enum options', () => {
  const sessionPath = '/a';
  const state = produce(initialArchState, draft => {
    draft.sessions.sessions = [{ path: sessionPath, name: 'A', cwd: '/', modifiedAt: '', messageCount: 0 }];
    draft.sessions.activeSessionPath = sessionPath;
    draft.sessions.analyticsFactorsBySession[sessionPath] = {
      promptFamily: 'harness+skills',
      promptHash: 'prompt-hash',
      harnessPromptHash: 'harness-hash',
      customPromptHash: null,
      appendSystemPromptHash: null,
      promptGuidelineHashes: [],
      contextFiles: [],
      selectedToolIds: ['read', 'bash', 'read', 'subagent'],
      toolSnippetHashes: [],
      toolSetHash: 'tool-set-hash',
      skills: [
        {
          name: 'debugging',
          contentHash: 'content-a',
          sourceHash: 'source-a',
          disableModelInvocation: false,
          lastModifiedAt: null,
        },
        {
          name: 'hidden-skill',
          contentHash: 'content-b',
          sourceHash: 'source-b',
          disableModelInvocation: true,
          lastModifiedAt: null,
        },
        {
          name: 'analysis',
          contentHash: 'content-c',
          sourceHash: 'source-c',
          disableModelInvocation: false,
          lastModifiedAt: null,
        },
      ],
      skillSetHash: 'skill-set-hash',
      activeExtensions: ['skill-pruner'],
    };
  });

  assert.deepEqual(selectViewState(state).pruningCatalog, {
    skills: ['analysis', 'debugging'],
    tools: ['bash', 'read', 'subagent'],
  });
});

// ─── ViewState: full snapshot invariant ───────────────────────────────────────

test('ViewState: all fields are present in initial state', () => {
  const vs = selectViewState(initialArchState);

  // Spot-check all top-level fields are present (not undefined)
  const requiredKeys = [
    'sessions', 'openTabPaths', 'runningSessionPaths', 'unreadFinishedSessionPaths',
    'activeSession', 'transcript', 'transcriptWindow', 'transcriptLoaded', 'pendingComposerInputs',
    'activeRunSummary', 'runSummariesBySession', 'busy', 'notice', 'backendReady',
    'workspaceCwd', 'systemPrompts', 'modelSettings', 'availableModels', 'contextUsage',
    'prefs', 'fileChanges', 'availableExtensions', 'pruningResult', 'pruningSettings',
    'pruningCatalog', 'editingMessageId', 'showOutcomeDialog', 'pendingExtensionUIRequest', 'pendingExtensionUIRequestsBySession',
  ];

  for (const key of requiredKeys) {
    assert.ok(
      key in vs,
      `ViewState missing required field: ${key}`,
    );
  }

  // Value sanity checks
  assert.deepEqual(vs.sessions, []);
  assert.deepEqual(vs.openTabPaths, []);
  assert.deepEqual(vs.runningSessionPaths, []);
  assert.equal(vs.activeSession, null);
  assert.deepEqual(vs.transcript, []);
  assert.equal(vs.transcriptLoaded, false);
  assert.equal(vs.busy, false);
  assert.equal(vs.notice, null);
  assert.equal(vs.backendReady, false);
  assert.equal(vs.workspaceCwd, null);
  assert.equal(vs.modelSettings, null);
  assert.deepEqual(vs.pruningCatalog, { skills: [], tools: [] });
  assert.equal(vs.contextUsage, null);
});

// ─── Chat prefs menu invariant ────────────────────────────────────────────────

test('chatPrefs: menu sections expose all toggleable transcript prefs', () => {
  const transcriptSection = CHAT_PREF_MENU_SECTIONS.find(s => s.id === 'transcript');
  assert.ok(transcriptSection);
  assert.deepEqual(
    transcriptSection?.items.map(i => i.key),
    ['autoExpandReasoning', 'autoExpandToolCalls', 'autoExpandSubagentCalls'],
  );
});

// ─── reducer purity checks ────────────────────────────────────────────────────

test('arch reducer: pure — does not mutate input state', () => {
  const state: ArchState = {
    ...initialArchState,
    sessions: { ...initialArchState.sessions, interruptInFlightBySession: { '/s': false } },
    pending: {
      ...initialArchState.pending,
      ops: { 'c1': { kind: 'send', sessionPath: '/s', localId: 'loc', previousSummary: null } },
    },
  };

  const copy = JSON.parse(JSON.stringify(state));

  reducer(state, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c2', sessionPath: '/s' },
  });

  assert.deepEqual(state, copy);
});

test('arch reducer: pure — returns new state references', () => {
  const result = reducer(initialArchState, {
    kind: 'Command',
    cmd: { kind: 'Interrupt', corrId: 'c1', sessionPath: '/s' },
  });

  assert.notStrictEqual(result.state, initialArchState);
  assert.notStrictEqual(result.state.sessions, initialArchState.sessions);
});
