# pi-config

A personal stack built around the [`pi` coding agent](https://www.npmjs.com/package/@mariozechner/pi-coding-agent): a VS Code sidebar extension (*pie*), reusable pi plugins, local run-analytics tooling, and the maintainer's own agents/skills/config.

## What's in this repo

| Path | What it is | Distribution |
|---|---|---|
| [`extension/`](extension) | *pie* — VS Code sidebar extension that surfaces a `pi` agent as chat | Source build today; CI-built VSIX planned |
| [`extensions/subagent/`](extensions/subagent), [`extensions/cwd-skills/`](extensions/cwd-skills) | Reusable pi plugins (subagent delegation, cwd-scoped skill discovery) | Loaded by `pi` via `settings.json` packages |
| [`analysis/`](analysis) | Local DuckDB + static-site workspace for run analytics | Internal research tool |
| [`agents/`](agents), [`skills/`](skills), [`APPEND_SYSTEM.md`](APPEND_SYSTEM.md), [`settings.json`](settings.json) | Maintainer's personal pi config | Reference / example only |
| [`data/`](data), [`pie/`](pie), [`auth.json`](#) | Local runtime/auth data | Local-only; excluded from the portable config |
| [`docs/`](docs) | Design contracts and plans; start at [`docs/INDEX.md`](docs/INDEX.md) | Internal |

## Goals

- Take effective workflows and refine them — the flow of writing docs, making tweaks, and reviewing changes in VS Code while agents work in the sidebar.
- Collect local usage data to improve outcomes — which models, skills, tools, and treatments actually produce results.
- Keep one portable config across machines, with session history local and out of git.

These are the *original* design drivers. The architecture is being adjusted so external users can adopt the publishable pieces (extension, pi plugins) without inheriting the personal layer; see [`docs/INDEX.md`](docs/INDEX.md) and the open plans under it.

## Prerequisites

- Node.js 20+ (Node 24+ for the `analysis/` workspace)
- npm 10+
- [`pi`](https://www.npmjs.com/package/@mariozechner/pi-coding-agent) installed globally if you want the runtime flow end-to-end
- VS Code, for interactive extension work

## Install

### Windows

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
.\install.ps1
```

### macOS / Linux

```bash
chmod +x install.sh
./install.sh
```

The macOS/Linux script currently does the essentials (env var, auth migration, `pi update`). Full feature parity with `install.ps1` (session migration, sessionDir repair, settings patching) is planned for a future phase.

Both installers are idempotent: re-running updates/repairs rather than duplicating state.

## Quick start

### Build the pie VS Code extension

```bash
cd extension
npm install
npm run build      # builds and syncs into the installed extension
```

Useful extension commands:

- `npm run watch` — incremental rebuild for UI work
- `npm run test` — unit tests
- `npm run typecheck` — type-only check
- `npm run package` — produce a `.vsix`

### Run the analytics workspace

```bash
# from repo root
npm run analytics:serve
```

Other analytics helpers from the repo root: `analytics:build-db`, `analytics:query -- --name model_quality`, `analytics:export-site-data`, `analytics:validate`.

## Persistence and storage

- PI session history is stored as canonical JSONL under this checkout's local `data/outcomes/sessions/` once `PI_CODING_AGENT_DIR` points here.
- `data/` is git-ignored. It is local runtime data, not part of the portable repo/config state.
- `install.ps1` migrates legacy session files (`~/.pi/agent/sessions/`, `data/sessions/`), repairs reachable absolute / `~`-based legacy `sessionDir` overrides, prefers newer transcripts on conflict, and preserves the loser as `.conflict.*.bak`.
- Relative `sessionDir` overrides cannot be repaired safely by the installer and need manual cleanup.

### Storage locations

| State | Default location | Override env var |
|---|---|---|
| Auth tokens | `%LOCALAPPDATA%\pie\auth.json` (Win) / `~/.config/pie/auth.json` (macOS/Linux) | `PI_CODING_AGENT_AUTH_DIR` |
| Sessions | `data/outcomes/sessions/` (in-tree, git-ignored) | `PI_CODING_AGENT_SESSION_DIR` |
| Run analytics | `data/outcomes/<id>/` or `PIE_ANALYTICS_DIR` override | `PIE_ANALYTICS_DIR` |

The backend logs resolved storage paths on startup via the `backend.ready` event.

## More docs

- [AGENTS.md](AGENTS.md) — repo-specific working conventions for AI assistants
- [docs/INDEX.md](docs/INDEX.md) — curated index of design docs and plans
- [docs/STATE_CONTRACT.md](docs/STATE_CONTRACT.md) — authoritative host ↔ webview sync contract
- [extension/README.md](extension/README.md) — extension design philosophy
- [analysis/README.md](analysis/README.md) — analytics workspace details
