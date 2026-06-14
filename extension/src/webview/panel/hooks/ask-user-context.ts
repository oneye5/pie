/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext } from 'preact';
import type { ExtensionUIRequestPayload, WebviewToHostMessage } from '../../../shared/protocol';

/**
 * Context for resolving ask_user prompts inline in the transcript.
 *
 * Provides a registry of all pending extension UI requests for the active
 * session, keyed by request ID. Components subscribe by matching
 * `subagentCallId` to find the request that belongs to their context
 * (main agent or a specific subagent tool call).
 */
export interface AskUserContextValue {
  /** The active session path (for addressing responses). */
  sessionPath: string | null;
  /** Posts a message to the extension host. */
  postMessage: (msg: WebviewToHostMessage) => void;
  /** All pending requests for the active session, keyed by request ID. */
  pendingRequests: Record<string, ExtensionUIRequestPayload>;
}

export const AskUserContext = createContext<AskUserContextValue>({
  sessionPath: null,
  postMessage: () => {},
  pendingRequests: {},
});

/**
 * Find the pending 'select' request that matches a given subagentCallId.
 *
 * - When `subagentCallId` is undefined (main agent), returns the first
 *   'select' request that also has no `subagentCallId`.
 * - When `subagentCallId` is provided (subagent), returns the 'select'
 *   request whose `subagentCallId` matches exactly.
 */
export function findMatchingRequest(
  pendingRequests: Record<string, ExtensionUIRequestPayload>,
  subagentCallId?: string,
): ExtensionUIRequestPayload | null {
  for (const request of Object.values(pendingRequests)) {
    if (request.method !== 'select') continue;
    if (request.subagentCallId === subagentCallId) return request;
  }
  return null;
}