import assert from 'node:assert/strict';
import test from 'node:test';

import type { SdkBuildSystemPromptOptions, SdkSkill, SdkToolInfo } from '../src/backend/sdk';
import { buildProviderSystemPrompt, buildSessionSystemPrompts } from '../src/backend/system-prompts';

function makeSkill(name: string): SdkSkill {
  return {
    name,
    description: `${name} description`,
    filePath: `/repo/skills/${name}/SKILL.md`,
    baseDir: '/repo/skills',
    sourceInfo: null,
    disableModelInvocation: false,
  };
}

test('buildSessionSystemPrompts mirrors the actual model-context order for a custom prompt session', () => {
  const promptOptions: SdkBuildSystemPromptOptions = {
    cwd: '/repo',
    customPrompt: 'Custom instructions',
    appendSystemPrompt: 'Append instructions',
    contextFiles: [
      { path: '/repo/AGENTS.md', content: 'Repo rules' },
      { path: '/home/user/.pi/agent/AGENTS.md', content: 'Global rules' },
    ],
    skills: [makeSkill('design-system'), makeSkill('frontend-design')],
  };

  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions,
    formatSkillsForPrompt: (skills) => skills.map((skill) => skill.name).join('\n'),
  });

  assert.deepEqual(
    prompts.map((prompt) => prompt.title),
    [
      'Provider system prompt',
      'Custom system prompt',
      'Appended system prompt',
      'Project Context',
      'repo/AGENTS.md',
      'agent/AGENTS.md',
      'Skills',
      'Current date / working directory',
    ],
  );

  assert.equal(prompts[1]?.text, 'Custom instructions');
  assert.equal(prompts[2]?.text, 'Append instructions');
  assert.equal(prompts[3]?.text, '# Project Context\n\nProject-specific instructions and guidelines:');
  assert.equal(prompts[4]?.tooltip, '/repo/AGENTS.md');
  assert.equal(prompts[4]?.text, '## repo/AGENTS.md\n\nRepo rules');
  assert.equal(prompts[5]?.tooltip, '/home/user/.pi/agent/AGENTS.md');
  assert.equal(prompts[5]?.text, '## agent/AGENTS.md\n\nGlobal rules');
  assert.equal(prompts[6]?.summary, 'design-system, frontend-design');
  assert.match(prompts[7]?.text ?? '', /^Current date: \d{4}-\d{2}-\d{2}\nCurrent working directory: \/repo$/);
});

test('buildSessionSystemPrompts deduplicates project context files that differ only by Windows path casing', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: d:/Projects/StandAloneProjects/pi-config',
    promptOptions: {
      cwd: 'd:/Projects/StandAloneProjects/pi-config',
      contextFiles: [
        {
          path: 'D:\\Projects\\StandAloneProjects\\pi-config\\AGENTS.md',
          content: 'Repo rules',
        },
        {
          path: 'd:/Projects/StandAloneProjects/pi-config/AGENTS.md',
          content: 'Duplicate repo rules',
        },
      ],
      skills: [],
    },
    formatSkillsForPrompt: () => '',
  });

  assert.deepEqual(
    prompts.map((prompt) => prompt.title),
    [
      'Provider system prompt',
      'Harness system prompt',
      'Project Context',
      'pi-config/AGENTS.md',
      'Current date / working directory',
    ],
  );
  assert.equal(prompts[3]?.tooltip, 'D:/Projects/StandAloneProjects/pi-config/AGENTS.md');
  assert.equal(prompts[3]?.text, '## pi-config/AGENTS.md\n\nRepo rules');
});

test('buildSessionSystemPrompts keeps the harness prompt as the main system section when no custom prompt is configured', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: {
      cwd: '/repo',
      appendSystemPrompt: '   ',
      contextFiles: [{ path: '/repo/AGENTS.md', content: '   ' }],
      skills: [],
    },
    formatSkillsForPrompt: () => '',
  });

  assert.deepEqual(
    prompts.map((prompt) => ({ title: prompt.title, availability: prompt.availability })),
    [
      { title: 'Provider system prompt', availability: 'unknown' },
      { title: 'Harness system prompt', availability: 'available' },
      { title: 'Current date / working directory', availability: 'available' },
    ],
  );

  assert.equal(prompts[1]?.text, 'Harness instructions');
  assert.equal(prompts[2]?.text, 'Current date: 2026-05-13\nCurrent working directory: /repo');
});

