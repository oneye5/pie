import * as path from 'node:path';

import * as vscode from 'vscode';

import { type RunObserver } from '../stats-service';
import type {
  ComposerInput,
  ComposerInputDraft,
  UserContentPart,
} from '../../shared/protocol';
import type { ArchState } from './arch-state';
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_INPUT_BYTES } from '../../shared/image-constraints';

export type GetArchState = () => ArchState;
export type MutateArchState = (recipe: (draft: ArchState) => void) => void;

export function normalizeAttachUris(uris: vscode.Uri[]): vscode.Uri[] {
  return uris.filter((uri) => uri.scheme === 'file');
}

export function upsertPendingComposerInput(
  sessionPath: string,
  input: ComposerInput,
  getArchState: GetArchState,
  mutateArchState: MutateArchState,
): void {
  const existingInputs = getArchState().composer.pendingComposerInputsBySession[sessionPath] ?? [];
  if (input.kind === 'filesystemPathRef') {
    const duplicate = existingInputs.some(
      (existing) => existing.kind === 'filesystemPathRef' && existing.path === input.path,
    );
    if (duplicate) {
      return;
    }
  }

  mutateArchState((draft) => {
    const list = (draft.composer.pendingComposerInputsBySession[sessionPath] ??= []);
    list.push(input);
  });
}

export function validateAndMaterializeComposerInput(
  sessionPath: string,
  inputDraft: ComposerInputDraft,
  createComposerInputId: () => string,
  scheduleRender: () => void,
  runObserver: RunObserver,
  getArchState: GetArchState,
  mutateArchState: MutateArchState,
): ComposerInput | null {
  if (inputDraft.kind === 'filesystemPathRef') {
    const filesystemPath = inputDraft.path.trim();
    if (!filesystemPath) {
      mutateArchState((draft) => { draft.settings.notice = 'Cannot attach file path: path is empty.'; });
      scheduleRender();
      return null;
    }

    return {
      id: createComposerInputId(),
      kind: 'filesystemPathRef',
      path: filesystemPath,
      name: inputDraft.name.trim() || path.basename(filesystemPath) || filesystemPath,
      source: inputDraft.source,
    };
  }

  if (inputDraft.kind === 'imageBlob') {
    const mimeType = inputDraft.mimeType.trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME_TYPES.has(mimeType)) {
      mutateArchState((draft) => { draft.settings.notice = `Cannot attach image: unsupported type ${inputDraft.mimeType}.`; });
      scheduleRender();
      return null;
    }
    if (!Number.isFinite(inputDraft.sizeBytes) || inputDraft.sizeBytes <= 0) {
      mutateArchState((draft) => { draft.settings.notice = 'Cannot attach image: invalid size.'; });
      scheduleRender();
      return null;
    }
    if (inputDraft.sizeBytes > MAX_IMAGE_INPUT_BYTES) {
      mutateArchState((draft) => {
        draft.settings.notice = `Cannot attach image: exceeds the ${MAX_IMAGE_INPUT_BYTES} byte limit.`;
      });
      scheduleRender();
      return null;
    }
    if (!inputDraft.dataBase64.trim()) {
      mutateArchState((draft) => { draft.settings.notice = 'Cannot attach image: missing image data.'; });
      scheduleRender();
      return null;
    }
    if (
      inputDraft.width !== undefined
      && (!Number.isFinite(inputDraft.width) || inputDraft.width <= 0)
    ) {
      mutateArchState((draft) => { draft.settings.notice = 'Cannot attach image: invalid width.'; });
      scheduleRender();
      return null;
    }
    if (
      inputDraft.height !== undefined
      && (!Number.isFinite(inputDraft.height) || inputDraft.height <= 0)
    ) {
      mutateArchState((draft) => { draft.settings.notice = 'Cannot attach image: invalid height.'; });
      scheduleRender();
      return null;
    }
    if (modelSupportsInputKind(sessionPath, undefined, 'image', getArchState) === false) {
      mutateArchState((draft) => { draft.settings.notice = 'The selected model does not support image inputs.'; });
      scheduleRender();
      return null;
    }

    return {
      id: createComposerInputId(),
      kind: 'imageBlob',
      mimeType,
      name: inputDraft.name.trim() || 'image',
      sizeBytes: inputDraft.sizeBytes,
      dataBase64: inputDraft.dataBase64,
      width: inputDraft.width,
      height: inputDraft.height,
      source: inputDraft.source,
    };
  }

  runObserver.onUnsupportedInputAttempt(sessionPath);
  mutateArchState((draft) => {
    draft.settings.notice =
      'Arbitrary pasted file attachments are not supported yet. Please attach a filesystem path instead.';
  });
  scheduleRender();
  return null;
}

export function modelSupportsInputKind(
  sessionPath: string,
  requestedModelId: string | undefined,
  inputKind: 'text' | 'image',
  getArchState: GetArchState = () => { throw new Error('getArchState not provided'); },
): boolean {
  const archState = getArchState();
  const modelId = requestedModelId
    ?? archState.sessions.sessions.find((s) => s.path === sessionPath)?.modelId
    ?? archState.settings.modelSettings?.defaultModel;
  if (!modelId) {
    return inputKind === 'text';
  }

  const directModels = archState.settings.availableModelsBySession[sessionPath] ?? [];
  const fallbackModels = Object.values(archState.settings.availableModelsBySession)
    .flatMap((models) => models);
  const model = [...directModels, ...fallbackModels].find((candidate) => candidate.id === modelId);
  if (!model) {
    return inputKind === 'text';
  }

  return model.inputKinds.includes(inputKind);
}

export function clearPendingImageInputs(
  sessionPath: string,
  getArchState: GetArchState,
  mutateArchState: MutateArchState,
): void {
  const existingInputs = getArchState().composer.pendingComposerInputsBySession[sessionPath] ?? [];
  const remainingInputs = existingInputs.filter((input) => input.kind !== 'imageBlob');
  if (remainingInputs.length === existingInputs.length) {
    return;
  }
  if (remainingInputs.length === 0) {
    mutateArchState((draft) => {
      delete draft.composer.pendingComposerInputsBySession[sessionPath];
    });
    return;
  }
  mutateArchState((draft) => {
    draft.composer.pendingComposerInputsBySession[sessionPath] = remainingInputs;
  });
}

export function buildPromptText(text: string, inputs: ComposerInput[]): string {
  const sections: string[] = [];
  const pathPrelude = inputs
    .filter((input): input is Extract<ComposerInput, { kind: 'filesystemPathRef' }> =>
      input.kind === 'filesystemPathRef')
    .map((input) => `@${input.path}`);
  if (pathPrelude.length > 0) {
    sections.push(pathPrelude.join('\n'));
  }
  if (text.trim()) {
    sections.push(text);
  }
  return sections.join('\n\n');
}

export function buildOptimisticUserParts(
  text: string,
  inputs: ComposerInput[],
): UserContentPart[] | undefined {
  const userParts: UserContentPart[] = [];
  const promptText = buildPromptText(text, inputs);
  if (promptText) {
    userParts.push({ kind: 'text', text: promptText });
  }

  for (const input of inputs) {
    if (input.kind !== 'imageBlob') {
      continue;
    }
    userParts.push({
      kind: 'image',
      mimeType: input.mimeType,
      dataBase64: input.dataBase64,
      name: input.name,
      width: input.width,
      height: input.height,
    });
  }

  return userParts.length > 0 ? userParts : undefined;
}