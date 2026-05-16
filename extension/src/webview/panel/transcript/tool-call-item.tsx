/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ChatPrefs, ToolCall } from '../../../shared/protocol';
import { shouldOpenSubagentContextMenu } from './interactions';
import { summarizeToolCall } from '../tool-call-summary';
import { getToolCallContextType } from '../chat-prefs';

import { MessageItem } from './message-item';
import {
  getRenderableSubagentResultFromToolCall,
  subagentSingleResultToChatMessages,
  type SubagentResult,
  type SubagentSingleResult,
} from './subagent';
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

const SCORE_DIMS = [
  { key: 'precision', label: 'P', full: 'Precision' },
  { key: 'creativity', label: 'C', full: 'Creativity' },
  { key: 'reasoning', label: 'R', full: 'Reasoning' },
  { key: 'thoroughness', label: 'T', full: 'Thoroughness' },
] as const;

function shortenModelId(id: string): string {
  return id.replace(/:cloud$/, '').replace(/:local$/, '');
}

/** Count how many score dimensions have values. */
function countScoreDims(scores: Record<string, number> | undefined): number {
  if (!scores) return 0;
  let n = 0;
  for (const { key } of SCORE_DIMS) {
    if (scores[key] != null) n++;
  }
  return n;
}

function isRunning(result: SubagentSingleResult): boolean {
  return result.exitCode === -1 || (result.runningTools?.length ?? 0) > 0;
}

function isFailed(result: SubagentSingleResult): boolean {
  if (isRunning(result)) return false;
  return result.exitCode !== 0 || result.stopReason === 'error' || result.stopReason === 'aborted';
}

/** Aggregate status across all results in a subagent call. */
function aggregateStatus(results: SubagentSingleResult[], toolCallStatus: ToolCall['status']): 'running' | 'failed' | 'completed' {
  if (toolCallStatus === 'running') return 'running';
  if (toolCallStatus === 'failed') return 'failed';
  // Any child still running?
  if (results.some((r) => isRunning(r))) return 'running';
  // Any child failed?
  if (results.some((r) => isFailed(r))) return 'failed';
  return 'completed';
}

/** Compact score bar: colored number badges for each dimension that has a value. */
function ScoreBar({ scores }: { scores: Record<string, number> | undefined }) {
  if (!scores || countScoreDims(scores) === 0) return null;
  return (
    <span class="subagent-scores">
      {SCORE_DIMS.map(({ key, label, full }) => {
        const val = scores[key];
        if (val == null) return null;
        return (
          <span
            key={key}
            class="subagent-score-dim"
            data-score={val}
            title={`${full}: ${val}/5`}
          >{label}{val}</span>
        );
      })}
    </span>
  );
}

/** Model badge shown in the header row. */
function ModelTag({ result }: { result: SubagentSingleResult }) {
  const model = result.selectedModel ?? result.model;
  if (!model) return null;
  const short = shortenModelId(model);
  return <span class="subagent-model-tag" title={model}>{short}</span>;
}

/** Thinking pill, if present. */
function ThinkingTag({ result }: { result: SubagentSingleResult }) {
  if (!result.thinkingLevel) return null;
  return <span class="subagent-thinking-tag">{result.thinkingLevel}</span>;
}

/** Build a tooltip showing model-selection pool details. */
function modelPoolTooltip(result: SubagentSingleResult): string | undefined {
  if (!result.selectionPool || !result.selectionFitScores) return undefined;
  let tooltip = 'Model selection:\n';
  tooltip += result.selectionPool
    .map((m, i) => {
      const marker = m === result.selectedModel ? '→ ' : '  ';
      const fit = result.selectionFitScores![i];
      return `${marker}${shortenModelId(m)}${fit != null ? ` (${fit})` : ''}`;
    })
    .join('\n');
  if (result.thinkingLevel) tooltip += `\nThinking: ${result.thinkingLevel}`;
  return tooltip;
}

/** Compact badge for inline use in multi-agent labels when expanded. */
function InlineBadge({ result }: { result: SubagentSingleResult }) {
  const hasScores = countScoreDims(result.taskScores) > 0;
  const model = result.selectedModel ?? result.model;
  if (!hasScores && !model) return null;

  return (
    <span class="subagent-inline-badge" title={modelPoolTooltip(result)}>
      {hasScores && <ScoreBar scores={result.taskScores} />}
      {model && <span class="subagent-model-tag">{shortenModelId(model)}</span>}
      {result.thinkingLevel && <span class="subagent-thinking-tag">{result.thinkingLevel}</span>}
    </span>
  );
}

/** Status indicator: small dot or label at the right side of the header. */
function StatusIndicator({ status }: { status: 'running' | 'failed' | 'completed' }) {
  if (status === 'completed') return null;
  if (status === 'running') {
    return <span class="subagent-status subagent-status-running" aria-label="Running" />;
  }
  return <span class="subagent-status subagent-status-failed">Failed</span>;
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
  const [open, setOpen] = useDisclosureOpen(`subagent:${toolCall.id}`, prefs.autoExpandSubagentCalls);

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

  const agentNames = [...new Set(result.results.map((r) => r.agent))];
  const multipleResults = result.results.length > 1;
  const singleResult = result.results.length === 1 ? result.results[0] : undefined;
  const summary = summarizeToolCall(toolCall);
  const status = aggregateStatus(result.results, toolCall.status);
  const nestedDisclosureDefaultsKey = `${prefs.autoExpandReasoning ? 'r1' : 'r0'}-${prefs.autoExpandToolCalls ? 't1' : 't0'}`;

  // Name display: for single agent show the name; for multi show "N agents"
  const nameDisplay = multipleResults
    ? (agentNames.length === 1 ? `${result.results.length}× ${agentNames[0]}` : `${agentNames.length} agents`)
    : agentNames[0] ?? 'agent';

  return (
    <div
      class={`tool-call tool-call-subagent ${toolCall.status}`}
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
        <span class="subagent-agent-name">{nameDisplay}</span>
        {singleResult ? (
          <>
            <ScoreBar scores={singleResult.taskScores} />
            <ModelTag result={singleResult} />
            <ThinkingTag result={singleResult} />
          </>
        ) : (
          <MultiAgentSummary results={result.results} />
        )}
        {!open && summary && <span class="subagent-header-summary">{summary}</span>}
        <StatusIndicator status={status} />
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
          {result.results.map((singleResult, index) => {
            const messages = subagentSingleResultToChatMessages(singleResult, `${toolCall.id}-${index}`);
            return (
              <div key={index} class={`subagent-result${multipleResults ? ' labeled' : ''}`}>
                {multipleResults && (
                  <div class="subagent-result-label">
                    {singleResult.agent}
                    <InlineBadge result={singleResult} />
                  </div>
                )}
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
                    overlayParts={undefined}
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
            );
          })}
        </div>
      )}
    </div>
  );
}

/** For multi-agent results shown collapsed: list unique model names. */
function MultiAgentSummary({ results }: { results: SubagentSingleResult[] }) {
  const models = [...new Set(results.map((r) => r.selectedModel ?? r.model).filter(Boolean))];
  if (models.length === 0) return null;
  return (
    <span class="subagent-multi-models">
      {models.map((m) => <span key={m} class="subagent-model-tag">{shortenModelId(m!)}</span>)}
    </span>
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