test('buildSessionSystemPrompts matches Pi skill inclusion rules when read is unavailable', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: {
      cwd: '/repo',
      selectedTools: ['bash'],
      skills: [makeSkill('frontend-design')],
    },
    formatSkillsForPrompt: (skills) => skills.map((skill) => skill.name).join('\n'),
  });

  assert.ok(!prompts.some((prompt) => prompt.title === 'Skills'));
});

test('buildSessionSystemPrompts includes a Tools entry when tools are provided', () => {
  const tools: SdkToolInfo[] = [
    { name: 'read', description: 'Read file contents' },
    { name: 'subagent', description: 'Delegate tasks to specialized subagents', parameters: { type: 'object', properties: { agent: { type: 'string' } } } },
  ];

  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    tools,
  });

  const toolEntry = prompts.find((p) => p.title === 'Tools');
  assert.ok(toolEntry, 'Tools entry should exist');
  assert.equal(toolEntry.source, 'harness');
  assert.equal(toolEntry.availability, 'available');
  assert.equal(toolEntry.summary, 'read, subagent');
  assert.match(toolEntry.text, /## read/);
  assert.match(toolEntry.text, /## subagent/);
  assert.match(toolEntry.text, /Read file contents/);
  assert.match(toolEntry.text, /Delegate tasks/);
  assert.match(toolEntry.text, /"agent"/);
});

test('buildSessionSystemPrompts omits Tools entry when tools array is empty', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness instructions\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    tools: [],
  });

  assert.ok(!prompts.some((p) => p.title === 'Tools'));
});

test('buildSessionSystemPrompts truncates long tool summary', () => {
  const tools: SdkToolInfo[] = Array.from({ length: 20 }, (_, i) => ({
    name: `tool_with_long_name_${i}`,
    description: `Description ${i}`,
  }));

  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    tools,
  });

  const toolEntry = prompts.find((p) => p.title === 'Tools');
  assert.ok(toolEntry);
  assert.ok(toolEntry.summary.length <= 83); // 80 + '...'
  assert.ok(toolEntry.summary.endsWith('...'));
});

test('buildProviderSystemPrompt names the active provider/model instead of hardcoding GitHub Copilot', () => {
  const entry = buildProviderSystemPrompt({ provider: 'umans', modelId: 'umans-glm-5.2', modelName: 'GLM 5.2' });

  assert.equal(entry.source, 'provider');
  assert.equal(entry.title, 'Provider system prompt');
  assert.equal(entry.availability, 'unknown');
  assert.equal(entry.summary, 'umans');
  assert.ok(!/GitHub Copilot provider prompt is not exposed/.test(entry.text), 'must not carry the stale hardcoded Copilot text');
  assert.match(entry.text, /umans/);
  assert.match(entry.text, /GLM 5\.2/);
});

test('buildProviderSystemPrompt falls back to a neutral unresolved state when no model is selected', () => {
  const entry = buildProviderSystemPrompt(undefined);

  assert.equal(entry.title, 'Provider system prompt');
  assert.equal(entry.availability, 'unknown');
  assert.equal(entry.summary, 'Unknown');
  assert.ok(!/GitHub Copilot/.test(entry.text), 'fallback must not assume a specific provider');
  assert.match(entry.text, /No active model has been selected/);
});

test('buildSessionSystemPrompts threads the active provider into the provider entry', () => {
  const prompts = buildSessionSystemPrompts({
    harnessPrompt: 'Harness\nCurrent date: 2026-05-13\nCurrent working directory: /repo',
    promptOptions: { cwd: '/repo', skills: [] },
    formatSkillsForPrompt: () => '',
    activeProvider: { provider: 'anthropic', modelId: 'claude-3-5-sonnet' },
  });

  const provider = prompts[0];
  assert.equal(provider.title, 'Provider system prompt');
  assert.equal(provider.summary, 'anthropic');
  assert.match(provider.text, /anthropic/);
  assert.match(provider.text, /claude-3-5-sonnet/);
});
