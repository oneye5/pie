# 08 — pi extensions review (`extensions/`)

Scope: `ask-user/`, `cwd-skills/`, `safeguard/`, `skill-pruner/`, `subagent/`.
Perspective: skeptical senior engineer. Read-only; no fixes proposed.

## Files reviewed (paths + line counts)

### ask-user
- `extensions/ask-user/index.ts` — 25
- `extensions/ask-user/src/ask.ts` — 58
- `extensions/ask-user/src/types.ts` — 39
- `extensions/ask-user/test/ask.test.ts` — 164
- `extensions/ask-user/package.json` — 10, `tsconfig.json` — 14

### cwd-skills
- `extensions/cwd-skills/index.ts` — 30
- `extensions/cwd-skills/README.md` — 23
- `extensions/cwd-skills/test/cwd-skills-extension.test.ts` — 503

### safeguard
- `extensions/safeguard/index.ts` — 348
- `extensions/safeguard/paths.ts` — 60
- `extensions/safeguard/shell.ts` — 98
- `extensions/safeguard/README.md` — 35
- `extensions/safeguard/test/safeguard-extension.test.ts` — 1001

### skill-pruner
- `extensions/skill-pruner/index.ts` — 61
- `extensions/skill-pruner/config.ts` — 285
- `extensions/skill-pruner/llm-scorer.ts` — 257
- `extensions/skill-pruner/logger.ts` — 128
- `extensions/skill-pruner/tokenize.ts` — 66
- `extensions/skill-pruner/types.ts` — 80
- `extensions/skill-pruner/types-global.d.ts` — 29
- `extensions/skill-pruner/pruning-system-prompt.md` — 21
- `extensions/skill-pruner/src/copilot-headers.ts` — 82
- `extensions/skill-pruner/src/message-builders.ts` — 272
- `extensions/skill-pruner/src/prepass.ts` — 325
- `extensions/skill-pruner/src/pruning-types.ts` — 36
- `extensions/skill-pruner/src/pruning.ts` — 246
- `extensions/skill-pruner/src/register.ts` — 244
- `extensions/skill-pruner/src/render.ts` — 54
- `extensions/skill-pruner/src/state.ts` — 71
- `extensions/skill-pruner/src/tools.ts` — 53
- tests: `test/config.test.ts` 237, `test/copilot-headers.test.ts` 134, `test/integration.test.ts` 1075, `test/llm-scorer.test.ts` 357, `test/logger.test.ts` 139, `test/message-builders.test.ts` 440, `test/model-surface.test.ts` 501, `test/pruning.test.ts` 433

### subagent
- `extensions/subagent/index.ts` — 7
- `extensions/subagent/agents.ts` — 203
- `extensions/subagent/bridge.ts` — 42
- `extensions/subagent/bucket-selector.ts` — 293
- `extensions/subagent/formatting.ts` — 222
- `extensions/subagent/model-resolution.ts` — 72
- `extensions/subagent/pricing.ts` — 270
- `extensions/subagent/render.ts` — 394
- `extensions/subagent/runner.ts` — 550
- `extensions/subagent/schema.ts` — 71
- `extensions/subagent/types.ts` — 79
- `extensions/subagent/validation.ts` — 61
- `extensions/subagent/src/execute.ts` — 519
- `extensions/subagent/src/helpers.ts` — 24
- `extensions/subagent/src/modes.ts` — 654
- `extensions/subagent/src/parent-extension-ui-bridge-proxy.ts` — 94
- `extensions/subagent/src/register.ts` — 111
- `extensions/subagent/README.md` — 148
- tests (18 files): `agents.test.ts` 637, `always-parent-model.test.ts` 84, `bridge.test.ts` 128, `bucket-selector.test.ts` 543, `confirm-project-agents.test.ts` 207, `execution-paths.test.ts` 450, `formatting.test.ts` 341, `index.test.ts` 184, `model-resolution.test.ts` 430, `modes.test.ts` 641, `nesting-controls.test.ts` 194, `parent-extension-ui-bridge-proxy.test.ts` 264, `pricing.test.ts` 409, `render.test.ts` 517, `runner.test.ts` 338, `runtime-config.test.ts` 134, `types.test.ts` 124, `validation.test.ts` 310

