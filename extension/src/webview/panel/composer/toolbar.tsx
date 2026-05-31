/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings, ThinkingLevel } from '../../../shared/protocol';

import { cx } from '../utils/cx';
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
  sessionTokenIndicator: { label: string; rateLabel: string; ariaLabel: string; tooltip: string };
  runStatus: ComposerToolbarStatus | null;
  onModelChange: (model: string, thinkingLevel: ThinkingLevel) => void;
}

const toolbarChipClass = 'inline-flex h-[22px] min-w-[80px] max-w-[180px] items-center overflow-hidden truncate whitespace-nowrap rounded-full border border-transparent bg-control px-2 py-0.5 text-[11px] text-foreground transition-colors duration-150 hover:border-border-subtle hover:bg-control-hover focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-2 forced-colors:border-[ButtonText]';
const selectChipClass = `${toolbarChipClass} cursor-pointer`;
const staticChipClass = `${toolbarChipClass} text-muted`;

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
  const runStatusClass = runStatus
    ? cx(
      'inline-flex h-[22px] items-center rounded-full border border-transparent bg-control px-2 text-[11px] leading-snug text-muted transition-colors duration-150 forced-colors:border-[ButtonText]',
      runStatus.tone === 'open' && 'border-success/30 bg-success/10 text-success',
      runStatus.tone === 'pending-score' && 'border-warning/30 bg-warning/10 text-warning',
    )
    : '';

  return (
    <div class="flex w-full flex-nowrap items-center gap-1.5 [container-name:toolbar] [container-type:inline-size]">
      <div class="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5">
        <ComposerSettingsMenu prefs={prefs} pruningSettings={pruningSettings} pruningCatalog={pruningCatalog} pruningResult={pruningResult} availableExtensions={availableExtensions} availableModels={availableModels} onSetPrefs={onSetPrefs} onSetPruningSettings={onSetPruningSettings} />

        {filteredModels.length > 0 ? (
          <div class="relative inline-flex min-h-[22px] min-w-[80px] max-w-[180px]">
            <span class="invisible min-w-0 max-w-full overflow-hidden truncate whitespace-nowrap rounded-full border border-transparent py-0.5 pl-2 pr-6 text-[11px]" aria-hidden="true">{selectedModelLabel}</span>
            <select
              class={cx(selectChipClass, 'absolute inset-0 w-full max-w-full appearance-none pr-6 text-transparent')}
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
            <span class="pointer-events-none absolute inset-0 inline-flex min-w-0 items-center overflow-hidden truncate whitespace-nowrap rounded-full py-0.5 pl-2 pr-6 text-[11px] text-foreground" aria-hidden="true">{selectedModelLabel}</span>
            <span class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-foreground/70" aria-hidden="true">▾</span>
          </div>
        ) : selectedModel ? (
          <span class={staticChipClass} title={selectedModel}>{selectedModel}</span>
        ) : null}

        {supportsReasoning && (
          <select
            class={cx(selectChipClass, 'min-w-[64px] max-w-[110px]')}
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

      <div class="ml-auto flex min-w-0 shrink-0 flex-nowrap items-center justify-end gap-1.5">
        <span
          class={cx(staticChipClass, 'session-token-rate justify-center font-normal tabular-nums text-foreground/75')}
          aria-label={`Output rate: ${sessionTokenIndicator.rateLabel}`}
          title="Output token rate"
        >
          {sessionTokenIndicator.rateLabel}
        </span>
        <span
          class={cx(staticChipClass, 'session-token-indicator justify-center font-normal tabular-nums text-foreground/75')}
          aria-label={sessionTokenIndicator.ariaLabel}
          title={sessionTokenIndicator.tooltip}
        >
          {sessionTokenIndicator.label}
        </span>

        {contextIndicator?.label && contextBreakdownTitle && (
          <span
            class={cx(staticChipClass, `context-window-indicator${contextIndicatorClass}`, 'justify-center font-normal tabular-nums text-foreground/90')}
            aria-label={contextIndicator.ariaLabel}
            aria-description={contextBreakdownTitle}
            title={contextBreakdownTitle}
          >
            {contextIndicator.label}
          </span>
        )}

        {runStatus && (
          <div class="ml-auto mr-0 inline-flex shrink-0 items-center gap-1.5">
            <span
              class={runStatusClass}
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
