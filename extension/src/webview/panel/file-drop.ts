import type { ComposerInputDraft } from '../../shared/protocol';

type FileLike = File | {
  path?: string;
  type?: string;
  name?: string;
  size?: number;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

type DataTransferItemLike = {
  kind?: string;
  type?: string;
  getAsFile?: () => FileLike | null;
};

type DataTransferLike = {
  types?: ArrayLike<string> | readonly string[];
  files?: ArrayLike<FileLike>;
  items?: ArrayLike<DataTransferItemLike>;
  getData: (format: string) => string;
};

export interface ComposerTransferExtraction {
  inputs: ComposerInputDraft[];
  unsupportedInputs: Array<Extract<ComposerInputDraft, { kind: 'fileBlob' }>>;
  rejectedFiles: string[];
}

const FILES_TYPE = 'Files';
const CODE_FILES_TYPE = 'CodeFiles';
const CODE_EDITORS_TYPE = 'CodeEditors';
const RESOURCE_URLS_TYPE = 'ResourceURLs';
const URI_LIST_TYPE = 'text/uri-list';
const INTERNAL_URI_LIST_TYPE = 'application/vnd.code.uri-list';
const PLAIN_TEXT_TYPE = 'text/plain';

export function canAcceptPathDrop(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) return false;

  // Hover-time checks must stay type-only because getData is not reliable until drop.
  // Be permissive for candidate path formats and decide what is really usable on drop.
  const types = normalizeTypes(dataTransfer.types);
  return (
    types.has(FILES_TYPE.toLowerCase()) ||
    types.has(CODE_FILES_TYPE.toLowerCase()) ||
    types.has(CODE_EDITORS_TYPE.toLowerCase()) ||
    types.has(RESOURCE_URLS_TYPE.toLowerCase()) ||
    types.has(URI_LIST_TYPE.toLowerCase()) ||
    types.has(PLAIN_TEXT_TYPE.toLowerCase()) ||
    types.has(INTERNAL_URI_LIST_TYPE.toLowerCase()) ||
    (dataTransfer.files?.length ?? 0) > 0
  );
}

export function canAcceptComposerTransfer(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  if (canAcceptPathDrop(dataTransfer)) {
    return true;
  }

  const files = extractTransferFiles(dataTransfer);
  return files.some((file) => isImageMimeType(file.type));
}

export function hasClipboardFilePayload(dataTransfer: DataTransferLike | null | undefined): boolean {
  if (!dataTransfer) {
    return false;
  }

  return extractTransferFiles(dataTransfer).length > 0;
}

export function extractDroppedPaths(dataTransfer: DataTransferLike | null | undefined): string[] {
  if (!dataTransfer) return [];

  const structuredPaths = extractStructuredDroppedPaths(dataTransfer);
  if (structuredPaths.length > 0) {
    return structuredPaths;
  }

  return extractPathsFromFiles(extractTransferFiles(dataTransfer));
}

export async function extractComposerInputs(
  dataTransfer: DataTransferLike | null | undefined,
  source: 'drop' | 'paste',
): Promise<ComposerTransferExtraction> {
  if (!dataTransfer) {
    return { inputs: [], unsupportedInputs: [], rejectedFiles: [] };
  }

  const inputs: ComposerInputDraft[] = [];
  const unsupportedInputs: Array<Extract<ComposerInputDraft, { kind: 'fileBlob' }>> = [];
  const rejectedFiles: string[] = [];
  const seenFilesystemPaths = new Set<string>();

  for (const path of extractStructuredDroppedPaths(dataTransfer)) {
    if (seenFilesystemPaths.has(path)) {
      continue;
    }
    seenFilesystemPaths.add(path);
    inputs.push({
      kind: 'filesystemPathRef',
      path,
      name: basename(path),
      source: source === 'drop' ? 'drop' : 'picker',
    });
  }

  const files = extractTransferFiles(dataTransfer);
  for (const file of files) {
    const imageInput = await fileToImageInput(file, source);
    if (imageInput) {
      inputs.push(imageInput);
      continue;
    }

    const path = normalizeAbsolutePath(resolveFilePath(file) ?? '');
    if (path) {
      if (seenFilesystemPaths.has(path)) {
        continue;
      }
      seenFilesystemPaths.add(path);
      inputs.push({
        kind: 'filesystemPathRef',
        path,
        name: basename(path),
        source: source === 'drop' ? 'drop' : 'picker',
      });
      continue;
    }

    if (looksLikeBlobFile(file)) {
      const name = (file.name ?? '').trim() || 'unnamed file';
      rejectedFiles.push(name);
      unsupportedInputs.push({
        kind: 'fileBlob',
        mimeType: (file.type ?? '').trim() || 'application/octet-stream',
        name,
        sizeBytes: typeof file.size === 'number' && Number.isFinite(file.size) ? file.size : 0,
        dataBase64: '',
        source,
      });
    }
  }

  return { inputs, unsupportedInputs, rejectedFiles };
}

