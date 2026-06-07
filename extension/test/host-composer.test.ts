import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateAndMaterializeComposerInput,
  modelSupportsInputKind,
  type GetArchState,
  type MutateArchState,
} from '../src/host/core/composer';
import { createInitialArchState } from '../src/host/core/arch-state';
import type { ArchState } from '../src/host/core/arch-state';

const NOOP_RENDER = () => {};
const NOOP_OBSERVER = {
  onAssistantTurnStarted: () => {},
  onBusyChanged: () => {},
  onContextUsageChanged: () => {},
  onInterrupted: () => {},
  onBackendError: () => {},
  onTruncatedAfter: () => {},
  onMessageEdited: () => {},
  onModelConfigChanged: () => {},
  prepareForSend: () => {},
  onSessionClosed: () => {},
  onUnsupportedInputAttempt: () => {},
  onSessionCompleted: () => {},
  recordOutcome: () => {},
  startNewTask: () => {},
  continueTask: () => {},
} as any;

function makeGetArchState(state: ArchState): GetArchState {
  return () => state;
}

function makeMutateArchState(stateRef: { current: ArchState }): MutateArchState {
  return (recipe) => {
    const { produce } = require('immer');
    stateRef.current = produce(stateRef.current, recipe);
  };
}

test('validateAndMaterializeComposerInput accepts imageBlob when model supports images', () => {
  let state = createInitialArchState();
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: [
        { path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0, modelId: 'gpt-4o' },
      ],
    },
    settings: {
      ...state.settings,
      availableModelsBySession: {
        '/s': [{ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', reasoning: false, inputKinds: ['text', 'image'] }],
      },
    },
  };

  const stateRef = { current: state };
  const getArchState = makeGetArchState(state);
  const mutateArchState = makeMutateArchState(stateRef);

  const input = validateAndMaterializeComposerInput(
    '/s',
    {
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'test.png',
      sizeBytes: 1024,
      dataBase64: 'iVBORw0KGgo=',
      source: 'paste',
    },
    () => 'input-1',
    NOOP_RENDER,
    NOOP_OBSERVER,
    getArchState,
    mutateArchState,
  );

  assert.ok(input, 'imageBlob should be accepted when model supports images');
  assert.equal(input?.kind, 'imageBlob');
});

test('validateAndMaterializeComposerInput rejects imageBlob when model does not support images', () => {
  let state = createInitialArchState();
  state = {
    ...state,
    sessions: {
      ...state.sessions,
      sessions: [
        { path: '/s', name: 'S', cwd: '/', modifiedAt: '', messageCount: 0, modelId: 'text-only' },
      ],
    },
    settings: {
      ...state.settings,
      availableModelsBySession: {
        '/s': [{ id: 'text-only', name: 'TextOnly', provider: 'openai', reasoning: false, inputKinds: ['text'] }],
      },
    },
  };

  const stateRef = { current: state };
  const getArchState = makeGetArchState(state);
  const mutateArchState = makeMutateArchState(stateRef);

  const input = validateAndMaterializeComposerInput(
    '/s',
    {
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'test.png',
      sizeBytes: 1024,
      dataBase64: 'iVBORw0KGgo=',
      source: 'paste',
    },
    () => 'input-1',
    NOOP_RENDER,
    NOOP_OBSERVER,
    getArchState,
    mutateArchState,
  );

  assert.equal(input, null);
  assert.equal(stateRef.current.settings.notice, 'The selected model does not support image inputs.');
});
