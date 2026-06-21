/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { FileChangeEntry } from '../../shared/protocol';

interface FileChangesPanelProps {
  fileChanges: FileChangeEntry[];
  expanded: boolean;
  onToggleExpanded: (expanded: boolean) => void;
  onOpenDiff: (filePath: string) => void;
  onOpenInEditor: (filePath: string) => void;
  onRevertFile: (filePath: string) => void;
}

const STATUS_LABELS: Record<FileChangeEntry['kind'], string> = {
  created: 'A',
  modified: 'M',
  deleted: 'D',
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

function FilePath({ path }: { path: string }) {
  const parts = path.split(/[/\\]/);
  const name = parts.pop() ?? path;
  const dir = parts.join('/');
  return (
    <span class="file-change-path-text">
      {dir ? <span class="file-change-dir">{dir}/</span> : null}
      <span class="file-change-name">{name}</span>
    </span>
  );
}

function CopyPathButton({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(path)
      .then(() => {
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1100);
      })
      .catch(() => {
        /* ignore */
      });
  };

  return (
    <button
      class={`action-btn icon-only file-change-copy${copied ? ' is-copied' : ''}`}
      type="button"
      title={copied ? 'Copied!' : `Copy path: ${path}`}
      aria-label={copied ? 'Path copied' : `Copy path of ${path}`}
      onClick={onClick}
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

function RevertButton({ path, onRevert }: { path: string; onRevert: (path: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (confirming) {
      onRevert(path);
      setConfirming(false);
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    } else {
      setConfirming(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    }
  };

  if (confirming) {
    return (
      <button
        class="action-btn danger file-change-revert file-change-revert-confirm"
        type="button"
        title="Click again to confirm revert"
        aria-label={`Confirm revert of ${path}`}
        onClick={onClick}
      >
        Confirm?
      </button>
    );
  }

  return (
    <button
      class="action-btn icon-only file-change-revert"
      type="button"
      title={`Revert changes to ${path}`}
      aria-label={`Revert ${path}`}
      onClick={onClick}
    >
      <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6.5 a4.5 4.5 0 1 1 1.5 3" />
        <path d="M3 6.5 L3 3 L6 4" />
      </svg>
    </button>
  );
}

function StatusLabel({ kind }: { kind: FileChangeEntry['kind'] }) {
  return (
    <span class={`file-change-status file-change-status-${kind}`} role="img" aria-label={kind}>
      {STATUS_LABELS[kind]}
    </span>
  );
}

export function FileChangesPanel({
  fileChanges,
  expanded,
  onToggleExpanded,
  onOpenDiff,
  onOpenInEditor,
  onRevertFile,
}: FileChangesPanelProps) {
  const [hasNewChanges, setHasNewChanges] = useState(false);
  const prevCountRef = useRef(fileChanges.length);

  useEffect(() => {
    const prev = prevCountRef.current;
    const curr = fileChanges.length;
    if (curr > prev && !expanded) {
      setHasNewChanges(true);
    }
    prevCountRef.current = curr;
    if (curr === 0) {
      setHasNewChanges(false);
    }
  }, [fileChanges.length, expanded]);

  useEffect(() => {
    if (expanded) setHasNewChanges(false);
  }, [expanded]);

  if (fileChanges.length === 0) return null;

  return (
    <div class={`file-changes-rail${expanded ? ' is-expanded' : ''}${hasNewChanges ? ' has-new-changes' : ''}`}>
      <button
        class="file-changes-handle"
        type="button"
        onClick={() => onToggleExpanded(!expanded)}
        aria-expanded={expanded}
        aria-label={`File changes: ${fileChanges.length}. ${expanded ? 'Collapse' : 'Expand'}`}
        title={`${fileChanges.length} changed file${fileChanges.length === 1 ? '' : 's'}`}
      >
        <svg width="14" height="14" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 3.5 H11" />
          <path d="M2 6.5 H11" />
          <path d="M2 9.5 H7.5" />
        </svg>
        <span class="file-changes-handle-count">{fileChanges.length}</span>
        <svg
          class="file-changes-handle-chevron"
          width="12"
          height="12"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <polyline points={expanded ? '9,3 6,6 9,9' : '3,3 6,6 3,9'} />
        </svg>
      </button>
      <div class="file-changes-drawer" aria-hidden={!expanded} inert={!expanded}>
        <div class="file-changes-drawer-inner">
        <div class="file-changes-header">
          <span class="file-changes-title">File changes · {fileChanges.length}</span>
          <button
            class="action-btn icon-only file-changes-close"
            type="button"
            aria-label="Collapse file changes"
            title="Collapse file changes"
            onClick={() => onToggleExpanded(false)}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9,3 6,6 9,9" />
            </svg>
          </button>
        </div>
        <div class="file-changes-list" role="list">
          {fileChanges.map((change) => (
            <div key={change.path} class={`file-change-item kind-${change.kind}`} role="listitem">
              <div class="file-change-main">
                <StatusLabel kind={change.kind} />
                <button
                  class="file-change-path"
                  type="button"
                  title={`${change.kind}: ${change.path}\n${change.description}`}
                  onClick={() => onOpenDiff(change.path)}
                >
                  <FilePath path={change.path} />
                </button>
                <LineStats additions={change.additions} deletions={change.deletions} />
              </div>
              <div class="file-change-actions">
                <button
                  class="action-btn icon-only file-change-open"
                  type="button"
                  title={change.kind === 'deleted' ? `${change.path} was deleted` : `Open ${change.path} in the editor`}
                  aria-label={change.kind === 'deleted' ? `${change.path} was deleted` : `Open ${change.path} in the editor`}
                  disabled={change.kind === 'deleted'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (change.kind !== 'deleted') onOpenInEditor(change.path);
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M9 4.5 L11.5 2 L11.5 4.5" />
                    <path d="M11.5 2 L7 6.5" />
                    <path d="M11 8 V10.5 a0.5 0.5 0 0 1 -0.5 0.5 H2.5 a0.5 0.5 0 0 1 -0.5 -0.5 V2.5 a0.5 0.5 0 0 1 0.5 -0.5 H5" />
                  </svg>
                </button>
                <CopyPathButton path={change.path} />
                <RevertButton path={change.path} onRevert={onRevertFile} />
              </div>
            </div>
          ))}
        </div>
        </div>
      </div>
    </div>
  );
}
