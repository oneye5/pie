# Model Token Pricing Evidence Ledger

**Purpose:** Authoritative traceability record for every price written to `models.json`.
Every non-zero cost field in `models.json` MUST have a corresponding row in this document.

**Retrieval date:** 2026-06-04
**Format:** All prices in USD per 1M tokens unless otherwise noted.

---

## Methodology

For each model in `model-profiles.yaml`:
- **GitHub Copilot models**: Token pricing sourced from official GitHub Copilot billing documentation. 1 AI credit = $0.01 USD.
- **Ollama Cloud models**: Compute-based estimates using the methodology from `ollama-pro-cloud-models-ranked.md` (H100 @ $3/hr, 2×active_params FLOPs/token). These are lower-bound estimates; actual billed prices may be higher due to platform margin and overhead.
- **Ollama Local models**: Free/local (no API cost).
- **Grok models**: No official token pricing found; marked as unknown.

### Confidence levels

| Tag | Meaning |
|---|---|
| `official` | Published on provider's official pricing page |
| `official-inferred` | Derived from official data with documented formula |
| `third-party` | From independent analysis or compute estimates |
| `unknown` | No reliable pricing found |

---

## GitHub Copilot Models

Source: [GitHub Copilot models and pricing](https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing)
Conversion: 1 AI credit = $0.01 USD

### Anthropic (via Copilot)

| Model ID | Input | Cached Input | Cache Write | Output | Source Units | Confidence | Notes |
|---|---|---|---|---|---|---|---|
| claude-haiku-4.5 | $1.00 | $0.10 | $1.25 | $5.00 | USD/1M tokens | official | Copilot docs table |
| claude-sonnet-4.5 | $3.00 | $0.30 | $3.75 | $15.00 | USD/1M tokens | official | Copilot docs table |
| claude-sonnet-4.6 | $3.00 | $0.30 | $3.75 | $15.00 | USD/1M tokens | official | Same tier as sonnet-4.5 per Copilot docs |
| claude-opus-4.6 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Copilot docs table |
| claude-opus-4.7 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Same tier as opus-4.6 per Copilot docs |
| claude-opus-4.8 | $5.00 | $0.50 | $6.25 | $25.00 | USD/1M tokens | official | Copilot docs table |

**Disabled/ineligible Copilot Anthropic models** (historical pricing):

| Model ID | Input | Cached Input | Cache Write | Output | Confidence | Notes |
|---|---|---|---|---|---|---|
| claude-opus-4.5 | $5.00 | $0.50 | $6.25 | $25.00 | official | Superseded |
| claude-sonnet-4 | $3.00 | $0.30 | $3.75 | $15.00 | official | Superseded |

### OpenAI (via Copilot)

| Model ID | Input | Cached Input | Output | Source Units | Confidence | Notes |
|---|---|---|---|---|---|---|
| gpt-4o | $2.50 | $0.25 | $10.00 | USD/1M tokens | official | Copilot docs table |
| gpt-4.1 | $2.00 | $0.50 | $8.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5-mini | $0.25 | $0.025 | $2.00 | USD/1M tokens | official | Copilot docs table; free-tier included |
| gpt-5.4-mini | $0.75 | $0.075 | $4.50 | USD/1M tokens | official | Copilot docs table |
| gpt-5.2 | $1.75 | $0.175 | $14.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5.2-codex | $1.75 | $0.175 | $14.00 | USD/1M tokens | official | Same as gpt-5.2 per docs |
| gpt-5.3-codex | $1.75 | $0.175 | $14.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5.4 | $2.50 | $0.25 | $15.00 | USD/1M tokens | official | Copilot docs table |
| gpt-5.5 | $5.00 | $0.50 | $30.00 | USD/1M tokens | official | Copilot docs table |

**Disabled/ineligible Copilot OpenAI models** (historical pricing):

| Model ID | Input | Cached Input | Output | Confidence | Notes |
|---|---|---|---|---|---|
| gpt-5.1 | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex-max | $1.75 | $0.175 | $14.00 | official | Superseded |
| gpt-5.1-codex-mini | $0.75 | $0.075 | $4.50 | official | Superseded |
| gpt-5 | $1.75 | $0.175 | $14.00 | official | Superseded |

Cache write pricing is NOT published for OpenAI Copilot models. Models default cacheWrite to 0 unless explicitly stated.

### Google (via Copilot)

| Model ID | Input | Cached Input | Output | Source Units | Confidence | Notes |
|---|---|---|---|---|---|---|
| gemini-3-flash-preview | $0.50 | $0.05 | $3.00 | USD/1M tokens | official | Copilot docs table (Gemini 3 Flash) |
| gemini-3-pro-preview | $2.00 | $0.20 | $12.00 | USD/1M tokens | official | Copilot docs table (Gemini 3.1 Pro pricing; 3 Pro assumed same tier) |
| gemini-3.1-pro-preview | $2.00 | $0.20 | $12.00 | USD/1M tokens | official | Copilot docs table |

**Disabled/ineligible Copilot Google models**:

