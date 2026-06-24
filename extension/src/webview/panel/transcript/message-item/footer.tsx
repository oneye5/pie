/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatMessage } from '../../../../shared/protocol';
import type { TurnActivityState } from '../activity';
import { TurnActivityRegion } from '../turn-activity-region';

interface MessageFooterProps {
  hasActivityFooter: boolean | undefined;
  footerActivityState: TurnActivityState | null;
  recovery: { kind: 'available'; userId: string } | { kind: 'unloaded' } | null;
  onEditRequest: (messageId: string) => void;
}

export function MessageFooter({
  hasActivityFooter,
  footerActivityState,
  recovery,
  onEditRequest,
}: MessageFooterProps) {
  return (
    <>
      {hasActivityFooter && (
        <div class="message-activity-footer">
          {footerActivityState ? (
            <TurnActivityRegion state={footerActivityState} />
          ) : null}
        </div>
      )}

      {recovery && (
        <div class="message-recovery">
          {recovery.kind === 'available' ? (
            <button
              class="message-retry-btn"
              type="button"
              onClick={() => onEditRequest(recovery.userId)}
              title="Edit the previous prompt and resend"
            >
              ↻ Edit previous prompt
            </button>
          ) : (
            <span class="message-retry-hint">Load older messages to retry</span>
          )}
        </div>
      )}
    </>
  );
}

// Referentially-stable recovery results. `useRecovery` is a pure function
// (despite the `use` prefix) called once per render in `renderMessage`
// (message-row.tsx); its result is passed as the `recovery` prop to the memo'd
// <MessageItem>. Returning a fresh object each call would defeat the shallow
// compare for error/interrupted assistant rows on every transcript re-render
// (e.g. every streaming token), re-rendering those rows for nothing. The
// `unloaded` case is a single shared constant; the `available` case is interned
// by `userId` so the same previous-user-message id always resolves to the same
// object reference. Bounded growth: one entry per distinct user message id,
// cleared on webview reload.
const RECOVERY_UNLOADED = { kind: 'unloaded' as const };
const availableRecoveryByUserId = new Map<string, { kind: 'available'; userId: string }>();

export function useRecovery(
  message: ChatMessage,
  transcript: ChatMessage[] | undefined,
  transcriptIndex: number | undefined,
  hasOlder: boolean | undefined,
): { kind: 'available'; userId: string } | { kind: 'unloaded' } | null {
  if (message.role !== 'assistant') return null;
  if (message.status !== 'error' && message.status !== 'interrupted') return null;
  if (transcript && typeof transcriptIndex === 'number') {
    for (let i = transcriptIndex - 1; i >= 0; i -= 1) {
      if (transcript[i]?.role === 'user') {
        const userId = transcript[i]!.id;
        let cached = availableRecoveryByUserId.get(userId);
        if (!cached) {
          cached = { kind: 'available' as const, userId };
          availableRecoveryByUserId.set(userId, cached);
        }
        return cached;
      }
    }
  }
  return hasOlder ? RECOVERY_UNLOADED : null;
}
