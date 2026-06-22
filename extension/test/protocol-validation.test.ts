import test from 'node:test';
import assert from 'node:assert/strict';

import { validateWebviewToHostMessage } from '../src/shared/protocol-validation';

test('validateWebviewToHostMessage accepts the simple no-payload messages', () => {
  for (const type of ['ready', 'refreshState', 'requestSnapshot', 'openFilePicker', 'newSession']) {
    const result = validateWebviewToHostMessage({ type });
    assert.equal(result.ok, true, `${type} should validate`);
  }
});

test('validateWebviewToHostMessage rejects non-objects and missing type', () => {
  for (const value of [null, undefined, 'send', 42, [], true]) {
    const result = validateWebviewToHostMessage(value);
    assert.equal(result.ok, false);
  }
  const noType = validateWebviewToHostMessage({});
  assert.equal(noType.ok, false);
  if (!noType.ok) assert.match(noType.reason, /type/);
});

test('validateWebviewToHostMessage rejects unknown message types', () => {
  const result = validateWebviewToHostMessage({ type: 'something.invented' });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /unknown/);
});

test('validateWebviewToHostMessage validates send payloads', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'send', sessionPath: '/a', text: 'hi' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'send', text: 'hi' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'send', sessionPath: '/a' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'send', sessionPath: '/a', text: 42 }).ok, false);
});

test('validateWebviewToHostMessage validates openFile', () => {
  assert.equal(validateWebviewToHostMessage({ type: 'openFile', path: '/x' }).ok, true);
  assert.equal(validateWebviewToHostMessage({ type: 'openFile' }).ok, false);
});

test('validateWebviewToHostMessage validates openFileDiff, openFileInEditor, and revertFile', () => {
  for (const type of ['openFileDiff', 'openFileInEditor', 'revertFile']) {
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/a', filePath: '/b' }).ok,
      true,
      `${type} with sessionPath + filePath should validate`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type, filePath: '/b' }).ok,
      false,
      `${type} without sessionPath should be rejected`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/a' }).ok,
      false,
      `${type} without filePath should be rejected`,
    );
  }
});

test('validateWebviewToHostMessage validates session-scoped messages with required sessionPath', () => {
  for (const type of ['openSession', 'closeSession', 'interrupt', 'startNewTask', 'continueTask', 'togglePinTab']) {
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/a' }).ok,
      true,
      `${type} with sessionPath should validate`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type }).ok,
      false,
      `${type} without sessionPath should fail`,
    );
  }
});

test('validateWebviewToHostMessage validates editMessage payloads', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1', text: 'edited' }).ok,
    true,
  );
  assert.equal(validateWebviewToHostMessage({ type: 'editMessage', messageId: 'm1', text: 'edited' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', messageId: 'm1' }).ok, false);
  assert.equal(validateWebviewToHostMessage({ type: 'editMessage', sessionPath: '/a', text: 'x' }).ok, false);
});

test('validateWebviewToHostMessage validates moveSessionTab', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'moveSessionTab', fromIndex: 0, toIndex: 2 }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'moveSessionTab', sessionPath: '/a', fromIndex: 0, toIndex: 1 }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'moveSessionTab', fromIndex: '0', toIndex: 1 }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates paging messages with optional sessionPath', () => {
  for (const type of ['loadOlderTranscript', 'loadNewerTranscript', 'jumpToLatestTranscript']) {
    assert.equal(validateWebviewToHostMessage({ type }).ok, true, `${type} should validate without sessionPath`);
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: '/p' }).ok,
      true,
      `${type} should validate with sessionPath`,
    );
    assert.equal(
      validateWebviewToHostMessage({ type, sessionPath: 7 }).ok,
      false,
      `${type} should reject non-string sessionPath`,
    );
  }
});

test('validateWebviewToHostMessage validates composer input drafts', () => {
  const validFsRef = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: { kind: 'filesystemPathRef', path: '/x', name: 'x', source: 'picker' },
  };
  assert.equal(validateWebviewToHostMessage(validFsRef).ok, true);

  const validImage = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: {
      kind: 'imageBlob',
      mimeType: 'image/png',
      name: 'x.png',
      sizeBytes: 1024,
      dataBase64: 'aaaa',
      source: 'paste',
    },
  };
  assert.equal(validateWebviewToHostMessage(validImage).ok, true);

  const missingFields = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: { kind: 'imageBlob', mimeType: 'image/png', name: 'x.png' },
  };
  assert.equal(validateWebviewToHostMessage(missingFields).ok, false);

  const unknownKind = {
    type: 'addComposerInput',
    sessionPath: '/a',
    input: { kind: 'imaginary', value: 1 },
  };
  assert.equal(validateWebviewToHostMessage(unknownKind).ok, false);
});

test('validateWebviewToHostMessage validates removeComposerInput', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'removeComposerInput', sessionPath: '/a', inputId: 'i1' }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'removeComposerInput', sessionPath: '/a' }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates recordOutcome', () => {
  assert.equal(
    validateWebviewToHostMessage({
      type: 'recordOutcome',
      sessionPath: '/a',
      outcome: { resolution: 'resolved', satisfaction: 4 },
    }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'recordOutcome',
      sessionPath: '/a',
      outcome: { resolution: 'unknown', satisfaction: 4 },
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'recordOutcome',
      sessionPath: '/a',
      outcome: { resolution: 'resolved' },
    }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates setModel and rejects invalid thinking levels', () => {
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setModel',
      defaultModel: 'gpt-X',
      defaultThinkingLevel: 'medium',
    }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setModel',
      defaultModel: 'gpt-X',
      defaultThinkingLevel: 'extreme',
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setModel',
      defaultThinkingLevel: 'low',
    }).ok,
    false,
  );
});

test('validateWebviewToHostMessage validates setPrefs patches and rejects unknown keys', () => {
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { autoExpandReasoning: true } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: {} }).ok,
    true,
    'empty prefs patch should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { autoExpandReasoning: 'yes' },
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({
      type: 'setPrefs',
      prefs: { unknownPref: true },
    }).ok,
    false,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMessageWidth: 80 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiBackground: '#0d1117' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiForeground: '#c9d1d9' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiBorder: '#30363d' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiCornerRadius: 12 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiDensity: 'compact' } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiDensity: 'invalid' } }).ok,
    false,
    'uiDensity must be one of compact/comfortable/spacious',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiMessageWidth: 40 } }).ok,
    false,
    'uiMessageWidth below the 60 floor should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiCornerRadius: -1 } }).ok,
    false,
    'uiCornerRadius below 0 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { uiCornerRadius: 21 } }).ok,
    false,
    'uiCornerRadius above 20 should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 240 } }).ok,
    true,
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 120 } }).ok,
    true,
    'expandedSectionMaxHeight at the 120 floor should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 720 } }).ok,
    true,
    'expandedSectionMaxHeight at the 720 ceiling should validate',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 100 } }).ok,
    false,
    'expandedSectionMaxHeight below the 120 floor should be rejected',
  );
  assert.equal(
    validateWebviewToHostMessage({ type: 'setPrefs', prefs: { expandedSectionMaxHeight: 800 } }).ok,
    false,
    'expandedSectionMaxHeight above the 720 ceiling should be rejected',
  );
});