| Model ID | Input | Cached Input | Output | Confidence | Notes |
|---|---|---|---|---|---|
| gemini-2.5-pro | $1.25 | $0.125 | $10.00 | official | Superseded |

Cache write pricing is NOT published for Google Copilot models.

### Grok (via Copilot)

| Model ID | Input | Cached Input | Output | Confidence | Notes |
|---|---|---|---|---|---|
| grok-code-fast-1 | unknown | unknown | unknown | unknown | No public token pricing found. The cost:13 heuristic in model-profiles.yaml is a manual estimate. |

---

## Ollama Cloud Models

Source: Compute-based estimates from `ollama-pro-cloud-models-ranked.md` (H100 @ $3/hr methodology).
These are **lower-bound compute-only estimates** and do not include platform margin.

Cost formula: `cost_per_1M ≈ active_params_in_billions / 600`
Confidence: `third-party` (compute estimates, not official pricing)

Cache pricing is NOT explicitly published for Ollama Cloud. Marked as `not applicable` in models.json.

| Model ID | Input (est.) | Output (est.) | Active Params | Confidence | Notes |
|---|---|---|---|---|---|
| deepseek-v4-pro:cloud | $0.0817 | $0.0817 | 49B | third-party | Frontier; 1.6T total, MoE |
| deepseek-v4-flash:cloud | $0.0217 | $0.0217 | 13B | third-party | Flash variant; 284B total, MoE |
| gemini-3-flash-preview:cloud | $0.02-$0.08 | $0.02-$0.08 | undisclosed | unknown | Closed-source; range from docs. No compute estimate possible. |
| gemma4:31b-cloud | $0.0517 | $0.0517 | 31B | third-party | Dense 31B |
| qwen3.5:397b-cloud | $0.0283 | $0.0283 | 17B | third-party | Uses A17B variant (midpoint of variant range) |
| qwen3.5:cloud | $0.0298 | $0.0298 | varies | third-party | Midpoint of documented variant range ($0.0013-$0.0583) |
| qwen3-coder-next:cloud | $0.0050 | $0.0050 | 3B | third-party | Very small active params |
| qwen3-coder:480b-cloud | $0.0583 | $0.0583 | 35B | third-party | Code-specialized |
| kimi-k2.6:cloud | $0.0533 | $0.0533 | 32B | third-party | Top open-weight model |
| kimi-k2.5:cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Earlier gen |
| kimi-k2.7-code:cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Coding-focused K2 variant; vision+tools+thinking |
| nemotron-3-super:cloud | $0.0200 | $0.0200 | 12B | third-party | 120B MoE |
| glm-5.2:cloud | $0.0667 | $0.0667 | 40B (est.) | third-party | 756B total, MoE; active params assumed same 40B generation as GLM-5/5.1 pending official spec |
| glm-5.1:cloud | $0.0667 | $0.0667 | 40B | third-party | Current gen |
| glm-5:cloud | $0.0667 | $0.0667 | 40B | third-party | 744B MoE; tools+thinking |
| glm-4.7:cloud | $0.0533 | $0.0533 | 32B | third-party | Current gen |
| gpt-oss:120b-cloud | $0.2000 | $0.2000 | 120B | third-party | Dense 120B |
| gpt-oss:20b-cloud | $0.0333 | $0.0333 | 20B | third-party | Superseded |
| minimax-m2.7:cloud | $0.0167 | $0.0167 | 10B | third-party | Current gen |
| minimax-m2.5:cloud | $0.0167 | $0.0167 | 10B | third-party | Tools+thinking; reinstated on cloud |
| minimax-m2.1:cloud | $0.0167 | $0.0167 | 10B | third-party | Tools only (no thinking); reinstated on cloud |

---

## Removed from Ollama Cloud (historical)

Models previously available on Ollama Cloud but no longer listed. Pricing retained for reference.

