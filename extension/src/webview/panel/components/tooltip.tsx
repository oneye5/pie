/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { cloneElement, toChildArray, type ComponentChildren, type JSX, type VNode } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

let tooltipIdCounter = 0;

function nextTooltipId(): string {
  tooltipIdCounter += 1;
  return `pie-tooltip-${tooltipIdCounter}`;
}

function clearTimer(id: number | undefined): void {
  if (id !== undefined) {
    window.clearTimeout(id);
  }
}

export interface TooltipProps {
  /** Tooltip text. Null/undefined/empty hides the tooltip. */
  content: string | null | undefined;
  /** Element that triggers the tooltip. */
  children?: ComponentChildren;
  /** Delay before showing, in milliseconds. */
  delayShow?: number;
  /** Delay before hiding, in milliseconds. */
  delayHide?: number;
  /** Preferred placement relative to the trigger. */
  placement?: 'top' | 'bottom';
}

/**
 * Custom tooltip wrapper.
 *
 * Native `title` tooltips close whenever the titled element re-renders, which
 * makes live indicators (tokens/sec, context window, cost, run status) hard to
 * inspect during active sessions. This component renders an out-of-tree DOM
 * node for the tooltip so it survives parent re-renders and updates its text
 * in place while the pointer is still over the trigger.
 */
export function Tooltip({
  content,
  children,
  delayShow = 350,
  delayHide = 50,
  placement = 'bottom',
}: TooltipProps): JSX.Element {
  const [isVisible, setIsVisible] = useState(false);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const hostIdRef = useRef<string>(nextTooltipId());
  const timersRef = useRef<{ show?: number; hide?: number }>({});

  const showTooltip = useCallback(() => {
    clearTimer(timersRef.current.hide);
    timersRef.current.hide = undefined;
    if (timersRef.current.show) return;
    timersRef.current.show = window.setTimeout(() => {
      timersRef.current.show = undefined;
      setIsVisible(true);
    }, delayShow);
  }, [delayShow]);

  const hideTooltip = useCallback(() => {
    clearTimer(timersRef.current.show);
    timersRef.current.show = undefined;
    if (timersRef.current.hide) return;
    timersRef.current.hide = window.setTimeout(() => {
      timersRef.current.hide = undefined;
      setIsVisible(false);
    }, delayHide);
  }, [delayHide]);

  // Create host lazily and update its content/position whenever visibility or
  // the tooltip text changes. Keeping the host outside the React tree means
  // parent re-renders never unmount or recreate the tooltip while the pointer
  // is hovering, and re-using the same DOM node while visible avoids flicker
  // when live values update frequently (e.g. the tokens/sec indicator).
  useEffect(() => {
    let host = hostRef.current;
    if (!host) {
      host = document.createElement('div');
      host.id = hostIdRef.current;
      host.className = 'pie-tooltip-host';
      host.role = 'tooltip';
      host.style.position = 'fixed';
      host.style.zIndex = '300';
      host.style.pointerEvents = 'none';
      document.body.appendChild(host);
      hostRef.current = host;
    }

    const trigger = triggerRef.current;

    if (!isVisible || !content || !trigger) {
      host.style.display = 'none';
      host.textContent = '';
      return;
    }

    host.style.display = 'block';
    host.textContent = content;

    const rect = trigger.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const gap = 6;

    let top =
      placement === 'bottom'
        ? rect.bottom + gap
        : rect.top - hostRect.height - gap;
    let left = rect.left + rect.width / 2 - hostRect.width / 2;

    // Keep inside the viewport.
    const maxLeft = window.innerWidth - hostRect.width - gap;
    left = Math.max(gap, Math.min(left, maxLeft));
    if (top + hostRect.height + gap > window.innerHeight) {
      top = rect.top - hostRect.height - gap;
    }
    top = Math.max(gap, top);

    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
  }, [isVisible, content, placement]);

  // Remove the host when the component unmounts, and tear down any pending timers.
  useEffect(() => {
    return () => {
      const host = hostRef.current;
      if (host) {
        hostRef.current = null;
        document.body.removeChild(host);
      }
      clearTimer(timersRef.current.show);
      clearTimer(timersRef.current.hide);
    };
  }, []);

  // Hide on Escape, viewport resize, or any scroll (capture phase so it
  // catches scroll within nested scrollable containers like the transcript,
  // which auto-scrolls during a run and would leave the fixed tooltip
  // detached from its trigger).
  useEffect(() => {
    if (!isVisible) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsVisible(false);
    };
    const handleResize = () => setIsVisible(false);
    const handleScroll = () => setIsVisible(false);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', handleScroll, true);
    };
  }, [isVisible]);

  const childArray = toChildArray(children);
  const singleChild = childArray.length === 1 ? childArray[0] : null;
  const singleVNode =
    singleChild && typeof singleChild === 'object' && 'props' in singleChild
      ? (singleChild as VNode)
      : null;

  // Clone a single element child so keyboard focus on interactive triggers
  // (buttons, selects) also opens/closes the tooltip. The wrapper still owns the
  // mouse/pointer events and the positioning ref.
  const originalDescribedBy = singleVNode
    ? (singleVNode.props as { 'aria-describedby'?: string })['aria-describedby']
    : undefined;
  const describedBy = isVisible
    ? (originalDescribedBy ? `${originalDescribedBy} ${hostIdRef.current}` : hostIdRef.current)
    : originalDescribedBy;

  const wrappedChildren = singleVNode
    ? cloneElement(singleVNode, {
        'aria-describedby': describedBy,
        onFocus: (e: FocusEvent) => {
          (singleVNode.props as { onFocus?: (event: FocusEvent) => void }).onFocus?.(e);
          showTooltip();
        },
        onBlur: (e: FocusEvent) => {
          (singleVNode.props as { onBlur?: (event: FocusEvent) => void }).onBlur?.(e);
          hideTooltip();
        },
      })
    : children;

  return (
    <span
      ref={triggerRef}
      class="pie-tooltip-trigger"
      aria-describedby={singleVNode ? undefined : (isVisible ? hostIdRef.current : undefined)}
      onMouseEnter={showTooltip}
      onMouseLeave={hideTooltip}
      onPointerEnter={showTooltip}
      onPointerLeave={hideTooltip}
    >
      {wrappedChildren}
    </span>
  );
}