## Notable issues

### Critical

1. **Stale/contradictory README documents a removed `taskScores` input feature.**
   `extensions/subagent/README.md:60-78` ("Task Scores") instructs users to pass a `taskScores`
   field (`{ "agent": "worker", "task": "...", "taskScores": { "precision": 3, ... } }`)
   and claims "Model selection reads `<pi-config>/model-profiles.yaml`... If no profile
   registry is available, no score-based model/thinking override is applied."
   But `taskScores` does **not** exist in the subagent schema
   (`extensions/subagent/schema.ts:1-71` — `SubagentParams` has only `bucket`/`thinkingLevel`,
   no `taskScores`), is absent from `extensions/subagent/types.ts` `SingleResult`, and a
   repo-wide grep finds zero `taskScores` references inside `extensions/subagent/`. The
   field only lives in the *host* extension (`extension/src/shared/subagent-result.ts:60`,
   `extension/src/shared/tool-call-analysis/verification.ts:196`), which reads it from the
   raw tool-call input independently. So the README tells users to pass a field the subagent
   extension neither validates, declares, nor propagates into `result.details.results[]`
   (the host's stated storage location per `verification.ts:196-197`). Why it matters:
   users will supply `taskScores` expecting score-driven model selection that the subagent
   extension silently drops; the documented behavior does not match any code path in the
   extension under review.

### High

2. **Intentional pricing-module duplication between subagent extension and host backend,
   with no shared module and an inconsistent module style.**
   `extensions/subagent/pricing.ts` (270 lines) and `extension/src/backend/pricing.ts`
   (≈150 lines) are near-verbatim copies: both define `ModelTokenPricing`,
   `ModelPricingRecord`, `parseModelPricing`, `maybeValidNumber`, `estimateNormalizedCost`,
   and `loadModelPricing` with identical constants (`INPUT_WEIGHT=3`, `OUTPUT_WEIGHT=1`,
   `BASELINE_USD_PER_1M=6.0`, `NORMALIZATION_SCALE=10`) and the same 3:1 blended-cost
   normalization. The backend copy self-documents the duplication at
   `extension/src/backend/pricing.ts:5-7`: *"This is a thin duplicate of the equivalent
   module in `extensions/subagent/pricing.ts`... Keep constants and logic synchronized."*
   Manual "keep synchronized" across two copies is a known drift hazard. Additionally the
   two copies use different module systems: `extensions/subagent/pricing.ts:13` uses ESM
   `import { readFileSync } from "node:fs"`, while `extension/src/backend/pricing.ts:79`
   uses inline CommonJS `require('node:fs').readFileSync(...)` inside the function body.
   Why it matters: any future pricing-logic change (e.g. the baseline anchor, weight ratio,
   or `models.json` schema) must be applied twice with no compile-time coupling; the two
   copies have already diverged in code style and will diverge in behavior on the next edit.
   A third copy of pricing logic also exists in `analysis/scripts/pricing.ts`.

3. **Subagent extension reaches into repo-local analytics scripts via fragile relative
   dynamic import.**
   `extensions/subagent/bridge.ts:18-29` does
   `await import("../../analysis/scripts/stratified-ranker.js")` and re-exports
   `BucketAssignments`/`SimpleModelConfig`/`ThinkingLevel` types from that same relative path
   (`bridge.ts:9-13`). The analytics scripts are not a published package — they are
   repo-local `.ts` files compiled separately. The extension's correctness depends on the
   analytics module's relative location and export surface remaining stable. Failure is
   fail-open (`bridge.ts:22-27` catches all and returns empty assignments → caller falls
   back to active model), so it won't crash, but silent fallback masks a broken contract.
   Why it matters: any move/rename of `analysis/scripts/stratified-ranker.ts` or change to
   `computeBucketAssignments`'s signature silently disables bucket-based model selection
   for the entire subagent system with only a swallowed catch as evidence.

4. **`CONFIG_ROOT` is independently recomputed in 4 places with different relative climbs,
   no shared helper.**
   - `extensions/skill-pruner/config.ts:6` — `path.resolve(import.meta.dirname, "..", "..")`
   - `extensions/skill-pruner/logger.ts:8` — `path.resolve(import.meta.dirname, "..", "..")`
   - `extensions/skill-pruner/src/state.ts:54` — `path.resolve(import.meta.dirname, "..", "..", "..")`
   - `extensions/subagent/src/execute.ts:26` — `path.resolve(import.meta.dirname, "..", "..", "..")`
   Each is "correct" for its own file depth, but the pattern is copy-pasted and the correct
   climb depth is implicit on file location — moving any of these files silently breaks
   repo-root resolution (and thus settings.json / model-profiles / a
nalytics-dir / log-path resolution). Why it matters: a refactor that relocates a file one directory deeper will
   read the wrong `settings.json`/`model-profiles.yaml`/`data/pruning.jsonl` with no error.

### Medium

5. **`skill-pruner/src/register.ts` `before_agent_start` handler is a ~150-line god function
   with ~12 mutable locals and string-prefix-based control flow.**
   `extensions/skill-pruner/src/register.ts:30-178` declares one async handler with `let
   modifiedSystemPrompt`, `skillPruningRan`, `skillResult`, `toolResult`, `pruningError`,
   `rawResponse`, `rawThinking`, `rawSystemPrompt`, `rawUserMessage`, `prepassThinkingLevel`,
   `latencyMs`, `skillSafeguardReason`, `toolSafeguardReason`, `keptAllDueToParseFailure`.
   Branching is driven by error-message string prefixes at `register.ts:97`:
   `if (!pruningError || pruningError.startsWith("Model") || pruningError.startsWith("LLM pruning failed"))`.
   Why it matters: control flow keyed on `error.message` prefixes is fragile — any wording
   change in `prepass.ts`'s error strings (e.g. `formatEmptyPrepassError`,
   `extensions/skill-pruner/src/prepass.ts:113-122`, or the `"Model '...' not found"`
   message at `prepass.ts:166`) silently flips whether skill/tool selection runs. This is
   the orchestrator's core decision point and it has no typed error discriminator.

