/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useMemo } from 'preact/hooks';

import { renderMarkdown } from '../markdown';
import { useBufferedText } from './use-buffered-text';

interface BufferedTextPartProps {
  messageId: string;
  index: number;
  text: string;
  streaming: boolean;
  onContextMenu: (e: Event) => void;
}

/**
 * Renders a text part with buffered smooth streaming.
 *
 * During streaming, text is revealed progressively to prevent layout jumps
 * when large chunks arrive at once. Once streaming ends, full text is shown.
 */
export function BufferedTextPart({ messageId, index, text, streaming, onContextMenu }: BufferedTextPartProps) {
  const visibleText = useBufferedText(text, streaming);
  const html = useMemo(() => renderMarkdown(visibleText), [visibleText]);

  return (
    <div
      key={`text-${messageId}-${index}`}
      class={`message-body${streaming ? ' streaming-text' : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e);
      }}
    />
  );
}
