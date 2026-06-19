import type { SystemPromptEntry } from '../shared/protocol';
import { prepareContextFiles } from './context-files';
import type { ActiveModelInfo } from './session-metadata';
import type { SdkBuildSystemPromptOptions, SdkSkill, SdkToolInfo } from './sdk';

/** Maximum characters for system prompt and tool description summaries. */
const SUMMARY_MAX_LENGTH = 80;

export function summarizePrompt(text: string): string {
  const stripped = text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > SUMMARY_MAX_LENGTH ? stripped.slice(0, SUMMARY_MAX_LENGTH) + '...' : stripped;
}

export function normalizePromptText(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  return trimmed ? trimmed : undefined;
}

function buildSkillSummary(skills: readonly SdkSkill[]): string {
  const summary = skills.map((skill) => skill.name).join(', ');
  return summary.length > SUMMARY_MAX_LENGTH ? `${summary.slice(0, SUMMARY_MAX_LENGTH)}...` : summary;
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

/**
 * Build the "Provider system prompt" entry from the session's active model.
 *
 * pi sends the reconstructed system prompt (harness template or a custom
 * prompt, plus appended / project-context / skills / runtime sections) to the
 * active provider as the system message. The provider's own system prompt is
 * not exposed to this extension — direct API providers do not inject one, while
 * wrapper providers (e.g. GitHub Copilot Chat) may prepend hidden instructions
 * server-side. This entry names the active provider/model so the card reflects
 * the live session instead of a hardcoded provider.
 */
export function buildProviderSystemPrompt(active?: ActiveModelInfo): SystemPromptEntry {
  const provider = active?.provider;
  const modelId = active?.modelId;
  const modelLabel = active?.modelName ?? modelId;
  const modelClause = modelLabel ? ` (${modelLabel})` : '';

  if (provider) {
    return {
      source: 'provider',
      title: 'Provider system prompt',
      summary: provider,
      text: `Not directly exposed.\n\npi sends the reconstructed system prompt — built from the harness template (or a custom prompt) plus the appended, project-context, skills, and runtime entries — to ${provider}${modelClause} as the system message. Some providers also inject their own hidden instructions server-side (e.g. GitHub Copilot Chat's prelude); those are not visible to this extension.`,
      availability: 'unknown',
    };
  }

  const text = modelId
    ? `Not resolved.\n\nThe active model (${modelId}) is not in pi's model registry, so its provider cannot be named here. pi still sends the reconstructed system prompt to it as the system message.`
    : `Not resolved yet.\n\nNo active model has been selected for this session. Once a model is chosen, this entry names its provider and describes the system prompt pi sends to it.`;
  return {
    source: 'provider',
    title: 'Provider system prompt',
    summary: 'Unknown',
    text,
    availability: 'unknown',
  };
}

export function buildSessionSystemPrompts(options: {
  harnessPrompt?: string;
  promptOptions?: SdkBuildSystemPromptOptions;
  formatSkillsForPrompt?: ((skills: SdkSkill[]) => string) | undefined;
  tools?: SdkToolInfo[];
  /** Active provider/model for the provider entry. Omit to render a neutral "not resolved" state. */
  activeProvider?: ActiveModelInfo;
}): SystemPromptEntry[] {
  const { harnessPrompt, promptOptions, formatSkillsForPrompt } = options;
  const entries: SystemPromptEntry[] = [buildProviderSystemPrompt(options.activeProvider)];

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
      summary: toolSummary.length > SUMMARY_MAX_LENGTH ? `${toolSummary.slice(0, SUMMARY_MAX_LENGTH)}...` : toolSummary,
      text: toolText,
      availability: 'available',
    });
  }

  const shouldIncludeSkills = !promptOptions?.selectedTools || promptOptions.selectedTools.includes('read');
  const skills = (promptOptions?.skills ?? []).filter(
    (s): s is SdkSkill => !!s && typeof s.name === 'string',
  );
  if (shouldIncludeSkills && formatSkillsForPrompt && skills.length > 0) {
    try {
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
    } catch { /* SDK formatSkillsForPrompt may crash on malformed skill data */ }
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
