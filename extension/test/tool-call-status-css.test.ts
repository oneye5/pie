import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readToolCallCss() {
  return readFile(new URL('../src/webview/panel/styles/tool-call.css', import.meta.url), 'utf8');
}

async function readTokensCss() {
  return readFile(new URL('../src/webview/panel/styles/tokens.css', import.meta.url), 'utf8');
}

test('collapsed tool-call status keeps enough reserved width for status chips', async () => {
  const css = await readToolCallCss();
  const tokens = await readTokensCss();
  const statusRule = css.match(/\.tool-call-status\s*\{[\s\S]*?\n\}/);
  const subagentStatusRule = css.match(/\.subagent-status\s*\{[\s\S]*?\n\}/);

  assert.match(tokens, /--tool-call-status-column-width:\s*12ch;/);
  assert.match(tokens, /--status-chip-height:\s*18px;/);
  assert.match(tokens, /--status-chip-dot-size:\s*5px;/);
  assert.ok(statusRule, 'expected .tool-call-status rule in tool-call.css');
  assert.match(statusRule[0], /min-width:\s*var\(--tool-call-status-column-width\);/);
  assert.match(statusRule[0], /max-width:\s*var\(--tool-call-status-column-width\);/);
  assert.match(statusRule[0], /flex:\s*0 0 var\(--tool-call-status-column-width\);/);
  assert.match(statusRule[0], /font-family:\s*var\(--vscode-editor-font-family,\s*monospace\);/);

  assert.ok(subagentStatusRule, 'expected .subagent-status rule in tool-call.css');
  assert.match(subagentStatusRule[0], /min-width:\s*var\(--tool-call-status-column-width\);/);
  assert.match(subagentStatusRule[0], /max-width:\s*var\(--tool-call-status-column-width\);/);
  assert.match(subagentStatusRule[0], /flex:\s*0 0 var\(--tool-call-status-column-width\);/);
});
