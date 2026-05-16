export interface FileMutationDelta {
  writeCount: number;
  editCount: number;
  deleteCount: number;
  renameCount: number;
  touchedFileCount: number;
  lineAdditions: number;
  lineDeletions: number;
  lineModifications: number;
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
};
