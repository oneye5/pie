import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readStatusChipCss() {
  return readFile(new URL('../src/webview/panel/styles/status-chip.css', import.meta.url), 'utf8');
}

async function readTokensCss() {
  return readFile(new URL('../src/webview/panel/styles/tokens.css', import.meta.url), 'utf8');
}

test('shared status chip reserves enough fixed-column width for tool/subagent headers', async () => {
  const css = await readStatusChipCss();
  const tokens = await readTokensCss();
  const baseRule = css.match(/\.status-chip\s*\{[\s\S]*?\n\}/);
  const fixedRule = css.match(/\.status-chip-fixed\s*\{[\s\S]*?\n\}/);

  assert.match(tokens, /--tool-call-status-column-width:\s*12ch;/);
  assert.match(tokens, /--status-chip-height:\s*18px;/);
  assert.match(tokens, /--status-chip-dot-size:\s*5px;/);

  assert.ok(baseRule, 'expected .status-chip base rule in status-chip.css');
  assert.match(baseRule[0], /font-family:\s*var\(--vscode-editor-font-family,\s*monospace\);/);

  assert.ok(fixedRule, 'expected .status-chip-fixed rule in status-chip.css');
  assert.match(fixedRule[0], /min-width:\s*var\(--tool-call-status-column-width\);/);
  assert.match(fixedRule[0], /max-width:\s*var\(--tool-call-status-column-width\);/);
  assert.match(fixedRule[0], /flex:\s*0 0 var\(--tool-call-status-column-width\);/);
});
