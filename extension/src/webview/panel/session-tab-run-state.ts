import type { ActiveRunSummary } from '../../shared/protocol';

export type SessionTabRunAction = 'recordOutcome' | 'startNewTask' | 'continueTask';

export interface SessionTabRunMenuItem {
  action: SessionTabRunAction;
  label: string;
}

export interface SessionTabRunBadge {
  text: string;
  tone: 'open' | 'pending-score';
  title: string;
}

export function getSessionTabRunMenuItems(runSummary: ActiveRunSummary | null): SessionTabRunMenuItem[] {
  if (!runSummary) {
    return [];
  }

  switch (runSummary.status) {
    case 'open':
      return [
        { action: 'recordOutcome', label: 'Mark tab as complete…' },
        { action: 'startNewTask', label: 'Start new task' },
      ];
    case 'closed_unscored':
      return [
        { action: 'recordOutcome', label: 'Rate completed run…' },
        { action: 'continueTask', label: 'Continue task' },
        { action: 'startNewTask', label: 'Start new task' },
      ];
    case 'scored':
      return [
        { action: 'continueTask', label: 'Continue task' },
        { action: 'startNewTask', label: 'Start new task' },
      ];
    default:
      return [];
  }
}

export function getSessionTabRunBadge(runSummary: ActiveRunSummary | null): SessionTabRunBadge | null {
  if (!runSummary) {
    return null;
  }

  switch (runSummary.status) {
    case 'open':
      return {
        text: 'Done…',
        tone: 'open',
        title: 'Click to mark this run complete and record a rating. You can also right-click the tab for task actions.',
      };
    case 'closed_unscored':
      return {
        text: 'Rate…',
        tone: 'pending-score',
        title: 'Click to record the outcome for this completed run. You can also right-click the tab for task actions.',
      };
    default:
      return null;
  }
}
