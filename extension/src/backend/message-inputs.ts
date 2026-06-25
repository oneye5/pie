import type { ComposerInput, ModelInputKind } from '../shared/protocol';
import type { SdkImageContent } from './sdk';

export { normalizeThinkingLevel } from '../shared/thinking-level.js';

function normalizeModelInputKinds(value: unknown): ModelInputKind[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const kinds = [...new Set(
    value.filter((kind): kind is ModelInputKind => kind === 'text' || kind === 'image'),
  )];

  if (kinds.length === 0) {
    return ['text'];
  }

  return kinds.includes('text') ? kinds : ['text', ...kinds];
}

export function resolveModelInputKinds(model: Record<string, unknown>): ModelInputKind[] {
  return normalizeModelInputKinds(model['input']) ?? ['text'];
}

function lowerFilesystemPathRefs(inputs: ComposerInput[]): string[] {
  return inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'filesystemPathRef' }> =>
      input.kind === 'filesystemPathRef')
    .map((input) => `@${input.path}`);
}

export function lowerImageInputs(inputs: ComposerInput[]): SdkImageContent[] {
  return inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'imageBlob' }> => input.kind === 'imageBlob')
    .map((input) => ({
      type: 'image',
      data: input.dataBase64,
      mimeType: input.mimeType,
    }));
}

export function buildPromptText(text: string, inputs: ComposerInput[]): string {
  const sections: string[] = [];
  const pathPrelude = lowerFilesystemPathRefs(inputs);
  if (pathPrelude.length > 0) {
    sections.push(pathPrelude.join('\n'));
  }
  if (text.trim()) {
    sections.push(text);
  }
  return sections.join('\n\n');
}
