import type { ActiveRunSummary } from '../../../shared/protocol';

interface ClosestCapableEventTarget {
  closest: (selector: string) => unknown;
  parentElement?: ClosestCapableEventTarget | null;
}

interface MaybeClosestCapableEventTarget {
  closest?: (selector: string) => unknown;
  parentElement?: MaybeClosestCapableEventTarget | null;
}

const GLOBAL_PASTE_BLOCKING_SELECTOR = [
  'input',
  'textarea',
  'select',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ');

function resolveClosestCapableTarget(target: EventTarget | null): ClosestCapableEventTarget | null {
  if (!target || typeof target !== 'object') {
    return null;
  }

  const candidate = target as MaybeClosestCapableEventTarget;
  if (typeof candidate.closest === 'function') {
    return candidate as ClosestCapableEventTarget;
  }

  if (candidate.parentElement && typeof candidate.parentElement.closest === 'function') {
    return candidate.parentElement as ClosestCapableEventTarget;
  }

  return null;
}

export function shouldHandleGlobalComposerPaste(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  return candidate.closest!(GLOBAL_PASTE_BLOCKING_SELECTOR) == null;
}

export function describeRunAnalyticsStatus(summary: ActiveRunSummary | null): string {
  switch (summary?.status) {
    case 'open':
      return 'Local analytics tracking';
    case 'closed_unscored':
      return 'Local analytics awaiting rating';
    case 'scored':
      return 'Local analytics scored';
    default:
      return 'Local analytics ready';
  }
}

export function describeImagePasteAffordance(supportsImageInputs: boolean): string {
  return supportsImageInputs
    ? 'Paste screenshots anywhere in chat'
    : 'Switch to an image-capable model to paste screenshots';
}
