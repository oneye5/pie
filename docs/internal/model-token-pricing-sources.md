# Model Token Pricing Evidence Ledger

**Purpose:** Authoritative traceability record for every price written to `models.json`.
Every non-zero cost field in `models.json` MUST have a corresponding row in this document.

**Retrieval date:** 2026-06-04
**Format:** All prices in USD per 1M tokens unless otherwise noted.

---

## Methodology

For each model in `model-profiles.yaml`:
- **GitHub Copilot models**: Token pricing sourced from official GitHub Copilot billing documentation. 1 AI credit = $0.01 USD.
- **Ollama Cloud models**: Token pricing sourced from the [Portkey-AI/models](https://github.com/Portkey-AI/models) open-source pricing database (`https://configs.portkey.ai/pricing`). Portkey tracks pricing for 2,000+ models across 40+ providers; values are converted from cents-per-token to USD per 1M tokens. Cache prices are pulled from original provider files where available (DeepSeek, Google, z-ai). These are actual billed rates, not compute estimates.
- **Ollama Local models**: Free/local (no API cost).
- **Grok models**: No official token pricing found; marked as unknown.

### Confidence levels

| Tag | Meaning |
|---|---|
| `official` | Published on provider's official pricing page |
| `official-inferred` | Derived from official data with documented formula |
| `third-party` | From independent analysis or compute estimates |
| `portkey` | Sourced from Portkey-AI/models pricing JSON — live provider pricing aggregated from 40+ providers |
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

**Source:** [Portkey-AI/models](https://github.com/Portkey-AI/models) — open-source pricing database for 2,000+ models across 40+ providers.
**Retrieval date:** 2026-06-04
**Confidence:** `portkey`

Cache pricing (`cache_read_input_token` / `cache_write_input_token`) is available from Portkey original provider files for some models (DeepSeek, Google, z-ai). Where absent, the upstream provider either does not publish cache rates or the provider file is not accessible via Portkey's public API. All prices are in USD per 1M tokens.

| Model ID | Input | Output | Cache Read | Cache Write | Portkey Model ID | Notes |
|---|---|---|---|---|---|---|---|
| cogito-2.1:671b-cloud | $1.2500 | $1.2500 | — | — | `deepcogito/cogito-v2.1-671b` | No cache pricing in Portkey provider file |
| deepseek-v3.1:671b-cloud | $0.1500 | $0.7500 | — | — | `deepseek/deepseek-chat-v3.1` |  |
| deepseek-v3.2:cloud | $0.2520 | $0.3780 | — | — | `deepseek/deepseek-v3.2` | No cache pricing in Portkey provider file |
| deepseek-v4-flash:cloud | $0.1400 | $0.2800 | $0.0028 | — | `deepseek/deepseek-v4-flash` |  |
| deepseek-v4-pro:cloud | $0.4350 | $0.8700 | $0.0036 | — | `deepseek/deepseek-v4-pro` | Extremely cheap cache read |
| devstral-2:123b-cloud | $0.4000 | $2.0000 | — | — | `mistralai/devstral-2512` |  |
| devstral-small-2:24b-cloud | $0.1000 | $0.3000 | — | — | *not listed* | Portkey OpenRouter file has devstral-small. Updated from compute estimate. |
| gemini-3-flash-preview:cloud | $0.5000 | $3.0000 | $0.0500 | $0.5000 | `google/gemini-3-flash-preview` | Cache write priced |
| gemma3:12b-cloud | $0.0400 | $0.1300 | — | — | `google/gemma-3-12b-it` | No cache pricing in Portkey provider file |
| gemma3:27b-cloud | $0.0800 | $0.1600 | — | — | `google/gemma-3-27b-it` | No cache pricing in Portkey provider file |
| gemma3:4b-cloud | $0.0400 | $0.0800 | — | — | `google/gemma-3-4b-it` | No cache pricing in Portkey provider file |
| gemma4:31b-cloud | $0.1300 | $0.3800 | — | — | `google/gemma-4-31b-it` | No cache pricing in Portkey provider file |
| glm-4.6:cloud | $0.6000 | $2.2000 | $0.1100 | — | `z-ai/glm-4.6` |  |
| glm-4.7:cloud | $0.6000 | $2.2000 | $0.1100 | — | `z-ai/glm-4.7` |  |
| glm-5:cloud | $1.0000 | $3.2000 | $0.2000 | — | `z-ai/glm-5` |  |
| glm-5.1:cloud | $1.4000 | $4.4000 | $0.2600 | — | `z-ai/glm-5.1` |  |
| gpt-oss:120b-cloud | $0.0390 | $0.1800 | — | — | `openai/gpt-oss-120b` | No cache pricing in Portkey provider file |
| gpt-oss:20b-cloud | $0.0300 | $0.1400 | — | — | `openai/gpt-oss-20b` | No cache pricing in Portkey provider file |
| kimi-k2-thinking:cloud | $0.6000 | $2.5000 | — | — | `moonshotai/kimi-k2-thinking` | No cache pricing in Portkey provider file |
| kimi-k2:1t-cloud | $0.5700 | $2.3000 | — | — | `moonshotai/kimi-k2` | No cache pricing in Portkey provider file |
| kimi-k2.5:cloud | $0.4400 | $2.0000 | — | — | `moonshotai/kimi-k2.5` |  |
| kimi-k2.6:cloud | $0.7500 | $3.5000 | — | — | `moonshotai/kimi-k2.6` |  |
| ministral-3:14b-cloud | $0.2000 | $0.2000 | — | — | `mistralai/ministral-14b-2512` |  |
| ministral-3:3b-cloud | $0.1000 | $0.1000 | — | — | `mistralai/ministral-3b-2512` |  |
| ministral-3:8b-cloud | $0.1500 | $0.1500 | — | — | `mistralai/ministral-8b-2512` |  |
| minimax-m2:cloud | $0.2550 | $1.0000 | — | — | `minimax/minimax-m2` |  |
| minimax-m2.1:cloud | $0.2900 | $0.9500 | — | — | `minimax/minimax-m2.1` |  |
| minimax-m2.5:cloud | $0.1500 | $1.1500 | — | — | `minimax/minimax-m2.5` | No cache pricing in Portkey provider file |
| minimax-m2.7:cloud | $0.3000 | $1.2000 | — | — | `minimax/minimax-m2.7` | No cache pricing in Portkey provider file |
| mistral-large-3:675b-cloud | $0.5000 | $1.5000 | — | — | `mistralai/mistral-large-2512` | Latest Mistral Large |
| nemotron-3-nano:30b-cloud | $0.0500 | $0.2000 | — | — | `nvidia/nemotron-3-nano-30b-a3b` | No cache pricing in Portkey provider file |
| nemotron-3-super:cloud | $0.0900 | $0.4500 | — | — | `nvidia/nemotron-3-super-120b-a12b` | No cache pricing in Portkey provider file |
| qwen3-coder-next:cloud | $0.1100 | $0.8000 | — | — | `qwen/qwen3-coder-next` |  |
| qwen3-coder:480b-cloud | $0.2200 | $1.8000 | — | — | `qwen/qwen3-coder` | No cache pricing in Portkey provider file |
| qwen3-next:80b-cloud | $0.0900 | $1.1000 | — | — | `qwen/qwen3-next-80b-a3b-instruct` | No cache pricing in Portkey provider file |
| qwen3-vl:235b-cloud | $0.2000 | $0.8800 | — | — | `qwen/qwen3-vl-235b-a22b-instruct` |  |
| qwen3-vl:235b-instruct-cloud | $0.2000 | $0.8800 | — | — | `qwen/qwen3-vl-235b-a22b-instruct` | Same as qwen3-vl:235b-cloud |
| qwen3.5:397b-cloud | $0.3900 | $2.3400 | — | — | `qwen/qwen3.5-397b-a17b` | No cache pricing in Portkey provider file |
| qwen3.5:cloud | $0.2600 | $1.5600 | — | — | `qwen/qwen3.5-plus-02-15` |  |
| rnj-1:8b-cloud | $0.1500 | $0.1500 | — | — | `essentialai/rnj-1-instruct` | No cache pricing in Portkey provider file |

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
| devstral-small-2:24b-cloud | Now mapped to `mistralai/devstral-small` in Portkey OpenRouter provider. Previous compute estimate ($0.04/$0.04) replaced. |

---

## Source URLs

1. **GitHub Copilot models and pricing**: https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing
2. **GitHub Copilot model multipliers (annual plans)**: https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans
3. **Portkey Models pricing JSON**: https://configs.portkey.ai/pricing (live pricing data for Ollama Cloud models)
3. **Portkey Models repo**: https://github.com/Portkey-AI/models
4. Internal historical: `docs/internal/copilot-model-pricing.md` (last updated 2026-05-16)
5. Internal historical: `docs/internal/ollama-pro-cloud-models-ranked.md` (compute estimate methodology — superseded by Portkey pricing)

---

## Changelog

| Date | Change |
|---|---|
| 2026-06-01 | Initial evidence ledger created. Copilot pricing sourced from official docs (via internal copilot-model-pricing.md). Ollama Cloud pricing from compute estimates (via ollama-pro-cloud-models-ranked.md). |
| 2026-06-04 | **Ollama Cloud pricing updated from Portkey-AI/models**. All cloud models now use Portkey's open-source pricing database. Original provider files used for cache info where accessible (DeepSeek, Google, z-ai). OpenRouter provider file used as fallback for models without direct provider access. Compute estimates retired for all listed models. |
| 2026-06-04 | **Cache pricing refreshed** from Portkey provider files. DeepSeek V4, Gemini 3 Flash, and GLM models now show cache read/write costs from upstream providers. Models without cache info in Portkey remain marked "—". |
