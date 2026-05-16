import type { SystemPromptEntry } from '../shared/protocol';
import { prepareContextFiles } from './context-files';
import type { SdkBuildSystemPromptOptions, SdkSkill, SdkToolInfo } from './sdk';

export function summarizePrompt(text: string): string {
  const stripped = text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 80 ? stripped.slice(0, 80) + '...' : stripped;
}

export function normalizePromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function buildSkillSummary(skills: readonly SdkSkill[]): string {
  const summary = skills.map((skill) => skill.name).join(', ');
  return summary.length > 80 ? `${summary.slice(0, 80)}...` : summary;
}

function splitRuntimeContext(text: string | undefined): {
  mainText?: string;
  runtimeText?: string;
} {
  const normalized = normalizePromptText(text);
  if (!normalized) {
    return {};
  }

  const match = normalized.match(/\nCurrent date: [^\n]+\nCurrent working directory: [^\n]+$/);
  if (!match) {
    return { mainText: normalized };
  }

  const runtimeText = match[0].trimStart();
  const mainText = normalized.slice(0, normalized.length - match[0].length).trimEnd();
  return {
    mainText: mainText || undefined,
    runtimeText: runtimeText || undefined,
  };
}

function buildRuntimeContext(cwd: string | undefined): string | undefined {
  const resolvedCwd = normalizePromptText(cwd)?.replace(/\\/g, '/');
  if (!resolvedCwd) {
    return undefined;
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `Current date: ${year}-${month}-${day}\nCurrent working directory: ${resolvedCwd}`;
}

function buildProjectContextPrelude(): string {
  return '# Project Context\n\nProject-specific instructions and guidelines:';
}

function buildContextFileSection(displayPath: string, content: string): string {
  return `## ${displayPath}\n\n${content}`;
}

export const PROVIDER_SYSTEM_PROMPT: SystemPromptEntry = {
  source: 'provider',
  title: 'Provider system prompt',
  summary: 'Unknown',
  text: 'Unknown.\n\nThe upstream GitHub Copilot provider prompt is not exposed to this extension.',
  availability: 'unknown',
};

export function buildSessionSystemPrompts(options: {
  harnessPrompt?: string;
  promptOptions?: SdkBuildSystemPromptOptions;
  formatSkillsForPrompt?: ((skills: SdkSkill[]) => string) | undefined;
  tools?: SdkToolInfo[];
}): SystemPromptEntry[] {
  const { harnessPrompt, promptOptions, formatSkillsForPrompt } = options;
  const entries: SystemPromptEntry[] = [PROVIDER_SYSTEM_PROMPT];

  const customPrompt = normalizePromptText(promptOptions?.customPrompt);
  const { mainText: harnessMainText, runtimeText: harnessRuntimeText } = splitRuntimeContext(harnessPrompt);

  if (customPrompt) {
    entries.push({
      source: 'user',
      title: 'Custom system prompt',
      summary: summarizePrompt(customPrompt),
      text: customPrompt,
      availability: 'available',
    });
  } else {
    entries.push(
      harnessMainText
        ? {
            source: 'harness',
            title: 'Harness system prompt',
            summary: summarizePrompt(harnessMainText),
            text: harnessMainText,
            availability: 'available',
          }
        : {
            source: 'harness',
            title: 'Harness system prompt',
            summary: 'Unavailable',
            text: 'The PI harness prompt could not be reconstructed for this session.',
            availability: 'missing',
          },
    );
  }

  const appendSystemPrompt = normalizePromptText(promptOptions?.appendSystemPrompt);
  if (appendSystemPrompt) {
    const headingMatch = appendSystemPrompt.match(/^#\s+(.+)$/m);
    const title = headingMatch ? headingMatch[1] : 'Appended system prompt';
    entries.push({
      source: 'user',
      title,
      summary: summarizePrompt(appendSystemPrompt),
      text: appendSystemPrompt,
      availability: 'available',
    });
  }

  const contextFiles = prepareContextFiles(promptOptions?.contextFiles)
    .map((contextFile) => ({
      path: contextFile.path,
      displayPath: contextFile.displayPath,
      content: normalizePromptText(contextFile.content),
    }))
    .filter((contextFile): contextFile is { path: string; displayPath: string; content: string } => !!contextFile.content);

  if (contextFiles.length > 0) {
    entries.push({
      source: 'user',
      title: 'Project Context',
      summary: 'Project-specific instructions and guidelines',
      text: buildProjectContextPrelude(),
      availability: 'available',
    });

    for (const contextFile of contextFiles) {
      entries.push({
        source: 'user',
        title: contextFile.displayPath,
        tooltip: contextFile.path !== contextFile.displayPath ? contextFile.path : undefined,
        summary: summarizePrompt(contextFile.content),
        text: buildContextFileSection(contextFile.displayPath, contextFile.content),
        availability: 'available',
      });
    }
  }

  const tools = options.tools ?? [];
  if (tools.length > 0) {
    const toolSummary = tools.map((t) => t.name).join(', ');
    const toolText = tools.map((t) => {
      let entry = `## ${t.name}\n\n${t.description || '(no description)'}`;
      if (t.parameters) {
        try {
          entry += '\n\n**Parameters:**\n```json\n' + JSON.stringify(t.parameters, null, 2) + '\n```';
        } catch { /* ignore serialization errors */ }
      }
      return entry;
    }).join('\n\n---\n\n');
    entries.push({
      source: 'harness',
      title: 'Tools',
      summary: toolSummary.length > 80 ? `${toolSummary.slice(0, 80)}...` : toolSummary,
      text: toolText,
      availability: 'available',
    });
  }

  const shouldIncludeSkills = !promptOptions?.selectedTools || promptOptions.selectedTools.includes('read');
  const skills = promptOptions?.skills ?? [];
  if (shouldIncludeSkills && formatSkillsForPrompt && skills.length > 0) {
    const formattedSkills = normalizePromptText(formatSkillsForPrompt(skills));
    if (formattedSkills) {
      entries.push({
        source: 'user',
        title: 'Skills',
        summary: buildSkillSummary(skills),
        text: formattedSkills,
        availability: 'available',
      });
    }
  }

  const runtimeContext = customPrompt
    ? buildRuntimeContext(promptOptions?.cwd)
    : harnessRuntimeText;
  if (runtimeContext) {
    entries.push({
      source: 'user',
      title: 'Current date / working directory',
      summary: summarizePrompt(runtimeContext),
      text: runtimeContext,
      availability: 'available',
    });
  }

  return entries;
}
