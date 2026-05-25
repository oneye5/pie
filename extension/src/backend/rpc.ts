import type { ComposerInput, ModelSettings, ThinkingLevel, TranscriptPageDirection } from '../shared/protocol';
import { ALLOWED_IMAGE_MIME_TYPES, MAX_IMAGE_INPUT_BYTES } from '../shared/image-constraints';

export { MAX_IMAGE_INPUT_BYTES } from '../shared/image-constraints';

// ─── Argument parsing ────────────────────────────────────────────────────────

export interface BackendArgs {
  sdkPath: string;
  cwd: string;
}

export function parseArgs(argv: string[]): BackendArgs {
  let sdkPath = '';
  let cwd = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--sdkPath' && value) {
      sdkPath = value;
      index += 1;
      continue;
    }
    if (arg === '--cwd' && value) {
      cwd = value;
      index += 1;
    }
  }

  if (!sdkPath) {
    throw new Error('Missing required --sdkPath argument.');
  }

  return { sdkPath, cwd };
}

// ─── RPC parameter validation ────────────────────────────────────────────────

export interface SessionPathParams {
  sessionPath: string;
}

export interface SessionPathOptionalParams {
  sessionPath?: string;
}

export interface MessageSendParams {
  sessionPath: string;
  text: string;
  inputs: ComposerInput[];
}

export interface SessionCreateParams {
  cwd?: string;
  selectionToken?: string;
}

export interface SessionOpenParams extends SessionPathParams {
  selectionToken?: string;
}

const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];



function isObj(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function fail(method: string, detail: string): never {
  throw new Error(`Invalid params for ${method}: ${detail}`);
}

function readSelectionToken(method: string, params: Record<string, unknown>): string | undefined {
  const selectionToken = params['selectionToken'];
  if (selectionToken !== undefined && typeof selectionToken !== 'string') {
    fail(method, 'selectionToken must be a string when provided');
  }
  return selectionToken as string | undefined;
}

export function validateSessionPath(method: string, params: unknown): SessionPathParams {
  if (!isObj(params) || typeof params['sessionPath'] !== 'string' || !params['sessionPath']) {
    fail(method, 'requires a string sessionPath');
  }
  return { sessionPath: params['sessionPath'] as string };
}

export function validateSessionPathOptional(params: unknown): SessionPathOptionalParams {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) return {};
  const sp = params['sessionPath'];
  if (sp !== undefined && typeof sp !== 'string') {
    fail('<rpc>', 'sessionPath must be a string when provided');
  }
  return { sessionPath: sp as string | undefined };
}

export function validateSessionCreate(params: unknown): SessionCreateParams {
  if (params === undefined || params === null) return {};
  if (!isObj(params)) fail('session.create', 'expected an object');
  const cwd = (params as Record<string, unknown>)['cwd'];
  if (cwd !== undefined && typeof cwd !== 'string') {
    fail('session.create', 'cwd must be a string when provided');
  }
  return {
    cwd: cwd as string | undefined,
    selectionToken: readSelectionToken('session.create', params),
  };
}

export function validateSessionOpen(params: unknown): SessionOpenParams {
  if (!isObj(params)) fail('session.open', 'expected an object');
  const { sessionPath } = validateSessionPath('session.open', params);
  return {
    sessionPath,
    selectionToken: readSelectionToken('session.open', params),
  };
}

export interface LoadTranscriptPageParams extends SessionPathParams {
  direction: TranscriptPageDirection;
  loadedStart?: number;
  loadedEnd?: number;
}

const TRANSCRIPT_PAGE_DIRECTIONS: TranscriptPageDirection[] = ['older', 'newer', 'latest'];

