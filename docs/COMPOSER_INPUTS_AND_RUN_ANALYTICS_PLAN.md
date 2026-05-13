# pie Composer Inputs, File Support, and Run Analytics — Remaining Work Plan

## Status update (2026-05-13)
This historical remaining-work plan is now **fully closed**.

Closed result summary:
- **Phase 2 ship gate:** verified against the real PI SDK (`@mariozechner/pi-coding-agent` 0.73.0) with `extension/test/real-sdk-image-persistence.test.ts`. `session.prompt(text, { images })` persists committed user image bytes inline in the canonical session JSONL, and a fresh reopen restores user images from canonical history without relying on pending host state. No committed-image fallback store is needed.
- **Phase 4 / 5 analytics:** shipped structured prompt/skill/tool factor capture, tool/subagent/failure rollups, busy-time rollups, verification-command classification, file-mutation rollups, explicit export/query support, and experiment-assignment capture.
- **Phase 6 invariants remain enforced:** `fileBlob` stays blocked, and `filesystemPathRef` remains a reference lowered through the current `@path` flow until the PI SDK exposes a native file-reference mechanism.

## Purpose
This document originally tracked **only the work that was still outstanding**.

The foundation for host-owned composer inputs, native image sending, restored user-image rendering, and basic run analytics was already implemented. Items in the **Context** section below remain repository facts and architectural constraints, **not TODOs**.

## Context (already implemented; not TODO)

### State-domain boundaries
These boundaries are already in place and should remain the basis for future work.

| State domain | Current owner | Current source of truth |
|---|---|---|
| Pending composer input state | Host | Host store |
| Canonical conversation content | PI session history | Session JSONL |
| Local run analytics | `StatsService` + local storage | Local analytics store |

Implications:
- Pending pasted images are **not** canonical transcript history until send succeeds.
- Sent user images are treated as canonical conversation content.
- Outcome and run analytics remain **local analysis data**, not transcript content.
- Analytics must continue to observe structured inputs **before** transport-specific lowering.

### Current input behavior
| Input kind | Current behavior | Constraint that still matters |
|---|---|---|
| `filesystemPathRef` | Host-owned pending input, lowered to `@path` text today | Revisit only if the PI SDK exposes a real native path-reference mechanism |
| `imageBlob` | Host-owned pending input, native image send path, optimistic user image rows, restored user-image rendering | Do not replace with temp-file attachment emulation |
| `fileBlob` | Rejected with a user-facing error | Must remain blocked until Phase 6 conditions are met |

### Repository-aligned implementation notes
These are here to keep future agents aligned with the current codebase rather than the older draft structure.

- Protocol/state support already exists for:
  - `ComposerInput`
  - `UserContentPart`
  - `ModelInfo.inputKinds`
  - `ViewState.pendingComposerInputs`
  - `ViewState.activeRunSummary`
- `send` no longer carries `pendingPaths`.
- `sendRejected` restores **text only**.
- Pending composer inputs are already host-owned and session-scoped.
- User image transcript support already exists in backend transcript mapping and transcript rendering.
- Basic run/outcome flow already exists in `StatsService`, including:
  - run creation on send
  - outcome capture
  - task lineage controls
  - JSONL persistence under extension global storage
  - alternating-slot open-run checkpoint recovery
  - input counts, unsupported-input counts, edit counts, and truncate-after counts
  - mixed model/thinking config tracking
- The model-switch guard for pending images currently lives in `extension/src/host/session-service.ts`, not `extension-host.ts`.
- The current run-observer contract is centered on `prepareForSend(...)` plus event hooks; do not reintroduce the earlier draft naming as a parallel abstraction unless there is a strong reason.
- `fileBlob` rejection is already implemented in both webview flow and backend validation.

### Architectural constraints that remain in force
- Keep **runs**, not sessions, as the analytics unit.
- Keep analytics **local-first** and **structured by default**.
- Do **not** store raw transcript or raw tool payloads by default.
- Do **not** reintroduce temp-file attachment emulation for images or arbitrary file blobs.
- If committed-image persistence cannot come from canonical PI session history, use a **content-addressed committed-image store**, not a temp-file workaround.

### Large-file warning
The following files are already oversized and should preferably be split rather than grown further:
- `extension/src/host/session-service.ts`
- `extension/src/host/stats-service.ts`
- `extension/src/webview/panel/transcript.tsx`

## Historical remaining-work checklist (completed on 2026-05-13)

### 1. Phase 2 ship gate — verify canonical committed-image persistence
The image pipeline exists, but one pre-ship question is still open:

**Does the real PI SDK persist user image bytes into the session JSONL when `session.prompt(text, { images })` is used?**

#### Required work
- Verify against the real SDK, not mocks, that:
  1. sending a prompt with one or more `imageBlob` inputs stores committed image content in canonical session history,
  2. reopening the session restores those user images from canonical history, and
  3. restored transcript rendering does not depend on leftover pending host state.
- Record the verification result in this document or a linked implementation note so future agents do not need to rediscover it.

#### If the SDK **does** persist images canonically
- No attachment store is needed.
- Keep the existing native-image path.
- Treat image persistence as verified and close this item.

