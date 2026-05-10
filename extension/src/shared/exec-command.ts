import * as cp from 'node:child_process';

import { resolveCommandInvocation } from './command-invocation';
import type { CommandExecutor } from './runtime-resolution';

/**
 * Creates a `CommandExecutor` that routes commands through the appropriate
 * shell on the current platform (e.g. `npm` on Windows runs via cmd.exe).
 */
export function createCommandExecutor(platform?: NodeJS.Platform): CommandExecutor {
  return (command, args) => {
    const invocation = resolveCommandInvocation(command, args, { platform });
    return new Promise((resolve) => {
      cp.execFile(invocation.command, invocation.args, (err, stdout, stderr) => {
        // err.code is a string like 'ENOENT' for spawn errors; normalise to 1.
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({
          stdout: stdout ?? '',
          stderr: stderr ?? err?.message ?? '',
          exitCode,
        });
      });
    });
  };
}
