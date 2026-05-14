# Pie

My personal PI stack, complete with VSC extention GUI and local data collection for dialing in on what actually works backed by concrete numbers rather than 'vibes'.

## Purpose

Produce a higher quality / quantity of work by:

- Taking effective workflows and refining them. Ie the flow of using VSC to write docs, make tweaks, review changes whilst agents work in the side bar.

- Collecting usage data to improve outcomes. Ie, what models, skills, extentions, tools, etc produce the best results FOR ME.

- Having a centralized portable config. Multiple devices, one global config, while session history stays local and out of git.

- Making session switching more natural than available tooling.

## Persistence

- PI session history is stored as canonical JSONL under this checkout's local `data/outcomes/sessions/` tree once `PI_CODING_AGENT_DIR` points here.
- `data/` is git-ignored. It is local runtime data, not part of the portable repo/config state.
- PI still organizes session files by working directory inside `data/outcomes/sessions/`; using a stable checkout path helps project-scoped resume behavior on a given machine.
- `auth.json` remains ignored because it is secret material.
- Session JSONL contains full transcripts (and may contain image payloads), so treat `data/outcomes/sessions/` as sensitive local data.
- `install.ps1` migrates legacy session files from `~/.pi/agent/sessions/` and the older repo-local `data/sessions/` layout, repairs reachable absolute or `~`-based legacy `sessionDir` stores into this checkout's local `data/outcomes/sessions/--<cwd>--/` layout, prefers the newer transcript on conflicts, and preserves conflicting versions as backup files.
- Relative `sessionDir` overrides cannot be repaired safely by the installer and need manual cleanup.
- The tracked `settings.json` points `sessionDir` at `data/outcomes/sessions`; if you override it locally, clear that override when you want to return to the shared layout.

## Quick start

### VS Code extension

```bash
cd extension
npm run build
```

That rebuilds the extension and syncs the output into the locally installed VS Code extension.

Useful extension commands:

- `cd extension && npm run watch`
- `cd extension && npm run test`
- `cd extension && npm run typecheck`

### Analytics site

```bash
# from repo root
npm run analytics:serve
```

Optional analytics helpers from repo root:

- `npm run analytics:build-db`
- `npm run analytics:query -- --name model_quality`
- `npm run analytics:export-site-data`
- `npm run analytics:validate`

## Prerequisites

- Node.js 24+ for the analytics workspace in `analysis/`
- A local PI setup if you want the extension and runtime data flow to work end-to-end
- VS Code if you want to use the `extension/` package interactively

## More docs

- `AGENTS.md` for repo-specific working conventions
- `docs/STATE_CONTRACT.md` for the host ↔ webview sync contract
- `extension/README.md` for extension-focused notes
- `analysis/README.md` for analytics workspace details