export function validateLoadTranscriptPage(params: unknown): LoadTranscriptPageParams {
  if (!isObj(params)) {
    fail('session.loadTranscriptPage', 'expected an object');
  }

  const sessionPath = params['sessionPath'];
  if (typeof sessionPath !== 'string' || !sessionPath) {
    fail('session.loadTranscriptPage', 'requires a string sessionPath');
  }

  const direction = params['direction'];
  if (typeof direction !== 'string' || !TRANSCRIPT_PAGE_DIRECTIONS.includes(direction as TranscriptPageDirection)) {
    fail('session.loadTranscriptPage', `direction must be one of ${TRANSCRIPT_PAGE_DIRECTIONS.join(', ')}`);
  }

  const loadedStartRaw = params['loadedStart'];
  const loadedEndRaw = params['loadedEnd'];

  if (loadedStartRaw !== undefined && (!Number.isInteger(loadedStartRaw) || Number(loadedStartRaw) < 0)) {
    fail('session.loadTranscriptPage', 'loadedStart must be a non-negative integer when provided');
  }

  if (loadedEndRaw !== undefined && (!Number.isInteger(loadedEndRaw) || Number(loadedEndRaw) < 0)) {
    fail('session.loadTranscriptPage', 'loadedEnd must be a non-negative integer when provided');
  }

  const loadedStart = typeof loadedStartRaw === 'number' ? loadedStartRaw : undefined;
  const loadedEnd = typeof loadedEndRaw === 'number' ? loadedEndRaw : undefined;

  if (loadedStart !== undefined && loadedEnd !== undefined && loadedStart > loadedEnd) {
    fail('session.loadTranscriptPage', 'loadedStart must be less than or equal to loadedEnd when both are provided');
  }

  return {
    sessionPath,
    direction: direction as TranscriptPageDirection,
    loadedStart,
    loadedEnd,
  };
}

export interface TruncateAfterParams {
  sessionPath: string;
  entryId: string;
}

export function validateTruncateAfter(params: unknown): TruncateAfterParams {
  if (!isObj(params)) fail('session.truncateAfter', 'expected an object');
  const sp = (params as Record<string, unknown>)['sessionPath'];
  if (typeof sp !== 'string' || !sp) fail('session.truncateAfter', 'requires a string sessionPath');
  const eid = (params as Record<string, unknown>)['entryId'];
  if (typeof eid !== 'string' || !eid) fail('session.truncateAfter', 'requires a string entryId');
  return { sessionPath: sp as string, entryId: eid as string };
}

function validateComposerInput(input: unknown, index: number): ComposerInput {
  if (!isObj(input)) {
    fail('message.send', `inputs[${index}] must be an object`);
  }

  const id = input['id'];
  const kind = input['kind'];
  if (typeof id !== 'string' || !id) {
    fail('message.send', `inputs[${index}].id must be a non-empty string`);
  }
  if (typeof kind !== 'string' || !kind) {
    fail('message.send', `inputs[${index}].kind must be a non-empty string`);
  }

  if (kind === 'filesystemPathRef') {
    const path = input['path'];
    const name = input['name'];
    const source = input['source'];
    if (typeof path !== 'string' || !path) {
      fail('message.send', `inputs[${index}].path must be a non-empty string`);
    }
    if (typeof name !== 'string' || !name) {
      fail('message.send', `inputs[${index}].name must be a non-empty string`);
    }
    if (source !== 'picker' && source !== 'drop') {
      fail('message.send', `inputs[${index}].source must be "picker" or "drop"`);
    }

    return {
      id,
      kind,
      path,
      name,
      source,
    };
  }

  if (kind === 'imageBlob') {
    const mimeType = input['mimeType'];
    const name = input['name'];
    const sizeBytes = input['sizeBytes'];
    const dataBase64 = input['dataBase64'];
    const source = input['source'];
    const width = input['width'];
    const height = input['height'];

    if (typeof mimeType !== 'string' || !ALLOWED_IMAGE_MIME_TYPES.has(mimeType.toLowerCase())) {
      fail('message.send', `inputs[${index}].mimeType must be one of ${[...ALLOWED_IMAGE_MIME_TYPES].join(', ')}`);
    }
    if (typeof name !== 'string' || !name) {
      fail('message.send', `inputs[${index}].name must be a non-empty string`);
    }
    if (typeof sizeBytes !== 'number' || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      fail('message.send', `inputs[${index}].sizeBytes must be a positive number`);
    }
    if (sizeBytes > MAX_IMAGE_INPUT_BYTES) {
      fail('message.send', `inputs[${index}] exceeds the ${MAX_IMAGE_INPUT_BYTES} byte image limit`);
    }
    if (typeof dataBase64 !== 'string' || !dataBase64.trim()) {
      fail('message.send', `inputs[${index}].dataBase64 must be a non-empty string`);
    }
    if (source !== 'paste' && source !== 'drop') {
      fail('message.send', `inputs[${index}].source must be "paste" or "drop"`);
    }
    if (width !== undefined && (typeof width !== 'number' || !Number.isFinite(width) || width <= 0)) {
      fail('message.send', `inputs[${index}].width must be a positive number when provided`);
    }
    if (height !== undefined && (typeof height !== 'number' || !Number.isFinite(height) || height <= 0)) {
      fail('message.send', `inputs[${index}].height must be a positive number when provided`);
    }

    return {
      id,
      kind,
      mimeType,
      name,
      sizeBytes,
      dataBase64,
      width,
      height,
      source,
    };
  }

  if (kind === 'fileBlob') {
    fail('message.send', 'Arbitrary pasted file attachments are not supported yet. Please attach a filesystem path instead.');
  }

  fail('message.send', `inputs[${index}].kind is not supported: ${String(kind)}`);
}

