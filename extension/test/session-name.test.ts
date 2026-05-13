import test from 'node:test';
import assert from 'node:assert/strict';

import { createAppStore, sessionsActions } from '../src/host/store';
import { deriveSessionNameFromText, NEW_SESSION_NAME } from '../src/shared/session-name';

test('deriveSessionNameFromText returns the placeholder for blank input', () => {
  assert.deepEqual(deriveSessionNameFromText('   \n\t  '), {
    name: NEW_SESSION_NAME,
    isPlaceholder: true,
  });
});

test('deriveSessionNameFromText normalizes whitespace and truncates long prompts', () => {
  const derived = deriveSessionNameFromText(
    '  Build   a   background\n  session naming regression test for the VS Code sidebar tabs  ',
  );

  assert.deepEqual(derived, {
    name: 'Build a background session naming regres…',
    isPlaceholder: false,
  });
});

test('optimistic prompt-derived tab names survive placeholder list refreshes', () => {
  const store = createAppStore();
  const placeholder = {
    path: '/ws/background-tab',
    name: NEW_SESSION_NAME,
    cwd: '/ws',
    modifiedAt: '2026-05-12T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  };
  const derived = deriveSessionNameFromText('Trace the background tab renaming regression');

  store.dispatch(sessionsActions.upsertSession(placeholder));
  store.dispatch(sessionsActions.upsertSession({
    ...placeholder,
    name: derived.name,
    isPlaceholder: derived.isPlaceholder,
  }));
  store.dispatch(sessionsActions.replaceSessionSummaries([placeholder]));

  const session = store.getState().sessions.sessions.find((entry) => entry.path === placeholder.path);
  assert.equal(session?.name, derived.name);
  assert.equal(session?.isPlaceholder, false);
});

test('setSessionSummary can roll back an optimistic tab name exactly', () => {
  const store = createAppStore();
  const placeholder = {
    path: '/ws/send-error',
    name: NEW_SESSION_NAME,
    cwd: '/ws',
    modifiedAt: '2026-05-12T00:00:00.000Z',
    messageCount: 0,
    isPlaceholder: true,
  };
  const derived = deriveSessionNameFromText('Draft a rollback-safe optimistic rename flow');

  store.dispatch(sessionsActions.upsertSession(placeholder));
  store.dispatch(sessionsActions.upsertSession({
    ...placeholder,
    name: derived.name,
    isPlaceholder: derived.isPlaceholder,
  }));
  store.dispatch(sessionsActions.setSessionSummary(placeholder));

  const session = store.getState().sessions.sessions.find((entry) => entry.path === placeholder.path);
  assert.deepEqual(session, placeholder);
});
