import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { _clearSubagentProfilesCache, loadSubagentProfiles } from '../src/backend/subagent-profiles';

function makeAgentDir(profilesJson: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pie-subagent-profiles-'));
  if (profilesJson !== null) {
    fs.writeFileSync(path.join(dir, 'model-profiles.json'), profilesJson);
  }
  return dir;
}

test('loadSubagentProfiles parses eligible/ineligible profiles and computes aggregate rating', () => {
  _clearSubagentProfilesCache();
  const agentDir = makeAgentDir(JSON.stringify({
    profiles: [
      { _comment: 'header — ignored' },
      { id: 'good', precision: 4, creativity: 5, thoroughness: 4, reasoning: 5, eligible: true },
      { id: 'bad', precision: 3, creativity: 3, thoroughness: 3, reasoning: 3, eligible: false, _disabled_reason: 'incompatible API' },
    ],
  }));

  const profiles = loadSubagentProfiles(agentDir);
  assert.deepEqual(profiles.get('good'), { eligible: true, aggregate: 18 });
  assert.deepEqual(profiles.get('bad'), { eligible: false, aggregate: 12, disabledReason: 'incompatible API' });
  assert.equal(profiles.has('header'), false);
});

test('loadSubagentProfiles returns an empty map when the profiles file is missing', () => {
  _clearSubagentProfilesCache();
  const agentDir = makeAgentDir(null);
  const profiles = loadSubagentProfiles(agentDir);
  assert.equal(profiles.size, 0);
});

test('loadSubagentProfiles tolerates malformed JSON without throwing', () => {
  _clearSubagentProfilesCache();
  const agentDir = makeAgentDir('{ this is not json');
  const profiles = loadSubagentProfiles(agentDir);
  assert.equal(profiles.size, 0);
});

test('loadSubagentProfiles reloads when the profiles file is updated', () => {
  _clearSubagentProfilesCache();
  const agentDir = makeAgentDir(JSON.stringify({
    profiles: [{ id: 'm', precision: 1, creativity: 1, thoroughness: 1, reasoning: 1, eligible: true }],
  }));
  const filePath = path.join(agentDir, 'model-profiles.json');
  assert.equal(loadSubagentProfiles(agentDir).get('m')?.aggregate, 4);

  // Bump mtime forward to guarantee the cache invalidates on file systems with
  // coarse mtime resolution.
  const future = new Date(Date.now() + 5000);
  fs.writeFileSync(filePath, JSON.stringify({
    profiles: [{ id: 'm', precision: 5, creativity: 5, thoroughness: 5, reasoning: 5, eligible: false }],
  }));
  fs.utimesSync(filePath, future, future);

  const reloaded = loadSubagentProfiles(agentDir).get('m');
  assert.deepEqual(reloaded, { eligible: false, aggregate: 20 });
});
