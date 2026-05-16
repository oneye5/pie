import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateLoadTranscriptPage,
  validateMessageSend,
  validateRuntimePrefsSet,
  validateSessionCreate,
  validateSessionOpen,
  validateSettingsSet,
} from '../src/backend/rpc';

test('validateMessageSend requires an explicit sessionPath', () => {
  assert.throws(
    () => validateMessageSend({ text: 'hello' }),
    /sessionPath/,
  );
});

test('validateMessageSend accepts image-only sends with structured inputs', () => {
  assert.deepEqual(
    validateMessageSend({
      sessionPath: '/workspace/session.jsonl',
      text: '',
      inputs: [{
        id: 'input-1',
        kind: 'imageBlob',
        mimeType: 'image/png',
        name: 'diagram.png',
        sizeBytes: 1024,
        dataBase64: 'ZmFrZQ==',
        source: 'paste',
      }],
    }),
    {
      sessionPath: '/workspace/session.jsonl',
      text: '',
      inputs: [{
        id: 'input-1',
        kind: 'imageBlob',
        mimeType: 'image/png',
        name: 'diagram.png',
        sizeBytes: 1024,
        dataBase64: 'ZmFrZQ==',
        source: 'paste',
        width: undefined,
        height: undefined,
      }],
    },
  );
});

test('validateMessageSend rejects empty text when there are no inputs', () => {
  assert.throws(
    () => validateMessageSend({ sessionPath: '/workspace/session.jsonl', text: '   ', inputs: [] }),
    /non-empty text or at least one input/,
  );
});

test('validateMessageSend rejects unsupported fileBlob inputs', () => {
  assert.throws(
    () => validateMessageSend({
      sessionPath: '/workspace/session.jsonl',
      text: '',
      inputs: [{
        id: 'input-1',
        kind: 'fileBlob',
        mimeType: 'application/pdf',
        name: 'spec.pdf',
        sizeBytes: 2048,
        dataBase64: 'ZmFrZQ==',
        source: 'drop',
      }],
    }),
    /not supported yet/,
  );
});

test('validateSessionCreate accepts an optional selection token', () => {
  assert.deepEqual(
    validateSessionCreate({ cwd: '/workspace', selectionToken: 'selection:1' }),
    { cwd: '/workspace', selectionToken: 'selection:1' },
  );
});

test('validateSessionOpen accepts an optional selection token', () => {
  assert.deepEqual(
    validateSessionOpen({ sessionPath: '/workspace/session.jsonl', selectionToken: 'selection:2' }),
    { sessionPath: '/workspace/session.jsonl', selectionToken: 'selection:2' },
  );
});

test('validateLoadTranscriptPage accepts direction and loaded range', () => {
  assert.deepEqual(
    validateLoadTranscriptPage({
      sessionPath: '/workspace/session.jsonl',
      direction: 'older',
      loadedStart: 40,
      loadedEnd: 120,
    }),
    {
      sessionPath: '/workspace/session.jsonl',
      direction: 'older',
      loadedStart: 40,
      loadedEnd: 120,
    },
  );
});

test('validateLoadTranscriptPage rejects invalid direction values', () => {
  assert.throws(
    () => validateLoadTranscriptPage({ sessionPath: '/workspace/session.jsonl', direction: 'backward' }),
    /direction must be one of older, newer, latest/,
  );
});

test('validateSettingsSet accepts an optional sessionPath', () => {
  assert.deepEqual(
    validateSettingsSet({
      sessionPath: '/workspace/session.jsonl',
      defaultModel: 'claude-sonnet-4-5',
      defaultThinkingLevel: 'high',
    }),
    {
      sessionPath: '/workspace/session.jsonl',
      defaultModel: 'claude-sonnet-4-5',
      defaultThinkingLevel: 'high',
    },
  );
});

test('validateRuntimePrefsSet accepts provider toggles', () => {
  assert.deepEqual(
    validateRuntimePrefsSet({
      providerToggles: {
        ollama: false,
        'github-copilot': true,
      },
    }),
    {
      providerToggles: {
        ollama: false,
        'github-copilot': true,
      },
    },
  );
});

test('validateRuntimePrefsSet defaults missing provider toggles to empty', () => {
  assert.deepEqual(validateRuntimePrefsSet({}), { providerToggles: {} });
});

test('validateRuntimePrefsSet rejects non-boolean provider toggle values', () => {
  assert.throws(
    () => validateRuntimePrefsSet({ providerToggles: { ollama: 'off' } }),
    /providerToggles\.ollama must be a boolean/,
  );
});
