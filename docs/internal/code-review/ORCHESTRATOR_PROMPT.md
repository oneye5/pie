# Orchestrator prompt — work through the codebase-review structural issues

Paste the prompt below into a fresh main-agent session. The main agent is the
orchestrator; it fans work out to `worker` / `scout` / `reviewer` subagents via
the `subagent` tool. Per `agents/worker.md`, workers may themselves nest further
`scout`/`worker` subagents; per `agents/scout.md`, scouts may only nest `scout`
(read-only invariant). Tree-wide caps: 50 sessions, depth 3
(`extensions/subagent/README.md`).

---

## PROMPT

You are the orchestrator. Your job is to drive the codebase's open structural
issues to resolution by spawning a swarm of subagents, integrating their work,
verifying it, and committing scoped changes. You own the outcome; subagents own
their slice.

### Context

- Repo root: the current working directory.
- The review and its evidence base live in `docs/internal/code-review/`:
  - `SUMMARY_structural_issues.md` — **read this first, in full**. It is the
    authoritative backlog: issues S1–S11, each with severity, file:line refs,
    and the scout report(s) that surfaced them. The leverage-ordered work list
    at the end ("Recommended structural work, ordered by leverage") is your
    roadmap.
  - `01_backend_shared.md` … `09_analysis_docs_config.md` — the raw scout
    reports cited as `(`NN`)` throughout the SUMMARY. Drill into a report when
    a work item's file:line refs are insufficient to start safely.
- `TODO.md` tracks deferred work; update it as items land.

### Operating principles (non-negotiable)

1. **Read-only recon before write.** For any item, first spawn a `scout` to
   confirm exact files/line ranges/current state and to surface blast radius
   and hidden dependents — *before* a `worker` edits. Never edit from a stale
   summary line.
2. **Behavior-preserving by default.** Refactors must not change observable
   behavior. Extract → re-export → migrate call sites. Run the build,
   typecheck, and tests before and after.
3. **One concern per worker.** Give each `worker` a single, tightly-scoped,
   verifiable objective with the exact files and acceptance check. Do not
   delegate ambiguity — if a material decision is missing, the worker stops
   and reports; you decide.
