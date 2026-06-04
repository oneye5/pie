import assert from 'node:assert/strict';
import test from 'node:test';

import { dispatchSessionBackendEvent } from '../src/host/session-service/event-dispatch';
import type { SessionBackendEventHandlers } from '../src/host/session-service/event-dispatch';

function createHandlers() {
  const calls: Array<{ name: string; payload: unknown }> = [];

  const handlers: SessionBackendEventHandlers = {
    onSessionOpened: (payload) => calls.push({ name: 'session.opened', payload }),
    onSessionListChanged: (payload) => calls.push({ name: 'session.list.changed', payload }),
    onMessageStarted: (payload) => calls.push({ name: 'message.started', payload }),
    onMessageDelta: (payload) => calls.push({ name: 'message.delta', payload }),
    onMessageThinking: (payload) => calls.push({ name: 'message.thinking', payload }),
    onToolStarted: (payload) => calls.push({ name: 'tool.started', payload }),
    onToolFinished: (payload) => calls.push({ name: 'tool.finished', payload }),
    onToolProgress: (payload) => calls.push({ name: 'tool.progress', payload }),
    onMessageFinished: (payload) => calls.push({ name: 'message.finished', payload }),
    onCustomMessage: (payload) => calls.push({ name: 'message.custom', payload }),
    onMessageAborted: (payload) => calls.push({ name: 'message.aborted', payload }),
    onBusyChanged: (payload) => calls.push({ name: 'busy.changed', payload }),
    onContextUsageChanged: (payload) => calls.push({ name: 'contextUsage.changed', payload }),
    onExtensionUIRequest: (payload) => calls.push({ name: 'extension_ui.request', payload }),
    onError: (payload) => calls.push({ name: 'error', payload }),
  };

  return { handlers, calls };
}

test('dispatchSessionBackendEvent routes message.custom payloads', () => {
  const { handlers, calls } = createHandlers();
  const payload = {
    requestId: 'req-1',
    sessionPath: '/workspace/session.jsonl',
    message: {
      id: 'req-1:custom:1',
      role: 'system' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      markdown: 'Kept 4/14 skills',
      status: 'completed' as const,
      customType: 'pruning-result',
      customDetails: {
        includedSkills: ['systematic-debugging'],
        excludedSkills: ['frontend-design'],
        includedTools: ['read'],
        excludedTools: ['web_search'],
        mode: 'auto' as const,
        skillTokensSaved: 100,
        toolTokensSaved: 50,
      },
    },
  };

  dispatchSessionBackendEvent({ event: 'message.custom', payload }, handlers);

  assert.deepEqual(calls, [{ name: 'message.custom', payload }]);
});
