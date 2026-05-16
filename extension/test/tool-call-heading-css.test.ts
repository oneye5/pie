import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readPanelCss() {
  return readFile(new URL('../src/webview/panel/panel.css', import.meta.url), 'utf8');
}

test('collapsed tool-call headers keep titles ahead of summary text', async () => {
  const css = await readPanelCss();
  const headingRule = css.match(/\.tool-call-heading\.with-summary,\s*\.tool-call-heading\.with-size-hint\s*\{[\s\S]*?\n\}/);
  const nameRule = css.match(/\.tool-call-name\.with-summary\s*\{[\s\S]*?\n\}/);
  const summaryRule = css.match(/\.tool-call-summary\s*\{[\s\S]*?\n\}/);
  const summaryLinkRule = css.match(/\.tool-call-summary-link\s*\{[\s\S]*?\n\}/);
  const sizeHintRule = css.match(/\.tool-call-size-hint\s*\{[\s\S]*?\n\}/);
  const emptyHintRule = css.match(/\.tool-call-size-hint\.is-empty\s*\{[\s\S]*?\n\}/);

  assert.ok(headingRule, 'expected collapsed heading rule in panel.css');
  assert.ok(!/grid-template-columns:/.test(headingRule[0]), 'collapsed headings should use flex layout, not grid columns');
  assert.match(headingRule[0], /gap:\s*6px;/);

  assert.ok(nameRule, 'expected name rule in panel.css');
  assert.match(nameRule[0], /max-width:\s*none;/);

  assert.ok(summaryRule, 'expected summary rule in panel.css');
  assert.match(summaryRule[0], /display:\s*block;/);
  assert.match(summaryRule[0], /flex:\s*0 1 auto;/);
  assert.match(summaryRule[0], /max-width:\s*var\(--tool-call-summary-column-width\);/);

  assert.ok(summaryLinkRule, 'expected summary-link rule in panel.css');
  assert.match(summaryLinkRule[0], /display:\s*block;/);
  assert.match(summaryLinkRule[0], /flex:\s*0 1 auto;/);
  assert.match(summaryLinkRule[0], /max-width:\s*var\(--tool-call-summary-column-width\);/);

  assert.ok(sizeHintRule, 'expected size-hint rule in panel.css');
  assert.match(sizeHintRule[0], /display:\s*block;/);
  assert.match(sizeHintRule[0], /flex:\s*0 0 var\(--tool-call-size-column-width\);/);
  assert.match(sizeHintRule[0], /margin-left:\s*auto;/);

  assert.ok(emptyHintRule, 'expected empty size-hint rule in panel.css');
  assert.match(emptyHintRule[0], /display:\s*none;/);
});

test('subagent headers prioritize task scores and model over lower-priority metadata', async () => {
  const css = await readPanelCss();
  const subagentSummaryRule = css.match(/\.subagent-header-summary\s*\{[\s\S]*?\n\}/);
  const sharedMetaRule = css.match(/\.subagent-primary-meta,\s*\.subagent-secondary-meta,\s*\.subagent-multi-models\s*\{[\s\S]*?\n\}/);
  const primaryMetaFlexRule = css.match(/\.subagent-primary-meta,\s*\.subagent-multi-models\s*\{[\s\S]*?\n\}/);
  const secondaryMetaRule = css.match(/\.subagent-secondary-meta\s*\{[\s\S]*?\n\}/);
  const scoresRule = css.match(/\.subagent-scores\s*\{[\s\S]*?\n\}/);
  const modelRule = css.match(/\.subagent-model-tag\s*\{[\s\S]*?\n\}/);

  assert.ok(subagentSummaryRule, 'expected subagent summary rule in panel.css');
  assert.match(subagentSummaryRule[0], /flex:\s*1 1 auto;/);

  assert.ok(sharedMetaRule, 'expected shared subagent metadata rule in panel.css');
  assert.match(sharedMetaRule[0], /display:\s*inline-flex;/);
  assert.match(sharedMetaRule[0], /align-items:\s*center;/);

  assert.ok(primaryMetaFlexRule, 'expected primary subagent metadata flex rule in panel.css');
  assert.match(primaryMetaFlexRule[0], /flex:\s*0 0 auto;/);

  assert.ok(secondaryMetaRule, 'expected secondary subagent metadata rule in panel.css');
  assert.match(secondaryMetaRule[0], /flex:\s*0 1 auto;/);

  assert.ok(scoresRule, 'expected score bar rule in panel.css');
  assert.match(scoresRule[0], /flex-shrink:\s*0;/);

  assert.ok(modelRule, 'expected model tag rule in panel.css');
  assert.match(modelRule[0], /flex-shrink:\s*0;/);
});
