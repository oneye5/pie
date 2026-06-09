/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { ChatMessage } from '../../../../shared/protocol';
import { useNotice } from '../../hooks/notice-context';

const ERROR_TRUNCATE = 150;

export function ErrorDetailWithFallback({ message }: { message: ChatMessage }) {
  const notice = useNotice();
  const detail = message.errorDetail || notice;
  if (!detail) return null;
  return <ErrorDetail detail={detail} />;
}

export function ErrorDetail({ detail }: { detail: string }) {
  const [expanded, setExpanded] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const isLong = detail.length > ERROR_TRUNCATE;

  if (dismissed) return null;

  return (
    <div class="message-error-detail">
      <span class="message-error-detail-text">
        {isLong && !expanded ? detail.slice(0, ERROR_TRUNCATE) + '…' : detail}
      </span>
      <span class="message-error-detail-actions">
        {isLong && (
          <button class="message-error-detail-btn" onClick={() => setExpanded(v => !v)}>
            {expanded ? 'Less' : 'More'}
          </button>
        )}
        <button
          class="message-error-detail-btn"
          onClick={() => { void navigator.clipboard?.writeText(detail); }}
          title="Copy error detail"
          aria-label="Copy error detail"
        >
          Copy
        </button>
        <button class="message-error-detail-btn" onClick={() => setDismissed(true)} title="Dismiss">✕</button>
      </span>
    </div>
  );
}
