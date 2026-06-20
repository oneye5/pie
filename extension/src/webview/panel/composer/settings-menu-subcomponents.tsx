/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { playCompletionSound, warmupCompletionSoundContext } from '../completion-sound';

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningSettings, PruningMode, ThinkingLevel, UiDensity } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS, setExtensionEnabled, setProviderEnabled, toggleChatPref } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';
import { ModelPicker } from '../components/model-picker';
import { CollapsibleChevron } from '../components/chevron';
import { EXTENSIONS_WITH_SETTINGS, PRUNING_MODE_OPTIONS, THINKING_LEVEL_OPTIONS, DENSITY_OPTIONS, UI_THEME_PRESETS, matchUiThemePreset, uiThemePresetToPrefs, filterKeepCatalog } from './settings-menu-helpers';

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

interface FontOption {
  label: string;
  /** CSS font-family stack. Empty string means "use the bundled default". */
  value: string;
}

/** Curated sans-serif (plus a few serif) stacks for the UI font picker. */
const SANS_FONT_OPTIONS: ReadonlyArray<FontOption> = [
  { label: 'Default', value: '' },
  { label: 'Inter', value: 'Inter, "Segoe UI", system-ui, sans-serif' },
  { label: 'System UI', value: 'system-ui, -apple-system, BlinkMacSystemFont, sans-serif' },
  { label: 'Segoe UI', value: '"Segoe UI", system-ui, sans-serif' },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", Helvetica, sans-serif' },
  { label: 'Georgia (serif)', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Times New Roman (serif)', value: '"Times New Roman", Times, serif' },
  { label: 'Garamond (serif)', value: 'Garamond, "Times New Roman", serif' },
];

/** Curated monospace stacks for the code/tool-output font picker. */
const MONO_FONT_OPTIONS: ReadonlyArray<FontOption> = [
  { label: 'Default', value: '' },
  { label: 'JetBrains Mono', value: '"JetBrains Mono", "Cascadia Code", Consolas, monospace' },
  { label: 'Cascadia Code', value: '"Cascadia Code", "JetBrains Mono", Consolas, monospace' },
  { label: 'Fira Code', value: '"Fira Code", "JetBrains Mono", Consolas, monospace' },
  { label: 'SF Mono', value: '"SF Mono", ui-monospace, Menlo, monospace' },
  { label: 'ui-monospace', value: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
  { label: 'Consolas', value: 'Consolas, "Courier New", monospace' },
  { label: 'Menlo', value: 'Menlo, Consolas, monospace' },
  { label: 'Monaco', value: 'Monaco, Menlo, monospace' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
];

interface FontSelectProps {
  value: string;
  options: ReadonlyArray<FontOption>;
  ariaLabel: string;
  onChange: (next: string) => void;
}

/**
 * Font-family dropdown (replaces the old free-text input). The closed control
 * and each option render in their own font as a live preview where the browser
 * supports per-option styling. A value that doesn't match any preset (e.g. left
 * over from the old text input) is surfaced as an explicit "Custom" option so
 * the select never silently snaps away from persisted state.
 */
function FontSelect({ value, options, ariaLabel, onChange }: FontSelectProps) {
  const hasMatch = options.some((opt) => opt.value === value);
  return (
    <select
      class="toolbar-settings-select toolbar-settings-ui-font-select"
      style={value ? { fontFamily: value } : undefined}
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange((e.target as HTMLSelectElement).value)}
    >
      {!hasMatch && value !== '' && (
        <option value={value} style={{ fontFamily: value }}>Custom</option>
      )}
      {options.map((opt) => (
        <option key={opt.label} value={opt.value} style={opt.value ? { fontFamily: opt.value } : undefined}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

interface UiSubmenuTriggerProps {
  open: boolean;
  onToggle: () => void;
}

/** The "UI ▸" row inside the settings menu that opens the UI flyout to the side. */
function UiSubmenuTrigger({ open, onToggle }: UiSubmenuTriggerProps) {
  return (
    <button
      class={`toolbar-settings-ui-trigger${open ? ' open' : ''}`}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label="UI settings"
      onClick={onToggle}
    >
      <span>UI</span>
      <svg class="toolbar-settings-ui-trigger-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>
  );
}

interface UiGroupLabelProps {
  label: string;
}

/** Small uppercase divider heading used to group related controls in the flyout
 *  now that it holds many settings. Styled like the flyout title. */
function UiGroupLabel({ label }: UiGroupLabelProps) {
  return <div class="toolbar-settings-ui-group-label">{label}</div>;
}

interface ColorRowProps {
  label: string;
  /** Current pref value; '' means "use bundled default". */
  value: string;
  /** Solid swatch shown when value is '' (the bundled default is often
   *  semi-transparent and <input type="color"> can't render alpha, so we show
   *  its solid RGB). */
  defaultValue: string;
  hint: string;
  ariaLabel: string;
  onChange: (next: string) => void;
}

/** Reusable color-picker + Reset row. The bundled default swatch is shown when
 *  no override is set so the control always displays a meaningful color; Reset
 *  clears the override so the stylesheet default wins. */
function ColorRow({ label, value, defaultValue, hint, ariaLabel, onChange }: ColorRowProps) {
  return (
    <div class="toolbar-settings-ui-control">
      <span class="toolbar-settings-ui-control-label">{label}</span>
      <div class="toolbar-settings-color-controls">
        <input
          type="color"
          class="toolbar-settings-color-input"
          value={value || defaultValue}
          onInput={(e) => onChange((e.target as HTMLInputElement).value)}
          aria-label={ariaLabel}
        />
        <button
          type="button"
          class="toolbar-settings-color-reset"
          disabled={!value}
          onClick={() => onChange('')}
          aria-label={`Reset ${ariaLabel}`}
        >Reset</button>
      </div>
      <div class="toolbar-settings-item-hint">{hint}</div>
    </div>
  );
}

/** Theme preset picker. Shows the active preset when the four color prefs
 *  exactly match one, else "Custom". Selecting a preset writes all four color
 *  prefs as a batch; the user can then tweak individually (which flips back to
 *  Custom). */
function ThemeSelect({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
  const active = matchUiThemePreset(prefs);
  return (
    <div class="toolbar-settings-ui-control">
      <span class="toolbar-settings-ui-control-label">Theme</span>
      <select
        class="toolbar-settings-select toolbar-settings-ui-font-select"
        value={active}
        aria-label="Color theme"
        onChange={(e) => {
          const id = (e.target as HTMLSelectElement).value;
          const preset = UI_THEME_PRESETS.find((p) => p.id === id);
          if (preset) onSetPrefs(uiThemePresetToPrefs(preset));
        }}
      >
        {!active && <option value="">Custom</option>}
        {UI_THEME_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>{p.label}</option>
        ))}
      </select>
      <div class="toolbar-settings-item-hint">Apply a coordinated palette. Tweak any color below to make it custom.</div>
    </div>
  );
}

interface UiFlyoutProps {
  prefs: ChatPrefs;
  onSetPrefs: OnSetPrefs;
}

/**
 * Side panel of UI appearance controls. Renders as a flyout to the right of the
 * settings menu (a child of `.toolbar-settings-menu`, positioned past its right
 * edge) so opening it never grows the menu upward and off-screen. A mount-time
 * effect clamps its height to the viewport and shrinks it to fit the space
 * beside the menu, so it never grows the menu upward or runs off-screen.
 */
function UiFlyout({ prefs, onSetPrefs }: UiFlyoutProps) {
  const flyoutRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = flyoutRef.current;
    const menu = el?.parentElement; // .toolbar-settings-menu
    if (!el || !menu) return;
    const pad = 8;
    const gap = 8; // matches var(--panel-gap-md) in the CSS left offset
    const naturalWidth = 260; // matches .toolbar-settings-ui-flyout width
    const minWidth = 200;
    const fit = () => {
      const flyRect = el.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();
      // Vertical: never overflow the viewport bottom (the main off-screen fix).
      const overflowBottom = flyRect.bottom - (window.innerHeight - pad);
      el.style.maxHeight =
        overflowBottom > 0 ? `${Math.max(180, flyRect.height - overflowBottom)}px` : '';
      // Horizontal: the menu sits at the panel's left edge, so the flyout
      // always opens to the right. Shrink it to fit the space beside the menu
      // rather than overflowing the right edge (there's no room to flip left).
      const available = window.innerWidth - menuRect.right - gap - pad;
      el.style.width =
        available < naturalWidth ? `${Math.max(minWidth, available)}px` : '';
    };
    fit();
    // Re-measure once the entrance animation settles (transform skews the rect).
    const t = window.setTimeout(fit, 320);
    window.addEventListener('resize', fit);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('resize', fit);
    };
  }, []);

  return (
    <div ref={flyoutRef} class="toolbar-settings-ui-flyout" role="dialog" aria-label="UI settings">
      <div class="toolbar-settings-ui-flyout-title">UI</div>

      <ThemeSelect prefs={prefs} onSetPrefs={onSetPrefs} />

      <UiGroupLabel label="Colors" />
      <ColorRow
        label="Background"
        value={prefs.uiBackground}
        defaultValue="#050506"
        hint="Base surface color; lighter shades for cards and inputs derive from it."
        ariaLabel="Background color"
        onChange={(next) => onSetPrefs({ uiBackground: next })}
      />
      <ColorRow
        label="Text"
        value={prefs.uiForeground}
        defaultValue="#f2eee4"
        hint="Primary text color; muted shades derive toward the background."
        ariaLabel="Text color"
        onChange={(next) => onSetPrefs({ uiForeground: next })}
      />
      <ColorRow
        label="Border"
        value={prefs.uiBorder}
        defaultValue="#f2eee4"
        hint="Separators and outlines. The default is a faint cream line."
        ariaLabel="Border color"
        onChange={(next) => onSetPrefs({ uiBorder: next })}
      />
      <ColorRow
        label="Accent"
        value={prefs.uiAccentColor}
        defaultValue="#d7a942"
        hint="Buttons, highlights, and active states."
        ariaLabel="Accent color"
        onChange={(next) => onSetPrefs({ uiAccentColor: next })}
      />

      <UiGroupLabel label="Shape" />
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Corner radius</span>
          <span class="toolbar-settings-ui-control-value">{prefs.uiCornerRadius}px</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="0"
          max="16"
          step="1"
          value={prefs.uiCornerRadius}
          onInput={(e) => onSetPrefs({ uiCornerRadius: Number((e.target as HTMLInputElement).value) })}
          aria-label="Corner radius"
        />
        <div class="toolbar-settings-item-hint">Roundness of cards, buttons, and inputs across the panel.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <span class="toolbar-settings-ui-control-label">Density</span>
        <select
          class="toolbar-settings-select toolbar-settings-ui-font-select"
          value={prefs.uiDensity}
          aria-label="Spacing density"
          onChange={(e) => onSetPrefs({ uiDensity: (e.target as HTMLSelectElement).value as UiDensity })}
        >
          {DENSITY_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <div class="toolbar-settings-item-hint">Spacing between elements. Compact tightens, spacious loosens.</div>
      </div>

      <UiGroupLabel label="Layout" />
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Message width</span>
          <span class="toolbar-settings-ui-control-value">{prefs.uiMessageWidth}%</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="60"
          max="100"
          step="2"
          value={prefs.uiMessageWidth}
          onInput={(e) => onSetPrefs({ uiMessageWidth: Number((e.target as HTMLInputElement).value) })}
          aria-label="Message width"
        />
        <div class="toolbar-settings-item-hint">Max width of chat bubbles. Narrow view scales up to keep content readable.</div>
      </div>

      <UiGroupLabel label="Typography" />
      <div class="toolbar-settings-ui-control">
        <div class="toolbar-settings-ui-control-head">
          <span class="toolbar-settings-ui-control-label">Expanded text</span>
          <span class="toolbar-settings-ui-control-value">{prefs.expandedSectionFontSize}px</span>
        </div>
        <input
          type="range"
          class="toolbar-settings-slider toolbar-settings-ui-slider"
          min="9"
          max="18"
          step="1"
          value={prefs.expandedSectionFontSize}
          onInput={(e) => onSetPrefs({ expandedSectionFontSize: Number((e.target as HTMLInputElement).value) })}
          aria-label="Expanded section font size"
        />
        <div class="toolbar-settings-item-hint">Tool-call output, reasoning, system prompts, and code blocks.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <span class="toolbar-settings-ui-control-label">Sans font</span>
        <FontSelect
          value={prefs.uiFontSans}
          options={SANS_FONT_OPTIONS}
          ariaLabel="Sans-serif font family"
          onChange={(next) => onSetPrefs({ uiFontSans: next })}
        />
        <div class="toolbar-settings-item-hint">Body and UI text. "Default" uses the bundled stack.</div>
      </div>
      <div class="toolbar-settings-ui-control">
        <span class="toolbar-settings-ui-control-label">Mono font</span>
        <FontSelect
          value={prefs.uiFontMono}
          options={MONO_FONT_OPTIONS}
          ariaLabel="Monospace font family"
          onChange={(next) => onSetPrefs({ uiFontMono: next })}
        />
        <div class="toolbar-settings-item-hint">Code and tool output. "Default" uses the bundled stack.</div>
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
            <CollapsibleChevron open={isExpanded} size={12} />
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
  UiSubmenuTrigger,
  UiFlyout,
  SoundSection,
  ExtensionsSection,
  ProvidersSection,
};
