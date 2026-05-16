/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { ChatPrefs, ExtensionInfo, ModelInfo } from '../../../shared/protocol';
import { CHAT_PREF_MENU_SECTIONS, setExtensionEnabled, setProviderEnabled, toggleChatPref } from '../chat-prefs';

interface ComposerSettingsMenuProps {
  prefs: ChatPrefs;
  availableExtensions: ExtensionInfo[];
  availableModels: ModelInfo[];
  onSetPrefs: (prefs: Partial<ChatPrefs>) => void;
}

export function ComposerSettingsMenu({ prefs, availableExtensions, availableModels, onSetPrefs }: ComposerSettingsMenuProps) {
  const [open, setOpen] = useState(false);
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
                        <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
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
          {availableExtensions.length > 0 && (
            <div key="extensions" class="toolbar-settings-section">
              <div class="toolbar-settings-section-label">Extensions</div>
              <div class="toolbar-settings-list">
                {availableExtensions.map((ext) => {
                  // If the extension ID is not in the toggles map, it's enabled by default.
                  const checked = prefs.extensionToggles[ext.id] !== false;
                  return (
                    <button
                      key={ext.id}
                      class={`toolbar-settings-item${checked ? ' checked' : ''}`}
                      type="button"
                      role="menuitemcheckbox"
                      aria-checked={checked}
                      title={ext.description}
                      onClick={() => onSetPrefs(setExtensionEnabled(prefs, ext.id, !checked))}
                    >
                      <span class="toolbar-settings-item-check" aria-hidden="true">
                        <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
                          <polyline points="2.5,6.5 5,9 10.5,3.5" />
                        </svg>
                      </span>
                      <span class="toolbar-settings-item-label">{ext.label}</span>
                    </button>
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
                        <svg width="12" height="12" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style={checked ? '' : 'opacity:0'}>
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