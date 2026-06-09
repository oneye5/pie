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

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function getTriggerClass(compact?: boolean): string {
  return compact
    ? 'model-picker-trigger model-picker-trigger-compact'
    : 'model-picker-trigger';
}

function getWrapperClass(compact?: boolean): string {
  return ['model-picker', compact && 'model-picker-compact'].filter(Boolean).join(' ');
}

function getDropdownClass(direction: 'up' | 'down'): string {
  return [
    'model-picker-dropdown',
    direction === 'down' && 'model-picker-dropdown-down',
  ].filter(Boolean).join(' ');
}

function getRowClass(isSelected: boolean, isActive: boolean, ineligible?: boolean): string {
  return [
    'model-picker-row',
    isSelected && 'model-picker-row-selected',
    isActive && 'model-picker-row-active',
    ineligible && 'model-picker-row-ineligible',
  ].filter(Boolean).join(' ');
}

type ListKeyAction = 'next' | 'prev' | 'first' | 'last' | 'select' | 'close';

function resolveListKeyAction(key: string): ListKeyAction | null {
  switch (key) {
    case 'ArrowDown':
      return 'next';
    case 'ArrowUp':
      return 'prev';
    case 'Home':
      return 'first';
    case 'End':
      return 'last';
    case 'Enter':
    case ' ':
      return 'select';
    case 'Tab':
      return 'close';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Sub-hooks
// ---------------------------------------------------------------------------

function useFocusOnOpen(
  open: boolean,
  selectedIndex: number,
  setActiveIndex: (index: number) => void,
  listRef: { current: HTMLDivElement | null },
) {
  useEffect(() => {
    if (!open) return;
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    requestAnimationFrame(() => {
      listRef.current?.focus();
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

function useClickOutside(
  open: boolean,
  setOpen: (value: boolean) => void,
  triggerRef: { current: HTMLButtonElement | null },
  listRef: { current: HTMLDivElement | null },
) {
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      const target = e.target as Node;
      const outside =
        listRef.current &&
        !listRef.current.contains(target) &&
        triggerRef.current &&
        !triggerRef.current.contains(target);
      if (outside) {
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
}

function useDropdownMaxHeight(
  open: boolean,
  dropdownDirection: 'up' | 'down',
  listRef: { current: HTMLDivElement | null },
  triggerRef: { current: HTMLButtonElement | null },
) {
  useEffect(() => {
    if (!open) return;
    if (dropdownDirection !== 'down') return;
    if (!listRef.current || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const margin = 8;
    const available = window.innerHeight - rect.bottom - margin;
    const maxHeight = Math.min(420, Math.max(120, available));
    listRef.current.style.maxHeight = `${maxHeight}px`;
  }, [open, dropdownDirection]);
}

function useScrollActiveItem(
  open: boolean,
  activeIndex: number,
  itemRefs: { current: (HTMLDivElement | null)[] },
) {
  useEffect(() => {
    if (!open) return;
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);
}

function useHandleSelect(
  onChange: (modelId: string) => void,
  setOpen: (value: boolean) => void,
  triggerRef: { current: HTMLButtonElement | null },
) {
  return useCallback(
    (modelId: string) => {
      onChange(modelId);
      setOpen(false);
      triggerRef.current?.focus();
    },
    [onChange],
  );
}

function useTriggerKeyDown(setOpen: (value: boolean) => void) {
  return useCallback(
    (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setOpen(true);
      }
    },
    [],
  );
}

function useListKeyDown(
  entries: ModelPickerEntry[],
  activeIndex: number,
  handleSelect: (modelId: string) => void,
  setOpen: (value: boolean) => void,
  setActiveIndex: (updater: (prev: number) => number) => void,
) {
  return useCallback(
    (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => {
      if (entries.length === 0) return;
      const action = resolveListKeyAction(e.key);
      if (!action) return;
      if (action === 'close') {
        setOpen(false);
        return;
      }
      e.preventDefault();
      switch (action) {
        case 'next':
          setActiveIndex((i) => Math.min(entries.length - 1, i + 1));
          break;
        case 'prev':
          setActiveIndex((i) => Math.max(0, i - 1));
          break;
        case 'first':
          setActiveIndex(() => 0);
          break;
        case 'last':
          setActiveIndex(() => entries.length - 1);
          break;
        case 'select': {
          const entry = entries[activeIndex];
          if (entry) handleSelect(entry.model.id);
          break;
        }
      }
    },
    [entries, activeIndex, handleSelect],
  );
}

function useModelPicker({
  value,
  entries,
  onChange,
  dropdownDirection,
}: {
  value: string;
  entries: ModelPickerEntry[];
  onChange: (modelId: string) => void;
  dropdownDirection: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);
  const idBase = useId();
  const listId = `${idBase}-list`;
  const selectedIndex = entries.findIndex((e) => e.model.id === value);

  useFocusOnOpen(open, selectedIndex, setActiveIndex, listRef);
  useClickOutside(open, setOpen, triggerRef, listRef);
  useDropdownMaxHeight(open, dropdownDirection, listRef, triggerRef);
  useScrollActiveItem(open, activeIndex, itemRefs);

  const handleSelect = useHandleSelect(onChange, setOpen, triggerRef);
  const onTriggerKeyDown = useTriggerKeyDown(setOpen);
  const onListKeyDown = useListKeyDown(entries, activeIndex, handleSelect, setOpen, setActiveIndex);

  const activeDescendant = activeIndex >= 0 ? `${idBase}-option-${entries[activeIndex]?.model.id}` : undefined;

  return {
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    triggerRef,
    listRef,
    itemRefs,
    idBase,
    listId,
    selectedIndex,
    handleSelect,
    onTriggerKeyDown,
    onListKeyDown,
    activeDescendant,
  };
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ModelPickerTriggerProps {
  triggerRef: { current: HTMLButtonElement | null };
  className: string;
  ariaLabel: string;
  title: string;
  label: string;
  open: boolean;
  onClick: () => void;
  onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLButtonElement>) => void;
}

function ModelPickerTrigger({
  triggerRef,
  className,
  ariaLabel,
  title,
  label,
  open,
  onClick,
  onKeyDown,
}: ModelPickerTriggerProps) {
  return (
    <button
      ref={triggerRef}
      type="button"
      class={className}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-label={ariaLabel}
      title={title}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <span class="model-picker-trigger-label">{label}</span>
      <span class="model-picker-trigger-caret" aria-hidden="true">
        ▾
      </span>
    </button>
  );
}

interface ModelPickerRowProps {
  entry: ModelPickerEntry;
  isSelected: boolean;
  isActive: boolean;
  optionId: string;
  setItemRef: (el: HTMLDivElement | null) => void;
  onMouseEnter: () => void;
  onMouseDown: (e: JSX.TargetedMouseEvent<HTMLDivElement>) => void;
}

function ModelPickerRow({
  entry,
  isSelected,
  isActive,
  optionId,
  setItemRef,
  onMouseEnter,
  onMouseDown,
}: ModelPickerRowProps) {
  return (
    <div
      key={entry.model.id}
      id={optionId}
      ref={setItemRef}
      class={getRowClass(isSelected, isActive, entry.ineligible)}
      role="option"
      aria-selected={isSelected}
      title={entry.title}
      onMouseEnter={onMouseEnter}
      onMouseDown={onMouseDown}
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
}

interface ModelPickerDropdownProps {
  listRef: { current: HTMLDivElement | null };
  listId: string;
  dropdownDirection: 'up' | 'down';
  ariaLabel: string;
  activeDescendant: string | undefined;
  onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLDivElement>) => void;
  entries: ModelPickerEntry[];
  value: string;
  activeIndex: number;
  idBase: string;
  handleSelect: (modelId: string) => void;
  setActiveIndex: (index: number) => void;
  itemRefs: { current: (HTMLDivElement | null)[] };
}

function ModelPickerDropdown({
  listRef,
  listId,
  dropdownDirection,
  ariaLabel,
  activeDescendant,
  onKeyDown,
  entries,
  value,
  activeIndex,
  idBase,
  handleSelect,
  setActiveIndex,
  itemRefs,
}: ModelPickerDropdownProps) {
  return (
    <div
      ref={listRef}
      id={listId}
      class={getDropdownClass(dropdownDirection)}
      role="listbox"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-activedescendant={activeDescendant}
      onKeyDown={onKeyDown}
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
            <ModelPickerRow
              key={entry.model.id}
              entry={entry}
              isSelected={isSelected}
              isActive={isActive}
              optionId={optionId}
              setItemRef={(el) => { itemRefs.current[i] = el; }}
              onMouseEnter={() => setActiveIndex(i)}
              onMouseDown={(e) => {
                // prevent focus loss so the item is clicked properly
                e.preventDefault();
                handleSelect(entry.model.id);
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ModelPicker({
  value,
  label,
  ariaLabel,
  title,
  entries,
  onChange,
  compact,
  dropdownDirection = 'up',
}: ModelPickerProps) {
  const state = useModelPicker({ value, entries, onChange, dropdownDirection });

  const triggerClass = getTriggerClass(compact);
  const wrapperClass = getWrapperClass(compact);

  return (
    <div class={wrapperClass}>
      <ModelPickerTrigger
        triggerRef={state.triggerRef}
        className={triggerClass}
        ariaLabel={ariaLabel}
        title={title}
        label={label}
        open={state.open}
        onClick={() => state.setOpen((o) => !o)}
        onKeyDown={state.onTriggerKeyDown}
      />
      {state.open && (
        <ModelPickerDropdown
          listRef={state.listRef}
          listId={state.listId}
          dropdownDirection={dropdownDirection}
          ariaLabel={ariaLabel}
          activeDescendant={state.activeDescendant}
          onKeyDown={state.onListKeyDown}
          entries={entries}
          value={value}
          activeIndex={state.activeIndex}
          idBase={state.idBase}
          handleSelect={state.handleSelect}
          setActiveIndex={state.setActiveIndex}
          itemRefs={state.itemRefs}
        />
      )}
    </div>
  );
}
