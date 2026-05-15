# AGENTS.md

Personal pi config stack: VS Code extension GUI ("pie"), custom pi extensions, agents, skills, and centralized settings.

## Structure

- `extension/` — VS Code extension (TypeScript + Preact webview)
- `extensions/` — Custom pi tools: `subagent` (delegate to isolated pi processes), `cwd-skills` (auto-discovers `skills/` in cwd)
- `agents/` — Agent definitions (worker, planner, reviewer, scout)
- `skills/` — Pi skills
- `settings.json` — Pi settings (model, sessionDir, packages) — tracked, don't commit local overrides
- `APPEND_SYSTEM.md` — Appended to every agent system prompt
- `docs/` — Internal design docs; `STATE_CONTRACT.md` is authoritative for host↔webview sync
- `data/` — Git-ignored local runtime data (sessions, outcomes)

## Test convention

Every package with tests has its own `test/` directory containing `*.test.ts` files,
co-located with the code under test. There is no shared top-level `test/` directory.

| Package | Test dir | Runner |
|---|---|---|
| `extension/` | `extension/test/` | `npm run extension:test` |
| `extensions/*` | `extensions/<name>/test/` | `npm run extensions:test` |
| `analysis/` | `analysis/test/` | `npm run analytics:test` |

When adding a new test, place it in the `test/` directory of the package it tests.

## Extension build

**Always rebuild after editing `extension/src/`** — build auto-syncs output to the installed VS Code extension.

```bash
cd extension
npm run build      # build + sync
npm run watch      # incremental
npm run test       # unit tests
npm run typecheck  # type-check only
npm run package    # produce .vsix
```
