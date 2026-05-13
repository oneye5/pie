interface ClosestCapableEventTarget {
  closest: (selector: string) => unknown;
  parentElement?: ClosestCapableEventTarget | null;
}

interface MaybeClosestCapableEventTarget {
  closest?: (selector: string) => unknown;
  parentElement?: MaybeClosestCapableEventTarget | null;
}

const USER_MESSAGE_EDIT_BLOCKING_SELECTOR = [
  'a',
  'button',
  'input',
  'textarea',
  'select',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable=""]',
  '[contenteditable="true"]',
].join(', ');
const SUBAGENT_CONTEXT_MENU_BLOCKING_SELECTOR = '.message';

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

export function shouldOpenUserMessageEditor(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  return candidate.closest!(USER_MESSAGE_EDIT_BLOCKING_SELECTOR) == null;
}

export function shouldOpenSubagentContextMenu(target: EventTarget | null): boolean {
  const candidate = resolveClosestCapableTarget(target);
  if (!candidate) {
    return true;
  }

  return candidate.closest!(SUBAGENT_CONTEXT_MENU_BLOCKING_SELECTOR) == null;
}
