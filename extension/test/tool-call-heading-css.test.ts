import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readToolCallCss() {
  return readFile(new URL('../src/webview/panel/styles/tool-call.css', import.meta.url), 'utf8');
}

test('collapsed tool-call headers keep titles ahead of summary text', async () => {
  const css = await readToolCallCss();
  const headingRule = css.match(/\.tool-call-heading\.with-summary,\s*\.tool-call-heading\.with-size-hint\s*\{[\s\S]*?\n\}/);
  const nameRule = css.match(/\.tool-call-name\.with-summary\s*\{[\s\S]*?\n\}/);
  const summaryRule = css.match(/\.tool-call-summary\s*\{[\s\S]*?\n\}/);
  const summaryLinkRule = css.match(/\.tool-call-summary-link\s*\{[\s\S]*?\n\}/);
  const sizeHintRule = css.match(/\.tool-call-size-hint\s*\{[\s\S]*?\n\}/);
  const emptyHintRule = css.match(/\.tool-call-size-hint\.is-empty\s*\{[\s\S]*?\n\}/);

  assert.ok(headingRule, 'expected collapsed heading rule in tool-call.css');
  assert.ok(!/grid-template-columns:/.test(headingRule[0]), 'collapsed headings should use flex layout, not grid columns');
  assert.match(headingRule[0], /gap:\s*6px;/);

  assert.ok(nameRule, 'expected name rule in tool-call.css');
  assert.match(nameRule[0], /max-width:\s*none;/);

  assert.ok(summaryRule, 'expected summary rule in tool-call.css');
  assert.match(summaryRule[0], /display:\s*block;/);
  assert.match(summaryRule[0], /flex:\s*0 1 auto;/);
  assert.match(summaryRule[0], /max-width:\s*var\(--tool-call-summary-column-width\);/);

  assert.ok(summaryLinkRule, 'expected summary-link rule in tool-call.css');
  assert.match(summaryLinkRule[0], /display:\s*block;/);
  assert.match(summaryLinkRule[0], /flex:\s*0 1 auto;/);
  assert.match(summaryLinkRule[0], /max-width:\s*var\(--tool-call-summary-column-width\);/);

  assert.ok(sizeHintRule, 'expected size-hint rule in tool-call.css');
  assert.match(sizeHintRule[0], /display:\s*block;/);
  assert.match(sizeHintRule[0], /flex:\s*0 0 var\(--tool-call-size-column-width\);/);
  assert.match(sizeHintRule[0], /margin-left:\s*auto;/);

  assert.ok(emptyHintRule, 'expected empty size-hint rule in tool-call.css');
  assert.match(emptyHintRule[0], /display:\s*none;/);
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
