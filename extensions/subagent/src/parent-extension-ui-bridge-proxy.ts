/**
 * ParentExtensionUIBridgeProxy — thin decorator that implements
 * `ExtensionUIContext` for subagent sessions by delegating dialog methods
 * (`select`, `input`, `confirm`, `notify`) to the parent session's
 * `ExtensionUIBridge`, stamping every request payload with `subagentCallId`.
 *
 * TUI-specific methods (`setTheme`, `setStatus`, `setWidget`, etc.) are
 * no-ops — subagents have no terminal UI.
 *
 * The parent bridge owns the promises; the proxy just awaits them.
 * No parallel promise tracking, no subscription lifecycle, no new event types.
 */

import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@mariozechner/pi-coding-agent";

/**
 * Minimal interface for the parent bridge — we only need the dialog methods
 * that the ask_user extension (and safeguard) actually call.
 */
export interface ParentBridge {
  select(title: string, options: string[], opts?: { signal?: AbortSignal; subagentCallId?: string }): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: { signal?: AbortSignal; subagentCallId?: string }): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: { signal?: AbortSignal; subagentCallId?: string }): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error", subagentCallId?: string): void;
  cancelAll(): void;
}

export class ParentExtensionUIBridgeProxy implements ExtensionUIContext {
  private readonly parentBridge: ParentBridge;
  private readonly subagentCallId: string;

  constructor(parentBridge: ParentBridge, subagentCallId: string) {
    this.parentBridge = parentBridge;
    this.subagentCallId = subagentCallId;
  }

  // ── Dialog methods (delegated to parent bridge) ──────────────────────────

  async select(title: string, options: string[], opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.parentBridge.select(title, options, { signal: opts?.signal, subagentCallId: this.subagentCallId });
  }

  async confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean> {
    return this.parentBridge.confirm(title, message, { signal: opts?.signal, subagentCallId: this.subagentCallId });
  }

  async input(title: string, placeholder?: string, opts?: ExtensionUIDialogOptions): Promise<string | undefined> {
    return this.parentBridge.input(title, placeholder, { signal: opts?.signal, subagentCallId: this.subagentCallId });
  }

  notify(message: string, type?: "info" | "warning" | "error"): void {
    this.parentBridge.notify(message, type, this.subagentCallId);
  }

  /**
   * Cancel pending parent-bridge dialog requests. Called when the subagent is
   * aborted (parent close / timeout) so an in-flight `ask_user` prompt does not
   * hang — the parent bridge ignores the abort signal, so without this the
   * pending promise would never settle. Delegates to the parent bridge's
   * `cancelAll()`, which resolves outstanding requests as cancelled. While a
   * subagent is running the parent agent loop is blocked awaiting its result,
   * so the only outstanding parent-bridge requests are subagent-scoped.
   */
  cancelAll(): void {
    this.parentBridge.cancelAll();
  }

  // ── TUI methods (no-ops for subagent sessions) ────────────────────────────

  onTerminalInput(): () => void { return () => undefined; }
  setStatus(): void { /* noop */ }
  setWorkingMessage(): void { /* noop */ }
  setWorkingVisible(): void { /* noop */ }
  setWorkingIndicator(): void { /* noop */ }
  setHiddenThinkingLabel(): void { /* noop */ }
  setWidget(): void { /* noop */ }
  setFooter(): void { /* noop */ }
  setHeader(): void { /* noop */ }
  setTitle(): void { /* noop */ }
  async custom<T>(): Promise<T> { throw new Error("custom() not available in subagent sessions"); }
  pasteToEditor(): void { /* noop */ }
  setEditorText(): void { /* noop */ }
  getEditorText(): string { return ""; }
  async editor(): Promise<string | undefined> { return undefined; }
  addAutocompleteProvider(): void { /* noop */ }
  setEditorComponent(): void { /* noop */ }
  getEditorComponent(): undefined { return undefined; }
  get theme(): any { return {} as any; }
  getAllThemes(): { name: string; path: string | undefined }[] { return []; }
  getTheme(): any { return undefined; }
  setTheme(): { success: boolean; error?: string } { return { success: false, error: "not available in subagent" }; }
  getToolsExpanded(): boolean { return false; }
  setToolsExpanded(): void { /* noop */ }
}
