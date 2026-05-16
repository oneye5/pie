/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';
import type { FileChangeEntry } from '../../shared/protocol';

interface FileChangesPanelProps {
  fileChanges: FileChangeEntry[];
  onOpenDiff: (filePath: string) => void;
  onRevertFile: (filePath: string) => void;
}

const CHANGE_ICONS: Record<FileChangeEntry['kind'], string> = {
  created: '+',
  modified: '~',
  deleted: '\u2212',
};

const CHANGE_LABELS: Record<FileChangeEntry['kind'], string> = {
  created: 'Created',
  modified: 'Modified',
  deleted: 'Deleted',
};

export function FileChangesPanel({
  fileChanges,
  onOpenDiff,
  onRevertFile,
}: FileChangesPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (fileChanges.length === 0) return null;

  const toggle = () => setIsExpanded((v) => !v);

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
      </button>
      {isExpanded && (
        <div class="file-changes-list">
          {fileChanges.map((change) => (
            <div key={change.path} class={`file-change-item kind-${change.kind}`}>
              <span
                class={`file-change-icon ${change.kind}`}
                aria-label={CHANGE_LABELS[change.kind]}
              >
                {CHANGE_ICONS[change.kind]}
              </span>
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
