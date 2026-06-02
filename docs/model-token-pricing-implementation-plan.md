# Model Token Pricing Implementation Plan

**Goal:** Store real per-token model prices in `models.json` and derive normalized selection costs from them so future session/accrued cost indicators and subagent model selection use the same pricing source.

**Approach:** Keep `model-profiles.yaml` as the capability/eligibility registry and move authoritative pricing into `models.json`. Before editing price data, run a dedicated pricing-scouting phase that gathers current public/provider pricing from authoritative sources and records source URLs, retrieval dates, units, and confidence in a separate evidence document. Then add a shared pricing-normalization layer that converts real prices into the existing selector’s cost-penalty scale, preserving backward compatibility with the current `profile.cost` field until all consumers are migrated. Update both subagent selection and the VS Code extension model picker to consume normalized cost metadata without duplicating parsing logic.

## Current Change Points

- `models.json`
  - Root model registry.
  - Currently contains provider/model metadata and `cost: { input, output, cacheRead, cacheWrite }`, but almost all values are `0`.
  - Appears to contain only the `ollama` provider; Copilot models are represented in `model-profiles.yaml`, not here.

- `model-profiles.yaml`
  - Shared profile registry for subagent capability scoring.
  - Contains `precision`, `creativity`, `thoroughness`, `reasoning`, `thinking`, `eligible`, `disabled_reason`, and heuristic numeric `cost`.
  - Current `cost` is a relative `0–30+` selector penalty, not real money.

- `extensions/subagent/model-selection.ts`
  - Defines `ModelProfile.cost?: number`.
  - `computeFitness()` subtracts `COST_WEIGHT * cost`.
  - If `profile.cost` is missing, falls back to capability aggregate: `precision + creativity + thoroughness + reasoning`.

- `extensions/subagent/index.ts`
  - Loads model profile config for subagent selection.
  - Verify/fix profile path handling while touching selection config loading; at least one path references `model-profiles.json` despite YAML being the preferred registry.

- `extension/src/backend/subagent-profiles.ts`
  - Reads `model-profiles.{yaml,yml,json}` for the VS Code extension.
  - Exposes only `eligible`, `aggregate`, and `disabledReason` to the webview.
  - Cache invalidates only on profile file mtime.

- `extension/src/shared/protocol.ts`
  - Defines `ModelSubagentInfo` and `ModelInfo`.
  - Must be updated for any cost metadata sent host ↔ webview.

- `extension/src/webview/panel/composer/model-list.ts`
  - Orders model picker entries by eligibility, aggregate rating descending, then name/id.
  - Tooltip currently shows rating/ineligibility only.

- `docs/internal/copilot-model-pricing.md`
  - Documents old Copilot premium-request multiplier mapping.
  - Needs updating to token-credit pricing.

## Tasks

### 0. Scout current pricing data and write an evidence document

**Files:**

- Create `docs/internal/model-token-pricing-sources.md`
- Read/update `docs/internal/copilot-model-pricing.md`
- Read/update `docs/internal/ollama-pro-cloud-models-ranked.md` only if it contains useful source trails
- No production code changes in this task

**What:**

- The implementation agent must start by spinning up a read-only/scouting subagent dedicated to pricing research.
- The scouting subagent should gather current real-world token pricing from authoritative sources, not merely reuse stale local docs.
- Preferred source priority:
  1. Official GitHub Copilot docs/pages for credit or token-based model pricing.
  2. Official provider pricing pages for underlying models when Copilot-specific pricing is unavailable.
  3. Official Ollama Cloud/Ollama Turbo pricing docs for `:cloud` models.
  4. Existing repo docs only as historical context or fallback, never as the only source for new data.
- For each model in `model-profiles.yaml`, record:
  - model id in this repo
  - provider/source ecosystem (`github-copilot`, `ollama-cloud`, `ollama-local`, etc.)
  - source URL(s)
  - retrieval date
  - source units as published
  - normalized units to use in this repo (`USD per 1M input tokens`, `USD per 1M output tokens`, cache read/write if published)
  - whether cache pricing is explicitly published, inferred, unavailable, or not applicable
  - confidence: `official`, `official-inferred`, `third-party`, or `unknown`
  - notes for name/id mismatches, aliases, previews, and deprecated models
