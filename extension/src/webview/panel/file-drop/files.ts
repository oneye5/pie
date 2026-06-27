import type { ComposerInputDraft } from '../../../shared/protocol';

import type { ComposerTransferSource, DataTransferLike, FileLike } from './types';

function normalizeFiles(files: ArrayLike<FileLike> | undefined): FileLike[] {
  if (!files || files.length === 0) {
    return [];
  }

  const normalized: FileLike[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (file) {
      normalized.push(file);
    }
  }
  return normalized;
}

export function extractTransferFiles(dataTransfer: DataTransferLike): FileLike[] {
  const files = normalizeFiles(dataTransfer.files);
  if (files.length > 0) {
    return files;
  }

  const items = dataTransfer.items;
  if (!items || items.length === 0) {
    return [];
  }

  const extracted: FileLike[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item || typeof item.getAsFile !== 'function') {
      continue;
    }

    const file = item.getAsFile();
    if (file) {
      extracted.push(file);
    }
  }

  return extracted;
}

export function hasClipboardFilePayload(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  return extractTransferFiles(dataTransfer).length > 0;
}

export function resolveFilePath(file: FileLike): string | undefined {
  return 'path' in file && typeof file.path === 'string' ? file.path : undefined;
}

export function isImageMimeType(value: string | undefined): boolean {
  return typeof value === 'string' && /^image\//i.test(value.trim());
}

export function looksLikeBlobFile(file: FileLike): boolean {
  return !!(
    (typeof file.type === 'string' && file.type.trim().length > 0) ||
    typeof file.size === 'number' ||
    (typeof file.name === 'string' && file.name.trim().length > 0)
  );
}

export async function fileToImageInput(
  file: FileLike,
  source: ComposerTransferSource,
): Promise<Extract<ComposerInputDraft, { kind: 'imageBlob' }> | null> {
  if (!isImageMimeType(file.type) || typeof file.arrayBuffer !== 'function') {
    return null;
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    // Unreadable file (e.g. revoked blob); skip this image.
    return null;
  }

  const sizeBytes = typeof file.size === 'number' && Number.isFinite(file.size)
    ? file.size
    : buffer.byteLength;

  return {
    kind: 'imageBlob',
    mimeType: file.type!.trim().toLowerCase(),
    name: (file.name ?? '').trim() || 'image',
    sizeBytes,
    dataBase64: arrayBufferToBase64(buffer),
    source,
  };
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  const CHUNK_SIZE = 0x8000;
  for (let index = 0; index < bytes.length; index += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK_SIZE));
  }
  return btoa(binary);
}
