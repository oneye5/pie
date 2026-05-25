# Audit Remediation — Documented Punts

This file lists architectural problems the full audit identified that the
remediation pass deliberately did NOT fix, so the next iteration can pick them
up without re-discovering them.

## R1 — Per-session patch transport never wired

**Status:** Architectural punt. Snapshot-only sync in production.

The patch builder exists at
[extension/src/host/sidebar/sync.ts](../extension/src/host/sidebar/sync.ts) but
no host code path emits `patch` envelopes; only `snapshot` is sent (see
[extension/src/host/extension-host.ts](../extension/src/host/extension-host.ts)
around the `postState` plumbing).

`docs/STATE_CONTRACT.md` describes patch flow as normative. **The contract and
the runtime are out of sync.** A future pass must either:

- implement the patch transport host-side (and re-enable patch handling in the
  webview’s state hook), or
- amend `STATE_CONTRACT.md` to describe the snapshot-only reality.

Until that happens, do not file bugs against the patch flow — it does not run.

## R7 / B6 — Two settings stores (ghost settings)

**Status:** Architectural punt.

Chat prefs (model, thinking level, extension toggles, provider toggles) live in
the VS Code `globalState` keyed store, written via
[extension/src/host/session-service/startup.ts](../extension/src/host/session-service/startup.ts).
Pruning settings (skill-pruner mode/budgets) live in a separate JSON file on
disk via
[extension/src/host/session-service/pruning-settings.ts](../extension/src/host/session-service/pruning-settings.ts).

Two consequences:

1. Editing pruning settings does not invalidate chat prefs (and vice versa).
2. Migration / reset paths must touch two stores.

A future pass should unify both under a single SettingsService with a single
persistence boundary.

## B1 (partial) — `getSessionTabRunMenuItems` is orphaned

[extension/src/webview/panel/session-tabs/run-state.ts](../extension/src/webview/panel/session-tabs/run-state.ts)
exports `getSessionTabRunMenuItems()` but no caller renders the items.

The session-tab `Done`/`Rate` badge and the composer `Mark done` button are
both wired (B1 main behavior works). The orphan is the right-click /
context-menu surface on session tabs (`Start new task`, `Continue task`,
`Mark tab as complete…`). Wire it to a popover or VS Code context menu in a
follow-up.

## B3 (residual) — No per-session "ready" expiry

`backendReadyQueue` now has a 30s wedge watchdog
([extension/src/host/extension-host.ts](../extension/src/host/extension-host.ts)
`ensureBackendReadyQueueWatchdog`), but `pendingSendQueue` entries (sends
queued while a session is in `pending:` placeholder state) still have no
timeout. If session creation hangs, the message sits forever.

Apply the same pattern there in a follow-up.
