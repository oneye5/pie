/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ThinkingLevel } from '../../../shared/protocol';

import { useMemo } from 'preact/hooks';

import { ToolbarChip, ToolbarIndicatorChip, ToolbarRunStatusChip, ToolbarSelectChip } from '../components/panel-chip';
import { ModelPicker } from '../components/model-picker';
import { orderModelsForPicker } from './model-list';
import type { TokenRateIndicatorState } from './use-token-rate';
import { ComposerSettingsMenu } from './settings-menu';

const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Max',
};

interface ComposerToolbarStatus {
  text: string;
  tone: string;
  title: string;
}

interface ComposerToolbarProps {
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  selectedModel: string;
  selectedLevel: ThinkingLevel;
  supportsReasoning: boolean;
  contextIndicator: { label: string | null; ariaLabel: string; severity: string | null } | null;
  contextBreakdownTitle: string | null;
  sessionTokenIndicator: { label: string; ariaLabel: string; tooltip: string };
  sessionCostIndicator: { label: string; ariaLabel: string; tooltip: string } | null;
  tokenRateIndicator: TokenRateIndicatorState;
  runStatus: ComposerToolbarStatus | null;
  onModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
}

export function ComposerToolbar({
  prefs,
  pruningSettings,
  pruningCatalog,
  pruningResult,
  onSetPrefs,
  onSetPruningSettings,
  availableExtensions,
  availableModels,
  selectedModel,
  selectedLevel,
  supportsReasoning,
  contextIndicator,
  contextBreakdownTitle,
  sessionTokenIndicator,
  sessionCostIndicator,
  tokenRateIndicator,
  runStatus,
  onModelChange,
}: ComposerToolbarProps) {
  const filteredModels = useMemo(
    () => availableModels.filter(
      (m) => prefs.providerToggles[m.provider] !== false || m.id === selectedModel,
    ),
    [availableModels, prefs.providerToggles, selectedModel],
  );
  const modelEntries = useMemo(() => orderModelsForPicker(filteredModels), [filteredModels]);
  const selectedModelEntry = modelEntries.find((entry) => entry.model.id === selectedModel) ?? null;
  const fallbackModelLabel = modelEntries[0]?.selectedLabel ?? '';
  const selectedModelLabel = selectedModelEntry?.selectedLabel ?? (selectedModel || fallbackModelLabel);
  return (
    <div class="flex w-full flex-nowrap items-center gap-1.5 [container-name:toolbar] [container-type:inline-size]">
      <div class="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5">
        <ComposerSettingsMenu prefs={prefs} pruningSettings={pruningSettings} pruningCatalog={pruningCatalog} pruningResult={pruningResult} availableExtensions={availableExtensions} availableModels={availableModels} onSetPrefs={onSetPrefs} onSetPruningSettings={onSetPruningSettings} />

        {filteredModels.length > 0 ? (
          <ModelPicker
            label={selectedModelLabel}
            value={selectedModel}
            ariaLabel="Model"
            title="Select model"
            entries={modelEntries}
            onChange={(modelId) => onModelChange(modelId, selectedLevel)}
          />
        ) : selectedModel ? (
          <ToolbarChip label={selectedModel} title={selectedModel} />
        ) : null}

        {supportsReasoning && (
          <ToolbarSelectChip
            value={selectedLevel}
            width="reasoning"
            onChange={(e) => {
              const target = e.target as HTMLSelectElement;
              onModelChange(selectedModel, target.value as ThinkingLevel);
            }}
            ariaLabel="Reasoning level"
            title="Reasoning level"
          >
            {(Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).map((level) => (
              <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>
            ))}
          </ToolbarSelectChip>
        )}
      </div>

      <div class="ml-auto flex min-w-0 shrink-0 flex-nowrap items-center justify-end gap-1.5">
        {tokenRateIndicator.label && (
          <ToolbarIndicatorChip
            kind="speed"
            state={tokenRateIndicator.paused ? 'paused' : null}
            ariaLabel={tokenRateIndicator.ariaLabel}
            title={tokenRateIndicator.tooltip}
            label={tokenRateIndicator.label}
          />
        )}

        <ToolbarIndicatorChip
          kind="tokens"
          ariaLabel={sessionTokenIndicator.ariaLabel}
          title={sessionTokenIndicator.tooltip}
          label={sessionTokenIndicator.label}
        />

        {sessionCostIndicator && (
          <ToolbarIndicatorChip
            kind="cost"
            ariaLabel={sessionCostIndicator.ariaLabel}
            title={sessionCostIndicator.tooltip}
            label={sessionCostIndicator.label}
          />
        )}

        {contextIndicator?.label && contextBreakdownTitle && (
          <ToolbarIndicatorChip
            kind="context"
            severity={contextIndicator.severity}
            ariaLabel={contextIndicator.ariaLabel}
            title={contextBreakdownTitle}
            label={contextIndicator.label}
          />
        )}

        {runStatus && (
          <div class="ml-auto mr-0 inline-flex shrink-0 items-center gap-1.5">
            <ToolbarRunStatusChip
              tone={runStatus.tone}
              title={runStatus.title}
              label={runStatus.text}
            />
          </div>
        )}
      </div>
    </div>
  );
}
