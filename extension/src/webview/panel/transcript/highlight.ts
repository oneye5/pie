/**
 * Syntax highlighting + readable formatting for expanded tool calls.
 *
 * Uses highlight.js with a small, explicitly-registered language set (yaml,
 * json, bash) so the bundle only carries the grammars we need. A bespoke
 * theme that maps hljs token classes onto the panel's `--panel-*` palette
 * lives in `styles/tool-call.css`, so highlighting adapts to the panel theme
 * without shipping a full hljs stylesheet.
 *
 * Tool results from the pi SDK use a `{ content: [{ type: "text", text }] }`
 * shape (with optional `details`). `textFromToolResult` extracts the human-
 * readable text from that shape — used to render shell output as a live
 * streaming terminal pane instead of burying it inside JSON.
 */

import hljs from 'highlight.js/lib/core';
import yamlLang from 'highlight.js/lib/languages/yaml';
import jsonLang from 'highlight.js/lib/languages/json';
import bashLang from 'highlight.js/lib/languages/bash';
import { stringify as stringifyYaml } from 'yaml';

hljs.registerLanguage('yaml', yamlLang);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bashLang);

export type HighlightLanguage = 'yaml' | 'json' | 'bash';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Highlight `code` for `language`, returning safe HTML with hljs token spans. */
export function highlight(code: string, language: HighlightLanguage): string {
  try {
    if (hljs.getLanguage(language)) {
      return hljs.highlight(code, { language }).value;
    }
  } catch {
    // fall through to escaped plain text
  }
  return escapeHtml(code);
}

export interface ToolResultContentPartLike {
  type?: string;
  text?: string;
}

/**
 * Extract concatenated text from a tool result's `content` parts (the SDK's
 * standard result shape). Returns `undefined` when there is no text content,
 * so callers can fall back to structured formatting.
 */
export function textFromToolResult(result: unknown): string | undefined {
  if (result == null) {
    return undefined;
  }
  if (typeof result === 'string') {
    return result || undefined;
  }
  if (typeof result !== 'object') {
    return undefined;
  }
  const content = (result as { content?: unknown }).content;
  if (typeof content === 'string') {
    return content || undefined;
  }
  if (Array.isArray(content)) {
    const text = content
      .filter(
        (part): part is ToolResultContentPartLike =>
          Boolean(part) && typeof part === 'object',
      )
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text ?? '')
      .join('\n\n');
    return text || undefined;
  }
  return undefined;
}

/**
 * True when a result object carries nothing but `content` (+ `details`
 * metadata) — i.e. it is essentially plain text, not structured data worth
 * showing field-by-field as YAML.
 */
export function isTextOnlyToolResult(result: unknown): boolean {
  if (result == null || typeof result !== 'object') {
    return true;
  }
  const keys = Object.keys(result as Record<string, unknown>);
  if (keys.length === 0) {
    return true;
  }
  return keys.every((key) => key === 'content' || key === 'details');
}

/** Format an arbitrary value as highlighted YAML HTML. Strings render as-is. */
export function formatValueAsHighlightedYaml(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  let text: string;
  try {
    // lineWidth: 0 disables line wrapping so code/paths stay intact.
    text = stringifyYaml(value, { indent: 2, lineWidth: 0 });
  } catch {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  return highlight(text, 'yaml');
}