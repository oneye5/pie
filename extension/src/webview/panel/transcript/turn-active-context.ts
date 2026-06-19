import { createContext } from 'preact';

/**
 * Indicates whether the agent turn that owns this tool call is still active
 * (the session is `busy`). Consumed by `ToolCallCard` to defer the
 * post-completion auto-close of an auto-shown shell body until the owning
 * turn goes idle, so consecutive commands don't collapse→re-expand mid-turn.
 *
 * Provided by the main `TranscriptVirtualList` from its `busy` prop.
 * `undefined` — i.e. no provider above the consumer (notably the nested
 * subagent transcript, which does not receive `busy`) — falls back to the
 * legacy completion-relative grace, so nested behaviour is unchanged.
 */
export const TurnActiveContext = createContext<boolean | undefined>(undefined);