export function validateMessageSend(params: unknown): MessageSendParams {
  if (!isObj(params)) fail('message.send', 'expected an object');
  const text = (params as Record<string, unknown>)['text'];
  if (typeof text !== 'string') {
    fail('message.send', 'text must be a string');
  }
  const sp = (params as Record<string, unknown>)['sessionPath'];
  if (typeof sp !== 'string' || !sp) {
    fail('message.send', 'requires a string sessionPath');
  }

  const rawInputs = (params as Record<string, unknown>)['inputs'];
  let inputs: ComposerInput[] = [];
  if (rawInputs !== undefined) {
    if (!Array.isArray(rawInputs)) {
      fail('message.send', 'inputs must be an array when provided');
    }
    inputs = rawInputs.map((input, index) => validateComposerInput(input, index));
  }

  if (!text.trim() && inputs.length === 0) {
    fail('message.send', 'requires non-empty text or at least one input');
  }

  return { text: text as string, sessionPath: sp as string, inputs };
}

export interface RuntimePrefsSetParams {
  providerToggles: Record<string, boolean>;
  extensionToggles: Record<string, boolean>;
}

export interface SettingsSetParams extends Partial<ModelSettings> {
  sessionPath?: string;
}

function validateBooleanMap(
  method: string,
  fieldName: string,
  raw: unknown,
): Record<string, boolean> {
  if (raw === undefined) return {};
  if (!isObj(raw) || Array.isArray(raw)) {
    fail(method, `${fieldName} must be an object when provided`);
  }
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'boolean') {
      // Keys with non-identifier characters (e.g. "skill-pruner") render with
      // bracket notation so the error message is parseable.
      const isIdentLike = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
      const path = isIdentLike ? `${fieldName}.${key}` : `${fieldName}['${key}']`;
      fail(method, `${path} must be a boolean`);
    }
    out[key] = value;
  }
  return out;
}

export function validateRuntimePrefsSet(params: unknown): RuntimePrefsSetParams {
  if (!isObj(params)) fail('runtimePrefs.set', 'expected an object');
  const providerToggles = validateBooleanMap(
    'runtimePrefs.set',
    'providerToggles',
    (params as Record<string, unknown>)['providerToggles'],
  );
  const extensionToggles = validateBooleanMap(
    'runtimePrefs.set',
    'extensionToggles',
    (params as Record<string, unknown>)['extensionToggles'],
  );
  return { providerToggles, extensionToggles };
}

export function validateSettingsSet(params: unknown): SettingsSetParams {
  if (!isObj(params)) fail('settings.set', 'expected an object');
  const out: SettingsSetParams = {};
  const sessionPath = (params as Record<string, unknown>)['sessionPath'];
  if (sessionPath !== undefined) {
    if (typeof sessionPath !== 'string' || !sessionPath) {
      fail('settings.set', 'sessionPath must be a non-empty string when provided');
    }
    out.sessionPath = sessionPath;
  }
  const dm = (params as Record<string, unknown>)['defaultModel'];
  if (dm !== undefined) {
    if (typeof dm !== 'string') fail('settings.set', 'defaultModel must be a string');
    out.defaultModel = dm;
  }
  const dt = (params as Record<string, unknown>)['defaultThinkingLevel'];
  if (dt !== undefined) {
    if (typeof dt !== 'string' || !THINKING_LEVELS.includes(dt as ThinkingLevel)) {
      fail('settings.set', `defaultThinkingLevel must be one of ${THINKING_LEVELS.join(',')}`);
    }
    out.defaultThinkingLevel = dt as ThinkingLevel;
  }
  return out;
}