- Write findings to `docs/internal/model-token-pricing-sources.md` before changing `models.json`.
- If a model has no reliable public pricing, do not invent a price. Mark it as `unknown` in the evidence doc and keep legacy fallback behavior in code/data.
- If Copilot publishes prices in credits rather than USD, document the credit-to-USD conversion source and formula. If no official conversion exists, keep values in the evidence doc as credits and do not convert them to `models.json` dollar fields until a defensible conversion is available.

**Tests / verification:**

- No automated tests required for this research-only task.
- Manual acceptance criteria:
  - `docs/internal/model-token-pricing-sources.md` exists.
  - Every eligible model in `model-profiles.yaml` is represented in the evidence table.
  - Every price later written to `models.json` can be traced to a row in the evidence doc.

### 1. Define the pricing schema and migration rule

**Files:**

- `models.json`
- `model-profiles.yaml`
- `extension/src/shared/protocol.ts`
- `extensions/subagent/model-selection.ts`
- New shared/helper module for pricing parsing + normalization

**What:**

- Treat `models.json` model `cost` values as real prices in **USD per 1M tokens**.
- Keep the existing object shape:

  ```json
  {
    "cost": {
      "input": 0,
      "output": 0,
      "cacheRead": 0,
      "cacheWrite": 0
    }
  }
  ```

- Prefer these semantics:
  - `0` = genuinely free/local/included.
  - Missing `cost` = unknown pricing.
  - Missing subfields = unknown/invalid pricing unless safely defaulted by parser rules.
- Add/standardize a type like:

  ```ts
  interface ModelTokenPricing {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }
  ```

- Document units as `USD per 1M tokens`.
- Do **not** immediately delete `model-profiles.yaml`’s existing `cost` field. Use it as a backward-compatible fallback until pricing exists for all profiled models.
- Add a derived code concept such as `normalizedCost` or `costIndex` representing the existing selector’s `0–30+` scale. This does not need to be persisted in `models.json`.

**Tests:**

- Parser behavior for complete, missing, partial, zero, and malformed `cost`.
- Unknown pricing does not crash and falls back to legacy profile cost.

### 2. Populate `models.json` with real pricing data

**Files:**

- `models.json`
- `docs/internal/model-token-pricing-sources.md`
- `docs/internal/copilot-model-pricing.md`
- Possibly `docs/internal/ollama-pro-cloud-models-ranked.md`

**What:**

- Use `docs/internal/model-token-pricing-sources.md` as the evidence source for all prices written to `models.json`.
- Add/update prices in `models.json` as real USD-per-1M-token values only when the evidence doc provides a defensible USD conversion.
- If the evidence doc only establishes credit pricing without a defensible USD conversion, do not force those values into the dollar-denominated `cost` fields. Either leave pricing unknown and use legacy fallback, or add a separate documented credit-pricing field only if the schema task explicitly chooses to support that.
- Local Ollama models remain zero-cost.
- Cloud Ollama models should use current official pricing gathered during the scouting phase; existing repo docs are historical context only.
- Add a Copilot/GitHub provider block if it does not already exist.
  - Inspect existing model loading code before choosing the provider key. Likely candidates are `copilot` or `github-copilot`.
  - Include all Copilot model ids present in `model-profiles.yaml`, including current Claude, GPT, Gemini, and Grok entries.
- Preserve known metadata such as `name`, `reasoning`, `contextWindow`, `maxTokens`, and `input`.
- If exact context/max-token metadata is unknown for a newly added Copilot model, omit optional fields rather than guessing.
- Keep source detail out of `models.json` because it is strict JSON and cannot contain comments. Use `docs/internal/model-token-pricing-sources.md` as the traceability mechanism instead.

**Tests:**

