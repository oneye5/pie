export interface FileMutationDelta {
  writeCount: number;
  editCount: number;
  deleteCount: number;
  renameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
  /** Per-file EDIT counts keyed by a path hash (FNV-1a, base36). Tracks how often each distinct
   *  file was re-edited so the leaderboard can score "file churn" — reworking the same file over
   *  and over, a signal the agent kept getting it wrong. Edits only (creates/deletes/renames are
   *  first-touches, not churn). Path-hashed to avoid persisting raw file paths. Empty when no edits
   *  were attributable to a path (e.g. legacy runs captured before this field existed). */
  editCountsByFile: Record<string, number>;
}

export type FileExtensionOperation = 'read' | 'write' | 'edit';

export interface FileExtensionAnalysis {
  extension: string;
  operation: FileExtensionOperation;
}

export interface EditSizeStats {
  additions: number;
  deletions: number;
  modifications: number;
}

export const EMPTY_FILE_MUTATION_DELTA: FileMutationDelta = {
  writeCount: 0,
  editCount: 0,
  deleteCount: 0,
  renameCount: 0,
  touchedFileCount: 0,
  lineAdditions: 0,
  lineDeletions: 0,
  lineModifications: 0,
  editCountsByFile: {},
};
