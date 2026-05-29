import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertProtocolVersion,
  DEFAULT_CHAT_PREFS,
  PROTOCOL_VERSION,
  resolveChatPrefs,
  type ChatMessage,
  type ComposerInput,
  type ContextUsageChangedPayload,
  type HostToWebviewMessage,
  type ModelInfo,
  type PatchOp,
  type SessionAnalyticsFactors,
  type SessionOpenedPayload,
  type ToolFinishedPayload,
  type WebviewToHostMessage,
} from '../src/shared/protocol';

// ---------------------------------------------------------------------------
// Protocol contract: PROTOCOL_VERSION is a positive integer that the host and
// backend must agree on. Bumps require a coordinated change.
// ---------------------------------------------------------------------------

test('PROTOCOL_VERSION is a positive integer', () => {
  assert.equal(typeof PROTOCOL_VERSION, 'number');
  assert.ok(Number.isInteger(PROTOCOL_VERSION));
  assert.ok(PROTOCOL_VERSION >= 1);
});

test('DEFAULT_CHAT_PREFS shape', () => {
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandReasoning, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandToolCalls, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.autoExpandSubagentCalls, 'boolean');
  assert.equal(typeof DEFAULT_CHAT_PREFS.suppressCompletionNotifications, 'boolean');
});

test('resolveChatPrefs backfills subagent auto-expand from legacy tool-call prefs', () => {
  assert.equal(resolveChatPrefs({ autoExpandToolCalls: true }).autoExpandSubagentCalls, true);
  assert.equal(
    resolveChatPrefs({ autoExpandToolCalls: true, autoExpandSubagentCalls: false }).autoExpandSubagentCalls,
    false,
  );
});

test('assertProtocolVersion accepts matches and rejects mismatches', () => {
  assert.doesNotThrow(() => {
    assertProtocolVersion('backend.ready', PROTOCOL_VERSION);
  });

  assert.throws(() => {
    assertProtocolVersion('backend.ready', PROTOCOL_VERSION + 1);
  }, /protocol mismatch/i);

  assert.throws(() => {
    assertProtocolVersion('backend.ready', 'not-a-number');
  }, /valid integer protocolVersion/i);
});

test('ModelInfo carries explicit inputKinds capability metadata', () => {
  const model: ModelInfo = {
    id: 'claude-sonnet-4-5',
    name: 'Claude Sonnet 4.5',
    provider: 'anthropic',
    reasoning: true,
    inputKinds: ['text', 'image'],
    contextWindow: 200000,
    maxTokens: 8192,
  };

  assert.deepEqual(model.inputKinds, ['text', 'image']);
});

test('ChatMessage.userParts supports structured user image content', () => {
  const message: ChatMessage = {
    id: 'user-1',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'Please inspect this screenshot',
    userParts: [
      { kind: 'text', text: 'Please inspect this screenshot' },
      {
        kind: 'image',
        mimeType: 'image/png',
        dataBase64: 'ZmFrZQ==',
        name: 'screenshot.png',
        width: 100,
        height: 50,
      },
    ],
    status: 'completed',
  };

  assert.equal(message.userParts?.[1]?.kind, 'image');
});

// ---------------------------------------------------------------------------
// Snapshot envelope contract: every state and patch carries hostInstanceId +
// revision. The webview uses these to detect host-side counter resets and
// missed patches respectively.
// ---------------------------------------------------------------------------

test('HostToWebviewMessage state envelope carries hostInstanceId and revision', () => {
  const msg: HostToWebviewMessage = {
    type: 'state',
    protocolVersion: 1,
    hostInstanceId: 'abc',
    revision: 7,
    state: {
      sessions: [],
      openTabPaths: [],
      runningSessionPaths: [],
      unreadFinishedSessionPaths: [],
      activeSession: null,
      transcript: [],
      transcriptWindow: {
        totalCount: 0,
        loadedStart: 0,
        loadedEnd: 0,
        hasOlder: false,
        hasNewer: false,
        isPartial: false,
        hasUserMessages: false,
      },
      pendingComposerInputs: [],
      activeRunSummary: null,
      runSummariesBySession: {},
      busy: false,
      notice: null,
      backendReady: false,
      workspaceCwd: null,
      systemPrompts: [],
      modelSettings: null,
      availableModels: [],
      contextUsage: null,
      prefs: DEFAULT_CHAT_PREFS,
      availableExtensions: [],
      fileChanges: [],
      pruningResult: null,
      pruningSettings: {
        mode: 'auto' as const,
        skillCeiling: 8,
        toolCeiling: 10,
        skillAlwaysKeep: [],
        toolAlwaysKeep: [],
        model: 'gpt-5.4-mini',
        provider: 'github-copilot',
        thinkingLevel: 'minimal' as const,
      },
      pruningCatalog: {
        skills: [],
        tools: [],
      },
      editingMessageId: null,
      showOutcomeDialog: false,
      pendingExtensionUIRequest: null,
    },
  };
  assert.equal(msg.type, 'state');
  if (msg.type === 'state') {
    assert.equal(msg.hostInstanceId, 'abc');
    assert.equal(msg.revision, 7);
    assert.deepEqual(msg.state.pendingComposerInputs, []);
    assert.equal(msg.state.activeRunSummary, null);
    assert.deepEqual(msg.state.runSummariesBySession, {});
  }
});

