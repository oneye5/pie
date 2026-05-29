export type LocalMessageKind = 'send' | 'edit';

function randomIdFragment(): string {
  return Math.random().toString(36).slice(2);
}

export function createLocalMessageId(kind: LocalMessageKind = 'send'): string {
  const prefix = kind === 'edit' ? 'local:edit' : 'local';
  return `${prefix}:${Date.now()}:${randomIdFragment()}`;
}
