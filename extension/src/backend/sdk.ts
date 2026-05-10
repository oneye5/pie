import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { ChatMessage, ToolCall } from '../shared/protocol';
import type { SessionEntryLike } from './transcript';

// ─── Minimal SDK contract ────────────────────────────────────────────────────
// We type only the surface the backend actually consumes. SDK breaking changes
// surface as TypeScript errors here instead of late runtime failures.

export interface SdkSessionEvent {
  type:
    | 'session_start'
    | 'agent_start'
    | 'agent_end'
    | 'message_start'
    | 'message_update'
    | 'message_end'
    | 'tool_execution_start'
    | 'tool_execution_end'
    | string;
  message?: { role?: 'user' | 'assistant'; content?: unknown; stopReason?: string };
  assistantMessageEvent?: {
    type: 'text_delta' | 'thinking_delta' | string;
    delta?: string;
    thinking?: string;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
}

export interface SdkSessionManager {
  getCwd: () => string;
  getSessionFile: () => string | undefined;
  getSessionName: () => string | undefined;
  getBranch: () => SessionEntryLike[];
  getEntries: () => SessionEntryLike[];
}

export interface SdkSession {
  model?: { id: string };
  sessionFile?: string;
  sessionName?: string;
  isStreaming: boolean;
  messages: unknown[];
  sessionManager: SdkSessionManager;
  subscribe: (listener: (event: SdkSessionEvent) => void) => () => void;
  prompt: (text: string, options?: Record<string, unknown>) => Promise<void>;
  abort: () => Promise<void>;
}

export interface SdkRuntime {
  session: SdkSession;
  services: {
    modelRegistry: {
      getAvailable: () => Array<{ id: string; name: string; provider: string; reasoning: boolean }>;
    };
    diagnostics?: unknown[];
  };
  dispose: () => Promise<void>;
}

export interface SdkSessionInfo {
  path: string;
  cwd: string;
  name?: string;
  modified: Date;
  messageCount: number;
}

export interface SdkModule {
  VERSION: string;
  getAgentDir: () => string;
  AuthStorage: {
    create: (filePath?: string) => unknown;
  };
  SessionManager: {
    continueRecent: (cwd: string) => SdkSessionManager;
    create: (cwd: string) => SdkSessionManager;
    open: (sessionPath: string) => SdkSessionManager;
    listAll: () => Promise<SdkSessionInfo[]>;
  };
  createAgentSessionServices: (options: unknown) => Promise<unknown>;
  createAgentSessionFromServices: (options: unknown) => Promise<unknown>;
  createAgentSessionRuntime: (factory: unknown, options: unknown) => Promise<SdkRuntime>;
}

// ─── Loader ──────────────────────────────────────────────────────────────────

const dynamicImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>;

/**
 * Permitted parent directories for the SDK. The configured `sdkPath` must
 * resolve to a child of one of these locations to be loaded — defence in depth
 * against an attacker-controlled `--sdkPath` pointing at arbitrary code.
 */
function isPathAllowed(sdkPath: string): boolean {
  const normalized = path.resolve(sdkPath);
  const allowedRoots = [
    process.env['ProgramFiles'],
    process.env['ProgramFiles(x86)'],
    process.env['LOCALAPPDATA'],
    process.env['APPDATA'],
    process.env['HOME'],
    process.env['USERPROFILE'],
    '/usr/local',
    '/usr/lib',
    '/opt',
  ].filter((r): r is string => typeof r === 'string' && r.length > 0);

  return allowedRoots.some((root) => {
    const r = path.resolve(root);
    return normalized === r || normalized.startsWith(r + path.sep);
  });
}

export async function loadSdk(sdkPath: string): Promise<SdkModule> {
  if (!isPathAllowed(sdkPath)) {
    throw new Error(
      `Refusing to load SDK from disallowed path: ${sdkPath}. ` +
        `Set piAssistant.sdkPath to a directory under your user profile or system program directories.`,
    );
  }

  const entryUrl = pathToFileURL(path.join(sdkPath, 'dist', 'index.js')).href;
  const mod = (await dynamicImport(entryUrl)) as Partial<SdkModule>;

  if (
    typeof mod.VERSION !== 'string' ||
    typeof mod.getAgentDir !== 'function' ||
    typeof mod.SessionManager?.listAll !== 'function' ||
    typeof mod.createAgentSessionRuntime !== 'function'
  ) {
    throw new Error(
      `SDK at ${sdkPath} is missing required exports (expected pi-coding-agent contract).`,
    );
  }

  return mod as SdkModule;
}