test('HostToWebviewMessage patch envelope carries hostInstanceId and revision', () => {
  const msg: HostToWebviewMessage = {
    type: 'patch',
    protocolVersion: 1,
    sessionPath: '/tmp/session-a',
    hostInstanceId: 'abc',
    revision: 8,
    op: { kind: 'messageDelta', messageId: 'm1', delta: 'hello' },
  };
  assert.equal(msg.type, 'patch');
  if (msg.type === 'patch') {
    assert.equal(msg.op.kind, 'messageDelta');
    assert.equal(msg.sessionPath, '/tmp/session-a');
  }
});

// ---------------------------------------------------------------------------
// Overlay clear contract: host sends `clearOverlay` to instruct the webview
// to drop streaming bytes for specific messages once the snapshot has been
// updated. An undefined `messageIds` means clear all overlays.
// ---------------------------------------------------------------------------

test('PatchOp.clearOverlay accepts targeted and untargeted forms', () => {
  const targeted: PatchOp = { kind: 'clearOverlay', messageIds: ['m1', 'm2'] };
  const all: PatchOp = { kind: 'clearOverlay' };
  assert.equal(targeted.kind, 'clearOverlay');
  assert.deepEqual((targeted as { messageIds: string[] }).messageIds, ['m1', 'm2']);
  assert.equal(all.kind, 'clearOverlay');
});

// ---------------------------------------------------------------------------
// busy-seq dedup contract: BusyChangedPayload may carry a `seq` counter that
// monotonically increases per session. The host drops events whose seq is
// less than or equal to the last accepted value to ignore re-orderings.
// ---------------------------------------------------------------------------

function acceptBusySeq(state: Map<string, number>, sessionPath: string, seq: number | undefined): boolean {
  if (typeof seq !== 'number') return true;
  const last = state.get(sessionPath) ?? 0;
  if (seq <= last) return false;
  state.set(sessionPath, seq);
  return true;
}

test('busy-seq dedup ignores out-of-order events but accepts unordered (no seq)', () => {
  const state = new Map<string, number>();
  assert.equal(acceptBusySeq(state, '/a', 1), true);
  assert.equal(acceptBusySeq(state, '/a', 2), true);
  // Stale event from an earlier dispatch arrives late.
  assert.equal(acceptBusySeq(state, '/a', 1), false);
  // Same seq is also dropped.
  assert.equal(acceptBusySeq(state, '/a', 2), false);
  // Higher seq accepted.
  assert.equal(acceptBusySeq(state, '/a', 3), true);
  // Different session has independent counter.
  assert.equal(acceptBusySeq(state, '/b', 1), true);
  // Missing seq is always accepted (backward-compat).
  assert.equal(acceptBusySeq(state, '/a', undefined), true);
});

test('ContextUsageChangedPayload carries nullable live usage per session', () => {
  const update: ContextUsageChangedPayload = {
    sessionPath: '/workspace/session.jsonl',
    contextUsage: { tokens: 1234, contextWindow: 200000, percent: 0.617 },
  };
  const cleared: ContextUsageChangedPayload = {
    sessionPath: '/workspace/session.jsonl',
    contextUsage: null,
  };

  assert.equal(update.contextUsage?.tokens, 1234);
  assert.equal(cleared.contextUsage, null);
});

test('SessionOpenedPayload can carry structured analytics factors', () => {
  const analyticsFactors: SessionAnalyticsFactors = {
    promptFamily: 'harness+customPrompt',
    promptHash: 'prompt-hash',
    harnessPromptHash: 'harness-hash',
    customPromptHash: 'custom-hash',
    appendSystemPromptHash: null,
    promptGuidelineHashes: ['guideline-hash'],
    contextFiles: [{ path: '/workspace/context.md', hash: 'context-hash' }],
    selectedToolIds: ['read', 'bash'],
    toolSnippetHashes: [{ toolId: 'bash', hash: 'tool-snippet-hash' }],
    toolSetHash: 'tool-set-hash',
    skills: [{
      name: 'frontend-design',
      contentHash: 'skill-hash',
      sourceHash: 'skill-source-hash',
      disableModelInvocation: false,
      lastModifiedAt: null,
    }],
    skillSetHash: 'skill-set-hash',
    activeExtensions: ['subagent'],
  };

  const payload: SessionOpenedPayload = {
    session: {
      path: '/workspace/session.jsonl',
      name: 'Session',
      cwd: '/workspace',
      modifiedAt: '2026-01-01T00:00:00.000Z',
      messageCount: 2,
    },
    transcript: [],
    transcriptWindow: {
      totalCount: 0,
      loadedStart: 0,
      loadedEnd: 0,
      hasOlder: false,
      hasNewer: false,
      isPartial: false,
      hasUserMessages: false,
    },
    busy: false,
    analyticsFactors,
  };

  assert.equal(payload.analyticsFactors?.promptHash, 'prompt-hash');
  assert.equal(payload.analyticsFactors?.selectedToolIds[0], 'read');
});