| Model ID | Input (est.) | Output (est.) | Active Params | Confidence | Notes |
|---|---|---|---|---|---|
| deepseek-v3.2:cloud | $0.0617 | $0.0617 | 37B | third-party | Baseline anchor for Ollama cost scale; Removed from cloud 2026-06 |
| deepseek-v3.1:671b-cloud | $0.0617 | $0.0617 | 37B | third-party | Removed from cloud 2026-06 |
| cogito-2.1:671b-cloud | $0.0617 | $0.0617 | 37B | third-party | Same active params as deepseek-v3.x; Removed from cloud 2026-06 |
| gemma3:27b-cloud | $0.0450 | $0.0450 | 27B | third-party | Dense 27B; Removed from cloud 2026-06 |
| gemma3:12b-cloud | $0.0200 | $0.0200 | 12B | third-party | Dense 12B; Removed from cloud 2026-06 |
| gemma3:4b-cloud | $0.0067 | $0.0067 | 4B | third-party | Too small for agentic; Removed from cloud 2026-06 |
| rnj-1:8b-cloud | $0.0133 | $0.0133 | 8B | third-party | Too small for agentic; Removed from cloud 2026-06 |
| qwen3-next:80b-cloud | $0.0050 | $0.0050 | 3B | third-party | Very small active params; Removed from cloud 2026-06 |
| qwen3-vl:235b-cloud | $0.0367 | $0.0367 | 22B | third-party | VL-specialized; Removed from cloud 2026-06 |
| qwen3-vl:235b-instruct-cloud | $0.0367 | $0.0367 | 22B | third-party | Superseded/redundant; Removed from cloud 2026-06 |
| kimi-k2-thinking:cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Removed from cloud 2026-06 |
| kimi-k2:1t-cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Removed from cloud 2026-06 |
| nemotron-3-nano:30b-cloud | $0.0500 | $0.0500 | 30B | third-party | Dense 30B; Removed from cloud 2026-06 |
| glm-4.6:cloud | $0.0533 | $0.0533 | ~32B (est.) | third-party | Removed from cloud 2026-06 |
| minimax-m2:cloud | $0.0167 | $0.0167 | 10B | third-party | Removed from cloud 2026-06 |
| devstral-2:123b-cloud | $0.2050 | $0.2050 | 123B | third-party | Dense 123B; Removed from cloud 2026-06 |
| devstral-small-2:24b-cloud | $0.0400 | $0.0400 | 24B | third-party | Dense 24B; Removed from cloud 2026-06 |
| mistral-large-3:675b-cloud | $0.0683 | $0.0683 | 41B | third-party | 675B MoE; Removed from cloud 2026-06 |
| ministral-3:14b-cloud | $0.0233 | $0.0233 | 14B | third-party | Dense 14B; Removed from cloud 2026-06 |
| ministral-3:8b-cloud | $0.0133 | $0.0133 | 8B | third-party | Removed from cloud 2026-06 |
| ministral-3:3b-cloud | $0.0050 | $0.0050 | 3B | third-party | Removed from cloud 2026-06 |

---

## Ollama Local Models

| Model ID | Input | Output | Cache Read | Cache Write | Confidence | Notes |
|---|---|---|---|---|---|---|
| mistral-7b-pi:latest | $0.00 | $0.00 | $0.00 | $0.00 | official | Runs locally; no API cost |
| llama3.2-3b-pi:latest | $0.00 | $0.00 | $0.00 | $0.00 | official | Runs locally; no API cost |
| gemma4-e2b-pi:latest | $0.00 | $0.00 | $0.00 | $0.00 | official | Runs locally; no API cost |

---

## Normalization Baseline

For the normalized cost calculation (`estimateNormalizedCost()`), the baseline is:

- **Baseline model**: `claude-sonnet-4.6` (via Copilot)
- **Baseline pricing**: $3.00/M input, $15.00/M output
- **Blended baseline** (3:1 input:output ratio): `(3 * 3.00 + 1 * 15.00) / 4 = $6.00 / 1M`
- **Normalized baseline**: $6.00/1M maps to `cost ≈ 10` on the legacy selector scale
- **Formula**: `normalizedCost = 10 * sqrt(blendedUsdPer1M / 6.00)`
- **Legacy `cost=10` maps to**: ~$6.00/1M blended (sonnet-4.6 tier)

This baseline was chosen because:
1. Sonnet 4.6 already has `cost: 10` in model-profiles.yaml as the established baseline
2. $3/$15 per 1M is officially published by GitHub Copilot
3. The 3:1 token ratio is representative of agentic coding workloads

---

## Gap Analysis

Models in `model-profiles.yaml` without pricing in this evidence document:

| Model ID | Reason |
|---|---|
| grok-code-fast-1 | No official token pricing published by GitHub Copilot. Only multiplier-based pricing exists in the old premium-request model. Use legacy `cost: 13` in model-profiles.yaml until token pricing is published. |

Models with `unknown` confidence for pricing:
- `gemini-3-flash-preview:cloud` — closed-source model on Ollama Cloud with undisclosed parameters. Range estimate only ($0.02-$0.08). No single defensible price to store.

---

## Source URLs

1. **GitHub Copilot models and pricing**: https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing
2. **GitHub Copilot model multipliers (annual plans)**: https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
3. **Ollama Cloud documentation**: https://ollama.com/ (pricing measured by GPU time)
4. Internal historical: `docs/internal/copilot-model-pricing.md` (last updated 2026-05-16)
5. Internal historical: `docs/internal/ollama-pro-cloud-models-ranked.md` (compute estimate methodology)

---

## Changelog

| Date | Change |
|---|---|
| 2026-06-01 | Initial evidence ledger created. Copilot pricing sourced from official docs (via internal copilot-model-pricing.md). Ollama Cloud pricing from compute estimates (via ollama-pro-cloud-models-ranked.md). |
| 2026-06-15 | Synced Ollama Cloud model list: added glm-5, kimi-k2.7-code, minimax-m2.1, minimax-m2.5; removed 21 models no longer on cloud page |
| 2026-06-17 | Added `glm-5.2:cloud` with compute-estimate pricing (active params estimated 40B pending official spec) |