- Extend `extension/test/model-profile-coverage.test.ts` to check every `model-profiles.yaml` id either:
  - exists in `models.json`, or
  - has an explicit legacy-cost fallback reason.
- Add a pricing coverage test requiring every non-local, eligible profiled model to have either real pricing or legacy cost fallback.

### 3. Create one normalization algorithm for selection cost

**Files:**

- `extensions/subagent/model-selection.ts`
- New pricing helper module
- Extension-side equivalent or shared extracted utility
- Tests under the relevant package test directories

**What:**

- Define a deterministic function that converts token prices into the existing selector penalty range:

  ```ts
  estimateNormalizedCost(pricing: ModelTokenPricing): number
  ```

- Use a representative agentic coding token mix. Recommended initial default:
  - input: `3`
  - output: `1`
  - cacheRead: `0`
  - cacheWrite: `0`

- Compute blended USD-per-1M:

  ```ts
  blended = (3 * input + 1 * output) / 4
  ```

- Map to existing selector scale with a documented transform. Recommended:

  ```ts
  normalized = 10 * Math.sqrt(blended / baselineUsdPer1M)
  ```

- Choose `baselineUsdPer1M` from current Copilot baseline pricing documented in `docs/internal/model-token-pricing-sources.md` so normalized values roughly preserve the old `cost=10` behavior.
- Clamp lower bound at `0`; do not clamp upper bound unless required, since current docs allow `30+`.
- Use explicit fallback order:
  1. If real `models.json` pricing exists and is known, use normalized pricing.
  2. Else if `model-profiles.yaml` has legacy `cost`, use that.
  3. Else fall back to capability aggregate, preserving current behavior.
- Reject negative prices. Negative pricing must not act as a model-selection bonus.

**Tests:**

- Real pricing beats legacy when available.
- Legacy profile `cost` is used when pricing is missing.
- Capability aggregate is used when both are missing.
- Negative or non-finite prices are ignored/rejected.
- Free/local pricing normalizes to `0`.
- Expensive model receives higher penalty than cheap model.
- Existing `computeFitness()` expectations are updated intentionally.

### 4. Wire pricing into subagent model selection

**Files:**

- `extensions/subagent/index.ts`
- `extensions/subagent/model-selection.ts`
- New pricing loader/helper
- `extensions/subagent/README.md`

**What:**

- Load `model-profiles.yaml` as the capability source.
- Load root `models.json` as the pricing source.
- Resolve paths carefully:
  - `model-profiles.yaml` may be read from the pi config/agent directory.
  - `models.json` is at the pi-config root in this repo.
  - Do not assume both files are in the same directory unless existing config resolution confirms this.
- Join profiles to model pricing by model id.
- Keep provider-aware records internally:

  ```ts
  interface ModelPricingRecord {
    id: string;
    provider: string;
    pricing?: ModelTokenPricing;
  }
  ```

- If duplicate ids exist across providers, prefer an exact active registry match or ignore ambiguous pricing with a diagnostic instead of silently selecting one.
- Replace direct use of `profile.cost` in fitness with resolved normalized cost.
- Keep accepting `profile.cost` as legacy selector cost.

**Tests:**

- Selection with pricing data.
- Provider-disabled filtering still works.
- Missing `models.json` preserves current selection behavior.
- Malformed `models.json` does not crash subagent invocation.

### 5. Expose cost metadata to the VS Code extension model picker

**Files:**

- `extension/src/backend/subagent-profiles.ts`
- `extension/src/shared/protocol.ts`
- `extension/src/webview/panel/composer/model-list.ts`
- Related webview tests

**What:**

- Extend `ModelSubagentInfo` with optional cost metadata:

  ```ts
  export interface ModelSubagentInfo {
    eligible: boolean;
    aggregate: number;
    disabledReason?: string;
    normalizedCost?: number;
    pricing?: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
  }
  ```

