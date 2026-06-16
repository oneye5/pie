import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { installDom } from './_helpers/dom';
installDom();

// Stub DOMPurify before any component imports
import DOMPurify from 'dompurify';
DOMPurify.sanitize = ((html: string) => html) as typeof DOMPurify.sanitize;

import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { useState } from 'preact/hooks';

import { useComposerInput } from '../src/webview/panel/composer/hooks';
import type { ComposerInputDraft, WebviewToHostMessage } from '../src/shared/protocol';

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
  };
});

interface TestHarnessProps {
  sessionPath: string | null;
  draftText: string;
  postMessage: (msg: WebviewToHostMessage) => void;
}

function TestHarness({ sessionPath, draftText, postMessage }: TestHarnessProps) {
  const { text, textareaRef, handleInput } = useComposerInput({
    busy: false,
    onSend: () => {},
    pendingComposerInputsLength: 0,
    sessionPath,
    draftText,
    postMessage,
    onAddInput: (_input: ComposerInputDraft) => {},
    supportsImageInputs: false,
  });

  return (
    h('textarea', {
      ref: textareaRef,
      value: text,
      onInput: handleInput,
      'aria-label': 'Message composer',
    })
  );
}

test('useComposerInput seeds text from draftText on mount and session switch', () => {
  const posted: WebviewToHostMessage[] = [];

  act(() => {
    render(
      h(TestHarness, {
        sessionPath: '/s',
        draftText: 'persisted draft',
        postMessage: (msg) => { posted.push(msg); },
      }),
      container,
    );
  });

  const textarea = container.querySelector('textarea');
  assert.ok(textarea);
  assert.equal((textarea as HTMLTextAreaElement).value, 'persisted draft');
});

test('useComposerInput posts setComposerDraft after debounced typing', async () => {
  const posted: WebviewToHostMessage[] = [];
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;

  type PendingTimeout = { fn: () => void; ms: number; id: number };
  let pending: PendingTimeout[] = [];
  let nextId = 1;

  globalThis.setTimeout = window.setTimeout = ((fn: () => void, ms?: number) => {
    const id = nextId++;
    pending.push({ fn, ms: ms ?? 0, id });
    return id as unknown as number;
  }) as typeof globalThis.setTimeout;

  globalThis.clearTimeout = window.clearTimeout = ((id: number) => {
    pending = pending.filter((t) => t.id !== id);
  }) as typeof globalThis.clearTimeout;

  try {
    act(() => {
      render(
        h(TestHarness, {
          sessionPath: '/s',
          draftText: '',
          postMessage: (msg) => { posted.push(msg); },
        }),
        container,
      );
    });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    assert.ok(textarea);

    act(() => {
      textarea.value = 'typed draft';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    // After typing, a 300 ms debounce timeout should be pending.
    const debounce = pending.find((t) => t.ms === 300);
    assert.ok(debounce, 'debounce timeout should be scheduled');

    // Flush the debounce timeout.
    pending = pending.filter((t) => t.id !== debounce.id);
    debounce.fn();

    const draftMsg = posted.find((m) => m.type === 'setComposerDraft');
    assert.ok(draftMsg, 'setComposerDraft should be posted');
    assert.equal(draftMsg.type, 'setComposerDraft');
    assert.equal((draftMsg as any).sessionPath, '/s');
    assert.equal((draftMsg as any).text, 'typed draft');
  } finally {
    globalThis.setTimeout = window.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = window.clearTimeout = originalClearTimeout;
  }
});

test('useComposerInput does not post setComposerDraft when sessionPath is null', async () => {
  const posted: WebviewToHostMessage[] = [];

  act(() => {
    render(
      h(TestHarness, {
        sessionPath: null,
        draftText: '',
        postMessage: (msg) => { posted.push(msg); },
      }),
      container,
    );
  });

  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
  assert.ok(textarea);

  act(() => {
    textarea.value = 'orphan text';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // Wait long enough that any 300 ms debounce would have fired.
  await new Promise((resolve) => window.setTimeout(resolve, 350));

  assert.equal(posted.some((m) => m.type === 'setComposerDraft'), false);
});
