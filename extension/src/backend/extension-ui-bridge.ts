import * as crypto from 'node:crypto';

import type { ExtensionUIRequestPayload, ExtensionUIResponsePayload } from '../shared/protocol';

interface PendingRequest {
  resolve: (response: ExtensionUIResponsePayload) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface ExtensionUIBridgeEmitter {
  (event: 'extension_ui.request', payload: ExtensionUIRequestPayload): void;
}

/**
 * Implements the SDK's ExtensionUIContext interface by emitting events to the
 * host and awaiting responses. Each confirm/select/input call creates a pending
 * promise that resolves when `resolveRequest()` is called with the matching id.
 */
export class ExtensionUIBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly emit: ExtensionUIBridgeEmitter;

  constructor(emit: ExtensionUIBridgeEmitter) {
    this.emit = emit;
  }

  async confirm(title: string, message: string, opts?: { timeout?: number }): Promise<boolean> {
    const id = crypto.randomUUID();
    const payload: ExtensionUIRequestPayload = { id, method: 'confirm', title, message, timeout: opts?.timeout };
    const response = await this.emitAndAwait(id, payload, opts?.timeout);
    if (response.cancelled) return false;
    return response.confirmed ?? false;
  }

  async select(title: string, options: string[], opts?: { timeout?: number }): Promise<string | undefined> {
    const id = crypto.randomUUID();
    const payload: ExtensionUIRequestPayload = { id, method: 'select', title, options, timeout: opts?.timeout };
    const response = await this.emitAndAwait(id, payload, opts?.timeout);
    if (response.cancelled) return undefined;
    return response.value;
  }

  async input(title: string, placeholder?: string, opts?: { timeout?: number }): Promise<string | undefined> {
    const id = crypto.randomUUID();
    const payload: ExtensionUIRequestPayload = { id, method: 'input', title, placeholder, timeout: opts?.timeout };
    const response = await this.emitAndAwait(id, payload, opts?.timeout);
    if (response.cancelled) return undefined;
    return response.value;
  }

  notify(message: string, type?: 'info' | 'warning' | 'error'): void {
    const id = crypto.randomUUID();
    this.emit('extension_ui.request', { id, method: 'notify', message, notifyType: type });
  }

  // Stubs for methods the SDK interface declares but we don't need in the webview.
  onTerminalInput(): () => void { return () => undefined; }
  setStatus(): void { /* noop */ }
  setWorkingMessage(): void { /* noop */ }
  setWorkingVisible(): void { /* noop */ }
  setWorkingIndicator(): void { /* noop */ }
  setHiddenThinkingLabel(): void { /* noop */ }
  setWidget(): void { /* noop */ }

  /**
   * Resolve a pending request with the response from the host.
   */
  resolveRequest(response: ExtensionUIResponsePayload): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(response.id);
    pending.resolve(response);
  }

  /**
   * Cancel all pending requests (e.g. on session abort).
   */
  cancelAll(): void {
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ id, cancelled: true });
    }
    this.pending.clear();
  }

  private emitAndAwait(
    id: string,
    payload: ExtensionUIRequestPayload,
    timeout?: number,
  ): Promise<ExtensionUIResponsePayload> {
    return new Promise<ExtensionUIResponsePayload>((resolve) => {
      const pending: PendingRequest = { resolve };

      if (timeout && timeout > 0) {
        pending.timer = setTimeout(() => {
          this.pending.delete(id);
          resolve({ id, cancelled: true });
        }, timeout);
      }

      this.pending.set(id, pending);
      this.emit('extension_ui.request', payload);
    });
  }
}
