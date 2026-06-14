import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { findMatchingRequest } from '../src/webview/panel/hooks/ask-user-context';
import type { ExtensionUIRequestPayload } from '../src/shared/protocol';

/** Helper to build a 'select' request. */
function selectReq(
  overrides: Partial<Pick<ExtensionUIRequestPayload, 'id' | 'subagentCallId'>> & {
    id?: string;
  } = {},
): ExtensionUIRequestPayload {
  return {
    id: overrides.id ?? 'req-1',
    sessionPath: '/test-session',
    method: 'select',
    title: 'Choose',
    options: ['a', 'b'],
    ...overrides,
  };
}

/** Helper to build a 'confirm' request. */
function confirmReq(id = 'req-c'): ExtensionUIRequestPayload {
  return {
    id,
    sessionPath: '/test-session',
    method: 'confirm',
    title: 'Confirm?',
    message: 'Are you sure?',
  };
}

/** Helper to build an 'input' request. */
function inputReq(id = 'req-i'): ExtensionUIRequestPayload {
  return {
    id,
    sessionPath: '/test-session',
    method: 'input',
    title: 'Enter value',
  };
}

describe('findMatchingRequest', () => {
  it('matches first select request without subagentCallId when subagentCallId is undefined (main agent)', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1' }),
      'req-2': selectReq({ id: 'req-2', subagentCallId: 'call_abc' }),
    };
    const result = findMatchingRequest(pending, undefined);
    assert.ok(result);
    assert.equal(result.id, 'req-1');
    assert.equal(result.subagentCallId, undefined);
  });

  it('matches subagent exact subagentCallId', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1' }),
      'req-2': selectReq({ id: 'req-2', subagentCallId: 'call_abc' }),
    };
    const result = findMatchingRequest(pending, 'call_abc');
    assert.ok(result);
    assert.equal(result.id, 'req-2');
    assert.equal(result.subagentCallId, 'call_abc');
  });

  it('matches parallel subagent prefix-style subagentCallId', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1', subagentCallId: 'call_abc:0' }),
    };
    const result = findMatchingRequest(pending, 'call_abc:0');
    assert.ok(result);
    assert.equal(result.id, 'req-1');
    assert.equal(result.subagentCallId, 'call_abc:0');
  });

  it('returns null when no request has matching subagentCallId', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-1': selectReq({ id: 'req-1', subagentCallId: 'call_other' }),
    };
    const result = findMatchingRequest(pending, 'call_abc');
    assert.equal(result, null);
  });

  it('skips non-select methods (confirm, input, notify)', () => {
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-c': confirmReq(),
      'req-i': inputReq(),
      'req-s': selectReq({ id: 'req-s' }),
    };
    const result = findMatchingRequest(pending, undefined);
    assert.ok(result);
    assert.equal(result!.method, 'select');
    assert.equal(result!.id, 'req-s');
  });

  it('returns null when pending requests is empty', () => {
    const result = findMatchingRequest({}, undefined);
    assert.equal(result, null);
  });

  it('returns the first matching request when multiple candidates exist', () => {
    // Object.values order: insertion order for string keys in modern JS engines
    const pending: Record<string, ExtensionUIRequestPayload> = {
      'req-a': selectReq({ id: 'req-a' }),
      'req-b': selectReq({ id: 'req-b' }),
    };
    const result = findMatchingRequest(pending, undefined);
    assert.ok(result);
    assert.equal(result!.id, 'req-a');
  });
});