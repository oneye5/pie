import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { DEFAULT_CHAT_PREFS, type ChatPrefs, type ExtensionInfo, type ExtensionUIRequestPayload } from '../../shared/protocol';

interface UiState {
  notice: string | null;
  backendReady: boolean;
  prefs: ChatPrefs;
  availableExtensions: ExtensionInfo[];
  /** Message ID currently being edited (null = not editing). */
  editingMessageId: string | null;
  /** Whether the run-outcome recording dialog is open. */
  showOutcomeDialog: boolean;
  /** Pending extension UI request awaiting user response. */
  pendingExtensionUIRequest: ExtensionUIRequestPayload | null;
}

const uiSlice = createSlice({
  name: 'ui',
  initialState: { notice: null, backendReady: false, prefs: DEFAULT_CHAT_PREFS, availableExtensions: [], editingMessageId: null, showOutcomeDialog: false, pendingExtensionUIRequest: null } as UiState,
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
    setEditingMessageId(state, action: PayloadAction<string | null>) {
      state.editingMessageId = action.payload;
    },
    setShowOutcomeDialog(state, action: PayloadAction<boolean>) {
      state.showOutcomeDialog = action.payload;
    },
    setPendingExtensionUIRequest(state, action: PayloadAction<ExtensionUIRequestPayload | null>) {
      state.pendingExtensionUIRequest = action.payload;
    },
  },
});

export const uiReducer = uiSlice.reducer;
export const uiActions = uiSlice.actions;
