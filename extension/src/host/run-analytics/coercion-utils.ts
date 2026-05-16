import type { ComposerInput, RunOutcome } from '../../shared/protocol';

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isRunOutcome(value: unknown): value is RunOutcome {
  return !!value
    && typeof value === 'object'
    && 'resolution' in value
    && 'satisfaction' in value
    && typeof (value as { resolution: unknown }).resolution === 'string'
    && typeof (value as { satisfaction: unknown }).satisfaction === 'number';
}

export function isInputKindArray(value: unknown): value is Array<ComposerInput['kind']> {
  return Array.isArray(value)
    && value.every((item) => item === 'filesystemPathRef' || item === 'imageBlob' || item === 'fileBlob');
}

export function toNonNegativeInteger(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.trunc(value);
}

export function coerceStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
