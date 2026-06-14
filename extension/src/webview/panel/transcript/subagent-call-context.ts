/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { createContext } from 'preact';

/**
 * Context that carries the parent subagent's tool call ID through nested
 * transcript rendering. When a subagent's nested ask_user tool call needs
 * to find its matching ExtensionUIRequestPayload, it reads this context
 * to get the `subagentCallId` to match against.
 *
 * `undefined` means we're at the top level (main agent transcript).
 */
export const SubagentCallContext = createContext<string | undefined>(undefined);