- Update `subagent-profiles.ts` to load pricing from `models.json` and compute `normalizedCost`.
- Ensure cache invalidation watches both profile file mtime and `models.json` mtime.
- Prefer shared normalization code. If sharing is impractical, duplicate only the thin parser/normalizer and keep constants/tests synchronized.
- Update model picker ordering conservatively:
  - Ineligible models remain last.
  - Aggregate rating remains primary ranking.
  - `normalizedCost` becomes a tiebreaker before name/id.
  - Cheap but much lower-rated models should not jump ahead of much better-rated models unless explicitly intended later.
- Update tooltip to include:
  - rating
  - normalized selector cost
  - real pricing if known, formatted as `$X/M in, $Y/M out`
  - disabled reason when applicable

**Tests:**

- `loadSubagentProfiles()` includes normalized cost when pricing exists.
- Cache invalidates when only `models.json` changes.
- Model picker sorts same-rating models by cheaper normalized cost.
- Existing deterministic name/id tiebreak remains when aggregate and cost are equal.
- Tooltip includes price text only when pricing is known.

### 6. Update documentation and comments

**Files:**

- `model-profiles.yaml`
- `docs/internal/copilot-model-pricing.md`
- `docs/model-scoring-methodology.md`
- `docs/INDEX.md`
- `extensions/subagent/README.md`
- `AGENTS.md` only if the project-level registry description needs updating

**What:**

- Remove or rewrite comments saying `model-profiles.yaml cost` is the primary cost source.
- Document that:
  - `docs/internal/model-token-pricing-sources.md` is the evidence ledger for current pricing sources.
  - `models.json` contains real token pricing in USD per 1M tokens only when a defensible USD conversion exists.
  - `model-profiles.yaml cost` is legacy fallback selector cost.
  - Subagent selection uses normalized cost derived from real pricing when available.
  - Normalized cost is not displayed as dollars and should not be used for billing.
- Update `docs/internal/copilot-model-pricing.md` from premium-request-multiplier framing to credit/token-pricing framing, with links back to the evidence ledger.
- Document the normalization formula and baseline value, including the exact evidence-doc row/source used for the baseline.

### 7. Add validation/coverage tests for data consistency

**Files:**

- `extension/test/model-profile-coverage.test.ts`
- New pricing tests in appropriate package test directories

**What:**

- Validate every model profile has:
  - valid id
  - non-negative capability scores
  - either real pricing in `models.json`, legacy `cost`, or explicit local/free status
- Validate every real pricing object has:
  - finite non-negative numbers
  - no missing required subfields if `cost` is present
  - a matching evidence row in `docs/internal/model-token-pricing-sources.md`
  - local models may be all zero
  - non-local cloud/Copilot models should not silently be all zero unless explicitly marked free/included by the evidence doc
- Validate no negative legacy cost is accepted as a bonus.
- Consider adding a test that ensures Copilot profile ids are represented in `models.json` after the new provider block is added.

**Verification:**

Run:

```bash
npm run test -- --package extension
npm run test -- --package subagent
npm run test
```

After editing `extension/src/`, rebuild:

```bash
cd extension
npm run build
```

## Implementation Notes

- Do **not** replace `profile.cost` with `costIndex` in one breaking step.
  - Existing profiles and tests depend on `cost`.
  - Prefer keeping `cost` parsed as legacy selector cost.
- Do **not** treat unknown cloud pricing as zero.
  - Zero should mean genuinely free/local/included.
  - Unknown should trigger fallback or warning behavior.
- Do **not** duplicate normalization constants in multiple places unless unavoidable.
  - If duplicated, add tests in both consumers.
- Be careful with path resolution:
  - Extension backend loads profiles from `agentDir`.
  - Root `models.json` may need to be resolved from configured pi root/repo root, not from the profile file directory.
- Update tests that currently assume name-based sorting when aggregates match; cost becomes a tiebreaker.

## Out of Scope

- Implementing the actual estimated session cost indicator UI.
- Implementing the always-visible accruing cost indicator.
- Changing runtime token accounting logic beyond preparing pricing metadata.
- Enforcing hard budget limits or blocking expensive models.
- Fetching live pricing from GitHub/Ollama APIs. Use committed static pricing data for now.
