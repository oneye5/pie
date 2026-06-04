/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';
import type { FileChangeEntry } from '../../shared/protocol';

import { FileTypeIcon } from './components/file-type-icon';

interface FileChangesPanelProps {
  fileChanges: FileChangeEntry[];
  onOpenDiff: (filePath: string) => void;
  onRevertFile: (filePath: string) => void;
}

const CHANGE_LABELS: Record<FileChangeEntry['kind'], string> = {
  created: 'Created',
  modified: 'Modified',
  deleted: 'Deleted',
};

function LineStats({ additions, deletions }: { additions?: number; deletions?: number }) {
  if (!additions && !deletions) return null;
  return (
    <span class="file-change-stats">
      {additions ? <span class="stat-additions">+{additions}</span> : null}
      {deletions ? <span class="stat-deletions">-{deletions}</span> : null}
    </span>
  );
}

export function FileChangesPanel({
  fileChanges,
  onOpenDiff,
  onRevertFile,
}: FileChangesPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (fileChanges.length === 0) return null;

  const toggle = () => setIsExpanded((v) => !v);

  const totalAdditions = fileChanges.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const totalDeletions = fileChanges.reduce((sum, f) => sum + (f.deletions ?? 0), 0);

  return (
    <div class={`file-changes-panel${isExpanded ? ' expanded' : ''}`}>
      <button
        class="file-changes-header"
        type="button"
        onClick={toggle}
        aria-expanded={isExpanded}
      >
        <span
          class={`file-changes-chevron${isExpanded ? ' open' : ''}`}
          aria-hidden="true"
        >
          {'\u25B8'}
        </span>
        <span class="file-changes-title">Files Changed</span>
        <span class="file-changes-count">{fileChanges.length}</span>
        {(totalAdditions > 0 || totalDeletions > 0) && (
          <span class="file-changes-aggregate-stats">
            {totalAdditions > 0 && <span class="stat-additions">+{totalAdditions}</span>}
            {totalDeletions > 0 && <span class="stat-deletions">-{totalDeletions}</span>}
          </span>
        )}
      </button>
      {isExpanded && (
        <div class="file-changes-list">
          {fileChanges.map((change) => (
            <div key={change.path} class={`file-change-item kind-${change.kind}`}>
              <FileTypeIcon path={change.path} className={`kind-${change.kind}`} />
              <button
                class="file-change-path"
                type="button"
                title={`${CHANGE_LABELS[change.kind]}: ${change.path}\n${change.description}`}
                onClick={() => onOpenDiff(change.path)}
              >
                <span class="file-change-name">
                  {change.path.split(/[/\\]/).pop()}
                </span>
                <span class="file-change-dir">
                  {change.path.split(/[/\\]/).slice(0, -1).join('/') || '.'}
                </span>
              </button>
              <LineStats additions={change.additions} deletions={change.deletions} />
              <button
                class="file-change-revert"
                type="button"
                title={`Revert changes to ${change.path}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRevertFile(change.path);
                }}
                aria-label={`Revert ${change.path}`}
              >
                {'\u21A9'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
