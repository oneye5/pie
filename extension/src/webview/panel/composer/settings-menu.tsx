/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { playCompletionSound, warmupCompletionSoundContext } from '../completion-sound';

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningMode, PruningResult, PruningSettings, ThinkingLevel } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS, setExtensionEnabled, setProviderEnabled, toggleChatPref } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';

/** Extension IDs that have nested settings panels */
const EXTENSIONS_WITH_SETTINGS = new Set(['skill-pruner']);

const PRUNING_MODE_OPTIONS: { value: PruningMode; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'off', label: 'Off' },
];

const THINKING_LEVEL_OPTIONS: { value: ThinkingLevel; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

interface ComposerSettingsMenuProps {
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
}

/** Compute a sorted, deduplicated catalog for the always-keep picker. */
export function computeKeepCatalog(
  discoveredNames: string[],
  fromPruningResult: { included?: string[]; excluded?: string[] } | null,
  currentlySelected: string[],
): string[] {
  const set = new Set<string>();
  for (const name of discoveredNames) set.add(name);
  for (const name of fromPruningResult?.included ?? []) set.add(name);
  for (const name of fromPruningResult?.excluded ?? []) set.add(name);
  // Always-keep items are filtered OUT of the prepass input, so they will not
  // appear in included/excluded after the next pruning turn. Union them in so
  // they remain visible/removable in the picker.
  for (const name of currentlySelected) set.add(name);
  return [...set].sort((a, b) => a.localeCompare(b));
}

/** Filter catalog by hiding already-selected names. */
export function filterKeepCatalog(catalog: string[], selected: string[]): string[] {
  const selectedSet = new Set(selected);
  return catalog.filter((name) => !selectedSet.has(name));
}

interface AlwaysKeepPickerProps {
  label: string;
  selected: string[];
  catalog: string[];
  category: 'skill' | 'tool';
  onChange: (next: string[]) => void;
}

export function AlwaysKeepPicker({ label, selected, catalog, category, onChange }: AlwaysKeepPickerProps) {
  const availableOptions = useMemo(() => filterKeepCatalog(catalog, selected), [catalog, selected]);

  const addName = (rawName: string) => {
    const name = rawName.trim();
    if (!name || selected.includes(name)) return;
    onChange([...selected, name]);
  };

  const removeName = (name: string) => {
    onChange(selected.filter((n) => n !== name));
  };

  return (
    <div class="toolbar-settings-keep-picker">
      <div class="toolbar-settings-keep-picker-label">{label}</div>
      {selected.length > 0 && (
        <div class="toolbar-settings-keep-chips">
          {selected.map((name) => (
            <span key={name} class="toolbar-settings-keep-chip">
              <span>{name}</span>
              <button
                type="button"
                class="toolbar-settings-keep-chip-remove"
                aria-label={`Remove ${name}`}
                onClick={() => removeName(name)}
              >×</button>
            </span>
          ))}
        </div>
      )}
      <div class="toolbar-settings-keep-picker-wrap">
        <select
          class="toolbar-settings-select toolbar-settings-keep-select"
          value=""
          aria-label={label}
          disabled={availableOptions.length === 0}
          onChange={(e) => {
            const name = (e.target as HTMLSelectElement).value;
            if (name) {
              addName(name);
              (e.target as HTMLSelectElement).value = '';
            }
          }}
        >
          <option value="">
            {availableOptions.length === 0
              ? `No ${category}s available`
              : `Select ${category} to omit from pruning...`}
          </option>
          {availableOptions.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

export function ComposerSettingsMenu({ prefs, pruningSettings, pruningCatalog, pruningResult, availableExtensions, availableModels, onSetPrefs, onSetPruningSettings }: ComposerSettingsMenuProps) {
  const skillCatalog = useMemo(
    () => computeKeepCatalog(
      pruningCatalog.skills,
      pruningResult ? { included: pruningResult.includedSkills, excluded: pruningResult.excludedSkills } : null,
      pruningSettings.skillAlwaysKeep,
    ),
    [pruningCatalog.skills, pruningResult, pruningSettings.skillAlwaysKeep],
  );
  const toolCatalog = useMemo(
    () => computeKeepCatalog(
      pruningCatalog.tools,
      pruningResult ? { included: pruningResult.includedTools, excluded: pruningResult.excludedTools } : null,
      pruningSettings.toolAlwaysKeep,
    ),
    [pruningCatalog.tools, pruningResult, pruningSettings.toolAlwaysKeep],
  );
  const [open, setOpen] = useState(false);
  const [expandedExt, setExpandedExt] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  // Extract unique providers from available models, sorted alphabetically
  const providers = [...new Set(availableModels.map((m) => m.provider))].sort((a, b) =>
    a.localeCompare(b),
  );

  return (
    <div ref={menuRef} class="toolbar-settings">
      <button
        class={`toolbar-settings-trigger${open ? ' open' : ''}`}
        type="button"
        aria-label="Chat settings"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Chat settings"
        onClick={() => setOpen((current) => !current)}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 .99-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51.99H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      {open && (
        <div class="toolbar-settings-menu" role="menu" aria-label="Chat settings menu">
          {CHAT_PREF_MENU_SECTIONS.map((section) => (
            <div key={section.id} class="toolbar-settings-section">
              {section.label && <div class="toolbar-settings-section-label">{section.label}</div>}
              <div class="toolbar-settings-list">
                {section.items.map((item) => {
                  const checked = prefs[item.key];
                  return (
                    <button
                      key={item.key}
                      class={`toolbar-settings-item${checked ? ' checked' : ''}`}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      onClick={() => onSetPrefs(toggleChatPref(prefs, item.key))}
                    >
                      <span class="toolbar-settings-item-check" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
                          <polyline points="2.5,6.5 5,9 10.5,3.5" />
                        </svg>
                      </span>
                      <span class="toolbar-settings-item-label">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div key="sound" class="toolbar-settings-section">
            <div class="toolbar-settings-section-label">Completion Sound</div>
            <div class="toolbar-settings-list">
              <div class="toolbar-settings-item toolbar-settings-mode-row">
                <span class="toolbar-settings-item-label">
                  {prefs.completionSoundVolume === 0 ? 'Off' : `${prefs.completionSoundVolume}%`}
                </span>
                <div class="toolbar-settings-sound-controls">
                  <input
                    type="range"
                    class="toolbar-settings-slider"
                    min="0"
                    max="100"
                    step="5"
                    value={prefs.completionSoundVolume}
                    onChange={(e) => onSetPrefs({ completionSoundVolume: Number((e.target as HTMLInputElement).value) })}
                    aria-label="Completion sound volume"
                  />
                  <button
                    type="button"
                    class="toolbar-settings-test-btn"
                    disabled={prefs.completionSoundVolume === 0}
                    onClick={() => { warmupCompletionSoundContext(); playCompletionSound(prefs.completionSoundVolume); }}
                    aria-label="Test completion sound"
                  >▶</button>
                </div>
              </div>
            </div>
          </div>
          {availableExtensions.length > 0 && (
            <div key="extensions" class="toolbar-settings-section">
              <div class="toolbar-settings-section-label">Extensions</div>
              <div class="toolbar-settings-list">
                {availableExtensions.map((ext) => {
                  // If the extension ID is not in the toggles map, it's enabled by default.
                  const checked = prefs.extensionToggles[ext.id] !== false;
                  const hasSettings = EXTENSIONS_WITH_SETTINGS.has(ext.id);
                  const isExpanded = expandedExt === ext.id;
                  return (
                    <div key={ext.id} class="toolbar-settings-ext-group">
                      <div class="toolbar-settings-ext-row">
                        <button
                          class={`toolbar-settings-item${checked ? ' checked' : ''}`}
                          type="button"
                          role="menuitemcheckbox"
                          aria-checked={checked}
                          title={ext.description}
                          onClick={() => onSetPrefs(setExtensionEnabled(prefs, ext.id, !checked))}
                        >
                          <span class="toolbar-settings-item-check" aria-hidden="true">
                            <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
                              <polyline points="2.5,6.5 5,9 10.5,3.5" />
                            </svg>
                          </span>
                          <span class="toolbar-settings-item-label">{ext.label}</span>
                        </button>
                        {hasSettings && (
                          <button
                            class={`toolbar-settings-ext-chevron${isExpanded ? ' expanded' : ''}`}
                            type="button"
                            aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${ext.label} settings`}
                            aria-expanded={isExpanded}
                            onClick={() => setExpandedExt(isExpanded ? null : ext.id)}
                          >
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                              <polyline points="4,2 8,6 4,10" />
                            </svg>
                          </button>
                        )}
                      </div>
                      {hasSettings && isExpanded && ext.id === 'skill-pruner' && (
                        <div class="toolbar-settings-ext-settings">
                          <button
                            class={`toolbar-settings-item${prefs.showPruningMessages ? ' checked' : ''}`}
                            type="button"
                            role="menuitemcheckbox"
                            aria-checked={prefs.showPruningMessages}
                            onClick={() => onSetPrefs(toggleChatPref(prefs, 'showPruningMessages'))}
                          >
                            <span class="toolbar-settings-item-check" aria-hidden="true">
                              <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={prefs.showPruningMessages ? '' : 'opacity:0'}>
                                <polyline points="2.5,6.5 5,9 10.5,3.5" />
                              </svg>
                            </span>
                            <span class="toolbar-settings-item-label">Show pruning summary</span>
                          </button>
                          <div class="toolbar-settings-item toolbar-settings-mode-row">
                            <span class="toolbar-settings-item-label">Mode</span>
                            <select
                              class="toolbar-settings-select"
                              value={pruningSettings.mode}
                              onChange={(e) => onSetPruningSettings({ mode: (e.target as HTMLSelectElement).value as PruningMode })}
                              aria-label="Pruning mode"
                            >
                              {PRUNING_MODE_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                          <div class="toolbar-settings-item toolbar-settings-mode-row">
                            <span class="toolbar-settings-item-label">Prepass model</span>
                            <select
                              class="toolbar-settings-select"
                              value={pruningSettings.model}
                              onChange={(e) => {
                                const selected = availableModels.find((m) => m.id === (e.target as HTMLSelectElement).value);
                                if (selected) {
                                  onSetPruningSettings({ model: selected.id, provider: selected.provider });
                                }
                              }}
                              aria-label="Pruning prepass model"
                            >
                              {!availableModels.some((m) => m.id === pruningSettings.model) && pruningSettings.model && (
                                <option key={pruningSettings.model} value={pruningSettings.model}>
                                  {pruningSettings.model} (unavailable)
                                </option>
                              )}
                              {orderModelsForPicker(availableModels).map((entry) => (
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
                          </div>
                          <div class="toolbar-settings-item toolbar-settings-mode-row">
                            <span class="toolbar-settings-item-label">Thinking</span>
                            <select
                              class="toolbar-settings-select"
                              value={pruningSettings.thinkingLevel}
                              onChange={(e) => onSetPruningSettings({ thinkingLevel: (e.target as HTMLSelectElement).value as ThinkingLevel })}
                              aria-label="Pruning thinking level"
                            >
                              {THINKING_LEVEL_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </div>
                          <div class="toolbar-settings-item toolbar-settings-stepper-row">
                            <span class="toolbar-settings-item-label">Skill limit</span>
                            <div class="toolbar-settings-stepper">
                              <button
                                type="button"
                                class="toolbar-settings-stepper-btn"
                                aria-label="Decrease skill limit"
                                disabled={pruningSettings.skillCeiling <= 1}
                                onClick={() => onSetPruningSettings({ skillCeiling: Math.max(1, pruningSettings.skillCeiling - 1) })}
                              >−</button>
                              <span class="toolbar-settings-stepper-value">{pruningSettings.skillCeiling}</span>
                              <button
                                type="button"
                                class="toolbar-settings-stepper-btn"
                                aria-label="Increase skill limit"
                                onClick={() => onSetPruningSettings({ skillCeiling: pruningSettings.skillCeiling + 1 })}
                              >+</button>
                            </div>
                          </div>
                          <div class="toolbar-settings-item toolbar-settings-stepper-row">
                            <span class="toolbar-settings-item-label">Tool limit</span>
                            <div class="toolbar-settings-stepper">
                              <button
                                type="button"
                                class="toolbar-settings-stepper-btn"
                                aria-label="Decrease tool limit"
                                disabled={pruningSettings.toolCeiling <= 1}
                                onClick={() => onSetPruningSettings({ toolCeiling: Math.max(1, pruningSettings.toolCeiling - 1) })}
                              >−</button>
                              <span class="toolbar-settings-stepper-value">{pruningSettings.toolCeiling}</span>
                              <button
                                type="button"
                                class="toolbar-settings-stepper-btn"
                                aria-label="Increase tool limit"
                                onClick={() => onSetPruningSettings({ toolCeiling: pruningSettings.toolCeiling + 1 })}
                              >+</button>
                            </div>
                          </div>
                          <AlwaysKeepPicker
                            label="Omitted skills (never pruned)"
                            selected={pruningSettings.skillAlwaysKeep}
                            catalog={skillCatalog}
                            category="skill"
                            onChange={(next) => onSetPruningSettings({ skillAlwaysKeep: next })}
                          />
                          <AlwaysKeepPicker
                            label="Omitted tools (never pruned)"
                            selected={pruningSettings.toolAlwaysKeep}
                            catalog={toolCatalog}
                            category="tool"
                            onChange={(next) => onSetPruningSettings({ toolAlwaysKeep: next })}
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {providers.length > 0 && (
            <div key="providers" class="toolbar-settings-section">
              <div class="toolbar-settings-section-label">Providers</div>
              <div class="toolbar-settings-list">
                {providers.map((provider) => {
                  const checked = prefs.providerToggles[provider] !== false;
                  return (
                    <button
                      key={provider}
                      class={`toolbar-settings-item${checked ? ' checked' : ''}`}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      onClick={() => onSetPrefs(setProviderEnabled(prefs, provider, !checked))}
                    >
                      <span class="toolbar-settings-item-check" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
                          <polyline points="2.5,6.5 5,9 10.5,3.5" />
                        </svg>
                      </span>
                      <span class="toolbar-settings-item-label">{provider}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}