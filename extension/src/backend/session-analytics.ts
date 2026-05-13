import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';

import type { SessionAnalyticsFactors } from '../shared/protocol';
import type { SdkBuildSystemPromptOptions, SdkSkill } from './sdk';

function normalizeHashInput(text: string | undefined): string | null {
  if (typeof text !== 'string') {
    return null;
  }

  const normalized = text.replace(/\r\n?/g, '\n').trim();
  return normalized.length > 0 ? normalized : null;
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function toDisplayPath(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const sortedEntries = Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => [key, sortJsonValue(entry)]);

  return Object.fromEntries(sortedEntries);
}

function hashOptionalText(text: string | undefined): string | null {
  const normalized = normalizeHashInput(text);
  return normalized ? sha256Hex(normalized) : null;
}

function buildPromptFamily(options: {
  harnessPromptHash: string | null;
  customPromptHash: string | null;
  appendSystemPromptHash: string | null;
  promptGuidelineHashes: string[];
  contextFiles: SessionAnalyticsFactors['contextFiles'];
  selectedToolIds: string[];
  toolSnippetHashes: SessionAnalyticsFactors['toolSnippetHashes'];
  skills: SessionAnalyticsFactors['skills'];
}): string | null {
  const familyParts: string[] = [];
  if (options.harnessPromptHash) {
    familyParts.push('harness');
  }
  if (options.customPromptHash) {
    familyParts.push('customPrompt');
  }
  if (options.appendSystemPromptHash) {
    familyParts.push('appendSystemPrompt');
  }
  if (options.promptGuidelineHashes.length > 0) {
    familyParts.push('promptGuidelines');
  }
  if (options.contextFiles.length > 0) {
    familyParts.push('contextFiles');
  }
  if (options.selectedToolIds.length > 0) {
    familyParts.push('selectedTools');
  }
  if (options.toolSnippetHashes.length > 0) {
    familyParts.push('toolSnippets');
  }
  if (options.skills.length > 0) {
    familyParts.push('skills');
  }

  return familyParts.length > 0 ? familyParts.join('+') : null;
}

async function readSkillContentHash(skill: SdkSkill): Promise<string | null> {
  try {
    const content = await fs.readFile(skill.filePath, 'utf8');
    return sha256Hex(content.replace(/\r\n?/g, '\n'));
  } catch {
    return null;
  }
}

async function buildSkillFactors(skills: SdkSkill[] | undefined): Promise<SessionAnalyticsFactors['skills']> {
  const entries = skills ?? [];
  const factors = await Promise.all(entries.map(async (skill) => ({
    name: skill.name,
    contentHash: await readSkillContentHash(skill),
    sourceHash: skill.sourceInfo === undefined ? null : sha256Hex(stableJson(skill.sourceInfo)),
    disableModelInvocation: skill.disableModelInvocation,
  })));

  return factors
    .filter((skill) => skill.name.trim().length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function buildSessionAnalyticsFactors(options: {
  harnessPrompt?: string;
  promptOptions?: SdkBuildSystemPromptOptions;
}): Promise<SessionAnalyticsFactors> {
  const promptOptions = options.promptOptions;
  const harnessPromptHash = hashOptionalText(options.harnessPrompt);
  const customPromptHash = hashOptionalText(promptOptions?.customPrompt);
  const appendSystemPromptHash = hashOptionalText(promptOptions?.appendSystemPrompt);
  const promptGuidelineHashes = [...new Set(
    (promptOptions?.promptGuidelines ?? [])
      .map((guideline) => hashOptionalText(guideline) ?? '')
      .filter((hash) => hash.length > 0),
  )].sort();
  const contextFiles = (promptOptions?.contextFiles ?? [])
    .map((contextFile) => ({
      path: toDisplayPath(contextFile.path),
      hash: hashOptionalText(contextFile.content) ?? '',
    }))
    .filter((contextFile) => contextFile.path.length > 0 && contextFile.hash.length > 0)
    .sort((a, b) => a.path.localeCompare(b.path));
  const selectedToolIds = [...new Set(
    (promptOptions?.selectedTools ?? [])
      .map((toolId) => toolId.trim())
      .filter((toolId) => toolId.length > 0),
  )].sort((a, b) => a.localeCompare(b));
  const toolSnippetHashes = Object.entries(promptOptions?.toolSnippets ?? {})
    .map(([toolId, snippet]) => ({
      toolId: toolId.trim(),
      hash: hashOptionalText(snippet) ?? '',
    }))
    .filter((entry) => entry.toolId.length > 0 && entry.hash.length > 0)
    .sort((a, b) => a.toolId.localeCompare(b.toolId));
  const skills = await buildSkillFactors(promptOptions?.skills);

  const toolSetHash = selectedToolIds.length > 0 || toolSnippetHashes.length > 0
    ? sha256Hex(stableJson({ selectedToolIds, toolSnippetHashes }))
    : null;
  const skillSetHash = skills.length > 0
    ? sha256Hex(stableJson(skills))
    : null;
  const promptFamily = buildPromptFamily({
    harnessPromptHash,
    customPromptHash,
    appendSystemPromptHash,
    promptGuidelineHashes,
    contextFiles,
    selectedToolIds,
    toolSnippetHashes,
    skills,
  });

  const promptHash = sha256Hex(stableJson({
    harnessPromptHash,
    customPromptHash,
    appendSystemPromptHash,
    promptGuidelineHashes,
    contextFiles,
    selectedToolIds,
    toolSnippetHashes,
    skills,
  }));

  return {
    promptFamily,
    promptHash,
    harnessPromptHash,
    customPromptHash,
    appendSystemPromptHash,
    promptGuidelineHashes,
    contextFiles,
    selectedToolIds,
    toolSnippetHashes,
    toolSetHash,
    skills,
    skillSetHash,
  };
}
