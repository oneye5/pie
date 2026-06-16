import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type * as vscode from 'vscode';

const BOOT_TRACE_PATH = path.join(os.tmpdir(), 'pie-boot-trace.jsonl');

/** Boot tracing is off by default to avoid synchronous disk I/O on hot paths. */
let bootTraceEnabled = process.env.PI_BOOT_LOG === '1';

/** Enable or disable boot tracing at runtime. */
export function setBootTraceEnabled(enabled: boolean): void {
  bootTraceEnabled = enabled;
}

function appendBootTraceSync(record: Record<string, unknown>): void {
  if (!bootTraceEnabled) {
    return;
  }
  try {
    fsSync.mkdirSync(path.dirname(BOOT_TRACE_PATH), { recursive: true });
    fsSync.appendFileSync(BOOT_TRACE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
  } catch {
    // Ignore trace write failures; tracing must never affect extension behavior.
  }
}

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

export function bootLog(
  scope: string,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!bootTraceEnabled) {
    return;
  }
  const record = {
    ts: new Date().toISOString(),
    pid: process.pid,
    scope,
    event,
    ...payload,
  };

  console.warn(`[pie:boot] ${JSON.stringify(record)}`);
  appendBootTraceSync(record);
}

export function bootTraceSync(
  scope: string,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!bootTraceEnabled) {
    return;
  }
  appendBootTraceSync({
    ts: new Date().toISOString(),
    pid: process.pid,
    scope,
    event,
    ...payload,
  });
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