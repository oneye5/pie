# Storage relocation plan

Status: mostly implemented.

Goal: make auth, session, and analytics storage locations explicit and overridable while keeping the repo's portable config separate from local runtime files.

## Storage locations

| Data | Current repo-local fallback | Preferred default | Override |
|---|---|---|---|
| Auth (`auth.json`) | `<repo>/auth.json` | OS user config dir | `PI_CODING_AGENT_AUTH_DIR` |
| Sessions | `<repo>/data/outcomes/sessions/` | repo-local runtime dir | `PI_CODING_AGENT_SESSION_DIR` |
| Run analytics (`StatsService`) | `<repo>/data/outcomes/<workspaceId>/` | repo-local runtime dir | `PIE_ANALYTICS_DIR` |

## Implemented pieces

- Backend resolves auth path at startup and reports it in `backend.ready`.
- Host resolves run-analytics storage through `getDataOutcomesRootPath()`.
- Installers can migrate legacy session files and repair reachable `sessionDir` overrides.
- Run analytics can migrate older `usage-data`/`runs` layouts into `data/outcomes`.

## Follow-ups

- Keep installer behavior idempotent across machines.
- Keep docs and tests aligned with the active storage defaults.
- Consider replacing file-based auth with an OS credential-store integration later if desired.
