/**
 * DOM environment helper for extension webview tests.
 * Installs happy-dom globals so Preact components can mount.
 */
import { Window } from 'happy-dom';

let installed = false;

function installGlobal(key: PropertyKey, value: unknown): void {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);

  if (!descriptor || descriptor.writable || descriptor.set) {
    try {
      (globalThis as Record<PropertyKey, unknown>)[key] = value;
      return;
    } catch {
      // Fall through to defineProperty for getter-only globals like navigator.
    }
  }

  if (descriptor?.configurable === false) {
    return;
  }

  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

export function installDom(): void {
  if (installed) return;
  installed = true;

  const window = new Window({ url: 'http://localhost' });

  // Install core DOM globals
  const globals = [
    'document', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement',
    'HTMLDivElement', 'HTMLButtonElement', 'HTMLFormElement',
    'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent',
    'MessageEvent', 'CustomEvent', 'InputEvent',
    'MutationObserver', 'SVGElement', 'navigator',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
    'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  ] as const;

  for (const key of globals) {
    if ((window as any)[key] !== undefined) {
      installGlobal(key, (window as any)[key]);
    }
  }

  // Set window itself
  installGlobal('window', window);

  // Stub ResizeObserver (happy-dom doesn't provide one)
  if (typeof globalThis.ResizeObserver === 'undefined') {
    (globalThis as any).ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }

  // Stub IntersectionObserver
  if (typeof (globalThis as any).IntersectionObserver === 'undefined') {
    (globalThis as any).IntersectionObserver = class IntersectionObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

export function cleanupDom(): void {
  // Nothing to tear down per-test; globals stay for the process.
}
