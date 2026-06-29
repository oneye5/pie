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
 * Find the pending ask_user request that matches a given caller id.
 *
 * - When `callerId` is undefined (legacy main agent), returns the first
 *   request (`select`, `confirm`, or `input`) that also has no `subagentCallId`
 *   or `toolCallId`.
 * - When `callerId` is provided, returns the request whose `toolCallId` or
 *   `subagentCallId` matches it. This lets a running `ask_user` tool card
 *   bind to its own prompt even when several are running in parallel.
 */
export function findMatchingRequest(
  pendingRequests: Record<string, ExtensionUIRequestPayload>,
  callerId?: string,
): ExtensionUIRequestPayload | null {
  for (const request of Object.values(pendingRequests)) {
    if (request.method !== 'select' && request.method !== 'confirm' && request.method !== 'input') continue;
    if (callerId === undefined) {
      if (request.toolCallId === undefined && request.subagentCallId === undefined) return request;
    } else {
      if (request.toolCallId === callerId || request.subagentCallId === callerId) return request;
    }
  }
  return null;
}