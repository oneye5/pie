import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function readStyleSource(fileName: string): Promise<string> {
  return readFile(new URL(`../src/webview/panel/styles/${fileName}`, import.meta.url), 'utf8');
}

async function readWebviewSource(relativePath: string): Promise<string> {
  return readFile(new URL(`../src/webview/panel/${relativePath}`, import.meta.url), 'utf8');
}

test('global focus fallback lives in Tailwind base so component outline utilities can override it', async () => {
  const indexCss = await readStyleSource('index.css');
  const baseLayerStart = indexCss.indexOf('@layer base');
  const baseLayerEnd = indexCss.indexOf('@utility message-prose');
  const focusFallbackStart = indexCss.indexOf(':focus-visible');

  assert.ok(baseLayerStart >= 0, 'expected index.css to define Tailwind base overrides');
  assert.ok(baseLayerEnd >= 0, 'expected @utility after @layer base');
  assert.ok(focusFallbackStart > baseLayerStart, 'expected global focus fallback inside base setup');
  assert.ok(focusFallbackStart < baseLayerEnd, 'expected global focus fallback inside @layer base block');
  // tokens.css merged into index.css — focus-visible belongs to @layer base only
});

test('panel chip styling is centralized instead of embedded in feature components', async () => {
  const indexCss = await readStyleSource('index.css');
  const panelChipCss = await readStyleSource('panel-chip.css');
  const toolbar = await readWebviewSource('composer/toolbar.tsx');
  const pruningHeader = await readWebviewSource('transcript/pruning-header.tsx');
  const pruningInline = await readWebviewSource('transcript/pruning-inline.tsx');
  const panelChipComponent = await readWebviewSource('components/panel-chip.tsx');

  assert.match(indexCss, /@import '\.\/panel-chip\.css';/);
  assert.match(panelChipCss, /\.panel-chip-toolbar/);
  assert.match(panelChipCss, /\.panel-chip-pruning/);
  assert.match(panelChipCss, /\.pruning-detail-row/);
  assert.match(panelChipComponent, /function PanelChip/);
  assert.match(panelChipComponent, /export function ToolbarIndicatorChip/);
  assert.match(panelChipComponent, /export function PruningHeaderChipControl/);

  assert.match(toolbar, /ToolbarModelSelectChip/);
  assert.match(toolbar, /ToolbarIndicatorChip/);
  assert.doesNotMatch(toolbar, /PanelChip/);
  assert.doesNotMatch(toolbar, /variant=/);
  assert.doesNotMatch(toolbar, /className="panel-chip/);

  assert.match(pruningHeader, /PruningHeaderChipControl/);
  assert.match(pruningHeader, /PruningDiagnostics/);
  assert.match(pruningInline, /PruningDiagnostics/);
  assert.doesNotMatch(pruningHeader, /PanelChip/);
  assert.doesNotMatch(pruningHeader, /variant=/);

  for (const [name, source] of [
    ['toolbar', toolbar],
    ['pruning header', pruningHeader],
    ['pruning inline', pruningInline],
  ] as const) {
    assert.doesNotMatch(source, /inline-flex h-\[(18|22)px\]/, `${name} should not own chip height/layout utilities`);
    assert.doesNotMatch(source, /rounded-full border border-transparent bg-control/, `${name} should not own chip shell utilities`);
    assert.doesNotMatch(source, /max-w-\[30ch\]/, `${name} should not hard-code pruning chip truncation width`);
    assert.doesNotMatch(source, /text-\[10px\] font-(bold|semibold) uppercase tracking-wider text-muted/, `${name} should not duplicate chip typography utilities`);
  }
});