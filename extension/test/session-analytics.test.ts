import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildSessionAnalyticsFactors } from '../src/backend/session-analytics';
import type { SdkBuildSystemPromptOptions, SdkSkill } from '../src/backend/sdk';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pie-session-analytics-'));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeSkill(filePath: string, name: string): SdkSkill {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: path.dirname(path.dirname(filePath)),
    sourceInfo: { scope: 'project' },
    disableModelInvocation: false,
  };
}

test('buildSessionAnalyticsFactors hashes structured prompt, tool, and skill inputs deterministically', async () => {
  await withTempDir(async (dir) => {
    const skillDir = path.join(dir, 'skills', 'verification-before-completion');
    await fs.mkdir(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    await fs.writeFile(skillFile, '# Verification\n\nAlways verify.\n', 'utf8');

    const promptOptionsA: SdkBuildSystemPromptOptions = {
      cwd: dir,
      customPrompt: 'Keep responses direct.',
      appendSystemPrompt: 'Prefer local-first analytics.',
      promptGuidelines: ['Always verify', 'Prefer hashes over raw payloads'],
      contextFiles: [
        { path: path.join(dir, 'README.md'), content: 'Repository guidance' },
        { path: path.join(dir, 'docs', 'PLAN.md'), content: 'Plan guidance' },
      ],
      selectedTools: ['bash', 'read'],
      toolSnippets: {
        bash: 'Run verification commands',
        read: 'Inspect files',
      },
      skills: [makeSkill(skillFile, 'verification-before-completion')],
    };

    const promptOptionsB: SdkBuildSystemPromptOptions = {
      ...promptOptionsA,
      contextFiles: [...(promptOptionsA.contextFiles ?? [])].reverse(),
      selectedTools: [...(promptOptionsA.selectedTools ?? [])].reverse(),
      toolSnippets: {
        read: 'Inspect files',
        bash: 'Run verification commands',
      },
      promptGuidelines: [...(promptOptionsA.promptGuidelines ?? [])].reverse(),
    };

    const [factorsA, factorsB] = await Promise.all([
      buildSessionAnalyticsFactors({
        harnessPrompt: 'Harness prompt body',
        promptOptions: promptOptionsA,
      }),
      buildSessionAnalyticsFactors({
        harnessPrompt: 'Harness prompt body',
        promptOptions: promptOptionsB,
      }),
    ]);

    assert.equal(factorsA.promptFamily, 'harness+customPrompt+appendSystemPrompt+promptGuidelines+contextFiles+selectedTools+toolSnippets+skills');
    assert.equal(typeof factorsA.promptHash, 'string');
    assert.equal(factorsA.promptHash.length, 64);
    assert.deepEqual(factorsA.selectedToolIds, ['bash', 'read']);
    assert.deepEqual(factorsA.toolSnippetHashes.map((entry) => entry.toolId), ['bash', 'read']);
    assert.equal(factorsA.skills[0]?.name, 'verification-before-completion');
    assert.equal(factorsA.skills[0]?.contentHash?.length, 64);

    assert.equal(factorsA.promptHash, factorsB.promptHash);
    assert.equal(factorsA.toolSetHash, factorsB.toolSetHash);
    assert.equal(factorsA.skillSetHash, factorsB.skillSetHash);
    assert.deepEqual(factorsA.contextFiles.map((entry) => path.basename(entry.path)), ['PLAN.md', 'README.md']);
  });
});
