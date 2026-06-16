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