6. **Inconsistent top-level-vs-`src/` layering across `subagent` and `skill-pruner`.**
   Both extensions split code across a top-level directory *and* a `src/` subdir with no
   consistent rule, and the entry point just re-exports:
   - `extensions/subagent/index.ts` (7 lines) -> `export { default } from "./src/register.js"`.
     `src/register.ts` then imports back up to top-level modules (`../agents.js`,
     `../schema.js`, `../render.js`, `./execute.js`). `src/execute.ts` likewise imports
     `../agents.js`, `../runner.js`, `../schema.js`, `../types.js`, `../validation.js`,
     `../bucket-selector.js`, `../bridge.js`, `../formatting.js`. So the `src/` files depend
     on the top-level files, while top-level `runner.ts` imports *down* into
     `./src/parent-extension-ui-bridge-proxy.js` and `./formatting.js`. The dependency graph
     crosses the `src/` boundary in both directions.
   - `extensions/skill-pruner/index.ts` (61 lines) re-exports from `./src/register.js` *and*
     also re-exports `SKILLS_BLOCK_RE`/`MIN_PROMPT_LENGTH` from `./src/pruning.js`, while
     also importing `clonePruningConfig`/`ensureCopilotHeaders` from `./src/pruning.js` and
     test-seam setters from `./src/state.js`, and top-level `./llm-scorer.js`. The barrel
     mixes concerns (public API + test seams).
   - Meanwhile `ask-user` (all in `src/`), `cwd-skills` (single file), and `safeguard`
     (flat, no `src/`) use three different conventions. Why it matters: there is no
     documented rule for what lives at top level vs `src/`; new contributors cannot predict
     where a module belongs, and the bidirectional `src/`<->top-level imports in `subagent`
     defeat the purpose of the layer boundary.

