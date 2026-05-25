/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { registerRowRenderer, type RowRendererProps } from '../registry';

function renderTypingIndicator({ row }: RowRendererProps) {
  if (row.kind !== 'typingIndicator') return null;

  return (
    <div class="typing-indicator" role="status" aria-label="Generating response">
      <span class="typing-indicator-dot" />
      <span class="typing-indicator-dot" />
      <span class="typing-indicator-dot" />
    </div>
  );
}

registerRowRenderer('typingIndicator', renderTypingIndicator);
