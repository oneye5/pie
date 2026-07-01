/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { playCompletionSound, warmupCompletionSoundContext } from '../completion-sound';
import type { ChatPrefs } from '../../../shared/protocol';
import type { OnSetPrefs } from './settings-menu-types';

export function SoundSection({ prefs, onSetPrefs }: { prefs: ChatPrefs; onSetPrefs: OnSetPrefs }) {
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
