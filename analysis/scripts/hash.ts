import * as crypto from 'node:crypto';

export function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hashToPrefix(value: string, length = 12): string {
  return sha256Hex(value).slice(0, length);
}

// Note: hashToPrefix truncates SHA-256 to the first `length` hex chars.
// For length=12 (default), this gives 2^48 collision resistance, which
// is sufficient for grouping runs by session path. For deduplication or
// unique identification, use the full SHA-256 hash instead.
export function existingHashPrefix(value: string | null | undefined, length = 12): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, Math.min(length, trimmed.length)) : null;
}
