/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { RunOutcome, RunOutcomeResolution } from '../../shared/protocol';

const RESOLUTION_OPTIONS: Array<{
  value: RunOutcomeResolution;
  label: string;
  description: string;
}> = [
  {
    value: 'resolved',
    label: 'Resolved',
    description: 'The task was completed successfully.',
  },
  {
    value: 'partially_resolved',
    label: 'Partially resolved',
    description: 'Some progress was made, but follow-up work is still needed.',
  },
  {
    value: 'unresolved',
    label: 'Unresolved',
    description: 'The task did not land in a usable state yet.',
  },
];

interface RunOutcomeDialogProps {
  sessionLabel: string;
  onCancel: () => void;
  onSubmit: (outcome: RunOutcome) => void;
}

export function RunOutcomeDialog({ sessionLabel, onCancel, onSubmit }: RunOutcomeDialogProps) {
  const [resolution, setResolution] = useState<RunOutcomeResolution>('resolved');
  const [satisfaction, setSatisfaction] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey && satisfaction !== null) {
        event.preventDefault();
        onSubmit({ resolution, satisfaction });
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, onSubmit, resolution, satisfaction]);

  return (
    <div
      class="run-outcome-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <div
        ref={dialogRef}
        class="run-outcome-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="run-outcome-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div class="run-outcome-header">
          <div class="run-outcome-eyebrow">Run analytics</div>
          <h2 id="run-outcome-title" class="run-outcome-title">Mark “{sessionLabel}” complete</h2>
          <p class="run-outcome-subtitle">
            Save a local outcome for this run. Choose a 1–5 rating, then confirm whether the task was resolved.
          </p>
        </div>

        <div class="run-outcome-section">
          <div class="run-outcome-section-title">Rating</div>
          <div class="run-outcome-rating-grid" role="radiogroup" aria-label="Run rating">
            {[1, 2, 3, 4, 5].map((value) => (
              <button
                key={value}
                class={`run-outcome-rating${satisfaction === value ? ' selected' : ''}`}
                type="button"
                role="radio"
                aria-checked={satisfaction === value}
                onClick={() => setSatisfaction(value)}
              >
                <span class="run-outcome-rating-value">{value}</span>
                <span class="run-outcome-rating-scale">/5</span>
              </button>
            ))}
          </div>
        </div>

        <div class="run-outcome-section">
          <div class="run-outcome-section-title">Resolution</div>
          <div class="run-outcome-resolution-list" role="radiogroup" aria-label="Run resolution">
            {RESOLUTION_OPTIONS.map((option) => (
              <button
                key={option.value}
                class={`run-outcome-resolution${resolution === option.value ? ' selected' : ''}`}
                type="button"
                role="radio"
                aria-checked={resolution === option.value}
                onClick={() => setResolution(option.value)}
              >
                <span class="run-outcome-resolution-label">{option.label}</span>
                <span class="run-outcome-resolution-description">{option.description}</span>
              </button>
            ))}
          </div>
        </div>

        <div class="run-outcome-actions">
          <button class="action-btn secondary" type="button" onClick={onCancel}>Cancel</button>
          <button
            class="action-btn primary"
            type="button"
            disabled={satisfaction === null}
            onClick={() => {
              if (satisfaction === null) {
                return;
              }
              onSubmit({ resolution, satisfaction });
            }}
          >
            Save outcome
          </button>
        </div>
      </div>
    </div>
  );
}
