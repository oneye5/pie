/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { playCompletionSound, warmupCompletionSoundContext } from '../completion-sound';

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningSettings, PruningMode, ThinkingLevel } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS, setBucketModels, setExtensionEnabled, setProviderEnabled, toggleChatPref } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';
import { ModelPicker } from '../components/model-picker';
import { CollapsibleChevron } from '../components/chevron';
import { EXTENSIONS_WITH_SETTINGS, PRUNING_MODE_OPTIONS, THINKING_LEVEL_OPTIONS } from './settings-menu-helpers';
import { AlwaysKeepPicker } from '../components/always-keep-picker';
import { FlyoutPanel, UiSubmenuTrigger, UiFlyout, UiGroupLabel } from './ui-appearance-settings';

export type OnSetPrefs = (prefs: Partial<ChatPrefs>) => void;
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

type BucketKey = 'small' | 'medium' | 'frontier';

interface BucketDef {
  key: BucketKey;
  label: string;
  hint: string;
}

/** The three model buckets, in display order. Hints mirror the schema guidance
 *  the LLM sees for the `bucket` parameter. */
const BUCKET_DEFS: readonly BucketDef[] = [
  { key: 'small', label: 'Small', hint: 'Haiku-class busywork' },
  { key: 'medium', label: 'Medium', hint: 'Sonnet-class main development' },
  { key: 'frontier', label: 'Frontier', hint: 'Opus-class hardest problems' },
];

interface BucketModelsEditorProps {
  bucket: BucketKey;
  label: string;
  hint: string;
  selected: string[];
  availableModels: ModelInfo[];
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  onChange: (models: string[]) => void;
}

/**
 * Editor for a single bucket's model list. Selected models render as removable
 * chips (labelled with the model's display name); an "Add model…" select lists
 * every available model not already in the bucket. Reuses the AlwaysKeepPicker
 * styling (chips + select) for visual consistency, and its optimistic-pending
 * gate so a slow host round-trip can't double-add an item.
 *
 * A model id that is no longer in the registry (e.g. its provider was toggled
 * off) still renders as a chip labelled with the raw id, so the user can see and
 * remove stale entries — selection-time filtering in the subagent extension
 * drops unavailable models from the pool anyway.
 */
