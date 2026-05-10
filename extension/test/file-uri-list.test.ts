import assert from 'node:assert/strict';
import test from 'node:test';

import { parseFileUriList } from '../src/shared/file-uri-list';

test('parseFileUriList converts Windows file URIs and dedupes entries', () => {
  assert.deepEqual(
    parseFileUriList([
      '# comment',
      'file:///C:/repo/alpha.ts',
      'file:///C:/repo/alpha.ts',
      'file:///C:/repo/beta.ts',
    ].join('\r\n')),
    [
      'C:\\repo\\alpha.ts',
      'C:\\repo\\beta.ts',
    ],
  );
});

test('parseFileUriList converts UNC file URIs to Windows paths', () => {
  assert.deepEqual(
    parseFileUriList('file://server/share/folder/file.txt'),
    ['\\\\server\\share\\folder\\file.txt'],
  );
});

test('parseFileUriList ignores non-file URIs and malformed entries', () => {
  assert.deepEqual(
    parseFileUriList([
      'https://example.com/readme',
      'not a uri',
      'file:///tmp/app.ts',
    ].join('\n')),
    ['/tmp/app.ts'],
  );
});
