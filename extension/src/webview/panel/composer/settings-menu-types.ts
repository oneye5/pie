import type { ChatPrefs, PruningSettings } from '../../../shared/protocol';

export type OnSetPrefs = (prefs: Partial<ChatPrefs>) => void;
export type OnSetPruningSettings = (settings: Partial<PruningSettings>) => void;
