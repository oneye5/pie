/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useMemo, useRef, useState } from 'preact/hooks';

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningCatalog, PruningResult, PruningSettings } from '../../../shared/protocol';
import { orderModelsForPicker } from './model-list';

import {
  computeKeepCatalog,
  computeToolKeepCatalog,
} from './settings-menu-helpers';

import {
  ChatPrefSections,
  ExtensionsSection,
  ProvidersSection,
  SoundSection,
  UiFlyout,
  UiSubmenuTrigger,
} from './settings-menu-subcomponents';

export {
  AlwaysKeepPicker,
} from './settings-menu-subcomponents';

export {
  computeKeepCatalog,
  computeToolKeepCatalog,
  filterKeepCatalog,
  DEFAULT_TOOL_KEEP_CATALOG,
} from './settings-menu-helpers';

export interface ComposerSettingsMenuProps {
  prefs: ChatPrefs;
  pruningSettings: PruningSettings;
  pruningCatalog: PruningCatalog;
  pruningResult: PruningResult | null;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
  onSetPruningSettings: (settings: Partial<PruningSettings>) => void;
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
    () => computeToolKeepCatalog(
      pruningCatalog.tools,
      pruningResult ? { included: pruningResult.includedTools, excluded: pruningResult.excludedTools } : null,
      pruningSettings.toolAlwaysKeep,
    ),
    [pruningCatalog.tools, pruningResult, pruningSettings.toolAlwaysKeep],
  );
  const [open, setOpen] = useState(false);
  const modelEntries = useMemo(() => orderModelsForPicker(availableModels), [availableModels]);
  const [expandedExt, setExpandedExt] = useState<string | null>(null);
  const [uiOpen, setUiOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

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
      if (event.key !== 'Escape') return;
      // If a nested overlay (e.g. the ModelPicker dropdown rendered inside this
      // menu) owns focus, defer to its own Escape handler so only the picker
      // closes and focus returns to the picker trigger. This menu's keydown
      // listener is registered first (parent mounts first) and therefore fires
      // first, so we skip here rather than rely on the child stopping
      // propagation (stopImmediatePropagation would have no effect).
      const active = document.activeElement as HTMLElement | null;
      if (
        active &&
        menuRef.current?.contains(active) &&
        active.closest('.model-picker-dropdown')
      ) {
        return;
      }
      setOpen(false);
      triggerRef.current?.focus();
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
        ref={triggerRef}
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
          <ChatPrefSections prefs={prefs} onSetPrefs={onSetPrefs} />
          <UiSubmenuTrigger open={uiOpen} onToggle={() => setUiOpen((v) => !v)} />
          {uiOpen && <UiFlyout prefs={prefs} onSetPrefs={onSetPrefs} />}
          <SoundSection prefs={prefs} onSetPrefs={onSetPrefs} />
          {availableExtensions.length > 0 && (
            <ExtensionsSection
              availableExtensions={availableExtensions}
              prefs={prefs}
              onSetPrefs={onSetPrefs}
              expandedExt={expandedExt}
              setExpandedExt={setExpandedExt}
              pruningSettings={pruningSettings}
              modelEntries={modelEntries}
              availableModels={availableModels}
              skillCatalog={skillCatalog}
              toolCatalog={toolCatalog}
              onSetPruningSettings={onSetPruningSettings}
            />
          )}
          {providers.length > 0 && (
            <ProvidersSection providers={providers} prefs={prefs} onSetPrefs={onSetPrefs} />
          )}
        </div>
      )}
    </div>
  );
}