export function formatComposerTransferError(rejectedFiles: string[]): string | null {
  if (rejectedFiles.length === 0) {
    return null;
  }

  if (rejectedFiles.length === 1) {
    return `Cannot attach ${rejectedFiles[0]}: arbitrary file blobs are not supported yet. Attach a filesystem path instead.`;
  }

  return `Cannot attach ${rejectedFiles.length} files: arbitrary file blobs are not supported yet. Attach filesystem paths instead.`;
}

function normalizeTypes(types: DataTransferLike['types']): Set<string> {
  const normalized = new Set<string>();
  if (!types) return normalized;

  for (let index = 0; index < types.length; index += 1) {
    const value = types[index];
    if (typeof value === 'string' && value.length > 0) {
      normalized.add(value.toLowerCase());
    }
  }

  return normalized;
}

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

function extractTransferFiles(dataTransfer: DataTransferLike): FileLike[] {
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

function safeGetData(dataTransfer: DataTransferLike, format: string): string {
  try {
    return dataTransfer.getData(format) ?? '';
  } catch {
    return '';
  }
}

function extractStructuredDroppedPaths(dataTransfer: DataTransferLike): string[] {
  const codeFilePaths = extractPathsFromCodeFiles(safeGetData(dataTransfer, CODE_FILES_TYPE));
  if (codeFilePaths.length > 0) {
    return codeFilePaths;
  }

  const resourcePaths = extractPathsFromResourceUrls(safeGetData(dataTransfer, RESOURCE_URLS_TYPE));
  if (resourcePaths.length > 0) {
    return resourcePaths;
  }

  const editorPaths = extractPathsFromCodeEditors(safeGetData(dataTransfer, CODE_EDITORS_TYPE));
  if (editorPaths.length > 0) {
    return editorPaths;
  }

  const uriListPaths = extractPathsFromUriPayload(
    safeGetData(dataTransfer, INTERNAL_URI_LIST_TYPE) || safeGetData(dataTransfer, URI_LIST_TYPE),
  );
  if (uriListPaths.length > 0) {
    return uriListPaths;
  }

  const plainTextPaths = extractPathsFromPlainText(safeGetData(dataTransfer, PLAIN_TEXT_TYPE));
  if (plainTextPaths.length > 0) {
    return plainTextPaths;
  }

  return [];
}

function extractPathsFromUriPayload(value: string): string[] {
  if (!value.trim()) return [];

  const jsonUris = parseJsonStringArray(value)
    .map(fileUriToFsPath)
    .filter((path): path is string => !!path);
  if (jsonUris.length > 0) {
    return dedupe(jsonUris);
  }

  const paths: string[] = [];
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const path = fileUriToFsPath(line);
    if (path) {
      paths.push(path);
    }
  }

  return dedupe(paths);
}

function extractPathsFromCodeFiles(value: string): string[] {
  const parsed = parseJsonStringArray(value).map(normalizeAbsolutePath).filter((path): path is string => !!path);
  return dedupe(parsed);
}