7. **Loose typing across the subagent render/session layer.**
   - `extensions/subagent/render.ts:12-14` — `type Theme = any; type Ctx = any; type
     RenderResult = any;` and `renderSubagentCall(args: any, ...)`, `renderSubagentResult(result: any, ...)`.
   - `extensions/subagent/runner.ts:31-41` — `SessionLike.subscribe: (cb: (event: any) => void)`,
     and `recordAssistantMessage(result, msg: any)`, `handleMessageUpdate(event: any, ...)`,
     `handleMessageEnd(rawMessage: any, ...)`. The SDK's `Message`/event types are erased
     into `any` at the boundary.
   - `extensions/subagent/src/modes.ts` casts `args.thinkingLevel as ThinkingLevel | undefined`
     (`modes.ts:79`, `:111`, `:188`) — `ThinkingLevel` is a string-union but
     `SubagentParams.thinkingLevel` is already typed as the union via the schema, so the cast
     hints the runtime type is actually `string | undefined`.
   - `extensions/subagent/runner.ts:21-29` hand-re-declares the SDK surface as a local
     `SubagentSdk` interface (`createSession`, `createResourceLoader`, ...) rather than
     importing the SDK types; drift between this local interface and the real SDK signatures
     is uncaught at compile time.
   Why it matters: the rendering and session-event paths are the user-visible surface and
   they are effectively untyped; refactors won't get compiler help.

8. **`ParentExtensionUIBridgeProxy` implements a large `ExtensionUIContext` with ~20 no-op
   methods.**
   `extensions/subagent/src/parent-extension-ui-bridge-proxy.ts:73-94` stubs out
   `onTerminalInput`, `setStatus`, `setWorkingMessage`, `setWidget`, `setFooter`,
   `setEditorText`, `getEditorText`, `editor`, `addAutocompleteProvider`,
   `setEditorComponent`, `getEditorComponent`, `getTheme`, `setTheme`,
   `getToolsExpanded`, `setToolsExpanded`, etc. as no-ops returning `undefined`/`""`/`{}`.
   `custom<T>()` throws "not available in subagent sessions". Why it matters: this is an
   interface-segregation smell — subagents only need `select/input/confirm/notify/cancelAll`,
   but the proxy must implement the full TUI surface to satisfy `ExtensionUIContext`. Any
   new TUI method added to the interface silently becomes a no-op in subagent sessions
   rather than a compile error.

9. **`ask-user` reaches into the VS Code extension's source tree for a shared sentinel.**
   `extensions/ask-user/src/types.ts:1` —
   `export { CUSTOM_SENTINEL } from "../../../extension/src/shared/ask-user-sentinel.js";`
   A pi extension imports a constant from the *host* VS Code extension's internal `src/`
   tree (not a published package). Why it matters: the extension is coupled to the host
   extension's internal file layout; moving `ask-user-sentinel.ts` breaks the ask-user
   extension's build. The sentinel value should live in a shared package or be duplicated.

10. **Duplicate `MAX_DEPTH` constant with unclear ownership.**
    `extensions/subagent/src/helpers.ts:10` — `export const MAX_DEPTH = 3;` (the canonical
    "3" is also `DEFAULT_MAX_DEPTH` in `extensions/subagent/runner.ts:137`, plus
    `getMaxDepth()` reads `PIE_SUBAGENT_MAX_DEPTH`). `helpers.MAX_DEPTH` is a plain constant
    with no env override; tests (`test/index.test.ts:22`, `test/nesting-controls.test.ts:11`)
    import it and assert `getMaxDepth() === MAX_DEPTH` for the default
    (`nesting-controls.test.ts:66`). Why it matters: there are two sources of truth for the
    default depth limit; if `DEFAULT_MAX_DEPTH` in `runner.ts` changes but `MAX_DEPTH` in
    `helpers.ts` doesn't, the documented/default behavior and the tests diverge silently.
    `helpers.ts` itself is otherwise a 24-line file that could be inlined.

### Low

11. **`bucket-selector.selectModel` mutates its `thinkingLevel` parameter.**
    `extensions/subagent/bucket-selector.ts:213` reassigns `thinkingLevel = relaxed;` then
    `:222` reassigns again, then returns the mutated value. Reassigning a parameter is a
    minor readability/aliasing smell; the function returns `thinkingLevel` so callers see
    the effect, but the in-place mutation makes the control flow harder to follow.

