import { serializeJsonLine } from '../shared/jsonl';
import type { ErrorPayload, EventEnvelope, ResponseEnvelope } from '../shared/protocol';

export function writeStdout(value: EventEnvelope | ResponseEnvelope): void {
  process.stdout.write(serializeJsonLine(value));
}

export function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * A typed backend error carrying a stable `code` (uppercase SNAKE_CASE) so the
 * client can distinguish failure modes (invalid-params, streaming-busy,
 * model-unavailable, ...) instead of them all collapsing to `BACKEND_ERROR`.
 * Handlers that still throw plain `Error` keep working — `extractRequestError`
 * falls back to `BACKEND_ERROR` for them (backward-compatible).
 */
export class BackendError extends Error {
  readonly code: string;
  readonly data?: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
    if (data !== undefined) {
      this.data = data;
    }
  }
}

export function extractRequestError(error: unknown): ErrorPayload & { data?: unknown } {
  if (error instanceof BackendError) {
    const payload: ErrorPayload & { data?: unknown } = { code: error.code, message: error.message };
    if (error.data !== undefined) {
      payload.data = error.data;
    }
    return payload;
  }
  if (error instanceof Error) {
    return { code: 'BACKEND_ERROR', message: error.message };
  }
  return { code: 'BACKEND_ERROR', message: String(error) };
}

export function responseOk(id: string, result?: unknown): ResponseEnvelope {
  return { id, ok: true, result };
}

export function responseError(
  id: string,
  code: string,
  message: string,
  data?: unknown,
): ResponseEnvelope {
  return { id, ok: false, error: { code, message, data } };
}
