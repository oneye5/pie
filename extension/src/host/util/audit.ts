import type * as vscode from 'vscode';

function isEnabled(context: vscode.ExtensionContext): boolean {
  return context.extensionMode === 1;
}

export function auditLog(
  context: vscode.ExtensionContext,
  scope: string,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!isEnabled(context)) {
    return;
  }

  console.debug(`[pi-state] ${JSON.stringify({ scope, event, ...payload })}`);
}

export function assertInvariant(
  context: vscode.ExtensionContext,
  scope: string,
  condition: boolean,
  message: string,
  payload: Record<string, unknown> = {},
): void {
  if (condition) {
    return;
  }

  const details = { scope, event: 'invariant', message, ...payload };
  console.error(`[pi-state] ${JSON.stringify(details)}`);

  if (isEnabled(context)) {
    throw new Error(`[pi-state] ${message}`);
  }
}