12. **`state.ts` exports a snake-case setter.**
    `extensions/skill-pruner/src/state.ts:69` —
    `export function set_piCompleteSimple(value: ...)` (snake_case) while every other setter
    in the same file is camelCase (`setConfigOverrideForTesting`, `setPiApi`, etc.). The
    file's header comment explains the single-`state`-object pattern for esbuild CJS
    reference semantics (good), but the one snake_case export is inconsistent and there is
    no caller found in `extensions/`.

13. **`cwd-skills` README is accurate but the extension is trivially small and has a
    503-line test file.**
    `extensions/cwd-skills/index.ts` (30 lines) returns `{ skillPaths: [skillsDir] }` from a
    is 503 lines for ~15 lines of real logic. Not a defect, but the test-to-code ratio is
    very high; worth confirming the tests aren't mostly boilerplate harness.

## Smaller nits

- `extensions/subagent/src/execute.ts:104-118` — `dispatchToMode` builds a positional
  11-element `modeArgs` tuple and spreads it into the three mode functions, which all take
  the same 11 positional parameters (`modes.ts:96-109`, `:117-128`, `:283-295`). A single
  options-object type would reduce the chance of positional-arg mis-ordering across four
  functions that must stay in sync.

- `extensions/subagent/src/modes.ts:79,111,188` — `runWithModelRetry` is called three times
  with near-identical `buildRuntime`/`runAttempt` closures differing only by the agent name
  and the `_toolCallId` stamping rule (`modes.ts:160-165`, `:317-322`), which is subtle and
  explained only in inline comments; a shared helper would localize the rule.

- `extensions/subagent/render.ts` — `appendChainTotal` (string path) and
  `appendChainTotalForContainer` (Container path) duplicate aggregation/format logic for two
  render shapes; same for `renderChainStepExpanded` vs `renderParallelStepExpanded` and
  `chainStepHeader` vs `parallelStepHeader`. The chain/parallel renderers are structurally
  near-identical and could share more.

- `extensions/ask-user/src/ask.ts:9` — `AskPort.ui.select` signature
  `{ timeout?: number; signal?: AbortSignal }` diverges from the real `ParentBridge.select`
  shape (`parent-extension-ui-bridge-proxy.ts:12`: `{ signal?; subagentCallId? }`).
  `ask-user` never passes `subagentCallId`; it relies on the proxy stamping it. The local
  port type doesn't reflect that contract.

- `extensions/safeguard/index.ts` — `HARD_BLOCK_PATTERNS`/`PROMPT_PATTERNS` are large inline
  regex tables (~90 entries). Overlap is documented (the `clean all` removal comment at
  `index.ts:175-180`), but the sheer size makes coverage gaps likely; no table-driven test
  enumeration is visible from the file itself (coverage lives in the 1001-line test file).

- `extensions/skill-pruner/llm-scorer.ts:117-128` — `buildStrategyInstruction` interpolates
  `config.tools?.ceiling ?? 10` while `buildPruningSystemPrompt` (`:135`) replaces
  `{{TOOL_CEILING}}` with the same `config.tools?.ceiling ?? 10`. The fallback `10` is
  duplicated and must match `DEFAULT_TOOL_CONFIG.ceiling` (`config.ts:11`).

- `extensions/subagent/runner.ts:289-292` — `runSingleAgent` takes `disabledProviders?` and
  passes it to `resolveExecutionModel`, but `disabledProviders` is also stored on
  `SelectionContext` (`execute.ts:88`); the same set is threaded via two paths.

- `extensions/subagent/README.md:25` claims "shares the parent's auth, model registry, and
  OAuth tokens" — consistent with `runner.ts` `loadSubagentSdk`/`createSession`, accurate.

- `extensions/skill-pruner/src/pruning.ts:8` re-exports a large surface from
  `./message-builders.js`, `./copilot-headers.js`, `./prepass.js`, and also defines
  `SKILLS_BLOCK_RE`/`MIN_PROMPT_LENGTH` locally; `index.ts` then re-exports those same
  symbols again. Double re-export chain (`pruning.ts` -> `index.ts`) is a minor indirection.