function BucketModelsEditor({ bucket, label, hint, selected, availableModels, modelEntries, onChange }: BucketModelsEditorProps) {
  const labelFor = (id: string): string => availableModels.find((m) => m.id === id)?.name ?? id;

  const availableOptions = useMemo(
    () => modelEntries.filter((entry) => !selected.includes(entry.model.id)),
    [modelEntries, selected],
  );

  // Optimistic names just added but not yet reflected in the host-persisted
  // `selected` prop (mirrors AlwaysKeepPicker). Without this gate the user can
  // re-select an item before the host state arrives, firing a duplicate update.
  const [pending, setPending] = useState<string[]>([]);
  useEffect(() => {
    if (pending.length === 0) return;
    const remaining = pending.filter((id) => !selected.includes(id));
    if (remaining.length !== pending.length) setPending(remaining);
  }, [selected, pending]);

  const addModel = (id: string) => {
    if (!id || selected.includes(id) || pending.includes(id)) return;
    setPending((cur) => [...cur, id]);
    onChange([...selected, id]);
    window.setTimeout(() => setPending((cur) => cur.filter((x) => x !== id)), 2000);
  };
  const removeModel = (id: string) => onChange(selected.filter((x) => x !== id));

  return (
    <div class="toolbar-settings-keep-picker">
      <div class="toolbar-settings-keep-picker-label">{label}</div>
      <div class="toolbar-settings-item-hint">{hint}</div>
      {selected.length > 0 && (
        <div class="toolbar-settings-keep-chips">
          {selected.map((id) => (
            <span key={id} class="toolbar-settings-keep-chip">
              <span>{labelFor(id)}</span>
              <button
                type="button"
                class="toolbar-settings-keep-chip-remove"
                aria-label={`Remove ${labelFor(id)} from ${label}`}
                onClick={() => removeModel(id)}
              >
                <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <line x1="3" y1="3" x2="10" y2="10" />
                  <line x1="10" y1="3" x2="3" y2="10" />
                </svg>
              </button>
            </span>
          ))}
        </div>
      )}
      <div class="toolbar-settings-keep-picker-wrap">
        <select
          class="toolbar-settings-select toolbar-settings-keep-select"
          value=""
          aria-label={`Add model to ${label} bucket`}
          disabled={availableOptions.length === 0}
          onChange={(e) => {
            const id = (e.target as HTMLSelectElement).value;
            if (id) {
              addModel(id);
              (e.target as HTMLSelectElement).value = '';
            }
          }}
        >
          <option value="">
            {availableOptions.length === 0 ? 'No models available' : 'Add model…'}
          </option>
          {availableOptions.map((entry) => (
            <option key={entry.model.id} value={entry.model.id}>{entry.label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

interface SubagentSettingsProps {
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  availableModels: ModelInfo[];
  modelEntries: ReturnType<typeof orderModelsForPicker>;
}

/**
 * Side-panel flyout for subagent settings (mirrors the UI flyout). Holds the
 * always-parent-model toggle, the user-configurable model buckets, and the
 * nesting limits — surfaced as a flyout rather than an inline expansion so the
 * bucket editors don't crowd the main settings menu.
 */
export function SubagentFlyout({ prefs, onSetPrefs, availableModels, modelEntries }: SubagentSettingsProps) {
  return (
    <FlyoutPanel title="Subagent" ariaLabel="Subagent settings">
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

      <UiGroupLabel label="Model buckets" />
      <div class="toolbar-settings-item-hint">
        Each bucket holds model ids you want eligible for that tier. When a subagent requests a bucket, one model is picked at random from its list. Empty buckets fall back to the parent's active model.
      </div>
      {BUCKET_DEFS.map((def) => (
        <BucketModelsEditor
          key={def.key}
          bucket={def.key}
          label={def.label}
          hint={def.hint}
          selected={prefs.subagentBuckets[def.key] ?? []}
          availableModels={availableModels}
          modelEntries={modelEntries}
          onChange={(models) => onSetPrefs(setBucketModels(prefs, def.key, models))}
        />
      ))}

      <UiGroupLabel label="Nesting" />
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Max depth</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentMaxDepth}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="1"
          max="8"
          step="1"
          value={prefs.subagentMaxDepth}
          onInput={(e) => onSetPrefs({ subagentMaxDepth: Number((e.target as HTMLInputElement).value) })}
          aria-label="Max subagent nesting depth"
        />
        <div class="toolbar-settings-item-hint">How deep subagents may delegate to further subagents (main → L1 → L2 → ...). Higher unlocks more nesting at higher cost.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Tree session budget</span>
          <span class="toolbar-settings-ui-control-value">{prefs.subagentMaxTreeSessions}</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="5"
          max="200"
          step="5"
          value={prefs.subagentMaxTreeSessions}
          onInput={(e) => onSetPrefs({ subagentMaxTreeSessions: Number((e.target as HTMLInputElement).value) })}
          aria-label="Max subagent sessions across the nested tree"
        />
        <div class="toolbar-settings-item-hint">Cap on total subagent sessions spawned across an entire nested tree, so increased nesting can't run away on cost.</div>
      </div>
    </FlyoutPanel>
  );
}

interface ExtensionItemProps {
  ext: ExtensionInfo;
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  isExpanded: boolean;
  setExpandedExt: (next: string | null) => void;
  /** Subagent settings open as a side flyout (not inline); this reflects and
   *  toggles that flyout's open state for the subagent extension row. */
  subagentOpen: boolean;
  onToggleSubagent: () => void;
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPruningSettings: OnSetPruningSettings;
}

function ExtensionItem({ ext, prefs, onSetPrefs, isExpanded, setExpandedExt, subagentOpen, onToggleSubagent, pruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPruningSettings }: ExtensionItemProps) {
  const checked = prefs.extensionToggles[ext.id] !== false;
  const hasSettings = EXTENSIONS_WITH_SETTINGS.has(ext.id);
  // The subagent settings live in a side flyout; other extensions expand inline.
  const expanded = ext.id === 'subagent' ? subagentOpen : isExpanded;
  const onChevronClick = ext.id === 'subagent' ? onToggleSubagent : () => setExpandedExt(isExpanded ? null : ext.id);
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
            class={`toolbar-settings-ext-chevron${expanded ? ' expanded' : ''}`}
            type="button"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${ext.label} settings`}
            aria-expanded={expanded}
            onClick={onChevronClick}
          >
            <CollapsibleChevron open={expanded} size={12} />
          </button>
        )}
      </div>
      {hasSettings && expanded && ext.id === 'skill-pruner' && (
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
    </div>
  );
}

interface ExtensionsSectionProps {
  availableExtensions: ExtensionInfo[];
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
  expandedExt: string | null;
  setExpandedExt: (next: string | null) => void;
  subagentOpen: boolean;
  onToggleSubagent: () => void;
  pruningSettings: PruningSettings;
  modelEntries: ReturnType<typeof orderModelsForPicker>;
  availableModels: ModelInfo[];
  skillCatalog: string[];
  toolCatalog: string[];
  onSetPruningSettings: OnSetPruningSettings;
}

function ExtensionsSection({ availableExtensions, prefs, onSetPrefs, expandedExt, setExpandedExt, subagentOpen, onToggleSubagent, pruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPruningSettings }: ExtensionsSectionProps) {
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
            subagentOpen={subagentOpen}
            onToggleSubagent={onToggleSubagent}
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


export {
  ChatPrefSections,
  UiSubmenuTrigger,
  UiFlyout,
  SoundSection,
  ExtensionsSection,
  ProvidersSection,
};
