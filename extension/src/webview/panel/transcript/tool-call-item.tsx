/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ToolCall } from '../../../shared/protocol';
import { summarizeSubagentToolCallInput } from '../../../shared/tool-call-analysis';
import { shouldOpenSubagentContextMenu } from './interactions';
import { getToolCallContextType } from '../chat-prefs';

import { MessageItem } from './message-item';
import {
  getRenderableSubagentResultFromToolCall,
  subagentSingleResultToChatMessages,
  type SubagentResult,
  type SubagentSingleResult,
} from './subagent';
import {
  DISPLAY_SCORE_DIMS,
  normalizeTaskScoresForDisplay,
} from './subagent-score-display';
import { ToolCallCard } from './tool-call-card';
import type { RenderToolCall, TranscriptContextMenuHandler } from './types';
import { useDisclosureOpen } from './use-disclosure-open';

interface ToolCallItemProps {
  toolCall: ToolCall;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
}

interface SubagentBlockProps {
  toolCall: ToolCall;
  subagentResult?: SubagentResult;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onNestedContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
}

function isRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
}

function isFailed(result: SubagentSingleResult): boolean {
  if (isRunning(result)) return false;
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

/** Extract a human-readable error summary from a single result. */
function subagentErrorDetail(result: SubagentSingleResult): string | undefined {
  if (!isFailed(result)) return undefined;
  const parts: string[] = [];
  const label =
    result.stopReason === 'aborted' ? 'Aborted'
    : result.stopReason === 'error' ? 'Error'
    : result.exitCode > 0 ? `Exit code ${result.exitCode}`
    : 'Failed';
  parts.push(label);
  if (result.errorMessage) parts.push(result.errorMessage);
  if (result.stderr) parts.push(result.stderr);
  return parts.join(': ');
}

/** Compact score bar: always shows the full effective requirement vector. */
function ScoreBar({ scores }: { scores: Record<string, number> | undefined }) {
  const normalized = normalizeTaskScoresForDisplay(scores);
  if (!normalized) return null;

  return (
    <span class="subagent-scores">
      {DISPLAY_SCORE_DIMS.map(({ key, label, full }) => {
        const val = normalized[key];
        const isDefaulted = scores?.[key] == null;
        return (
          <span
            key={key}
            class="subagent-score-dim"
            data-score={val}
            title={`${full}: ${val}/5${isDefaulted ? ' (default)' : ''}`}
          >{label}{val}</span>
        );
      })}
    </span>
  );
}

/** High-priority metadata that should remain visible before summary text. */
function PrimaryMeta({ result }: { result: SubagentSingleResult }) {
  if (!normalizeTaskScoresForDisplay(result.taskScores)) return null;

  return (
    <span class="subagent-primary-meta">
      <ScoreBar scores={result.taskScores} />
    </span>
  );
}

/** Status indicator: small dot or label at the right side of the header. */
function StatusIndicator({ status, errorDetail }: { status: 'running' | 'failed' | 'completed'; errorDetail?: string }) {
  if (status === 'completed') return null;
  if (status === 'running') {
    return <span class="subagent-status subagent-status-running" aria-label="Running" />;
  }

  const handleClick = (e: MouseEvent) => {
    e.stopPropagation();
    if (!errorDetail) return;
    const target = e.currentTarget as HTMLElement;
    navigator.clipboard.writeText(errorDetail);
    target.dataset.copied = '';
    setTimeout(() => { delete target.dataset.copied; }, 1200);
  };

  return (
    <span
      class={`subagent-status subagent-status-failed${errorDetail ? ' has-error-detail' : ''}`}
      title={errorDetail ?? undefined}
      onClick={errorDetail ? handleClick : undefined}
    ><span class="subagent-status-label">Failed</span></span>
  );
}

function singleResultStatus(
  result: SubagentSingleResult,
  toolCallStatus: ToolCall['status'],
  multipleResults: boolean,
): 'running' | 'failed' | 'completed' {
  if (isFailed(result)) return 'failed';
  if (isRunning(result)) return toolCallStatus === 'failed' ? 'failed' : 'running';
  if (!multipleResults && toolCallStatus === 'running') return 'running';
  if (!multipleResults && toolCallStatus === 'failed') return 'failed';
  return 'completed';
}

function summarizeSingleResult(result: SubagentSingleResult): string | null {
  return summarizeSubagentToolCallInput({ task: result.task });
}

interface SubagentSingleBlockProps {
  singleResult: SubagentSingleResult;
  toolCall: ToolCall;
  index: number;
  prefs: ChatPrefs;
  workingDirectory: string | null;
  onOpenFile: (path: string) => void;
  onContextMenu: (e: MouseEvent) => void;
  onNestedContextMenu: TranscriptContextMenuHandler;
  renderToolCall: RenderToolCall;
  multipleResults: boolean;
}

function SubagentSingleBlock({
  singleResult,
  toolCall,
  index,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  onNestedContextMenu,
  renderToolCall,
  multipleResults,
}: SubagentSingleBlockProps) {
  const disclosureKey = multipleResults
    ? `subagent:${toolCall.id}-${index}`
    : `subagent:${toolCall.id}`;
  const [open, setOpen] = useDisclosureOpen(disclosureKey, prefs.autoExpandSubagentCalls);
  const summary = summarizeSingleResult(singleResult);
  const status = singleResultStatus(singleResult, toolCall.status, multipleResults);
  const errorDetail = status === 'failed' ? subagentErrorDetail(singleResult) : undefined;
  const messages = subagentSingleResultToChatMessages(singleResult, `${toolCall.id}-${index}`);
  const nestedDisclosureDefaultsKey = `${prefs.autoExpandReasoning ? 'r1' : 'r0'}-${prefs.autoExpandToolCalls ? 't1' : 't0'}`;

  return (
    <div
      class={`tool-call tool-call-subagent ${status}`}
      role="button"
      aria-expanded={open}
      tabIndex={0}
      onClick={() => setOpen((v) => !v)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e as unknown as MouseEvent); }}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
    >
      <div class="subagent-header">
        <svg class={`thinking-block-chevron${open ? ' open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <polyline points="3,2 7,5 3,8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="subagent-agent-name">{singleResult.agent}</span>
        <PrimaryMeta result={singleResult} />
        {!open && summary && <span class="subagent-header-summary">{summary}</span>}
        <StatusIndicator status={status} errorDetail={errorDetail} />
      </div>
      {open && (
        <div
          class="subagent-messages"
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            if (!shouldOpenSubagentContextMenu(e.target)) {
              e.stopPropagation();
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            onContextMenu(e as unknown as MouseEvent);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {singleResult.runningTools && singleResult.runningTools.length > 0 && (
            <div class="subagent-running-tools">
              {singleResult.runningTools.map((runningTool, runningIndex) => (
                <span key={runningIndex} class="subagent-running-tool">{runningTool}…</span>
              ))}
            </div>
          )}
          {messages.map((message) => (
            <MessageItem
              key={`${message.id}-${nestedDisclosureDefaultsKey}`}
              message={message}
              isStreaming={false}
              prefs={prefs}
              readonly
              workingDirectory={workingDirectory}
              editingId={null}
              onEditRequest={() => {}}
              onEditConfirm={() => {}}
              onEditCancel={() => {}}
              onOpenFile={onOpenFile}
              onContextMenu={onNestedContextMenu}
              renderToolCall={renderToolCall}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SubagentBlock({
  toolCall,
  subagentResult,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  onNestedContextMenu,
  renderToolCall,
}: SubagentBlockProps) {
  const result = subagentResult ?? getRenderableSubagentResultFromToolCall(toolCall);

  if (!result) {
    return (
      <ToolCallCard
        toolCall={toolCall}
        autoExpand={prefs.autoExpandSubagentCalls}
        className="tool-call-subagent"
        workingDirectory={workingDirectory}
        onOpenFile={onOpenFile}
        onContextMenu={onContextMenu}
      />
    );
  }

  const multipleResults = result.results.length > 1;

  if (multipleResults) {
    return (
      <div class="subagent-parallel-group">
        {result.results.map((singleResult, index) => (
          <SubagentSingleBlock
            key={index}
            singleResult={singleResult}
            toolCall={toolCall}
            index={index}
            prefs={prefs}
            workingDirectory={workingDirectory}
            onOpenFile={onOpenFile}
            onContextMenu={onContextMenu}
            onNestedContextMenu={onNestedContextMenu}
            renderToolCall={renderToolCall}
            multipleResults
          />
        ))}
      </div>
    );
  }

  return (
    <SubagentSingleBlock
      singleResult={result.results[0]}
      toolCall={toolCall}
      index={0}
      prefs={prefs}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={onContextMenu}
      onNestedContextMenu={onNestedContextMenu}
      renderToolCall={renderToolCall}
      multipleResults={false}
    />
  );
}

export function ToolCallItem({
  toolCall,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall,
}: ToolCallItemProps) {
  const subagentResult = getRenderableSubagentResultFromToolCall(toolCall);
  const isSubagent = toolCall.name === 'subagent' || !!subagentResult;
  const contextType = getToolCallContextType(isSubagent ? 'subagent' : toolCall.name);
  const handleContextMenu = (e: MouseEvent) => onContextMenu(
    contextType,
    JSON.stringify(toolCall, null, 2),
    e,
  );

  if (isSubagent) {
    return (
      <SubagentBlock
        toolCall={toolCall}
        subagentResult={subagentResult}
        prefs={prefs}
        workingDirectory={workingDirectory}
        onOpenFile={onOpenFile}
        onContextMenu={handleContextMenu}
        onNestedContextMenu={onContextMenu}
        renderToolCall={renderToolCall}
      />
    );
  }

  return (
    <ToolCallCard
      toolCall={toolCall}
      autoExpand={prefs.autoExpandToolCalls}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={handleContextMenu}
    />
  );
}

/** Subagent renderer exposed for registry registration. */
export function SubagentToolRenderer({
  toolCall,
  prefs,
  workingDirectory,
  onOpenFile,
  onContextMenu,
  renderToolCall,
}: import('./registry').ToolRendererProps) {
  const subagentResult = getRenderableSubagentResultFromToolCall(toolCall);
  const contextType = getToolCallContextType('subagent');
  const handleContextMenu = (e: MouseEvent) => onContextMenu(
    contextType,
    JSON.stringify(toolCall, null, 2),
    e,
  );

  return (
    <SubagentBlock
      toolCall={toolCall}
      subagentResult={subagentResult}
      prefs={prefs}
      workingDirectory={workingDirectory}
      onOpenFile={onOpenFile}
      onContextMenu={handleContextMenu}
      onNestedContextMenu={onContextMenu}
      renderToolCall={renderToolCall}
    />
  );
}
