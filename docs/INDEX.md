# Documentation index

This folder mixes design contracts, implementation plans (some completed, some open), and historical brain-dumps. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [ARCHITECTURE.md](ARCHITECTURE.md) — **primary architecture reference**. System overview, pattern explanation, data flow scenarios, extension-point recipes, and invariants. Start here.
- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative rules for host ↔ webview state sync. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).
- [internal/ARCH-OVERVIEW.md](internal/ARCH-OVERVIEW.md) — concise developer-onboarding file map. Spine file locations, glossary table, and "where to make changes" quick-reference.

## Active plans (in progress)

- [EXPANDED-SECTION-UI-PLAN.md](EXPANDED-SECTION-UI-PLAN.md) — audit + grilling decisions for the bash/terminal tool pane and reasoning preview: bound reasoning with the resizable model, shared `expandedSectionMaxHeight` pref across all four expanded sections, reduced default max-height, and removed the "hold close while turn active" logic (per-command grace-then-slow-close) so open panes stop dominating the transcript. Secondary findings (ANSI, exitCode, long-line handling, stderr) deferred.

## Archived plans (removed — see git history)

Historical migration and planning documents were removed from the tree after completion. Check git history for the original content:

- `ARCH-MIGRATION-PLAN.md` — multi-phase extension host + webview migration to CQRS/Elm/MVI
- `HANDOFF_mvi-migration.md` — MVI migration tracker (Phases 0–5, 12 Phase 5 items). **Completed** — the MessageRouter is 100% Commands, `QueueManager` deleted, all per-session keyed maps cleaned on session close, optimistic-op TTL in place, all deferred items resolved. The code is now the authoritative record; see `ARCHITECTURE.md` and `STATE_CONTRACT.md` for the architecture.
- `PLAN-extension-ui-questions.md` — extension UI question resolution
- `PLAN-llm-pruner-rewrite.md` — LLM-based skill pruning implementation
- `PLAN-skill-tool-pruning.md` — skill/tool pruning design and implementation.
- `model-token-pricing-implementation-plan.md` — token-pricing migration; **completed**. Pricing now lives in `extensions/subagent/pricing.ts` + `extension/src/backend/pricing.ts`; authoritative price evidence in `internal/model-token-pricing-sources.md`.
- `ui-ux-review.md` — pie webview UI/UX engineering review (41 findings across hitboxes, a11y, streaming jank, virtualization, tabs, overlays). **Completed** across two rounds (commits `b1a0107` + `5a1804c`); the code is the authoritative record.
- `audit-ui-subagent-prompt.md` — UI & subagent systems audit (integrity / duplication / architecture findings with P0–P2 remediation steps). Historical report; remediations landed in code.
- `model-scoring-methodology.md` — superseded fitness-based model-scoring methodology; replaced by the data-driven stratified leaderboard (`analysis/scripts/stratified-ranker.ts`).
- `subagent-ask-user-design.md` — subagent `ask_user` support design (multi-entry pending requests, parent-bridge proxy, subagent-scoped webview rendering). **Implemented**.
- `subagent-model-selection-v2.md` — subagent model-selection v2 (bucket system). **Implemented** in `extensions/subagent/bucket-selector.ts` + `bridge.ts`.

## Reference / informational

- [internal/ollama-pro-cloud-models-ranked.md](internal/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [internal/copilot-model-pricing.md](internal/copilot-model-pricing.md) — GitHub Copilot premium request multipliers, token pricing, and cost mapping for `model-profiles.yaml`.
- [internal/model-token-pricing-sources.md](internal/model-token-pricing-sources.md) — **authoritative evidence ledger** for all real token pricing in `models.json`. Every non-zero cost field traces back to a row here.
- [IDEAS.md](IDEAS.md) — unstructured brain-dump. Not a roadmap. Items here are candidates for evaluation, not commitments.

## Conventions

- A doc named `*_PLAN.md` under `docs/` describes work that is **either in progress or not yet started**. When work completes, update the plan with an explicit "closed" status at the top, or remove the plan doc and update this index to reflect the code as the authoritative record.
- Plans under `docs/internal/` are status reports or implementation notes, not user-facing contracts.
- The only file in `docs/` that downstream code is allowed to depend on (via tests pinning invariants) is `STATE_CONTRACT.md`.
