import type {
  ModelInfo,
  ModelSettings,
  ThinkingLevel,
} from '../../shared/protocol';

export interface ComposerModelState {
  selectedModel: string;
  selectedLevel: ThinkingLevel;
  selectedModelInfo?: ModelInfo;
  supportsReasoning: boolean;
}

interface ResolveComposerModelStateOptions {
  activeModelId?: string;
  activeThinkingLevel?: ThinkingLevel;
  modelSettings: ModelSettings | null;
  availableModels: ModelInfo[];
}

export function resolveComposerModelState({
  activeModelId,
  activeThinkingLevel,
  modelSettings,
  availableModels,
}: ResolveComposerModelStateOptions): ComposerModelState {
  const selectedModel = activeModelId?.trim() || modelSettings?.defaultModel || '';
  const selectedLevel = activeThinkingLevel ?? modelSettings?.defaultThinkingLevel ?? 'medium';
  const selectedModelInfo = availableModels.find((model) => model.id === selectedModel);

  return {
    selectedModel,
    selectedLevel,
    selectedModelInfo,
    supportsReasoning: selectedModelInfo?.reasoning ?? false,
  };
}
