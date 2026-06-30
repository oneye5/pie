import * as cp from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { ArchState } from './reducer';

export const EMPTY_DIFF_SCHEME = 'pie-empty-diff';

export class EmptyDiffContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(): string {
    return '';
  }
}

export class FileDiffService {
  constructor(private readonly getArchState: () => ArchState) {}

  resolveFileChangePath(sessionPath: string, filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }

    const archState = this.getArchState();
    const sessionCwd = archState.sessions.sessions.find(
      (session) => session.path === sessionPath,
    )?.cwd;
    const basePath =
      sessionCwd ||
      archState.sessions.workspaceCwd ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return basePath ? path.resolve(basePath, filePath) : filePath;
  }

  getFileChangeKind(
    sessionPath: string,
    filePath: string,
    resolvedPath: string,
  ): 'created' | 'modified' | 'deleted' {
    const archState = this.getArchState();
    const changes = archState.fileChanges.bySession[sessionPath] ?? [];
    const change = changes.find((entry) => {
      const entryPath = this.resolveFileChangePath(sessionPath, entry.path);
      return entry.path === filePath || entryPath === resolvedPath;
    });
    return change?.kind ?? 'modified';
  }

  private toGitUri(uri: vscode.Uri, ref: string): vscode.Uri {
    return uri.with({
      scheme: 'git',
      query: JSON.stringify({ path: uri.fsPath, ref }),
    });
  }

  private toEmptyDiffUri(uri: vscode.Uri): vscode.Uri {
    return uri.with({
      scheme: EMPTY_DIFF_SCHEME,
      query: '',
      fragment: '',
    });
  }

  async openFileDiff(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);
    const uri = vscode.Uri.file(resolvedPath);
    const kind = this.getFileChangeKind(sessionPath, filePath, resolvedPath);
    const emptyUri = this.toEmptyDiffUri(uri);
    // Diff baseline: NOT a bare `HEAD`. The changed-files panel is derived
    // from transcript tool calls, and pi agents commit their work after each
    // task — so for any committed file `HEAD` already contains the agent's
    // changes and a `HEAD`-vs-working-tree diff is empty (the "same file on
    // both sides" bug). `resolveBaselineRef` walks the file's git history to
    // the most recent commit whose content DIFFERS from the working tree —
    // the pre-change baseline — falling back to `HEAD` when none is found.
    const baselineRef =
      kind === 'created' ? 'HEAD' : await this.resolveBaselineRef(resolvedPath);
    const originalUri = kind === 'created' ? emptyUri : this.toGitUri(uri, baselineRef);
    const modifiedUri = kind === 'deleted' ? emptyUri : uri;

    try {
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        modifiedUri,
        `${path.basename(resolvedPath)} — agent changes`,
        { preview: true },
      );
    } catch {
      await vscode.commands.executeCommand('git.openChange', uri);
    }
  }

  /**
   * Resolve the git ref to diff a changed file against — the pre-change
   * baseline rather than a bare `HEAD`.
   *
   * Walks the file's git history (commits that touched it, newest first) and
   * returns the most recent commit whose content DIFFERS from the working
   * tree. For an uncommitted (dirty) change that is `HEAD` itself (current
   * behaviour preserved); for a change the agent has since committed it is the
   * commit just before the change — without this, `HEAD` already holds the
   * agent's edits and the diff is empty.
   *
   * Known limitation: if the agent made several commits to the same file
   * during a session and the working tree matches the latest of them, the
   * baseline is the commit before the LAST change, so the diff shows only
   * that final delta rather than the whole session's churn. Returns `'HEAD'`
   * (no regression) when the file is untracked, git is unavailable, or the
   * walk finds no differing commit.
   */
  async resolveBaselineRef(resolvedPath: string): Promise<string> {
    const dir = path.dirname(resolvedPath);
    try {
      const { stdout, code } = await this.execGit(dir, [
        'log',
        '--format=%H',
        '-n',
        '50',
        '--',
        resolvedPath,
      ]);
      if (code !== 0) return 'HEAD';
      const shas = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      for (const sha of shas) {
        if (await this.differsFromCommit(dir, sha, resolvedPath)) return sha;
      }
      return 'HEAD';
    } catch {
      return 'HEAD';
    }
  }

  /** Whether the working-tree version of `absPath` differs from its content
   * at `sha`. `git diff --quiet` exits 0 when identical, 1 when different, and
   *  — unlike `--exit-code` — emits no patch to stdout, so it can't overflow
   *  the exec buffer on large changes. */
  private async differsFromCommit(
    dir: string,
    sha: string,
    absPath: string,
  ): Promise<boolean> {
    const { code } = await this.execGit(dir, ['diff', '--quiet', sha, '--', absPath]);
    if (code === 0) return false;
    if (code === 1) return true;
    throw new Error(`git diff --quiet ${sha} exited ${code}`);
  }

  /** Run `git` in `dir`; resolve `{ stdout, code }`. Non-zero exit codes (e.g.
   *  `git diff --exit-code` → 1 on differences, 128 for a bad ref) resolve with
   *  their code for callers to inspect; only non-numeric failures (git not
   *  installed) reject. */
  private execGit(
    dir: string,
    args: string[],
  ): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      cp.execFile(
        'git',
        args,
        { cwd: dir, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err) {
            const code = (err as { code?: number }).code;
            if (typeof code === 'number') {
              resolve({ stdout: typeof stdout === 'string' ? stdout : '', code });
              return;
            }
            reject(err);
            return;
          }
          resolve({ stdout: typeof stdout === 'string' ? stdout : '', code: 0 });
        },
      );
    });
  }

  async openFileInEditor(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolvedPath), { preview: false });
  }

  async revertFile(sessionPath: string, filePath: string): Promise<void> {
    const resolvedPath = this.resolveFileChangePath(sessionPath, filePath);

    try {
      // Check whether the file is known to git (tracked or staged).
      const tracked = await new Promise<boolean>((resolve) => {
        cp.execFile(
          'git',
          ['ls-files', '--error-unmatch', resolvedPath],
          { cwd: path.dirname(resolvedPath) },
          (err) => resolve(!err),
        );
      });

      if (tracked) {
        // Restore to last committed version.
        await new Promise<void>((resolve, reject) => {
          cp.execFile(
            'git',
            ['checkout', 'HEAD', '--', resolvedPath],
            { cwd: path.dirname(resolvedPath) },
            (err) => (err ? reject(err) : resolve()),
          );
        });
      } else {
        // Untracked file created by the agent – delete it.
        await fs.unlink(resolvedPath);
      }
    } catch {
      // Last resort: if the file still exists, warn the user.
      const exists = await fs.access(resolvedPath).then(() => true, () => false);
      if (exists) {
        void vscode.window.showWarningMessage(
          `Could not revert ${filePath}. The file may not be under source control.`,
        );
        return;
      }
      // File is already gone – treat as success and remove the entry.
    }
  }
}