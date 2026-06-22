import type { ChatMessage, SystemPromptEntry } from '../../../shared/protocol';

/**
 * Cheap fingerprints that gate the O(transcript) indicator walks in
 * {@link useComposerIndicators}, so they bail when only the streaming message
 * grew instead of re-walking the whole transcript every snapshot.
 *
 * Background: the host posts a structured-cloned `ViewState` ~7×/sec while
 * streaming (`postMessage`'s clone gives every nested object a fresh reference
 * even when byte-identical), so keying a memo on the `transcript` array ref
 * recomputes the walk on every snapshot. These signatures are O(1)/O(small)
 * surrogates that are STABLE while the guarded result is stable and CHANGE
 * whenever the result could change, so the memos skip the walk in the common
 * "only the streaming message grew" case.
 *
 * Correctness contract — why a length + last-message fingerprint suffices:
 * The guarded walks read only
 *   - `message.usage` / `message.modelId`  — set once at `MessageFinished`
 *     (the message is the last assistant message at that moment) and immutable
 *     afterwards;
 *   - `message.toolCalls` / `message.parts` tool calls — results land
 *     atomically on the streaming (last) message, and are immutable once
 *     completed;
 *   - `message.markdown` / `message.thinking` — only the streaming message's
 *     grow.
 * None of these mutate a non-streaming message after it completes, and the
 * only "content transition" during a turn happens on the last message (the one
 * streaming). Appends/removes change `transcript.length`. So
 * `length + last-message volatile fields` captures every transition the walks
 * care about, without paying O(transcript) to detect it.
 *
 * This deliberately does NOT stabilize the whole transcript (the decision
 * documented in `view-state-stabilize.ts`): the signatures are O(1)/O(small),
 * and the walks themselves only run (over the real transcript) when a
 * signature actually changes.
 */

/**
 * O(1). Guards {@link buildSessionTokenUsage} and {@link buildCompletedCostSummary},
 * which sum per-message usage. Usage lands only at `MessageFinished` and is
 * immutable afterwards, so `length + last-message id/status/usage-total`
 * captures every transition: appends/removes (length) and a turn finishing
 * (status flips + `usage` appears).
 */
export function transcriptUsageSignature(transcript: readonly ChatMessage[]): string {
  const last = transcript[transcript.length - 1];
  return `${transcript.length}|${last?.id ?? ''}|${last?.status ?? ''}|${last?.usage?.totalTokens ?? ''}`;
}

/**
 * O(streaming messages) — in practice O(1) (one streaming message). A
 * fingerprint of the streaming message's growing prose. Used by memos whose
 * result legitimately changes as the streaming content grows: the context-window
 * breakdown's ESTIMATED branch (when no live `contextUsage.tokens` is reported)
 * and the live cost estimate. Empty when nothing is streaming.
 *
 * Uses `markdown.length` + `thinking.length` (not a BPE estimate) deliberately:
 * streaming prose is APPEND-ONLY (the reducer concatenates deltas), so its
 * length strictly grows every delta and the signature changes every delta —
 * exactly when the gated result (an `estimateTextTokens` estimate of that same
 * prose) legitimately changes. A same-length content swap of a streaming
 * message's prose cannot occur mid-stream, so the length proxy is sound here
 * and avoids re-running BPE in the signature on every tick.
 */
export function streamingContentSignature(transcript: readonly ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of transcript) {
    if (m.status !== 'streaming') continue;
    parts.push(`${m.id}:${m.markdown.length}:${(m.thinking ?? '').length}`);
  }
  return parts.join(',');
}

/**
 * O(total prompt text) — prompts are few and small. Guards the context-window
 * breakdown's system-prompt contributor, whose value is
 * `estimateTextTokens(prompt.text)` (a real cl100k_base BPE count, which is
 * CONTENT-dependent, not length-dependent). A `text.length` proxy would be
 * unsound: two same-length prompts can tokenize to different token counts, so
 * a same-length system-prompt edit would change the breakdown but not the
 * signature → a stale tooltip. Including each prompt's availability + full text
 * is unambiguously faithful (any content change is detected) and cheaper than
 * re-running BPE in the signature. It is intentionally over-faithful — a
 * same-token-count text edit needlessly recomputes the breakdown — because
 * system-prompt edits are rare (config edits, not mid-stream) and the cost of
 * including the text is far below the O(transcript) BPE walk this signature
 * gates.
 */
export function systemPromptsSignature(systemPrompts: readonly SystemPromptEntry[]): string {
  let acc = `${systemPrompts.length}`;
  for (const p of systemPrompts) {
    acc += `|${p.availability}:${p.text}`;
  }
  return acc;
}

/**
 * O(last message's tool calls). Guards {@link extractSubagentDirectCost}, which
 * sums `cost` from completed subagent tool calls across the transcript.
 * Completed subagent results are immutable once landed; the only NEW completed
 * calls during a turn arrive on the streaming (last) message, so
 * `length + last-message tool-call id/status/name/result-presence` captures
 * every transition without walking the whole transcript. Mirrors
 * `toolCallsFromMessage` (prefers `toolCalls` when non-empty, else the `parts`
 * tool-call entries) so the fingerprint tracks exactly the calls the walk sees.
 */
export function subagentCostSignature(transcript: readonly ChatMessage[]): string {
  const last = transcript[transcript.length - 1];
  if (!last) return `${transcript.length}|`;
  const tcs = last.toolCalls ?? [];
  const partTcs = last.parts
    ?.filter((p) => p.kind === 'toolCall')
    .map((p) => p.toolCall) ?? [];
  const calls = tcs.length ? tcs : partTcs;
  const fp = calls
    .map((tc) => `${tc.id}:${tc.status}:${tc.name ?? ''}:${tc.result !== undefined ? 1 : 0}`)
    .join(',');
  return `${transcript.length}|${fp}`;
}
