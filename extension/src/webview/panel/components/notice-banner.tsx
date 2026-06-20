/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useState } from 'preact/hooks';

const TRUNCATE_LENGTH = 120;

export interface NoticeBannerProps {
  notice: string;
  onDismiss: () => void;
}

export function NoticeBanner({ notice, onDismiss }: NoticeBannerProps) {
  const isError = notice.toLowerCase().includes('error') || notice.toLowerCase().includes('fail');
  const isLong = notice.length > TRUNCATE_LENGTH;
  const [expanded, setExpanded] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  // A new notice replaces the old one in place; reset the exit state so it
  // isn't auto-dismissed and the entrance animation replays.
  useEffect(() => {
    setDismissing(false);
  }, [notice]);

  return (
    <div
      class={`notice${isError ? ' error' : ''}${dismissing ? ' dismissing' : ''}`}
      onAnimationEnd={(e) => {
        if (e.animationName === 'notice-exit') onDismiss();
      }}
    >
      <div class="notice-content">
        <span class={`notice-text${isLong && !expanded ? ' notice-text-truncated' : ''}`}>
          {isLong && !expanded ? notice.slice(0, TRUNCATE_LENGTH) + '…' : notice}
        </span>
      </div>
      <div class="notice-actions">
        {isLong && (
          <button
            class="notice-btn"
            onClick={() => setExpanded(v => !v)}
            title={expanded ? 'Show less' : 'Show more'}
          >
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        <button class="notice-btn notice-dismiss" onClick={() => setDismissing(true)} title="Dismiss" aria-label="Dismiss notice">✕</button>
      </div>
    </div>
  );
}
