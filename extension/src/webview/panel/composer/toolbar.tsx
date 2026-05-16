/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, ThinkingLevel } from '../../../shared/protocol';

import { orderModelsForPicker } from './model-list';
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
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  selectedModel: string;
  selectedLevel: ThinkingLevel;
  supportsReasoning: boolean;
  contextIndicator: { label: string | null; ariaLabel: string; severity: string | null } | null;
  contextBreakdownTitle: string | null;
  sessionTokenIndicator: { label: string; rateLabel: string; ariaLabel: string; tooltip: string };
  runStatus: ComposerToolbarStatus | null;
  onModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
}

export function ComposerToolbar({
  prefs,
  onSetPrefs,
  availableExtensions,
  availableModels,
  selectedModel,
  selectedLevel,
  supportsReasoning,
  contextIndicator,
  contextBreakdownTitle,
  sessionTokenIndicator,
  runStatus,
  onModelChange,
}: ComposerToolbarProps) {
  const contextIndicatorClass = contextIndicator?.severity ? ` ${contextIndicator.severity}` : '';
  const filteredModels = availableModels.filter(
    (m) => prefs.providerToggles[m.provider] !== false || m.id === selectedModel,
  );
  const modelEntries = orderModelsForPicker(filteredModels);
  const selectedModelEntry = modelEntries.find((entry) => entry.model.id === selectedModel) ?? null;
  const fallbackModelLabel = modelEntries[0]?.selectedLabel ?? '';
  const selectedModelLabel = selectedModelEntry?.selectedLabel ?? (selectedModel || fallbackModelLabel);

  return (
    <div class="composer-toolbar">
      <div class="composer-toolbar-left">
        <ComposerSettingsMenu prefs={prefs} availableExtensions={availableExtensions} availableModels={availableModels} onSetPrefs={onSetPrefs} />

        {filteredModels.length > 0 ? (
          <div class="model-picker-shell">
            <span class="model-picker-sizer" aria-hidden="true">{selectedModelLabel}</span>
            <select
              class="model-select model-select-picker"
              value={selectedModel}
              onChange={(e) => {
                const target = e.target as HTMLSelectElement;
                onModelChange(target.value, selectedLevel);
              }}
              aria-label="Model"
              title="Select model"
            >
              {modelEntries.map((entry) => (
                <option
                  key={entry.model.id}
                  value={entry.model.id}
                  class={entry.ineligible ? 'model-option-ineligible' : undefined}
                  title={entry.title}
                >
                  {entry.label}
                </option>
              ))}
            </select>
            <span class="model-picker-value" aria-hidden="true">{selectedModelLabel}</span>
          </div>
        ) : selectedModel ? (
          <span class="model-select-static" title={selectedModel}>{selectedModel}</span>
        ) : null}

        {supportsReasoning && (
          <select
            class="model-select model-select-sm"
            value={selectedLevel}
            onChange={(e) => {
              const target = e.target as HTMLSelectElement;
              onModelChange(selectedModel, target.value as ThinkingLevel);
            }}
            aria-label="Reasoning level"
            title="Reasoning level"
          >
            {(Object.keys(THINKING_LEVEL_LABELS) as ThinkingLevel[]).map((level) => (
              <option key={level} value={level}>{THINKING_LEVEL_LABELS[level]}</option>
            ))}
          </select>
        )}
      </div>

      <div class="composer-toolbar-right">
        <span
          class="model-select-static session-token-rate"
          aria-label={`Output rate: ${sessionTokenIndicator.rateLabel}`}
          title="Output token rate"
        >
          {sessionTokenIndicator.rateLabel}
        </span>
        <span
          class="model-select-static session-token-indicator"
          aria-label={sessionTokenIndicator.ariaLabel}
          title={sessionTokenIndicator.tooltip}
        >
          {sessionTokenIndicator.label}
        </span>

        {contextIndicator?.label && contextBreakdownTitle && (
          <span
            class={`model-select-static context-window-indicator${contextIndicatorClass}`}
            aria-label={contextIndicator.ariaLabel}
            aria-description={contextBreakdownTitle}
            title={contextBreakdownTitle}
          >
            {contextIndicator.label}
          </span>
        )}

        {runStatus && (
          <div class="composer-run-controls">
            <span
              class={`composer-meta-chip ${runStatus.tone}`}
              title={runStatus.title}
            >
              {runStatus.text}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
