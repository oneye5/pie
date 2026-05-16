# Documentation index

This folder mixes design contracts, implementation plans (some completed, some open), and historical brain-dumps. Use this index instead of scanning the directory.

## Active design contracts (read first)

- [STATE_CONTRACT.md](STATE_CONTRACT.md) — authoritative rules for host ↔ webview state sync. Any change here requires matching tests in `extension/test/` (see `sync-contract.test.ts`).

## Open plans (work outstanding)


## Completed plans (kept for context, not action items)

The following work was completed without a formal plan document being created. The code is the authoritative record:

- Composer inputs and run analytics — closed 2026-05-13. See `extension/src/host/session-service/composer.ts` and `extension/src/host/stats-service/`.
- Analytics site — original execution and plan are embodied in `analysis/`. See `analysis/README.md` for current state.

## Reference / informational

- [internal/ollama-pro-cloud-models-ranked.md](internal/ollama-pro-cloud-models-ranked.md) — model evaluation notes.
- [IDEAS.md](IDEAS.md) — unstructured brain-dump. Not a roadmap. Items here are candidates for evaluation, not commitments.

## Conventions

- A doc named `*_PLAN.md` under `docs/` describes work that is **either in progress or not yet started**. When work completes, update the plan with an explicit "closed" status at the top, or remove the plan doc and update this index to reflect the code as the authoritative record.
- Plans under `docs/internal/` are status reports or implementation notes, not user-facing contracts.
- The only file in `docs/` that downstream code is allowed to depend on (via tests pinning invariants) is `STATE_CONTRACT.md`.
