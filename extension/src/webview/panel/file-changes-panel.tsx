/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FileChangeEntry } from '../../shared/protocol';

import { FileTypeIcon } from './components/file-type-icon';

interface FileChangesPanelProps {
  fileChanges: FileChangeEntry[];
  onOpenDiff: (filePath: string) => void;
  onOpenInEditor: (filePath: string) => void;
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

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const onCopy = (e: MouseEvent) => {
    e.stopPropagation();
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return;
    void clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1100);
      })
      .catch(() => {
        /* ignore — clipboard might be unavailable (e.g. insecure context) */
      });
  };

  return (
    <button
      class={`file-change-copy${copied ? ' is-copied' : ''}`}
      type="button"
      title={copied ? 'Copied!' : `Copy path: ${path}`}
      aria-label={copied ? 'Path copied' : `Copy path of ${path}`}
      onClick={onCopy}
    >
      {copied ? (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="2.5,7 5.5,10 10.5,3.5" />
        </svg>
      ) : (
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
          <path d="M5.5 1.5 H10 a1 1 0 0 1 1 1 V6.5" />
        </svg>
      )}
    </button>
  );
}

export function FileChangesPanel({
  fileChanges,
  onOpenDiff,
  onOpenInEditor,
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
              <div class="file-change-main">
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
              </div>
              <div class="file-change-actions">
                <button
                  class="file-change-open"
                  type="button"
                  title={
                    change.kind === 'deleted'
                      ? `${change.path} was deleted by the agent`
                      : `Open ${change.path} in the editor`
                  }
                  aria-label={
                    change.kind === 'deleted'
                      ? `${change.path} was deleted by the agent`
                      : `Open ${change.path} in the editor`
                  }
                  disabled={change.kind === 'deleted'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (change.kind === 'deleted') return;
                    onOpenInEditor(change.path);
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M9 4.5 L11.5 2 L11.5 4.5" />
                    <path d="M11.5 2 L7 6.5" />
                    <path d="M11 8 V10.5 a0.5 0.5 0 0 1 -0.5 0.5 H2.5 a0.5 0.5 0 0 1 -0.5 -0.5 V2.5 a0.5 0.5 0 0 1 0.5 -0.5 H5" />
                  </svg>
                </button>
                <CopyPathButton path={change.path} />
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
