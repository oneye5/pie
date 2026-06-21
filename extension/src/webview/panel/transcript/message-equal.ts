import type { ChatMessage } from '../../../shared/protocol';

/**
 * Content equality for {@link ChatMessage}, used by `MessageItem`'s `memo`
 * comparer so unchanged rows bail out of rendering on host snapshot posts.
 *
 * Why this exists: the host posts a fully serialized `ViewState` ~7×/sec while
 * streaming. `postMessage`'s structured clone gives every message a fresh
 * reference even when its content is byte-identical, which defeats
 * `MessageItem = memo(MessageItemView)`'s default shallow compare (the
 * `message` prop is always a "new" object). Without a content comparer, every
 * visible row re-renders on every snapshot — including the ~10–15 virtualized
 * rows that haven't changed — paying for hook re-runs, `renderMarkdown` cache
 * lookups, and Preact reconciliation each tick.
 *
 * The whole-transcript reference-stabilization in `view-state-stabilize.ts`
 * is deliberately NOT applied to the transcript (it would be O(n) per tick for
 * every message, not just the visible ones). This comparer is O(visible rows)
 * instead — it only runs for rows the virtualizer actually renders.
 *
 * Completeness: every field of {@link ChatMessage} is covered. Primitives and
 * strings use `===` with early-exit (during streaming the streaming message's
 * `markdown` grows, so the `markdown !==` check fails fast without touching the
 * nested arrays). Nested arrays/objects (`parts`, `toolCalls`, `userParts`,
 * `usage`, `customDetails`) fall through to `jsonEqual`, which is
 * complete-by-construction — a newly added field on `ChatMessage` only needs to
 * be added here to stay covered, and a missed addition fails safe (the field
 * would be absent from the `jsonEqual` calls, but since `jsonEqual` serializes
 * the whole sub-object, nested fields are still compared; a brand-new
 * top-level field would require an explicit check, so a test enumerates the
 * fields).
 */
export function chatMessageEqual(a: ChatMessage, b: ChatMessage): boolean {
  if (a === b) return true;

  // Cheap primitive/string early-exits. String `!==` is O(length) but
  // allocation-free and early-exits on the first differing byte — the
  // streaming message bails here (markdown grew) without reaching the nested
  // JSON comparisons below.
  if (
    a.id !== b.id ||
    a.role !== b.role ||
    a.status !== b.status ||
    a.createdAt !== b.createdAt ||
    a.markdown !== b.markdown ||
    a.thinking !== b.thinking ||
    a.modelId !== b.modelId ||
    a.thinkingLevel !== b.thinkingLevel ||
    a.errorDetail !== b.errorDetail ||
    a.durationMs !== b.durationMs ||
    a.turnLatencyMs !== b.turnLatencyMs ||
    a.overheadMs !== b.overheadMs ||
    a.providerLatencyMs !== b.providerLatencyMs ||
    a.customType !== b.customType
  ) {
    return false;
  }

  // Nested arrays/objects. Only reached when every primitive matched, i.e. the
  // message appears unchanged — `jsonEqual` confirms the nested content is
  // identical too. JSON serialization is complete (covers every enumerable
  // nested field) so this can't silently reuse a stale reference for a nested
  // mutation that the primitive checks missed (e.g. a tool call's `result`
  // landing, or `parts` growing without `markdown` changing).
  if (!jsonEqual(a.parts, b.parts)) return false;
  if (!jsonEqual(a.toolCalls, b.toolCalls)) return false;
  if (!jsonEqual(a.userParts, b.userParts)) return false;
  if (!jsonEqual(a.usage, b.usage)) return false;
  if (!jsonEqual(a.customDetails, b.customDetails)) return false;
  return true;
}

/**
 * Compare two JSON-serializable values by structural content. `undefined`
 * compares equal only to `undefined` (so an absent optional field on both
 * sides is equal, but `undefined` vs a present value is not). Identical
 * references short-circuit without serializing.
 */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}
