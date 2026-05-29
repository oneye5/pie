/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { AGENT_ACTIVITY_LABELS } from '../activity';
import {
  TurnActivityStrip,
  activityPhaseHasRunningDot,
  activityToneToStripTone,
} from '../turn-activity-strip';
import { registerRowRenderer, type RowRendererProps } from '../registry';

function renderTypingIndicator({ row }: RowRendererProps) {
  if (row.kind !== 'typingIndicator') return null;

  const activityState = row.activityState;
  const label = activityState?.label || AGENT_ACTIVITY_LABELS.preparing;
  const ariaLabel = activityState?.ariaLabel || 'Agent is preparing response';
  const tone = activityState ? activityToneToStripTone(activityState.tone) : 'neutral';
  const runningDot = activityState ? activityPhaseHasRunningDot(activityState.phase) : false;

  return (
    <div class="activity-status-indicator">
      <TurnActivityStrip
        label={label}
        detail={activityState?.detail}
        tone={tone}
        runningDot={runningDot}
        standalone={true}
        ariaLabel={ariaLabel}
      />
    </div>
  );
}

registerRowRenderer('typingIndicator', renderTypingIndicator);
