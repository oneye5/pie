import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { ModelSettings, ThinkingLevel } from '../shared/protocol';

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  defaultModel: '',
  defaultThinkingLevel: 'medium',
};

export async function readModelSettings(agentDir: string): Promise<ModelSettings> {
  try {
    const raw = await fs.readFile(path.join(agentDir, 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ModelSettings>;
    return {
      defaultModel: parsed.defaultModel ?? DEFAULT_MODEL_SETTINGS.defaultModel,
      defaultThinkingLevel: (parsed.defaultThinkingLevel as ThinkingLevel) ?? DEFAULT_MODEL_SETTINGS.defaultThinkingLevel,
    };
  } catch {
    return { ...DEFAULT_MODEL_SETTINGS };
  }
}

export async function writeModelSettings(
  agentDir: string,
  updates: Partial<ModelSettings>,
): Promise<ModelSettings> {
  const settingsPath = path.join(agentDir, 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // may not exist yet
  }
  const merged = { ...existing, ...updates };
  await fs.writeFile(settingsPath, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return await readModelSettings(agentDir);
}