test('ToolFinishedPayload carries normalized failure status', () => {
  const payload: ToolFinishedPayload = {
    requestId: 'request-1',
    sessionPath: '/workspace/session.jsonl',
    messageId: 'message-1',
    toolCallId: 'tool-1',
    result: { ok: false },
    status: 'failed',
  };

  assert.equal(payload.status, 'failed');
});

// ---------------------------------------------------------------------------
// Webview-to-host setPrefs envelope: prefs now live on the host (globalState)
// and changes flow as a typed RPC, replacing the old localStorage path.
// ---------------------------------------------------------------------------

test('WebviewToHostMessage.setPrefs accepts partial pref updates', () => {
  const msg: WebviewToHostMessage = {
    type: 'setPrefs',
    prefs: {
      autoExpandReasoning: true,
      autoExpandSubagentCalls: true,
      suppressCompletionNotifications: true,
    },
  };
  assert.equal(msg.type, 'setPrefs');
  if (msg.type === 'setPrefs') {
    assert.equal(msg.prefs.autoExpandReasoning, true);
    assert.equal(msg.prefs.autoExpandSubagentCalls, true);
    assert.equal(msg.prefs.suppressCompletionNotifications, true);
  }
});

test('WebviewToHostMessage.setModel can target an explicit session path', () => {
  const msg: WebviewToHostMessage = {
    type: 'setModel',
    sessionPath: '/workspace/session.jsonl',
    defaultModel: 'claude-sonnet-4-5',
    defaultThinkingLevel: 'medium',
  };
  assert.equal(msg.type, 'setModel');
  if (msg.type === 'setModel') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.defaultModel, 'claude-sonnet-4-5');
    assert.equal(msg.defaultThinkingLevel, 'medium');
  }
});

test('WebviewToHostMessage.addComposerInput accepts a raw input without an id', () => {
  const input: ComposerInput = {
    id: 'input-1',
    kind: 'filesystemPathRef',
    path: '/workspace/a.ts',
    name: 'a.ts',
    source: 'picker',
  };

  const msg: WebviewToHostMessage = {
    type: 'addComposerInput',
    sessionPath: '/workspace/session.jsonl',
    input: {
      kind: input.kind,
      path: input.path,
      name: input.name,
      source: input.source,
    },
  };

  assert.equal(msg.type, 'addComposerInput');
  if (msg.type === 'addComposerInput') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.ok(!('id' in msg.input));
    assert.equal(msg.input.kind, 'filesystemPathRef');
  }
});

test('WebviewToHostMessage.removeComposerInput targets an assigned input id', () => {
  const msg: WebviewToHostMessage = {
    type: 'removeComposerInput',
    sessionPath: '/workspace/session.jsonl',
    inputId: 'input-1',
  };

  assert.equal(msg.type, 'removeComposerInput');
  if (msg.type === 'removeComposerInput') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.inputId, 'input-1');
  }
});

test('WebviewToHostMessage.send carries an explicit sessionPath', () => {
  const msg: WebviewToHostMessage = {
    type: 'send',
    sessionPath: '/workspace/session.jsonl',
    text: 'hello',
  };
  assert.equal(msg.type, 'send');
  if (msg.type === 'send') {
    assert.equal(msg.sessionPath, '/workspace/session.jsonl');
    assert.equal(msg.text, 'hello');
  }
});

test('WebviewToHostMessage includes run outcome and task-control actions', () => {
  const outcome: WebviewToHostMessage = {
    type: 'recordOutcome',
    sessionPath: '/workspace/session.jsonl',
    outcome: { resolution: 'resolved', satisfaction: 5 },
  };
  const newTask: WebviewToHostMessage = {
    type: 'startNewTask',
    sessionPath: '/workspace/session.jsonl',
  };
  const continueTask: WebviewToHostMessage = {
    type: 'continueTask',
    sessionPath: '/workspace/session.jsonl',
  };

  assert.equal(outcome.type, 'recordOutcome');
  if (outcome.type === 'recordOutcome') {
    assert.equal(outcome.outcome.resolution, 'resolved');
    assert.equal(outcome.outcome.satisfaction, 5);
  }
  assert.equal(newTask.type, 'startNewTask');
  assert.equal(continueTask.type, 'continueTask');
});

test('HostToWebviewMessage.sendRejected restores only the text draft payload', () => {
  const msg: HostToWebviewMessage = {
    type: 'sendRejected',
    sessionPath: '/workspace/a.ts',
    text: 'hello',
  };
  assert.equal(msg.type, 'sendRejected');
  if (msg.type === 'sendRejected') {
    assert.equal(msg.sessionPath, '/workspace/a.ts');
    assert.equal(msg.text, 'hello');
  }
});
