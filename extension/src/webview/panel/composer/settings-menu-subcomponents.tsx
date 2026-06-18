/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useState } from 'preact/hooks';

import { playCompletionSound, warmupCompletionSoundContext } from '../completion-sound';

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningSettings, PruningMode, ThinkingLevel } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS, setExtensionEnabled, setProviderEnabled, toggleChatPref } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';
import { ModelPicker } from '../components/model-picker';
import { DisclosureChevron } from '../components/chevron';
import { EXTENSIONS_WITH_SETTINGS, PRUNING_MODE_OPTIONS, THINKING_LEVEL_OPTIONS, filterKeepCatalog } from './settings-menu-helpers';

type OnSetPrefs = (prefs: Partial<ChatPrefs>) => void;
type OnSetPruningSettings = (settings: Partial<PruningSettings>) => void;

type ChatPrefItemDef = (typeof CHAT_PREF_MENU_SECTIONS)[number]['items'][number];

function ChatPrefItem({ item, prefs, onSetPrefs }: { item: ChatPrefItemDef; prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  const checked = prefs[item.key];
  return (
    <button
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
}

function ChatPrefSections({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  return (
    <>
      {CHAT_PREF_MENU_SECTIONS.map((section) => (
        <div key={section.id} class="toolbar-settings-section">
          {section.label && <div class="toolbar-settings-section-label">{section.label}</div>}
          <div class="toolbar-settings-list">
            {section.items.map((item) => (
              <ChatPrefItem key={item.key} item={item} prefs={prefs} onSetPrefs={onSetPrefs} />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function SoundSection({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  return (
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
              onInput={(e) => onSetPrefs({ completionSoundVolume: Number((e.target as HTMLInputElement).value) })}
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
  );
}

interface SkillPrunerSettingsProps {
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPrefs: OnSetPrefs;
  onSetPruningSettings: OnSetPruningSettings;
}

function SkillPrunerSettings({ prefs, pruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPrefs, onSetPruningSettings }: SkillPrunerSettingsProps) {
  const modelLabel =
    modelEntries.find((e) => e.model.id === pruningSettings.model)?.selectedLabel
    || pruningSettings.model
    || 'Select model…';

  return (
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
        <ModelPicker
          compact
          dropdownDirection="down"
          value={pruningSettings.model}
          label={modelLabel}
          ariaLabel="Pruning prepass model"
          title="Select prepass model"
          entries={modelEntries}
          onChange={(modelId) => {
            const selected = availableModels.find((m) => m.id === modelId);
            if (selected) {
              onSetPruningSettings({ model: selected.id, provider: selected.provider });
            }
          }}
        />
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
  );
}

function SubagentSettings({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  return (
    <div class="toolbar-settings-ext-settings">
      <button
        class={`toolbar-settings-item${prefs.subagentAlwaysParentModel ? ' checked' : ''}`}
        type="button"
        role="menuitemcheckbox"
        aria-checked={prefs.subagentAlwaysParentModel}
        onClick={() => onSetPrefs(toggleChatPref(prefs, 'subagentAlwaysParentModel'))}
      >
        <span class="toolbar-settings-item-check" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={prefs.subagentAlwaysParentModel ? '' : 'opacity:0'}>
            <polyline points="2.5,6.5 5,9 10.5,3.5" />
          </svg>
        </span>
        <span class="toolbar-settings-item-label">Always use parent model</span>
      </button>
    </div>
  );
}

interface ExtensionItemProps {
  ext: ExtensionInfo;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  isExpanded: boolean;
  setExpandedExt: (next: string | null) => void;
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPruningSettings: OnSetPruningSettings;
}

function ExtensionItem({ ext, prefs, onSetPrefs, isExpanded, setExpandedExt, pruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPruningSettings }: ExtensionItemProps) {
  const checked = prefs.extensionToggles[ext.id] !== false;
  const hasSettings = EXTENSIONS_WITH_SETTINGS.has(ext.id);
  return (
    <div class="toolbar-settings-ext-group">
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
            <DisclosureChevron open={isExpanded} size={12} />
          </button>
        )}
      </div>
      {hasSettings && isExpanded && ext.id === 'skill-pruner' && (
        <SkillPrunerSettings
          prefs={prefs}
          pruningSettings={pruningSettings}
          modelEntries={modelEntries}
          availableModels={availableModels}
          skillCatalog={skillCatalog}
          toolCatalog={toolCatalog}
          onSetPrefs={onSetPrefs}
          onSetPruningSettings={onSetPruningSettings}
        />
      )}
      {hasSettings && isExpanded && ext.id === 'subagent' && (
        <SubagentSettings prefs={prefs} onSetPrefs={onSetPrefs} />
      )}
    </div>
  );
}

interface ExtensionsSectionProps {
  availableExtensions: ExtensionInfo[];
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  expandedExt: string | null;
  setExpandedExt: (next: string | null) => void;
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPruningSettings: OnSetPruningSettings;
}

function ExtensionsSection({ availableExtensions, prefs, onSetPrefs, expandedExt, setExpandedExt, pruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPruningSettings }: ExtensionsSectionProps) {
  return (
    <div key="extensions" class="toolbar-settings-section">
      <div class="toolbar-settings-section-label">Extensions</div>
      <div class="toolbar-settings-list">
        {availableExtensions.map((ext) => (
          <ExtensionItem
            key={ext.id}
            ext={ext}
            prefs={prefs}
            onSetPrefs={onSetPrefs}
            isExpanded={expandedExt === ext.id}
            setExpandedExt={setExpandedExt}
            pruningSettings={pruningSettings}
            modelEntries={modelEntries}
            availableModels={availableModels}
            skillCatalog={skillCatalog}
            toolCatalog={toolCatalog}
            onSetPruningSettings={onSetPruningSettings}
          />
        ))}
      </div>
    </div>
  );
}

interface ProviderItemProps {
  provider: string;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
}

function ProviderItem({ provider, prefs, onSetPrefs }: ProviderItemProps) {
  const checked = prefs.providerToggles[provider] !== false;
  return (
    <button
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
}

interface ProvidersSectionProps {
  providers: string[];
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
}

function ProvidersSection({ providers, prefs, onSetPrefs }: ProvidersSectionProps) {
  return (
    <div key="providers" class="toolbar-settings-section">
      <div class="toolbar-settings-section-label">Providers</div>
      <div class="toolbar-settings-list">
        {providers.map((provider) => (
          <ProviderItem key={provider} provider={provider} prefs={prefs} onSetPrefs={onSetPrefs} />
        ))}
      </div>
    </div>
  );
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

  // Optimistic names just added but not yet reflected in the host-persisted
  // `selected` prop. `selected` only updates after a host round-trip, so
  // without this gate the user can re-select an item (the <select> resets to
  // "" while availableOptions still lists it) before the host state arrives,
  // firing a duplicate setPruningSettings.
  const [pending, setPending] = useState<string[]>([]);

  // Release optimistic entries once the host-persisted `selected` catches up.
  useEffect(() => {
    if (pending.length === 0) return;
    const remaining = pending.filter((name) => !selected.includes(name));
    if (remaining.length !== pending.length) {
      setPending(remaining);
    }
  }, [selected, pending]);

  const addName = (rawName: string) => {
    const name = rawName.trim();
    if (!name) return;
    if (selected.includes(name) || pending.includes(name)) return;
    setPending((current) => [...current, name]);
    onChange([...selected, name]);
    // Safety net: if the host round-trip never arrives, release the lock so
    // the item becomes selectable again.
    window.setTimeout(() => {
      setPending((current) => current.filter((entry) => entry !== name));
    }, 2000);
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

export {
  ChatPrefSections,
  SoundSection,
  ExtensionsSection,
  ProvidersSection,
};
