import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';

import { installDom } from './_helpers/dom';
installDom();

import { h, render } from 'preact';
import { act } from 'preact/test-utils';

import { Tooltip } from '../src/webview/panel/components/tooltip';

let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  return () => {
    render(null, container);
    container.remove();
    Array.from(document.querySelectorAll('.pie-tooltip-host')).forEach((el) => el.remove());
  };
});

test('Tooltip renders trigger children and a hidden out-of-tree host', () => {
  act(() => {
    render(h(Tooltip, { content: 'Hello world' }, h('span', { class: 'trigger' }, 'target')), container);
  });

  const trigger = container.querySelector('.pie-tooltip-trigger');
  assert.ok(trigger, 'Trigger wrapper should render');
  assert.ok(trigger?.contains(container.querySelector('.trigger')), 'Tooltip should wrap the children');

  const host = document.querySelector('.pie-tooltip-host');
  assert.ok(host, 'Tooltip host should be appended to body');
  assert.equal(host.textContent, '');
  assert.equal((host as HTMLElement).style.display, 'none');
  assert.match(host.id, /^pie-tooltip-\d+$/);
});

test('Tooltip does not set a native title on the trigger', () => {
  act(() => {
    render(h(Tooltip, { content: 'Hello' }, h('span', null, 'x')), container);
  });

  const trigger = container.querySelector('.pie-tooltip-trigger');
  assert.equal(trigger?.getAttribute('title'), null);
});

test('Tooltip creates a distinct host for each instance', () => {
  const hostsBefore = document.querySelectorAll('.pie-tooltip-host').length;

  act(() => {
    render(
      h(
        'div',
        null,
        h(Tooltip, { content: 'A' }, h('span', null, 'a')),
        h(Tooltip, { content: 'B' }, h('span', null, 'b')),
      ),
      container,
    );
  });

  const hosts = Array.from(document.querySelectorAll('.pie-tooltip-host'));
  const newHosts = hosts.slice(hostsBefore);
  assert.ok(newHosts.length >= 2, 'Each tooltip should create its own host');
  const ids = new Set(newHosts.map((h) => h.id));
  assert.equal(ids.size, newHosts.length, 'Hosts should have unique ids');
});

test('freezeWhileVisible keeps the show-time text while content updates mid-hover', async () => {
  // A live indicator (e.g. tokens/sec) rebuilds its tooltip many times per
  // second. Without freezing the visible tooltip jumps on every rebuild;
  // freezeWhileVisible snapshots the text at show time and ignores further
  // updates until the pointer leaves and re-enters.
  // Prior tests' tooltip hosts accumulate in document.body (this file's
  // beforeEach teardown is a no-op under node:test), so clear them to isolate
  // this test's host.
  document.querySelectorAll('.pie-tooltip-host').forEach((el) => el.remove());
  const props = (content: string) => ({
    content,
    freezeWhileVisible: true,
    delayShow: 0,
    delayHide: 0,
  });

  act(() => {
    render(h(Tooltip, props('v1'), h('span', { class: 'trigger' }, 'target')), container);
  });
  const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
  const trigger = () => container.querySelector('.pie-tooltip-trigger') as HTMLElement;

  // Show the tooltip (delayShow: 0 fires on the next macrotask).
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(host().textContent, 'v1');

  // Live content updates while still hovering must NOT change the frozen text.
  await act(async () => {
    render(h(Tooltip, props('v2'), h('span', { class: 'trigger' }, 'target')), container);
  });
  assert.equal(host().textContent, 'v1', 'frozen tooltip should keep the show-time text');

  // Re-hovering (leave + re-enter) refreshes the snapshot. The leave and
  // re-enter are separate act() blocks so the hide flushes (clearing the
  // frozen snapshot) before the show re-snapshots — a single act would batch
  // the false->true transitions and skip the hide render.
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent('mouseleave'));
    await new Promise((r) => setTimeout(r, 30));
  });
  await act(async () => {
    trigger().dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(host().textContent, 'v2', 're-hover should refresh the snapshot');
});

test('without freezeWhileVisible the tooltip text follows live content updates', async () => {
  document.querySelectorAll('.pie-tooltip-host').forEach((el) => el.remove());
  act(() => {
    render(h(Tooltip, { content: 'v1', delayShow: 0, delayHide: 0 }, h('span', { class: 'trigger' }, 'target')), container);
  });
  const host = () => document.querySelector('.pie-tooltip-host') as HTMLElement;
  const trigger = () => container.querySelector('.pie-tooltip-trigger') as HTMLElement;

  await act(async () => {
    trigger().dispatchEvent(new MouseEvent('mouseenter'));
    await new Promise((r) => setTimeout(r, 30));
  });
  assert.equal(host().textContent, 'v1');

  await act(async () => {
    render(h(Tooltip, { content: 'v2', delayShow: 0, delayHide: 0 }, h('span', { class: 'trigger' }, 'target')), container);
  });
  assert.equal(host().textContent, 'v2', 'non-frozen tooltip should follow live content');
});
