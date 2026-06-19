/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatMessage } from '../../../../shared/protocol';
import type { TurnActivityState } from '../activity';
import { TurnActivityBlock } from '../turn-activity-tail';
import {
  TurnActivityStrip,
  activityPhaseHasRunningDot,
  activityToneToStripTone,
} from '../turn-activity-strip';

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
            footerActivityState.tail ? (
              <TurnActivityBlock state={footerActivityState} />
            ) : (
              <TurnActivityStrip
                label={footerActivityState.label}
                detail={footerActivityState.detail}
                tone={activityToneToStripTone(footerActivityState.tone)}
                runningDot={activityPhaseHasRunningDot(footerActivityState.phase)}
                phase={footerActivityState.phase}
                ariaLabel={footerActivityState.ariaLabel}
              />
            )
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
        return { kind: 'available' as const, userId: transcript[i]!.id };
      }
    }
  }
  return hasOlder ? { kind: 'unloaded' as const } : null;
}
