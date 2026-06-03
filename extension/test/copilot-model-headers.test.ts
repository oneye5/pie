import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const REQUIRED_COPILOT_HEADERS = [
  'User-Agent',
  'Editor-Version',
  'Editor-Plugin-Version',
  'Copilot-Integration-Id',
] as const;

test('custom Copilot provider keeps required IDE auth headers at provider boundary', async () => {
  const raw = await readFile(new URL('../../models.json', import.meta.url), 'utf8');
  const parsed = JSON.parse(raw) as {
    providers?: Record<string, { headers?: Record<string, string> }>;
  };

  const headers = parsed.providers?.['github-copilot']?.headers;
  assert.ok(headers, 'github-copilot provider must define provider-level headers');

  for (const header of REQUIRED_COPILOT_HEADERS) {
    assert.equal(typeof headers[header], 'string', `${header} must be configured`);
    assert.notEqual(headers[header].trim(), '', `${header} must not be empty`);
  }

  assert.ok(headers['Editor-Version'].startsWith('vscode/'));
});
