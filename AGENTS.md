# Repo specific conventions

Personal pi config stack: VS Code extension GUI ("pie"), custom pi extensions, agents, skills, and centralized settings.

- `extension/` — VS Code extension
- `extensions/` — Custom pi tools ie `subagent`
- `docs/` — Internal design docs; `STATE_CONTRACT.md` is authoritative for host↔webview sync

**Always rebuild after editing `extension/src/`** — build auto-syncs output to the installed VS Code extension.

```bash
cd extension
npm run build      # build + sync
npm run watch      # incremental
npm run test       # unit tests
npm run typecheck  # type-check only
npm run package    # produce .vsix
```

## Terminology

**Bucket (model selection)** — one of three model tiers for subagent work: `small` (Haiku-class, busywork), `medium` (Sonnet-class, main development), `frontier` (Opus-class, hardest problems). The main agent supplies a bucket hint; the subagent extension picks a model from that bucket. Mental model: Anthropic's Haiku/Sonnet/Opus naming — `small` ≈ Haiku, `medium` ≈ Sonnet, `frontier` ≈ Opus — but bucket names are vendor-neutral since the leaderboard spans all providers.
_Avoid_: tier, class, level

**Stratified leaderboard** — the data-driven leaderboard implemented in `analysis/scripts/stratified-ranker.ts` that ranks per-model entries within complexity bands (low/medium/high) and assigns them to buckets. Thinking levels are caller-driven, not baked into entries. Distinct from the global analytics leaderboard in `analysis/scripts/leaderboard.ts`.
_Avoid_: bucket leaderboard, model ranker

**Complexity score** — a per-run 0–1 heuristic computed from observable signals (lines changed, files touched, tool calls, duration, etc.) used to split runs into low/medium/high bands for stratified ranking.
_Avoid_: difficulty score, task weight
