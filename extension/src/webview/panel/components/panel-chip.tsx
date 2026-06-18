/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import type { ComponentChildren, JSX } from 'preact';

type PanelChipVariant = 'toolbar' | 'pruning';
type PanelChipTone = 'neutral' | 'muted' | 'success' | 'warning' | 'danger' | 'accent';

interface PanelChipBaseProps {
  variant: PanelChipVariant;
  tone?: PanelChipTone;
  label?: ComponentChildren;
  children?: ComponentChildren;
  leading?: ComponentChildren;
  trailing?: ComponentChildren;
  className?: string;
  title?: string;
  ariaLabel?: string;
}

interface PanelChipSpanProps extends PanelChipBaseProps {
  as?: 'span' | 'div';
  role?: JSX.AriaRole;
  ariaLive?: 'off' | 'polite' | 'assertive';
}

interface PanelChipButtonProps extends PanelChipBaseProps {
  as: 'button';
  expanded?: boolean;
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>;
}

type PanelChipProps = PanelChipSpanProps | PanelChipButtonProps;

function chipClassName({ variant, tone = 'neutral', className }: Pick<PanelChipBaseProps, 'variant' | 'tone' | 'className'>): string {
  return [
    'panel-chip',
    `panel-chip-${variant}`,
    `panel-chip-${tone}`,
    className,
  ].filter(Boolean).join(' ');
}

function chipContent({ label, children, leading, trailing }: Pick<PanelChipBaseProps, 'label' | 'children' | 'leading' | 'trailing'>) {
  return (
    <>
      {leading && <span class="panel-chip-leading" aria-hidden="true">{leading}</span>}
      {label !== undefined ? <span class="panel-chip-label">{label}</span> : children}
      {trailing && <span class="panel-chip-trailing" aria-hidden="true">{trailing}</span>}
    </>
  );
}

function PanelChip(props: PanelChipProps) {
  const className = chipClassName(props);
  const content = chipContent(props);

  if (props.as === 'button') {
    return (
      <button
        class={className}
        type="button"
        aria-expanded={props.expanded}
        aria-label={props.ariaLabel}
        title={props.title}
        onClick={props.onClick}
      >
        {content}
      </button>
    );
  }

  if (props.as === 'div') {
    return (
      <div
        class={className}
        role={props.role}
        aria-live={props.ariaLive}
        aria-label={props.ariaLabel}
        title={props.title}
      >
        {content}
      </div>
    );
  }

  return (
    <span
      class={className}
      role={props.role}
      aria-live={props.ariaLive}
      aria-label={props.ariaLabel}
      title={props.title}
    >
      {content}
    </span>
  );
}

interface ToolbarChipProps {
  label: ComponentChildren;
  title?: string;
  ariaLabel?: string;
  tone?: PanelChipTone;
}

export function ToolbarChip({ label, title, ariaLabel, tone = 'muted' }: ToolbarChipProps) {
  return <PanelChip variant="toolbar" tone={tone} label={label} title={title} ariaLabel={ariaLabel} />;
}

export type ToolbarIndicatorKind = 'tokens' | 'cost' | 'context' | 'speed';

interface ToolbarIndicatorChipProps extends ToolbarChipProps {
  kind: ToolbarIndicatorKind;
  severity?: 'warning' | 'critical' | string | null;
  /** Visual pause marker for indicators whose underlying measurement is frozen (e.g. the speed chip while a tool runs). */
  state?: 'paused' | null;
}

function indicatorClassName(kind: ToolbarIndicatorKind, severity?: string | null, state?: 'paused' | null): string {
  return [
    'panel-chip-indicator',
    `panel-chip-indicator-${kind}`,
    kind === 'tokens' && 'session-token-indicator',
    kind === 'cost' && 'session-cost-indicator',
    kind === 'context' && 'context-window-indicator',
    severity,
    state === 'paused' && 'is-paused',
  ].filter(Boolean).join(' ');
}

export function ToolbarIndicatorChip({ kind, severity, state, label, title, ariaLabel }: ToolbarIndicatorChipProps) {
  return (
    <PanelChip
      variant="toolbar"
      tone="neutral"
      className={indicatorClassName(kind, severity, state)}
      ariaLabel={ariaLabel}
      title={title}
      label={label}
    />
  );
}

export type ToolbarRunStatusTone = 'open' | 'pending-score' | 'neutral' | string;

function toolbarRunStatusTone(tone: ToolbarRunStatusTone): PanelChipTone {
  if (tone === 'open') return 'success';
  if (tone === 'pending-score') return 'warning';
  return 'muted';
}

interface ToolbarRunStatusChipProps {
  label: ComponentChildren;
  title?: string;
  tone: ToolbarRunStatusTone;
}

export function ToolbarRunStatusChip({ label, title, tone }: ToolbarRunStatusChipProps) {
  return (
    <PanelChip
      variant="toolbar"
      tone={toolbarRunStatusTone(tone)}
      className="panel-chip-run-status"
      title={title}
      label={label}
    />
  );
}



interface ToolbarSelectChipProps {
  value: string;
  title: string;
  ariaLabel: string;
  width: 'reasoning';
  onChange: JSX.GenericEventHandler<HTMLSelectElement>;
  children: ComponentChildren;
}

export function ToolbarSelectChip({ value, title, ariaLabel, width, onChange, children }: ToolbarSelectChipProps) {
  return (
    <select
      class={`panel-chip panel-chip-toolbar panel-chip-select panel-chip-${width}-select`}
      value={value}
      onChange={onChange}
      aria-label={ariaLabel}
      title={title}
    >
      {children}
    </select>
  );
}

interface PruningHeaderChipControlProps {
  label: ComponentChildren;
  title: string;
  ariaLabel?: string;
  expanded?: boolean;
  failed?: boolean;
  pending?: boolean;
  leading?: ComponentChildren;
  trailing?: ComponentChildren;
  onClick?: JSX.MouseEventHandler<HTMLButtonElement>;
}

function pruningTone({ failed, expanded }: Pick<PruningHeaderChipControlProps, 'failed' | 'expanded'>): PanelChipTone {
  if (failed) return 'danger';
  if (expanded) return 'accent';
  return 'muted';
}

export function PruningHeaderChipControl(props: PruningHeaderChipControlProps) {
  if (props.pending) {
    return (
      <PanelChip
        as="div"
        variant="pruning"
        tone="muted"
        className="panel-chip-pruning-pending"
        role="status"
        ariaLive="polite"
        ariaLabel={props.ariaLabel}
        title={props.title}
        label={props.label}
      />
    );
  }

  return (
    <PanelChip
      as="button"
      variant="pruning"
      tone={pruningTone(props)}
      className="panel-chip-interactive"
      expanded={props.expanded}
      ariaLabel={props.ariaLabel}
      title={props.title}
      onClick={props.onClick}
      leading={props.leading}
      label={props.label}
      trailing={props.trailing}
    />
  );
}
