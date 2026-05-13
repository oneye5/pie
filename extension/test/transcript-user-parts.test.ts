import assert from 'node:assert/strict';
import test from 'node:test';

import { getRenderableUserParts, messageHasUserImages, splitSummaryPath } from '../src/webview/panel/transcript';
import type { ChatMessage } from '../src/shared/protocol';

function makeUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'user-1',
    role: 'user',
    createdAt: '2026-01-01T00:00:00.000Z',
    markdown: 'hello',
    status: 'completed',
    ...overrides,
  };
}

test('getRenderableUserParts prefers ordered structured user parts', () => {
  const message = makeUserMessage({
    markdown: 'fallback text',
    userParts: [
      { kind: 'text', text: 'Look at this' },
      { kind: 'image', mimeType: 'image/png', dataBase64: 'ZmFrZQ==', name: 'shot.png' },
    ],
  });

  assert.deepEqual(getRenderableUserParts(message), message.userParts);
});

test('getRenderableUserParts falls back to markdown for legacy user messages', () => {
  const message = makeUserMessage({ markdown: 'legacy text' });

  assert.deepEqual(getRenderableUserParts(message), [{ kind: 'text', text: 'legacy text' }]);
});

test('messageHasUserImages blocks click-to-edit only when a user image part is present', () => {
  assert.equal(messageHasUserImages(makeUserMessage({ userParts: [{ kind: 'text', text: 'hello' }] })), false);
  assert.equal(messageHasUserImages(makeUserMessage({
    userParts: [{ kind: 'image', mimeType: 'image/png', dataBase64: 'ZmFrZQ==' }],
  })), true);
});

test('splitSummaryPath separates the directory and highlighted file sections', () => {
  assert.deepEqual(splitSummaryPath('docs/IDEAS.md'), {
    pathSection: 'docs/',
    fileSection: 'IDEAS.md',
  });

  assert.deepEqual(splitSummaryPath('IDEAS.md'), {
    pathSection: null,
    fileSection: 'IDEAS.md',
  });
});
