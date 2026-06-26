/**
 * Runtime factory extracted from BackendServer.
 * Creates an agent session runtime from the SDK services.
 */

import { prepareContextFiles } from './context-files';
import type { SdkModule, SdkSessionEvent, SdkSessionManager } from './sdk';

/** Arguments the SDK passes into the runtime factory callback. */
interface RuntimeFactoryArgs {
  cwd: string;
  agentDir: string;
  sessionManager: SdkSessionManager;
  sessionStartEvent?: SdkSessionEvent;
}

// SDK accepts authStorage as unknown; kept untyped at the seam (no tighter type exists).
// `SdkModule.createAgentSessionServices` types its entire `options` bag as `unknown`,
// and `SdkModule.AuthStorage.create` returns `unknown`, so a narrower type here would lie.
export function createRuntimeFactory(sdk: SdkModule, authStorage: unknown, _startupCwd: string) {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: RuntimeFactoryArgs) => {
    // `SdkModule.createAgentSessionServices` returns `Promise<unknown>`; the
    // `Record<string, unknown>` narrowing is the minimal spread/assignment-compatible
    // shape required to forward `services` into `createAgentSessionFromServices`.
    const services = (await sdk.createAgentSessionServices({
      cwd,
      agentDir,
      authStorage,
      editorVersion: resolveEditorVersion(),
      resourceLoaderOptions: {
        agentsFilesOverride: (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({
          agentsFiles: prepareContextFiles(base.agentsFiles).map((contextFile) => ({
            path: contextFile.path,
            content: contextFile.content,
          })),
        }),
      },
    })) as Record<string, unknown>;

    // `SdkModule.createAgentSessionFromServices` returns `Promise<unknown>`; cast to
    // `Record<string, unknown>` only so the result can be spread below. No tighter
    // interface is claimed than the SDK contract declares.
    const created = (await sdk.createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })) as Record<string, unknown>;

    return {
      ...created,
      services,
    };
  };
}

function resolveEditorVersion(): string | undefined {
  const configured = process.env.PIE_EDITOR_VERSION?.trim();
  return configured || undefined;
}