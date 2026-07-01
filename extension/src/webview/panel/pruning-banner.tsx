/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useState } from 'preact/hooks';

import type { PruningResult } from '../../shared/protocol';
import { cx } from './utils/cx';
import { Collapsible } from './components/collapsible';
import { ResizablePre } from './components/resizable-pre';
import { highlightToolResultText } from './transcript/highlight';

interface PruningBannerProps {
  pruningResult: PruningResult;
}

/**
 * Compact, collapsible banner that surfaces skill-pruner results.
 * Appears above the system-prompts section when pruning occurred.
 */
export function PruningBanner({ pruningResult }: PruningBannerProps) {
  const [expanded, setExpanded] = useState(false);
  const [rawExpanded, setRawExpanded] = useState(false);

  const {
    skillsKept,
    skillsTotal,
    toolsKept,
    toolsTotal,
    tokensSaved,
    hasSkillPruning,
    hasToolPruning,
    error,
    details,
  } = pruningResult;

  // Error state
  if (error) {
    return (
      <Collapsible
        open={expanded}
        onToggle={setExpanded}
        ariaLabel="Toggle pruning error details"
        class={cx('pruning-banner pruning-banner-error', expanded ? 'pruning-banner-expanded' : 'pruning-banner-collapsed')}
        headerClass="pruning-banner-summary"
        bodyClass="pruning-banner-detail"
        closeFooter={false}
        header={
          <>
            <span class="pruning-banner-icon" aria-hidden="true">⚠</span>
            <span class="pruning-banner-text">Pruning failed</span>
          </>
        }
      >
        <div class="pruning-banner-detail-row">
          <span class="pruning-banner-detail-text pruning-banner-error-text">{error}</span>
        </div>
      </Collapsible>
    );
  }

  const summaryParts: string[] = [];
  if (skillsTotal > 0) summaryParts.push(`${skillsKept}/${skillsTotal} skills kept`);
  if (toolsTotal > 0) summaryParts.push(`${toolsKept}/${toolsTotal} tools kept`);
  if (skillsTotal === 0 && toolsTotal === 0) summaryParts.push('No skills or tools to prune');
  const summaryCore = summaryParts.join(' · ');
  const tokenSuffix = tokensSaved > 0
    ? `${summaryCore ? ' · ' : ''}~${tokensSaved} tokens saved`
    : '';
  const summaryText = `${summaryCore}${tokenSuffix}`;

  return (
    <Collapsible
      open={expanded}
      onToggle={setExpanded}
      ariaLabel="Toggle pruning details"
      class={cx('pruning-banner', expanded ? 'pruning-banner-expanded' : 'pruning-banner-collapsed')}
      headerClass="pruning-banner-summary"
      bodyClass="pruning-banner-detail"
      closeFooter={false}
      header={
        <>
          <span class="pruning-banner-icon" aria-hidden="true">✂</span>
          <span class="pruning-banner-text">{summaryText}</span>
        </>
      }
    >
      {details ? (
        <>
          {details.excludedSkills.length > 0 && (
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Skills pruned</span>
              <span class="pruning-banner-detail-text">{details.excludedSkills.join(', ')}</span>
            </div>
          )}
          {details.includedSkills.length > 0 && (
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Skills kept</span>
              <span class="pruning-banner-detail-text">{details.includedSkills.join(', ')}</span>
            </div>
          )}
          {details.excludedTools.length > 0 && (
            <div class="pruning-banner-detail-row">
              <span class="pruning-banner-hint">Tools pruned</span>
              <span class="pruning-banner-detail-text">{details.excludedTools.join(', ')}</span>
            </div>
          )}
          {(details.prepassSystemPrompt || details.prepassResponse) && (
            <Collapsible
              open={rawExpanded}
              onToggle={setRawExpanded}
              ariaLabel="Toggle raw LLM output"
              class="pruning-banner-raw-toggle"
              headerClass="pruning-banner-raw-toggle-text"
              bodyClass="pruning-banner-raw-content"
              closeFooter={false}
              header={<span>Raw LLM output</span>}
            >
              {details.prepassSystemPrompt && (
                <div class="pruning-banner-raw-section">
                  <span class="pruning-banner-hint">System prompt</span>
                  <ResizablePre class="pruning-banner-raw-pre hljs-scope" minHeight={80}>
                    <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(details.prepassSystemPrompt) }} />
                  </ResizablePre>
                </div>
              )}
              {details.prepassResponse && (
                <div class="pruning-banner-raw-section">
                  <span class="pruning-banner-hint">LLM reply</span>
                  <ResizablePre class="pruning-banner-raw-pre hljs-scope" minHeight={80}>
                    <code class="hljs" dangerouslySetInnerHTML={{ __html: highlightToolResultText(details.prepassResponse) }} />
                  </ResizablePre>
                </div>
              )}
            </Collapsible>
          )}
        </>
      ) : (
        <>
          <div class="pruning-banner-detail-row">
            <span class="pruning-banner-hint">Skill pruning</span>
            <span class="pruning-banner-detail-text">
              {hasSkillPruning
                ? 'Skills pruned by relevance score (low-scoring skills removed before injection)'
                : 'No skills were pruned'}
            </span>
          </div>
          <div class="pruning-banner-detail-row">
            <span class="pruning-banner-hint">Tool pruning</span>
            <span class="pruning-banner-detail-text">
              {hasToolPruning
                ? 'Tools pruned by tier (only high-tier request_tools included)'
                : 'No tools were pruned'}
            </span>
          </div>
        </>
      )}
    </Collapsible>
  );
}
