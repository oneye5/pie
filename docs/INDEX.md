# Documentation index

This folder mixes design contracts, implementation plans (some completed, some open), and historical brain-dumps. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative rules for host ↔ webview state sync. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).

## Open plans (work outstanding)

- [INSTALLATION_INFRA_PLAN.md](INSTALLATION_INFRA_PLAN.md) — cross-platform installer + VSIX distribution. Phase 1 partially shipped (`install.sh` exists; `scripts/bootstrap.mjs` does not yet).
- [internal/TRANSCRIPT_WINDOWING_AND_CULLING_PLAN.md](internal/TRANSCRIPT_WINDOWING_AND_CULLING_PLAN.md) — multi-phase plan to virtualize the transcript UI. Not yet started in code.

## Completed plans (kept for context, not action items)

- [COMPOSER_INPUTS_AND_RUN_ANALYTICS_PLAN.md](COMPOSER_INPUTS_AND_RUN_ANALYTICS_PLAN.md) — closed 2026-05-13. Treat sections under "Context (already implemented)" as repository facts, not TODOs.
- [internal/ANALYTICS_SITE_EXECUTION_STATUS.md](internal/ANALYTICS_SITE_EXECUTION_STATUS.md) — execution status for the analytics-site work.
- [internal/ANALYTICS_SITE_PLAN.md](internal/ANALYTICS_SITE_PLAN.md) — original analytics-site plan.

## Reference / informational

- [internal/ollama-pro-cloud-models-ranked.md](internal/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [IDEAS.md](IDEAS.md) — unstructured brain-dump. Not a roadmap. Items here are candidates for evaluation, not commitments.

## Conventions

- A doc named `*_PLAN.md` under `docs/` describes work that is **either in progress or not yet started**. When work completes, either update the plan with an explicit "closed" status at the top (see `COMPOSER_INPUTS_AND_RUN_ANALYTICS_PLAN.md` as the reference style) or move the file under `docs/internal/`.
- Plans under `docs/internal/` are status reports or implementation notes, not user-facing contracts.
- The only file in `docs/` that downstream code is allowed to depend on (via tests pinning invariants) is `STATE_CONTRACT.md`.