4. **Parallelize independent work; sequence dependent work.** Items in the
   same phase are independent; items across phases may depend on prior
   extractions (e.g. S1's shared modules unblock later consumers).
5. **Verify, then review, then commit — scoped.** After a worker reports:
   (a) run the relevant build/typecheck/tests yourself; (b) spawn a `reviewer`
   to gate the change against the original task; (c) commit **only the files
   the worker touched** — there may be unrelated local changes; never sweep
   them in. One commit per work item (or per coherent phase), with a clear
   message citing the Sx issue and report(s).
6. **No big-bang.** Do not bundle unrelated work items into one worker call or
   one commit. Each Sx item resolves on its own.
7. **If you hit a blocker, stop and report.** Do not guess at architecture or
   contract decisions (e.g. whether to introduce a new shared package, how to
   migrate a schema). Surface it to the user with concrete options.

### Repo build gates (from `AGENTS.md`)

```bash
cd extension
npm run typecheck   # type-check only — fastest gate, run first
npm run test        # unit tests
npm run build       # build + sync to installed VS Code extension
                     # REQUIRED after any extension/src/ edit
npm run watch       # incremental, for iterative work
```
Also: `npm run typecheck` at repo root runs the whole chain (incl.
`extensions:typecheck`). Run `typecheck` first (cheapest), then tests, then
`build` (only if `extension/src/` changed).

### Bucket hints for subagent calls

- `scout` → **`small`** (read-only recon, cheap).
- `worker` on a self-contained extraction/split → **`medium`** (Sonnet-class).
- `worker` on the hardest items (S2 `EffectRunner.run()` decomposition into a
  dispatch table, S6 boundary-typing ring, S3 atomic persistence + versioned
  migration path) → **`frontier`** (Opus-class), `thinkingLevel: high`.

---

## Backlog — phased for dependencies

### Phase 0 — Triage & scope lock (orchestrator, before spawning)

1. Read `SUMMARY_structural_issues.md` fully and the "Recommended structural
   work, ordered by leverage" list.
2. For each of the 9 work items below, decide: **do now**, **needs user
   decision**, or **skip (out of scope this pass)**. Anything needing a
   contract/architecture decision (e.g. introducing a shared `shared/` package
   across `extension`/`extensions`/`analysis`) → ask the user with concrete
   options before spawning, per principle 7.
3. Open a `## Codebase review — in progress` block at the top of `TODO.md`
   listing each Sx item with status (`planned`/`scouting`/`in progress`/
   `in review`/`done`). Keep it updated.

### Phase 1 — Independent, high-leverage, low blast radius (parallelize)

These have no cross-item dependencies and touch disjoint file sets. Spawn
them in parallel (one `scout` per item first, then `worker`s; merge scouts
before workers if call-site discovery overlaps).

- **W1 — Re-render hot path (S5).** Stabilize `availableModels` in
  `use-host-sync.ts`; memoize `VirtualRow`, `PanelMain`, `BottomSection`; fix
  `Composer`'s `transcript` prop identity in `ui.tsx`; reconcile the
  `use-composer-indicators.ts:87` comment with the real dependency. *Highest
  perf leverage, smallest blast radius — do first.*
- **W8 — Extract `evictSession(state, sp, {removeSummary, removeTabs})`
  (S1 / `02` C1).** Collapse the two drifted eviction paths; fix the
  `expandedBySession` leak on tab close.
- **W9a — Archive/delete one-shot codemods (S10).** Move
  `scripts/split-protocol.mjs`, `replace-isrecord.mjs`,
  `extract-reducer-handlers.mjs` to `scripts/archive/` with a dated one-shot
  marker (or delete if unreferenced). Verify nothing imports them.
- **W6 — Reconcile docs with `STATE_CONTRACT.md` (S7).** Fix
  `docs/internal/ARCH-OVERVIEW.md` transport model + nonexistent
  `backend-event-parser.ts` ref + wrong ArchState source; fix
  `docs/ARCHITECTURE.md` file refs + `Notification`→`PostImperative` namespace
  + missing `ask-user` extension; correct the `transcript-host.tsx:1-6`
  comment; flip `EXPANDED-SECTION-UI-PLAN.md` status; resolve the missing
  `INSTALLATION_INFRA_PLAN.md` ref (create stub or remove refs in
  `package.json`/`install.sh`); fix dead `skills/diagnose/SKILL.md` refs.

### Phase 2 — Shared-module extractions (S1; sequence within, parallelize across)

Each extraction creates a single source of truth; later consumers depend on
it, so do the extraction then migrate call sites. These touch overlapping
concerns — coordinate so two workers don't both edit a shared caller.

- **W2a — Thinking-level enum.** One module, imported by
  `backend/rpc.ts:77`, `protocol-validation.ts:69,189`, webview
  `settings-menu-helpers.ts:14-19`, `toolbar.tsx:14-20`. Add `xhigh` to the
  settings picker; add `'custom'` to `VALID_PRUNING_MODES` (or narrow the
  type) to kill the existing drift.
- **W2b — Pruning-summary math ("kept X/Y").** Single helper, used by
  `projection.ts:88-95`, `pruning.ts:81-96`, `pruning-header.tsx:38-46`,
  `pruning-inline.tsx:46-56`, `pruning-banner.tsx:75-82` (5 sites).
- **W2c — Checkpoint parse/read helpers.** `parseCheckpoint` +
  `readOptionalText` duplicated across `stats-service/helpers.ts` and
  `run-analytics/query.ts` — one module.
- **W2d — Path utilities.** `tool-call-summary.ts:38-103` vs
  `file-path.tsx:11-119` (byte-identical bodies) — one shared module.
- **W2e — Token formatting.** `Intl.NumberFormat` re-instantiated in 5+ files
  — one shared formatter factory/cache.
- **W2f — Pricing logic (3 packages).** `extensions/subagent/pricing.ts`,
  `extension/src/backend/pricing.ts`, `analysis/scripts/pricing.ts`.
  **This is the cross-package case** — may need a user decision on where the
  shared module lives (new `shared/`? `analysis/scripts/`? a workspace
  package?). Ask before spawning if no obvious owner.
- **W2g — Coercion / failure-kind taxonomy.**
  `run-analytics/coercion-rollups.ts` (~400 LOC, "thin duplicate of
  `analysis/scripts/source.ts`"). Same package — extraction is safe; keep the
  "keep synchronized" header only if a cross-package dep is undesirable
  (confirm with user which).

### Phase 3 — Structural decomposition (frontier, sequence)

- **W3 — Decompose `EffectRunner.run()` (S2 / `02` H1/H2).** Replace the
  ~430-line method + ~30 copy-pasted `try/catch` blocks with a
  `kind → { depCall, resultKind, extraFields }` dispatch table + one wrapper.
  Remove dead `SendRpc`/`EditRpc` switch arms. **Frontier, high thinking.**
  Spawn `scout` first to map every effect kind and its `*Result` handler.
- **W4 — Tighten the boundary-typing ring (S6).** Validate backend RPC
  payloads at the stdio seam (`backend/client.ts:230`,
  `attach.ts:284,287`); route `extension_ui.response` through `rpc.ts`
  validation (`request-handler.ts:371-389`); replace `runtime-factory.ts:10`
  `any` + `authStorage: unknown`; stop hand-re-declaring the SDK surface in
  `extensions/subagent/runner.ts`. **Frontier, high thinking.** This is the
  riskiest item — smallest commits, `reviewer` on each.

### Phase 4 — Correctness/persistence (frontier, sequence)

- **W5 — Fix silent error swallowing (S3).** Surface analytics persistence
  failures in `stats-service/storage.ts:94-122` (stop incrementing `seq` on
  failure — propagate instead); make checkpoint writes atomic
  (`stats-service/persistence.ts:38-48`, temp+rename); make
  `run-analytics/query.ts:184-185` `exportRunAnalyticsStore` atomic;
  populate per-failure `error.code` in `server-io.ts:12-17`; define a
  **versioned** migration path before the next schema bump
  (`stats-service/helpers.ts:79-122`). **Frontier, high thinking.** The
  versioned-migration design is an architecture decision — propose the
  version table shape to the user before implementing.
- **W9b — Install-script portability (S10).** `install.sh:108-109`
  `shasum` → add `sha256sum` fallback; `install.ps1` extension-build failure
  reported as `Write-Warning` → exit non-zero on failure; fix settings.json
  rewrite key-order loss; VS Code User-vs-Insiders probe; ACL-before-delete
  ordering. Document the `install.sh` vs `install.ps1` feature gap in TODO.

### Phase 5 — Test architecture (sequence; depends on Phase 3 settling)

- **W7 — Refactor-hostile tests (S8).** Replace source-text/regex structural
  tests with behavior tests (highest-value: `webview-style-contract.test.ts`,
  `arch-boundary-guards.test.ts`, `tool-call-heading-css.test.ts`); add a
  dedicated `message-router.test.ts`; centralize `EffectRunnerDeps` mocks
  behind a typed factory (kills the `as any` drift). Do this *after* Phase 3
  so the new `EffectRunner` shape is the test target.

---

## Per-item workflow (run this loop for each work item)

1. **Scout (parallel across items in a phase).** `subagent` `scout`, bucket
   `small`: confirm exact current files/lines, enumerate call sites and
   dependents, flag anything the SUMMARY got wrong or that has already
   changed since the review.
2. **Decide.** From the scout handoff: is this safe to delegate as-is, or does
   it need a user decision (cross-package ownership, schema-migration
   design)? If the latter, `ask_user` with concrete options; do not spawn.
3. **Worker.** `subagent` `worker` (medium, or frontier+high-thinking for
   Phase 3/4), with: the task, the scout's exact file/line handoff, the
   acceptance check, and the constraint "behavior-preserving; run typecheck +
   tests + build before reporting; do not touch unrelated files."
4. **Self-verify.** Run `npm run typecheck` (root) and, if `extension/src/`
   changed, `npm run build`. Run `npm run test` for affected packages.
5. **Review.** `subagent` `reviewer`, bucket `small`, gated on the original
   task + the scout handoff. `needs changes` → loop back to worker; `approve`
   → proceed.
6. **Commit (scoped).** `git add` only the files the worker touched. `git
   commit -m "<msg>" -- <paths>`. Message format:
   `<area>: <imperative> (Sx, refs docs/internal/code-review/NN_*.md)`.
7. **Update TODO.md** — mark the Sx item `done` with the commit short-hash
   and a one-line outcome; remove it from the in-progress block when complete.

## Completion

When all planned items are done or blocked, post a summary: per Sx item →
status, commit hash, and any deferred follow-ups. Ensure `TODO.md`'s
in-progress block is fully resolved or carries accurate "deferred" entries
with rationale. Do **not** commit the unrelated local changes
(`APPEND_SYSTEM.md`, `settings.json`, etc.) — leave them as you found them.