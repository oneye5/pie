export const NEW_SESSION_NAME = 'New Session';
const MAX_SESSION_NAME_LENGTH = 40;

export interface DerivedSessionName {
  name: string;
  isPlaceholder: boolean;
}

export function deriveSessionNameFromText(text: string | null | undefined): DerivedSessionName {
  const trimmed = text?.replace(/\s+/g, ' ').trim() ?? '';
  if (!trimmed) {
    return { name: NEW_SESSION_NAME, isPlaceholder: true };
  }

  return {
    name: trimmed.length > MAX_SESSION_NAME_LENGTH
      ? `${trimmed.slice(0, MAX_SESSION_NAME_LENGTH)}\u2026`
      : trimmed,
    isPlaceholder: false,
  };
}
