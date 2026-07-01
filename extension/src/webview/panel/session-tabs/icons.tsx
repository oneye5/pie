/** @jsxRuntime automatic */
/** @jsxImportSource preact */

// Small reusable inline-SVG icons shared by the session-tab context menu. Each
// renders a 13×13 leading indicator slot (the `context-menu-check` class) kept
// at opacity:0 so menu item text stays left-aligned whether or not an icon is
// shown — the empty `CheckmarkIcon` is the spacer used on items without one.

export function CheckmarkIcon() {
  return (
    <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0" />
  );
}

export function DuplicateIcon() {
  return (
    <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
      <rect x="2" y="2" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.2" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg class="context-menu-check" width="13" height="13" viewBox="0 0 13 13" aria-hidden="true" style="opacity:0">
      <line x1="3" y1="3" x2="10" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
      <line x1="10" y1="3" x2="3" y2="10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
    </svg>
  );
}
