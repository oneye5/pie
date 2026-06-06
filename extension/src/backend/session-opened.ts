/**
 * buildSessionOpenedPayload — extracted from BackendServer.
 * Builds the full payload for a session.opened event.
 */

import { buildSessionAnalyticsFactors } from './session-analytics';
import { buildCurrentSummary, listAvailableModels } from './session-metadata';
import { buildSessionSystemPrompts } from './system-prompts';
import { buildTailTranscriptWindow, buildDisplayTranscriptCache, isDisplayTranscriptCacheStale } from './transcript-window';
import type { SessionOpenedPayload, SystemPromptEntry } from '../shared/protocol';
import type { SessionContext, SessionPromptState } from './server-types';
import type { SdkBuildSystemPromptOptions } from './sdk';
import type { SessionEntryLike } from './transcript';

export interface BuildSessionOpenedPayloadDeps {
  getContextUsage(context: SessionContext): import('../shared/protocol').ContextWindowUsage | undefined;
  readHarnessSystemPrompt(context: SessionContext): Promise<string | undefined>;
  buildSystemPrompts(context: SessionContext, harnessPromptOverride?: string): Promise<SystemPromptEntry[]>;
  readModelSettings(): Promise<import('../shared/protocol').ModelSettings>;
  getPinnedStreamingMessageId(context: SessionContext): string | undefined;
  getSessionContext(sessionPath: string): SessionContext | undefined;
  agentDir: string;
  startupCwd: string;
}

export async function buildSessionOpenedPayload(
  sessionPath: string,
  deps: BuildSessionOpenedPayloadDeps,
  selectionToken?: string,
): Promise<SessionOpenedPayload> {
  const context = deps.getSessionContext(sessionPath);
  if (!context) {
    throw new Error(`Unknown session: ${sessionPath}`);
  }

  const harnessPrompt = await deps.readHarnessSystemPrompt(context);
  const [systemPrompts, modelSettings, analyticsFactors] = await Promise.all([
    deps.buildSystemPrompts(context, harnessPrompt),
    deps.readModelSettings(),
    buildSessionAnalyticsFactors({
      harnessPrompt,
      promptOptions: getPromptOptions(context.session),
    }),
  ]);

  const contextUsage = deps.getContextUsage(context) ?? null;
  context.lastContextUsage = contextUsage;

  const cache = ensureDisplayTranscriptCache(context);
  const transcriptSlice = buildTailTranscriptWindow(cache, {
    pinnedMessageId: deps.getPinnedStreamingMessageId(context),
  });

  return {
    session: buildCurrentSummary(context, deps.startupCwd),
    transcript: transcriptSlice.transcript,
    transcriptWindow: transcriptSlice.transcriptWindow,
    busy: context.session.isStreaming || !!context.activeRequest,
    selectionToken,
    systemPrompts,
    analyticsFactors,
    modelSettings,
    availableModels: listAvailableModels(context, deps.agentDir),
    contextUsage: contextUsage ?? undefined,
  };
}

function getPromptOptions(session: unknown): SdkBuildSystemPromptOptions | undefined {
  return (session as SessionPromptState)._baseSystemPromptOptions;
}

function ensureDisplayTranscriptCache(context: SessionContext) {
  const entries = (context.session.sessionManager.getBranch?.() ?? []) as SessionEntryLike[];
  if (isDisplayTranscriptCacheStale(context.displayTranscriptCache, entries)) {
    context.displayTranscriptCache = buildDisplayTranscriptCache(entries);
  }
  return context.displayTranscriptCache!;
}