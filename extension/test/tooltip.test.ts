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