function extractPathsFromResourceUrls(value: string): string[] {
  const parsed = parseJsonStringArray(value).map(fileUriToFsPath).filter((path): path is string => !!path);
  return dedupe(parsed);
}

function extractPathsFromCodeEditors(value: string): string[] {
  if (!value.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];
  const paths = parsed
    .map((entry) => extractPathFromEditorEntry(entry))
    .filter((path): path is string => !!path);
  return dedupe(paths);
}

function extractPathsFromPlainText(value: string): string[] {
  if (!value.trim()) return [];

  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return [];

  const paths: string[] = [];
  for (const line of lines) {
    const uriPath = fileUriToFsPath(line);
    if (uriPath) {
      paths.push(uriPath);
      continue;
    }

    const normalizedPath = normalizeAbsolutePath(line);
    if (!normalizedPath) {
      return [];
    }
    paths.push(normalizedPath);
  }

  return dedupe(paths);
}

function extractPathsFromFiles(files: ArrayLike<FileLike> | undefined): string[] {
  if (!files || files.length === 0) return [];

  const paths: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index] as (FileLike & { path?: string }) | undefined;
    const path = normalizeAbsolutePath(file?.path ?? '');
    if (path) {
      paths.push(path);
    }
  }

  return dedupe(paths);
}

function extractPathFromEditorEntry(entry: unknown): string | null {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const resource = (entry as Record<string, unknown>)['resource'];
  if (typeof resource === 'string') {
    return fileUriToFsPath(resource);
  }

  if (!resource || typeof resource !== 'object') {
    return null;
  }

  const scheme = (resource as Record<string, unknown>)['scheme'];
  const path = (resource as Record<string, unknown>)['path'];
  const authority = (resource as Record<string, unknown>)['authority'];
  if (scheme !== 'file' || typeof path !== 'string') {
    return null;
  }

  if (typeof authority === 'string' && authority.length > 0 && authority !== 'localhost') {
    return `\\\\${authority}${path.replace(/\//g, '\\')}`;
  }

  if (/^\/[A-Za-z]:/.test(path)) {
    return path.slice(1).replace(/\//g, '\\');
  }

  return path;
}

function parseJsonStringArray(value: string): string[] {
  if (!value.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter((entry): entry is string => typeof entry === 'string');
}

function fileUriToFsPath(rawValue: string): string | null {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    return null;
  }

  if (url.protocol !== 'file:') {
    return null;
  }

  const host = decodeURIComponent(url.hostname);
  const pathname = decodeURIComponent(url.pathname);
  if (/^\/[A-Za-z]:/.test(pathname)) {
    return pathname.slice(1).replace(/\//g, '\\');
  }

  if (host && host !== 'localhost') {
    return `\\\\${host}${pathname.replace(/\//g, '\\')}`;
  }

  return pathname;
}

function normalizeAbsolutePath(value: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return value.replace(/\//g, '\\');
  }

  if (/^\\\\[^\\]+\\[^\\]+/.test(value)) {
    return value.replace(/\//g, '\\');
  }

  if (value.startsWith('/')) {
    return value;
  }

  return null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function resolveFilePath(file: FileLike): string | undefined {
  return 'path' in file && typeof file.path === 'string' ? file.path : undefined;
}

function basename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

function isImageMimeType(value: string | undefined): boolean {
  return typeof value === 'string' && /^image\//i.test(value.trim());
}

function looksLikeBlobFile(file: FileLike): boolean {
  return !!(
    (typeof file.type === 'string' && file.type.trim().length > 0) ||
    typeof file.size === 'number' ||
    (typeof file.name === 'string' && file.name.trim().length > 0)
  );
}

async function fileToImageInput(
  file: FileLike,
  source: 'drop' | 'paste',
): Promise<Extract<ComposerInputDraft, { kind: 'imageBlob' }> | null> {
  if (!isImageMimeType(file.type) || typeof file.arrayBuffer !== 'function') {
    return null;
  }

  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
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
