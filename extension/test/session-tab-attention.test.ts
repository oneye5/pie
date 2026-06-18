import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { SessionTab } from '../src/webview/panel/session-tabs';
import type { SessionSummary } from '../src/shared/protocol';

// Derive the props type from the component so the test stays in sync with the
// real SessionTab signature without exporting a separate interface.
type SessionTabProps = Parameters<typeof SessionTab>[0];

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

function makeSession(path: string, name: string): SessionSummary {
  return { path, name, cwd: '/repo', modifiedAt: '2024-01-01T00:00:00.000Z', messageCount: 1 };
}

const noop = () => undefined;

function classList(el: Element): string[] {
  return (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
}

function renderTab(overrides: Partial<SessionTabProps> = {}): HTMLElement {
  const tabPath = overrides.tabPath ?? '/sessions/alpha';
  const props: SessionTabProps = {
    tabPath,
    index: 0,
    sessionByPath: new Map([[tabPath, makeSession(tabPath, 'Alpha')]]),
    openIndexByPath: new Map([[tabPath, 0]]),
    runningPathSet: new Set(),
    unreadFinishedPathSet: new Set(),
    activeSession: null,
    hasPendingExtensionUIRequest: false,
    activeRunSummary: null,
    onContextMenu: noop,
    onPointerDown: noop,
    onClick: noop,
    onClose: noop,
    onMarkComplete: noop,
    ...overrides,
  };

  act(() => {
    render(h(SessionTab, props), container);
  });

  const tab = container.querySelector('.session-tab');
  assert.ok(tab, 'session-tab root element should render');
  return tab as HTMLElement;
}

test('non-active tab with a pending extension UI request renders the attention class and waiting title', () => {
  // The pending tab is /sessions/alpha; a DIFFERENT session is active, so this
  // tab is non-active yet must still surface the attention indicator.
  const other = makeSession('/sessions/other', 'Other');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activeSession: other,
    hasPendingExtensionUIRequest: true,
  });

  assert.ok(classList(tab).includes('attention'), 'pending non-active tab gets the attention class');
  assert.ok(!classList(tab).includes('active'), 'non-active tab is not marked active');

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.ok(main);
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for your answer)');
});

test('non-active tab without a pending request does not get the attention class', () => {
  const other = makeSession('/sessions/other', 'Other');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activeSession: other,
    hasPendingExtensionUIRequest: false,
  });

  assert.ok(!classList(tab).includes('attention'));
  assert.ok(!classList(tab).includes('active'));

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha');
});

test('active tab with a pending request keeps both the active and attention classes', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activeSession: alpha,
    hasPendingExtensionUIRequest: true,
  });

  // The active treatment must not regress when a request is pending: both the
  // active marker and the attention marker apply to the same tab.
  assert.ok(classList(tab).includes('active'));
  assert.ok(classList(tab).includes('attention'));

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for your answer)');
});

test('pending request wins title precedence over unread-finished', () => {
  const alpha = makeSession('/sessions/alpha', 'Alpha');
  const tab = renderTab({
    tabPath: '/sessions/alpha',
    activeSession: alpha,
    hasPendingExtensionUIRequest: true,
    // The path is also in the unread-finished set, so without precedence the
    // title would read "(finished, unread)". Pending must win.
    unreadFinishedPathSet: new Set(['/sessions/alpha']),
  });

  assert.ok(classList(tab).includes('attention'));

  const main = tab.querySelector('.session-tab-main') as HTMLElement;
  assert.equal(main.getAttribute('title'), 'Alpha (waiting for your answer)');
});
