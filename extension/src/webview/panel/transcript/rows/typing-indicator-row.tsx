/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { AGENT_ACTIVITY_LABELS } from '../activity';
import {
  TurnActivityStrip,
  activityPhaseHasRunningDot,
  activityToneToStripTone,
  type TurnActivityPhase,
} from '../turn-activity-strip';
import { TurnActivityBlock } from '../turn-activity-tail';
import { registerRowRenderer, type RowRendererProps } from '../registry';

function renderTypingIndicator({ row }: RowRendererProps) {
  if (row.kind !== 'typingIndicator') return null;

  const activityState = row.activityState;
  const label = activityState?.label ?? AGENT_ACTIVITY_LABELS.preparing;
  const ariaLabel = activityState?.ariaLabel ?? 'Agent is preparing response';
  const phase = (activityState?.phase as TurnActivityPhase | undefined) ?? 'preparing';

  if (activityState?.tail) {
    return (
      <div class="activity-status-row">
        <TurnActivityBlock state={activityState} />
      </div>
    );
  }

  return (
    <div class="activity-status-row">
      <TurnActivityStrip
        label={label}
        tone={activityToneToStripTone(activityState?.tone ?? 'neutral')}
        runningDot={activityPhaseHasRunningDot(phase)}
        phase={phase}
        standalone
        ariaLabel={ariaLabel}
      />
    </div>
  );
}

registerRowRenderer('typingIndicator', renderTypingIndicator);
