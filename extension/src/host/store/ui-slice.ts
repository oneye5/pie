import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { DEFAULT_CHAT_PREFS, type ChatPrefs, type ExtensionInfo } from '../../shared/protocol';

interface UiState {
  notice: string | null;
  backendReady: boolean;
  prefs: ChatPrefs;
  availableExtensions: ExtensionInfo[];
}

const uiSlice = createSlice({
  name: 'ui',
  initialState: { notice: null, backendReady: false, prefs: DEFAULT_CHAT_PREFS, availableExtensions: [] } as UiState,
  reducers: {
    setNotice(state, action: PayloadAction<string | null>) {
      state.notice = action.payload;
    },
    setBackendReady(state, action: PayloadAction<boolean>) {
      state.backendReady = action.payload;
    },
    setPrefs(state, action: PayloadAction<Partial<ChatPrefs>>) {
      state.prefs = { ...state.prefs, ...action.payload };
      // Deep-merge extensionToggles to avoid overwriting missing keys.
      if (action.payload.extensionToggles) {
        state.prefs.extensionToggles = {
          ...state.prefs.extensionToggles,
          ...action.payload.extensionToggles,
        };
      }
      // Deep-merge providerToggles to avoid overwriting missing keys.
      if (action.payload.providerToggles) {
        state.prefs.providerToggles = {
          ...state.prefs.providerToggles,
          ...action.payload.providerToggles,
        };
      }
    },
    setAvailableExtensions(state, action: PayloadAction<ExtensionInfo[]>) {
      state.availableExtensions = action.payload;
    },
  },
});

export const uiReducer = uiSlice.reducer;
export const uiActions = uiSlice.actions;
