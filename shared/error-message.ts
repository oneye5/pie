/** Canonical error-normalization helpers shared across all packages
 *  (extension host/backend, webview, analysis CLI, and pi extensions).
 *
 *  Every catch site and every user-facing failure path should funnel through
 *  `toErrorMessage` so thrown values are normalized consistently regardless
 *  of shape (Error, string, {message}, {error}, {code}, null/undefined).
 *
 *  User-facing JSON reads of config/data files should use `parseJsonOrThrow`
 *  so a malformed file produces a message that names what was being parsed
 *  (and where the parse failed) instead of a bare "Unexpected token X". */

/** Normalize any thrown value into a human-readable message string.
 *  Handles Error, string, {message}, {error}, {code}, null/undefined. */
export function toErrorMessage(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.message === 'string' && e.message.length > 0) return e.message;
    if (typeof e.error === 'string' && e.error.length > 0) return e.error;
    if (typeof e.code === 'string' && e.code.length > 0) return e.code;
  }
  return String(err);
}

/** Parse JSON, throwing a contextual Error that names what was being parsed
 *  (`label`) so callers see e.g. "settings.json: invalid JSON — Unexpected
 *  token } in JSON at position 42" rather than a bare SyntaxError. Use for
 *  user-facing config/data file reads where a corrupt file should surface a
 *  useful message. */
export function parseJsonOrThrow<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`${label}: invalid JSON — ${err.message}`);
    }
    throw new Error(`${label}: ${toErrorMessage(err)}`);
  }
}