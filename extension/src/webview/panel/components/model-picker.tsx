/** @jsxRuntime automatic */
/** @jsxImportSource preact */

import { useCallback, useEffect, useId, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import type { ModelPickerEntry } from '../composer/model-list';

interface ModelPickerProps {
  /** Current selected model id. */
  value: string;
  /** Label shown on the closed trigger. */
  label: string;
  /** Accessible label for the control. */
  ariaLabel: string;
  /** Tooltip / title for the trigger. */
  title: string;
  /** Picker entries to display. */
  entries: ModelPickerEntry[];
  /** Called when the user selects a model. */
  onChange: (modelId: string) => void;
  /** Optional compact width for use inside settings rows. */
  compact?: boolean;
  /** Which direction the dropdown opens. Default 'up'. */
  dropdownDirection?: 'up' | 'down';
}

export function ModelPicker({ value, label, ariaLabel, title, entries, onChange, compact, dropdownDirection = 'up' }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const idBase = useId();
  const listId = `${idBase}-list`;

  const selectedIndex = entries.findIndex((e) => e.model.id === value);

  // Reset active index and move focus to the listbox when opening
  useEffect(() => {
    if (open) {
      setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
      requestAnimationFrame(() => {
        listRef.current?.focus();
      });
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click outside to close
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        listRef.current &&
        !listRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key);
    };
  }, [open]);

  // Adjust max-height so downward dropdowns fit within the viewport
  useEffect(() => {
    if (open && dropdownDirection === 'down' && listRef.current && triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      const margin = 8;
      const available = window.innerHeight - rect.bottom - margin;
      const maxHeight = Math.min(420, Math.max(120, available));
      listRef.current.style.maxHeight = `${maxHeight}px`;
    }
  }, [open, dropdownDirection]);

  // Scroll active item into view
  useEffect(() => {
    if (open && activeIndex >= 0) {
      itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, open]);

  const handleSelect = useCallback(
    (modelId: string) => {
      onChange(modelId);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );

  const onTriggerKeyDown = useCallback(
    (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
    },
    [],
  );

  const onListKeyDown = useCallback(
    (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
      if (entries.length === 0) return;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((i) => Math.min(entries.length - 1, i + 1));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((i) => Math.max(0, i - 1));
          break;
        case 'Home':
          e.preventDefault();
          setActiveIndex(0);
          break;
        case 'End':
          e.preventDefault();
          setActiveIndex(entries.length - 1);
          break;
        case 'Enter':
        case ' ': {
          e.preventDefault();
          const entry = entries[activeIndex];
          if (entry) handleSelect(entry.model.id);
          break;
        }
        case 'Tab':
          // Allow natural tab flow; close list so it doesn't trap
          setOpen(false);
          break;
      }
    },
    [entries, activeIndex, handleSelect],
  );

  const triggerClass = compact
    ? 'model-picker-trigger model-picker-trigger-compact'
    : 'model-picker-trigger';

  const wrapperClass = ['model-picker', compact && 'model-picker-compact'].filter(Boolean).join(' ');

  const activeDescendant = activeIndex >= 0 ? `${idBase}-option-${entries[activeIndex]?.model.id}` : undefined;

  return (
    <div class={wrapperClass}>
      <button
        ref={triggerRef}
        type="button"
        class={triggerClass}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        title={title}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onTriggerKeyDown}
      >
        <span class="model-picker-trigger-label">{label}</span>
        <span class="model-picker-trigger-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <div
          ref={listRef}
          id={listId}
          class={[
            'model-picker-dropdown',
            dropdownDirection === 'down' && 'model-picker-dropdown-down',
          ].filter(Boolean).join(' ')}
          role="listbox"
          tabIndex={0}
          aria-label={ariaLabel}
          aria-activedescendant={activeDescendant}
          onKeyDown={onListKeyDown}
        >
          <div class="model-picker-header" aria-hidden="true">
            <span class="model-picker-col model-picker-col-name">Model</span>
            <span class="model-picker-col model-picker-col-price">In</span>
            <span class="model-picker-col model-picker-col-price">Out</span>
            <span class="model-picker-col model-picker-col-images">Img</span>
          </div>
          <div class="model-picker-rows">
            {entries.map((entry, i) => {
              const isSelected = entry.model.id === value;
              const isActive = i === activeIndex;
              const optionId = `${idBase}-option-${entry.model.id}`;
              return (
                <div
                  key={entry.model.id}
                  id={optionId}
                  ref={(el) => { itemRefs.current[i] = el; }}
                  class={[
                    'model-picker-row',
                    isSelected && 'model-picker-row-selected',
                    isActive && 'model-picker-row-active',
                    entry.ineligible && 'model-picker-row-ineligible',
                  ].filter(Boolean).join(' ')}
                  role="option"
                  aria-selected={isSelected}
                  title={entry.title}
                  onMouseEnter={() => setActiveIndex(i)}
                  onMouseDown={(e) => {
                    // prevent focus loss so the item is clicked properly
                    e.preventDefault();
                    handleSelect(entry.model.id);
                  }}
                >
                  <span class="model-picker-col model-picker-col-name">
                    {entry.label}
                  </span>
                  <span class="model-picker-col model-picker-col-price">
                    {entry.tokenInPrice || '—'}
                  </span>
                  <span class="model-picker-col model-picker-col-price">
                    {entry.tokenOutPrice || '—'}
                  </span>
                  <span class="model-picker-col model-picker-col-images">
                    {entry.supportsImages ? '✓' : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
