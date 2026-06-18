/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';

import type { RunOutcome, RunOutcomeResolution } from '../../shared/protocol';

const RATING_HINTS: Record<number, { label: string; hint: string }> = {
  1: { label: '1', hint: 'Set back' },
  2: { label: '2', hint: 'Poor' },
  3: { label: '3', hint: 'Average' },
  4: { label: '4', hint: 'Good' },
  5: { label: '5', hint: 'Exceptional' },
};

const RESOLUTION_OPTIONS: Array<{
  value: RunOutcomeResolution;
  label: string;
  description: string;
}> = [
  { value: 'resolved', label: 'Resolved', description: 'Completed successfully.' },
  { value: 'partially_resolved', label: 'Partially resolved', description: 'Progress made, follow-up still needed.' },
  { value: 'unresolved', label: 'Unresolved', description: 'Did not land in a usable state.' },
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
  const title = `Mark "${sessionLabel}" done`;

  // Focus trap: keep focus inside the dialog while it's open so the user can't
  // Tab out to the session tabs (which would mutate activeSession and cause the
  // outcome to be recorded for the wrong session) and restore focus to whatever
  // had it before the dialog opened.
  useEffect(() => {
    const node = dialogRef.current;
    if (!node) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    node.focus();
    const handleFocusOut = () => {
      if (!node.contains(document.activeElement)) {
        node.focus();
      }
    };
    node.addEventListener('focusout', handleFocusOut);
    return () => {
      node.removeEventListener('focusout', handleFocusOut);
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.key === 'Tab') {
        const node = dialogRef.current;
        if (!node) return;
        const focusable = Array.from(
          node.querySelectorAll<HTMLElement>('button:not([disabled])'),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (event.shiftKey && active === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && active === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }

      if (event.key === 'Enter' && !event.shiftKey && satisfaction !== null) {
        // Let focused buttons handle Enter via their native click (so Enter on
        // Cancel actually cancels instead of submitting). Only submit when
        // focus is not on the Cancel button.
        const target = event.target as HTMLElement | null;
        if (target?.closest('[data-cancel-button]')) return;
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
          <h2 id="run-outcome-title" class="run-outcome-title">{title}</h2>
        </div>

        <div class="run-outcome-section">
          <div class="run-outcome-section-title">Rating</div>
          <div class="run-outcome-rating-grid" role="radiogroup" aria-label="Run rating">
            {[1, 2, 3, 4, 5].map((value) => {
              const { hint } = RATING_HINTS[value];
              return (
                <button
                  key={value}
                  class={`run-outcome-rating r${value}${satisfaction === value ? ' selected' : ''}`}
                  type="button"
                  role="radio"
                  aria-checked={satisfaction === value}
                  onClick={() => setSatisfaction(value)}
                >
                  <span class="run-outcome-rating-value">{value}<span class="run-outcome-rating-scale">/5</span></span>
                  <span class="run-outcome-rating-hint">{hint}</span>
                </button>
              );
            })}
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
          <button class="action-btn secondary" type="button" data-cancel-button onClick={onCancel}>Cancel</button>
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
