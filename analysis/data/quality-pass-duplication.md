# Duplication Analysis

Generated: 2026-06-05
Scope: `extension/src/` and `extensions/`

---

## 1. `reducer.ts` - CloseSession vs SessionClosed (nearly identical cleanup)

**Files:**
- `extension/src/host/core/reducer.ts` lines 200-260 (`Command/CloseSession` handler)
- `extension/src/host/core/reducer.ts` lines 380-440 (`SessionClosed` handler)

**Duplicated code:** Both handlers destructure the same set of per-session sub-state maps (transcript, sessions, settings, composer, fileChanges, pending) and rebuild the state tree. The destructuring pattern is identical across 11 Record destructures, ~55 lines each.

**Duplicated lines:** ~55 lines each, ~110 total.

**Suggestion:** Extract a `removeSessionFromState(state, sessionPath)` helper.

---

## 2. `backend/pricing.ts` vs `extensions/subagent/pricing.ts` - acknowledged copy

**Files:**
- `extension/src/backend/pricing.ts` (entire file, ~150 lines)
- `extensions/subagent/pricing.ts` (entire file, ~200 lines)

**Duplicated code:** Backend file header says it is a thin duplicate. Functions: `parseModelPricing`, `maybeValidNumber`, `estimateNormalizedCost`, `loadModelPricing`, `resolveModelCost`. ~120 lines identical.

**Suggestion:** Extract to shared package or `extension/src/shared/`.

---

## 3. `interactions.ts` - click guard functions

**File:** `extension/src/webview/panel/transcript/interactions.ts`

**Duplicated code:** `shouldOpenUserMessageEditor` and `shouldOpenSubagentContextMenu` share identical control flow. Only the CSS selector constant differs. 6 lines each.

**Suggestion:** Create `shouldOpenOnClick(target, blockingSelector)` helper.

---

## 4. `top-gap-row.tsx` vs `bottom-gap-row.tsx`

**Files:** `rows/top-gap-row.tsx` and `rows/bottom-gap-row.tsx` (lines 1-14 each)

**Duplicated code:** Both render a gap row with load button. Only class suffix and text differ. ~24 lines total.

**Suggestion:** Single `GapRow` component with `direction` prop.

---

## 5. `isRecord` type guard - 7 copies

**Files:** `file-change-derivation.ts:11`, `tool-call-analysis/summary.ts:24`, `token-usage.ts:239`, `tool-call-summary.ts:40`, `pruning.ts:7`, `subagent.ts:72`, `tool-call-card.tsx:114`

**Duplicated code:** `!!value && typeof value === "object" && !Array.isArray(value)`. 3 lines x 7 = ~21 lines.

**Suggestion:** Export from `extension/src/shared/type-guards.ts`.

---

## 6. `resolveAlias` - reducer.ts vs transcript-helpers.ts

**Files:** `reducer.ts:65` (private) vs `transcript-helpers.ts:20` (exported)

**Suggestion:** Import the exported version.

---

## 7. `normalizeThinkingLevel` - 2 backend files

**Files:** `message-inputs.ts:4` vs `transcript/content.ts:80`

**Suggestion:** Move to `shared/protocol.ts`.

---

## 8. `textFromParts` vs `textFromMessageParts`

**Files:** `transcript/content.ts:24-33` vs `chat-message-parts.ts:80-88`

**Suggestion:** Keep separate (different input types), consider adapter.

---

## 9. `clamp` - 2 transcript-window modules

**Files:** `host/core/transcript-window.ts:9` vs `backend/transcript-window.ts:26`

**Suggestion:** Export from `shared/` or inline.

---

## 10. `removeFromArray` / `addToArray` - reducer.ts

**File:** `reducer.ts:117-127`

**Suggestion:** Keep local unless reused.

---

## 11. `ensureAssistantParts` vs `legacyAssistantParts`

**Files:** `transcript-helpers.ts:24-40` vs `chat-message-parts.ts:48-62`

**Suggestion:** Delegate `ensureAssistantParts` to `legacyAssistantParts`.

---

## 12. `isObj` / `isObject` - validation guards

**Files:** `rpc.ts:88` vs `protocol-validation.ts:39`

**Suggestion:** Export correct version (rejects null/arrays) from `shared/`.

---

## 13. Part-building loops

**Files:** `transcript/content.ts:88-112` vs `chat-message-parts.ts:48-62`

**Suggestion:** Extract `pushPart()` helper.

---

## Summary Table

| # | Pattern | Files | Lines | Consolidation |
|---|---------|-------|-------|---------------|
| 1 | CloseSession/SessionClosed | `reducer.ts` | ~110 | Extract `removeSessionFromState()` |
| 2 | Pricing copy | `backend/` + `extensions/subagent/` | ~120 | Shared package |
| 3 | Click guards | `interactions.ts` | ~12 | Parameterized helper |
| 4 | Gap rows | 2 row files | ~24 | Single component |
| 5 | `isRecord` | 7 files | ~21 | Export from `shared/` |
| 6 | `resolveAlias` | 2 host/core files | ~6 | Import from helper |
| 7 | `normalizeThinkingLevel` | 2 backend files | ~16 | Move to `shared/` |
| 8 | text/thinking from parts | 2 files | ~20 | Adapter |
| 9 | `clamp` | 2 window files | ~6 | Export from `shared/` |
| 10 | Array helpers | `reducer.ts` | ~10 | Keep local |
| 11 | Assistant parts building | 2 files | ~12 | Delegate to shared |
| 12 | `isObj` / `isObject` | 2 validation files | ~6 | Export from `shared/` |
| 13 | Part-building loops | 2 files | ~20 | Extract `pushPart()` |

**Total estimated duplicated lines: ~370 lines**

---

## Recommended First Fixes (highest impact)

1. **#5 (`isRecord`)** - Trivial, 7 call sites. Export from `shared/type-guards.ts`.
2. **#1 (CloseSession/SessionClosed)** - High duplication (~110 lines). Extract `removeSessionFromState()`.
3. **#3 (interactions.ts)** - Small refactor. Parameterize the selector.
4. **#4 (gap rows)** - Small. Single component with direction prop.
5. **#6 (resolveAlias)** - Trivial. Import instead of redefining.
