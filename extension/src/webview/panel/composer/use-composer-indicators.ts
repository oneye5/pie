import { useMemo } from 'preact/hooks';

import type {
  ActiveRunSummary,
  ChatMessage,
  ContextWindowUsage,
  ModelInfo,
  ModelSettings,
  PruningDetails,
  PruningResult,
  SystemPromptEntry,
  ThinkingLevel,
  TranscriptWindow,
} from '../../../shared/protocol';
import { buildContextWindowBreakdown } from '../context-window/breakdown';
import { buildContextWindowIndicatorState } from '../context-window/indicator';
import {
  buildLiveSessionCostEstimate,
  buildSessionCostIndicator,
  buildSessionTokenIndicator,
  buildSessionTokenUsage,
  type TokenPricing,
} from '../session-tabs/token-usage';
import { resolveComposerModelState } from './model-state';
import { useTokenRateIndicator } from './use-token-rate';
import { useTurnLatencyIndicator } from './use-turn-latency';

export function useComposerIndicators({
  activeModelId,
  activeThinkingLevel,
  modelSettings,
  availableModels,
  contextUsage,
  systemPrompts,
  transcript,
  transcriptWindow,
  pruningResult,
  busy,
  sessionPath,
  activeRunSummary,
}: {
  activeModelId?: string;
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
  contextUsage: ContextWindowUsage | null;
  systemPrompts: SystemPromptEntry[];
  transcript: ChatMessage[];
  transcriptWindow: TranscriptWindow;
  pruningResult: PruningResult | null;
  busy: boolean;
  sessionPath: string | null;
  activeRunSummary?: ActiveRunSummary | null;
}) {
  const {
    selectedModel,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
  } = useMemo(() => resolveComposerModelState({
    activeModelId,
    activeThinkingLevel,
    modelSettings,
    availableModels,
  }), [activeModelId, activeThinkingLevel, modelSettings?.defaultModel, modelSettings?.defaultThinkingLevel, availableModels]);

  const pricingByModelId = useMemo(() => {
    const map = new Map<string, TokenPricing>();
    for (const model of availableModels) {
      const pricing = model.subagent?.pricing;
      if (pricing) map.set(model.id, pricing);
    }
    return map;
  }, [availableModels]);

  const supportsImageInputs = selectedModelInfo?.inputKinds.includes('image') ?? false;

  const effectiveContextWindow = contextUsage?.contextWindow ?? selectedModelInfo?.contextWindow ?? 0;
  const contextBreakdown = useMemo(() => (
    effectiveContextWindow <= 0
      ? null
      : buildContextWindowBreakdown({
          contextUsage,
          effectiveContextWindow,
          systemPrompts,
          transcript,
          isPartial: transcriptWindow.isPartial,
        })
  ), [contextUsage, effectiveContextWindow, systemPrompts, transcript, transcriptWindow.isPartial]);
  const contextIndicator = useMemo(() => (
    contextBreakdown
      ? buildContextWindowIndicatorState(contextBreakdown.summary)
      : null
  ), [contextBreakdown]);
  const sessionTokenUsage = useMemo(() => buildSessionTokenUsage(transcript), [transcript]);
  const sessionTokenIndicator = useMemo(
    () => buildSessionTokenIndicator(sessionTokenUsage),
    [sessionTokenUsage],
  );
  const liveCostEstimate = useMemo(
    () => buildLiveSessionCostEstimate(transcript, contextUsage, busy),
    [transcript, contextUsage, busy],
  );
  const sessionCostIndicator = useMemo(
    () => buildSessionCostIndicator(
      sessionTokenUsage,
      selectedModelInfo?.subagent?.pricing,
      selectedModelInfo?.name,
      transcript,
      (pruningResult?.details as PruningDetails | undefined),
      (modelId) => pricingByModelId.get(modelId),
      liveCostEstimate,
    ),
    [sessionTokenUsage, selectedModelInfo, transcript, pruningResult, pricingByModelId, liveCostEstimate],
  );

  const tokenRateIndicator = useTokenRateIndicator({ transcript, busy, sessionPath, activeRunSummary });
  const turnLatencyIndicator = useTurnLatencyIndicator({ transcript });

  return {
    selectedModel,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning,
    supportsImageInputs,
    contextBreakdown,
    contextIndicator,
    sessionTokenIndicator,
    sessionCostIndicator,
    tokenRateIndicator,
    turnLatencyIndicator,
  };
}
