/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ExtensionInfo, ModelInfo, PruningSettings } from '../../../shared/protocol';
import { setExtensionEnabled, toggleChatPref } from '../chat-prefs';
import { orderModelsForPicker } from './model-list';
import { CollapsibleChevron } from '../components/chevron';
import { EXTENSIONS_WITH_SETTINGS } from './settings-menu-helpers';
import { SkillPrunerSettings } from './settings-menu-skill-pruner';
import type { OnSetPrefs, OnSetPruningSettings } from './settings-menu-types';

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

export function ExtensionsSection({ availableExtensions, prefs, onSetPrefs, expandedExt, setExpandedExt, subagentOpen, onToggleSubagent, pruningSettings, modelEntries, availableModels, skillCatalog, toolCatalog, onSetPruningSettings }: ExtensionsSectionProps) {
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
