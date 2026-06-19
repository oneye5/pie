import { marked } from 'marked';
import DOMPurify from 'dompurify';

import { highlightCodeBlock } from './transcript/highlight';

marked.setOptions({ breaks: true, gfm: true });

/** Code blocks taller than this are collapsed by default with a "show all" toggle. */
const LONG_CODE_LINE_THRESHOLD = 16;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

marked.use({
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const { html, language } = highlightCodeBlock(text, lang);
      const lineCount = text.split('\n').length;
      const collapsible = lineCount > LONG_CODE_LINE_THRESHOLD;
      const langLabel = language ?? (lang || '').trim().split(/\s+/)[0] ?? '';
      // `hljs-scope` on the wrapper scopes the shared hljs token theme
      // (styles/highlight.css) to this block. `language-X` is kept for
      // external tooling / copy semantics.
      const codeClass = `hljs${language ? ` language-${escapeHtml(language)}` : ''}`;
      const header =
        '<div class="code-block-header">' +
        `<span class="code-block-lang">${langLabel ? escapeHtml(langLabel) : ''}</span>` +
        '<button class="code-block-copy" type="button" aria-label="Copy code">Copy</button>' +
        '</div>';
      const toggle = collapsible
        ? `<button class="code-block-toggle" type="button" aria-expanded="false">Show all ${lineCount} lines</button>`
        : '';
      const wrapperClass = collapsible
        ? 'code-block code-block-collapsible code-block-collapsed hljs-scope'
        : 'code-block hljs-scope';
      return (
        `<div class="${wrapperClass}">` +
        header +
        `<pre><code class="${codeClass}">${html}</code></pre>` +
        toggle +
        '</div>'
      );
    },
  },
});

export function renderMarkdown(text: string): string {
  const raw = marked.parse(text) as string;
  // Wrap GFM tables so they can scroll horizontally in a narrow sidebar.
  const withTableWrappers = raw
    .replace(/<table>/g, '<div class="md-table-wrap"><table>')
    .replace(/<\/table>/g, '</table></div>');
  return DOMPurify.sanitize(withTableWrappers, { RETURN_DOM: false });
}

export function reasoningSummary(text: string): string {
  const stripped = text
    .replace(/\*\*?(.*?)\*\*?/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/#{1,6}\s+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 80 ? stripped.slice(0, 80) + '...' : stripped;
}
