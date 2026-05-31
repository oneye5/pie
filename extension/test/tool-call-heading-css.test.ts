import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { h } from 'preact';
import renderToString from 'preact-render-to-string';

async function readToolCallCss() {
  return readFile(new URL('../src/webview/panel/styles/tool-call.css', import.meta.url), 'utf8');
}

test('collapsed tool-call headers keep titles ahead of summary text', async () => {
  const { ToolCallHeader } = await import('../src/webview/panel/transcript/tool-call-card.tsx');
  const html = renderToString(h(ToolCallHeader, {
    open: false,
    name: 'read',
    nameTitle: 'Read file',
    status: 'completed',
    summary: 'src/example.ts',
    summaryPath: '/repo/src/example.ts',
    sizeHint: '+3 lines',
    onOpenFile: () => {},
  }));

  assert.match(html, /flex min-w-0 flex-1 items-center/);
  assert.doesNotMatch(html, /grid-template-columns:/);
  assert.match(html, /min-w-0 flex-auto truncate font-mono text-xs font-semibold/);
  assert.match(html, /max-w-\[var\(--tool-call-summary-column-width\)\]/);
  assert.match(html, /flex-\[0_1_auto\]/);
  assert.match(html, /flex-\[0_0_var\(--tool-call-size-column-width\)\]/);
  assert.match(html, /ml-auto/);
});

test('subagent headers keep score badges ahead of summary text without extra model or thinking chrome', async () => {
  const css = await readToolCallCss();
  const subagentSummaryRule = css.match(/\.subagent-header-summary\s*\{[\s\S]*?\n\}/);
  const primaryMetaRule = css.match(/\.subagent-primary-meta\s*\{[\s\S]*?\n\}/);
  const scoresRule = css.match(/\.subagent-scores\s*\{[\s\S]*?\n\}/);

  assert.ok(subagentSummaryRule, 'expected subagent summary rule in tool-call.css');
  assert.match(subagentSummaryRule[0], /flex:\s*1 1 auto;/);

  assert.ok(primaryMetaRule, 'expected primary subagent metadata rule in tool-call.css');
  assert.match(primaryMetaRule[0], /display:\s*inline-flex;/);
  assert.match(primaryMetaRule[0], /align-items:\s*center;/);
  assert.match(primaryMetaRule[0], /flex:\s*0 0 auto;/);

  assert.ok(scoresRule, 'expected score bar rule in tool-call.css');
  assert.match(scoresRule[0], /flex-shrink:\s*0;/);

  assert.ok(!css.includes('.subagent-secondary-meta'), 'subagent secondary-meta chrome should be removed');
  assert.ok(!css.includes('.subagent-model-tag'), 'subagent model badges should be removed');
  assert.ok(!css.includes('.subagent-thinking-tag'), 'subagent thinking badges should be removed');
});
