/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

const TRUNCATE_LENGTH = 120;

export interface NoticeBannerProps {
  notice: string;
  onDismiss: () => void;
}

export function NoticeBanner({ notice, onDismiss }: NoticeBannerProps) {
  const isError = notice.toLowerCase().includes('error') || notice.toLowerCase().includes('fail');
  const isLong = notice.length > TRUNCATE_LENGTH;
  const [expanded, setExpanded] = useState(false);

  return (
    <div class={`notice${isError ? ' error' : ''}`}>
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
        <button class="notice-btn notice-dismiss" onClick={onDismiss} title="Dismiss">✕</button>
      </div>
    </div>
  );
}
