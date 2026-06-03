/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext } from 'preact';
import type { ExtensionUIRequestPayload, WebviewToHostMessage } from '../../../shared/protocol';

/**
 * Context for resolving ask_user prompts inline in the transcript.
 * When a running ask_user tool call has a matching pending extension UI
 * request, the inline renderer can respond directly without relying on
 * the bottom-anchored ExtensionUIPrompt bar.
 */
export interface AskUserContextValue {
  /** The active session path (for addressing responses). */
  sessionPath: string | null;
  /** Posts a message to the extension host. */
  postMessage: (msg: WebviewToHostMessage) => void;
  /** The current pending extension UI request, or null. */
  pendingRequest: ExtensionUIRequestPayload | null;
}

export const AskUserContext = createContext<AskUserContextValue>({
  sessionPath: null,
  postMessage: () => {},
  pendingRequest: null,
});