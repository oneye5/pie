/**
 * Runtime factory extracted from BackendServer.
 * Creates an agent session runtime from the SDK services.
 */

import { prepareContextFiles } from './context-files';
import type { SdkModule } from './sdk';

export function createRuntimeFactory(sdk: SdkModule, authStorage: unknown, _startupCwd: string) {
  return async ({ cwd, agentDir, sessionManager, sessionStartEvent }: any) => {
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