#### If the SDK **does not** persist image bytes canonically
Implement the fallback that was previously specified but is **not** yet present in the repo:
- Store committed image bytes under `globalStorageUri/image-store/<workspaceHash>/`.
- Key images by `sha256` of image content (`<hash>.<ext>`).
- Write once on send success; never mutate in place.
- Store a `storeKey` reference in committed user image content instead of inline Base64.
- Resolve `storeKey` back to bytes at transcript-mapping/render time.
- Determine reachability by scanning open session JSONLs at startup.
- Make unreferenced committed images eligible for compaction.
- Keep this store clearly modeled as committed canonical-media backing, **not** attachment-temp-file emulation.

#### Acceptance for this item
One of the following must be true:
- PI SDK image persistence is verified end-to-end with reopen restore, **or**
- the content-addressed committed-image store fallback is implemented and used.

### 2. Phase 4 — structured factor capture
The run foundation exists. What remains is enriching snapshots so they are useful for comparison and experimentation.

#### Required additions
- Capture **prompt family / prompt hash** at run start.
- Capture **skill metadata** once the backend exposes it structurally.
- Capture **tool metadata** once the backend exposes it structurally.
- Extend run snapshots with the missing high-value structured signals that are still not recorded, including:
  - tool-call counts
  - tool-failure counts
  - subagent usage
  - busy-time / response-time rollups where not already represented
  - any additional treatment factors needed for later experiment analysis
- Extend treatment-purity handling beyond model/thinking changes as additional factors are captured.

#### Constraints
- Prefer IDs, names, hashes, counts, and flags over raw payload storage.
- Do not scrape rendered UI for this information.
- Reuse the current `StatsService`/observer boundary rather than introducing a second analytics pathway.
- Input/file usage counts already exist; extend the snapshot schema rather than redesigning that part from scratch.

#### Likely code areas
- `extension/src/host/stats-service.ts`
- `extension/src/host/session-service.ts` (only if new observer hooks are required)
- `extension/src/backend/index.ts` or related backend metadata-emission paths

### 3. Phase 5 — verification, mutation, and analysis improvements
Some quality signals are already recorded (`onMessageEdited`, `onTruncatedAfter`), but the rest of this phase is still open.

#### Remaining work
- Add **file-mutation rollups** to run analytics.
- Add **verification-command classification** so local analysis can distinguish tests/builds/lints/other validation activity.
- Add **export/query paths** for the local analytics store.
- Add **experiment-assignment plumbing** so runs can be analyzed by treatment assignment rather than only by inferred config.

#### Constraints
- Keep analytics local-first.
- Avoid raw transcript persistence by default.
- Preserve append-only JSONL compatibility unless there is a deliberate storage-interface migration.

#### Likely code areas
- `extension/src/host/stats-service.ts`
- any new local export/query service layered on top of the current storage abstraction
- backend/host event surfaces if verification or mutation signals need structured emission

### 4. Phase 6 — future arbitrary file payload support and filesystem path reference revisit
This phase remains intentionally blocked until the runtime justifies it.

#### Arbitrary pasted file blobs
Do **not** implement arbitrary `fileBlob` support unless one of these becomes true:
1. the PI SDK exposes a native file-input path with canonical persistence, or
2. the extension adopts a real artifact system.

If an artifact system is needed, it must be:
- content-addressed,
- reachability-tracked or reference-counted,
- explicitly modeled as an artifact store,
- separate from temp-file attachment hacks.

#### Filesystem path references
- `filesystemPathRef` should remain on the short-term `@path` lowering path until the PI SDK offers a native file-reference mechanism.
- Revisit this item only when that capability actually exists.

## Recommended implementation order
1. **Close the Phase 2 ship gate first** by verifying real-SDK image persistence.
2. If canonical persistence fails, implement the committed-image fallback before shipping further transcript-restore assumptions.
3. Expand `StatsService` snapshot schema for Phase 4 structured-factor capture.
4. Add Phase 5 export/query and verification-classification capabilities.
5. Revisit Phase 6 only when the PI SDK adds relevant native capability or a real artifact-store need emerges.

## Remaining acceptance criteria
This remaining plan is complete when all of the following are true:
1. Real-SDK committed-image persistence is verified end-to-end, **or** the content-addressed committed-image fallback is implemented.
2. Run snapshots capture structured prompt/skill/tool/treatment factors needed for later analysis without storing raw noisy telemetry by default.
3. Run analytics include the missing high-signal operational factors still absent today, including tool/subagent/failure-related rollups.
4. File-mutation rollups and verification-command classification are persisted in the local analytics model.
5. Local analytics can be exported and/or queried through an explicit supported path.
6. Experiment assignment is recorded explicitly enough to support later analysis of pure vs mixed runs.
7. `fileBlob` remains blocked until native file support or a real artifact store exists.
8. `filesystemPathRef` remains clearly modeled as a reference until the SDK exposes a native file-reference path.

## Final note for future agents
Do **not** reopen already-finished foundation work unless one of the remaining items above requires a targeted change. This file is intentionally narrowed to reduce confusion about what is already done versus what still needs to ship.
