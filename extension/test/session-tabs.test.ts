import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getSessionTabRunBadge,
  getSessionTabRunMenuItems,
} from '../src/webview/panel/session-tab-run-state';

test('getSessionTabRunMenuItems exposes completion and task actions for open runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-1',
    status: 'open',
    scored: false,
  }), [
    { action: 'recordOutcome', label: 'Mark tab as complete…' },
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems keeps outcome capture available for closed unscored runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-2',
    status: 'closed_unscored',
    scored: false,
  }), [
    { action: 'recordOutcome', label: 'Rate completed run…' },
    { action: 'continueTask', label: 'Continue task' },
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems offers continuation for scored runs', () => {
  assert.deepEqual(getSessionTabRunMenuItems({
    runId: 'run-3',
    status: 'scored',
    scored: true,
  }), [
    { action: 'continueTask', label: 'Continue task' },
    { action: 'startNewTask', label: 'Start new task' },
  ]);
});

test('getSessionTabRunMenuItems returns no actions when there is no active run', () => {
  assert.deepEqual(getSessionTabRunMenuItems(null), []);
});

test('getSessionTabRunBadge highlights open and unrated runs', () => {
  assert.deepEqual(getSessionTabRunBadge({
    runId: 'run-open',
    status: 'open',
    scored: false,
  }), {
    text: 'Done…',
    tone: 'open',
    title: 'Click to mark this run complete and record a rating. You can also right-click the tab for task actions.',
  });

  assert.deepEqual(getSessionTabRunBadge({
    runId: 'run-rate',
    status: 'closed_unscored',
    scored: false,
  }), {
    text: 'Rate…',
    tone: 'pending-score',
    title: 'Click to record the outcome for this completed run. You can also right-click the tab for task actions.',
  });

  assert.equal(getSessionTabRunBadge({
    runId: 'run-scored',
    status: 'scored',
    scored: true,
  }), null);
});
