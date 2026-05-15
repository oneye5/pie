/**
 * Runtime validators for the host ↔ webview protocol.
 *
 * These guards are intentionally **hand-rolled and dependency-free** so they
 * can live in `shared/` (consumed by both backend and host) without pulling a
 * schema library into the webview bundle. They mirror the static types in
 * `./protocol.ts` and exist to catch protocol drift at the trust boundaries:
 *
 *   - Webview → host messages arrive as untyped JSON over `postMessage`.
 *     Bugs in the webview or a future fuzz/attacker could send malformed
 *     envelopes; the host should detect and log this rather than implicitly
 *     trusting `as WebviewToHostMessage`.
 *   - Backend ↔ host messages arrive as JSON-line envelopes; the existing
 *     `isEventEnvelope` / `isResponseEnvelope` checks only validate the outer
 *     shape, not the payload kind.
 *
 * Today the only consumer is `SidebarViewProvider` (audit-only logging — does
 * **not** drop messages). Tighten to rejection once the audit log is clean.
 */

import type {
  ChatPrefs,
  ComposerInputDraft,
  RunOutcome,
  ThinkingLevel,
  WebviewToHostMessage,
} from './protocol';

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
];

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value);
}

function validateComposerInputDraft(value: unknown): value is ComposerInputDraft {
  if (!isObject(value)) return false;
  switch (value.kind) {
    case 'filesystemPathRef':
      return (
        isString(value.path)
        && isString(value.name)
        && (value.source === 'picker' || value.source === 'drop')
      );
    case 'imageBlob':
      return (
        isString(value.mimeType)
        && isString(value.name)
        && isFiniteNumber(value.sizeBytes)
        && isString(value.dataBase64)
        && (value.source === 'paste' || value.source === 'drop')
      );
    case 'fileBlob':
      return (
        isString(value.mimeType)
        && isString(value.name)
        && isFiniteNumber(value.sizeBytes)
        && isString(value.dataBase64)
        && (value.source === 'paste' || value.source === 'drop')
      );
    default:
      return false;
  }
}

function validateRunOutcome(value: unknown): value is RunOutcome {
  return (
    isObject(value)
    && (value.resolution === 'resolved'
      || value.resolution === 'partially_resolved'
      || value.resolution === 'unresolved')
    && isFiniteNumber(value.satisfaction)
  );
}

function validateChatPrefsPatch(value: unknown): value is Partial<ChatPrefs> {
  if (!isObject(value)) return false;
  const booleanKeys: Array<keyof ChatPrefs> = [
    'autoExpandReasoning',
    'autoExpandToolCalls',
    'autoExpandSubagentCalls',
    'suppressCompletionNotifications',
  ];
  for (const key of Object.keys(value)) {
    if (!(booleanKeys as string[]).includes(key)) return false;
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== 'boolean') return false;
  }
  return true;
}

/**
 * Validate a JSON value as a `WebviewToHostMessage`. Returns a discriminated
 * union: `{ ok: true, value }` on success, `{ ok: false, reason }` on failure.
 *
 * Validation depth: outer envelope plus the fields the host actually branches
 * on. Deeper payload validation (e.g. exhaustive composer-input checks) is
 * intentionally light — the host is expected to defensively narrow before
 * acting on individual fields, and over-strict gating here would force the
 * validator to track every future protocol addition.
 */
export function validateWebviewToHostMessage(
  value: unknown,
): ValidationResult<WebviewToHostMessage> {
  if (!isObject(value)) return fail('not an object');
  const type = value.type;
  if (!isString(type)) return fail('missing string `type`');

  switch (type) {
    case 'ready':
    case 'refreshState':
    case 'requestSnapshot':
    case 'openFilePicker':
    case 'interrupt':
    case 'newSession':
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openFile':
      if (!isString(value.path)) return fail('openFile: missing string `path`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'addComposerInput':
      if (!isString(value.sessionPath)) return fail('addComposerInput: missing `sessionPath`');
      if (!validateComposerInputDraft(value.input)) return fail('addComposerInput: invalid `input`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'removeComposerInput':
      if (!isString(value.sessionPath)) return fail('removeComposerInput: missing `sessionPath`');
      if (!isString(value.inputId)) return fail('removeComposerInput: missing `inputId`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'send':
      if (!isString(value.text)) return fail('send: missing string `text`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'editMessage':
      if (!isString(value.messageId)) return fail('editMessage: missing `messageId`');
      if (!isString(value.text)) return fail('editMessage: missing `text`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'openSession':
    case 'closeSession':
      if (!isString(value.sessionPath)) return fail(`${type}: missing string \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'moveSessionTab':
      if (!isOptionalString(value.sessionPath)) return fail('moveSessionTab: bad `sessionPath`');
      if (!isFiniteNumber(value.fromIndex)) return fail('moveSessionTab: missing `fromIndex`');
      if (!isFiniteNumber(value.toIndex)) return fail('moveSessionTab: missing `toIndex`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'loadOlderTranscript':
    case 'loadNewerTranscript':
    case 'jumpToLatestTranscript':
      if (!isOptionalString(value.sessionPath)) return fail(`${type}: bad \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'recordOutcome':
      if (!isString(value.sessionPath)) return fail('recordOutcome: missing `sessionPath`');
      if (!validateRunOutcome(value.outcome)) return fail('recordOutcome: invalid `outcome`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'startNewTask':
    case 'continueTask':
      if (!isString(value.sessionPath)) return fail(`${type}: missing string \`sessionPath\``);
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setModel':
      if (!isOptionalString(value.sessionPath)) return fail('setModel: bad `sessionPath`');
      if (!isString(value.defaultModel)) return fail('setModel: missing `defaultModel`');
      if (!isThinkingLevel(value.defaultThinkingLevel)) return fail('setModel: invalid `defaultThinkingLevel`');
      return { ok: true, value: value as WebviewToHostMessage };

    case 'setPrefs':
      if (!validateChatPrefsPatch(value.prefs)) return fail('setPrefs: invalid `prefs` patch');
      return { ok: true, value: value as WebviewToHostMessage };

    default:
      return fail(`unknown message type: ${type}`);
  }
}
