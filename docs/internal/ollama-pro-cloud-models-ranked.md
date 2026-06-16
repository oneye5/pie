# Ollama Pro Cloud Models — Ranked by Parameter Size (Largest to Smallest)

> Sorted by total parameters. Source: `models.json` (pi-config).

> **Pricing update (2026-06-04):** All per-token costs below are now sourced from the [Portkey-AI/models](https://github.com/Portkey-AI/models) open-source pricing database ([`configs.portkey.ai`](https://configs.portkey.ai/pricing)), converted to USD per 1M tokens. Cache prices are included where available from original provider files. The previous OpenRouter and H100 @ $3/hr methodologies are preserved at the bottom of this document for historical reference only.

## Full Model List (22 models)

| Rank | Model ID | Display Name | Total Params | Active Params | Cost (USD / 1M tokens) — Portkey |
|------|----------|--------------|-------------:|-------------:|----------------------------------------:|
| 1 | deepseek-v4-pro:cloud | DeepSeek V4 Pro | 1.6T | 49B | $0.4350 in / $0.8700 out (cacheR $0.0036) |
| 2 | kimi-k2.6:cloud | Kimi K2.6 | 1.04T | 32B | $0.7500 in / $3.5000 out |
| 3 | kimi-k2.7-code:cloud | Kimi K2.7 Code | ~1T | 32B | $0.5700 in / $2.3000 out |
| 4 | kimi-k2.5:cloud | Kimi K2.5 | ~1T | 32B (est.) | $0.4400 in / $2.0000 out |
| 5 | glm-5.1:cloud | GLM 5.1 | 754B | 40B | $1.4000 in / $4.4000 out (cacheR $0.2600) |
| 6 | glm-5:cloud | GLM 5 | 744B | 40B | $1.0000 in / $3.2000 out (cacheR $0.2000) |
| 7 | nemotron-3-ultra:cloud | Nemotron 3 Ultra | 550B | 55B | $0.5000 in / $2.5000 out (cacheR $0.1500) |
| 8 | qwen3-coder:480b-cloud | Qwen3 Coder 480B | 480B | 35B | $0.2200 in / $1.8000 out |
| 9 | minimax-m3:cloud | MiniMax M3 | 428B | 22B | $0.6000 in / $2.4000 out (cacheR $0.1200) |
| 10 | qwen3.5:397b-cloud | Qwen 3.5 397B (A17B variant) | 397B | 17B | $0.3900 in / $2.3400 out |
| 11 | glm-4.7:cloud | GLM 4.7 | 355B | 32B | $0.6000 in / $2.2000 out (cacheR $0.1100) |
| 12 | deepseek-v4-flash:cloud | DeepSeek V4 Flash | 284B | 13B | $0.1400 in / $0.2800 out (cacheR $0.0028) |
| 13 | minimax-m2.7:cloud | MiniMax M2.7 | 230B | 10B | $0.3000 in / $1.2000 out |
| 14 | minimax-m2.5:cloud | MiniMax M2.5 | 230B | 10B | $0.1500 in / $1.1500 out |
| 15 | minimax-m2.1:cloud | MiniMax M2.1 | 230B | 10B | $0.2900 in / $0.9500 out |
| 16 | nemotron-3-super:cloud | Nemotron 3 Super | 120B | 12B | $0.0900 in / $0.4500 out |
| 17 | gpt-oss:120b-cloud | GPT OSS 120B | 120B | 120B | $0.0390 in / $0.1800 out |
| 18 | qwen3-coder-next:cloud | Qwen3 Coder Next | 80B | 3B | $0.1100 in / $0.8000 out |
| 19 | gemma4:31b-cloud | Gemma 4 31B | 31B | 31B | $0.1300 in / $0.3800 out |
| 20 | gpt-oss:20b-cloud | GPT OSS 20B | 20B | 20B | $0.0300 in / $0.1400 out |
| 21 | qwen3.5:cloud | Qwen 3.5 (default variants) | 397B | 35B / 27B / 9B / 4B / 2B / 0.8B | $0.2600 in / $1.5600 out |
| 22 | gemini-3-flash-preview:cloud | Gemini 3 Flash Preview | undisclosed | — | $0.5000 in / $3.0000 out (cacheW $0.5000, cacheR $0.0500) |

**Key observation:** Portkey pricing is often asymmetric (input ≠ output) and differs significantly from the old compute estimates. Models with cache support (DeepSeek V4, Gemini 3 Flash, GLM, Nemotron 3 Ultra, MiniMax M3) now show cache read/write costs where available. These are real billed rates from the upstream providers, not lower-bound compute projections.

---

## Parameter Tiers

| Tier | Range | Count | Models |
|------|-------|------:|---------|
| Frontier | >600B | 6 | DeepSeek-V4-Pro, Kimi K2.6/K2.7-Code/K2.5, GLM-5.1/5 |
| Large | 200–600B | 10 | Nemotron-3-Ultra, Qwen3-Coder-480B, MiniMax-M3, Qwen-3.5-397B, GLM-4.7, DeepSeek-V4-Flash, MiniMax-M2.7/M2.5/M2.1, Qwen-3.5 (default) |
| Medium | 80–200B | 3 | Nemotron-3-Super, GPT-OSS-120B, Qwen3-Coder-Next |
| Compact | <40B | 2 | Gemma-4-31B, GPT-OSS-20B |
| Undisclosed | — | 1 | Gemini-3-Flash-Preview |

## Reasoning Models

These models support explicit reasoning/thinking modes:

- deepseek-v4-flash:cloud
- deepseek-v4-pro:cloud
- gemini-3-flash-preview:cloud
- gemma4:31b-cloud
- glm-4.7:cloud
- glm-5:cloud
- glm-5.1:cloud
- gpt-oss:120b-cloud
- gpt-oss:20b-cloud
- kimi-k2.5:cloud
- kimi-k2.6:cloud
- kimi-k2.7-code:cloud
- minimax-m2.5:cloud
- minimax-m2.7:cloud
- minimax-m3:cloud
- nemotron-3-super:cloud
- nemotron-3-ultra:cloud
- qwen3-coder:480b-cloud
- qwen3.5:397b-cloud
- qwen3.5:cloud

> **Note:** minimax-m2.1:cloud and qwen3-coder-next:cloud do **not** support thinking/reasoning mode.

## Multimodal Models (Vision)

Models that accept image input:

- gemini-3-flash-preview:cloud
- gemma4:31b-cloud
- kimi-k2.5:cloud
- kimi-k2.6:cloud
- kimi-k2.7-code:cloud
- minimax-m3:cloud
- qwen3.5:397b-cloud
- qwen3.5:cloud

---

## Historical: Compute Estimate Methodology *(superseded)*

The following methodology was used prior to 2026-06-04 when OpenRouter pricing was adopted, and later superseded by Portkey-AI/models in 2026-06-04. It is kept for reference and for any models not yet listed on OpenRouter (e.g., `devstral-small-2:24b-cloud`).

- Ollama Cloud measures usage primarily by GPU time (their docs). We convert model compute to an estimated GPU time and then to USD. These are compute-only estimates (no platform markup, networking, or request overhead).
- FLOPs per token (approx): 2 × active_parameters (this is a common inference approximation for decoder transformers; for MoE use activated params per token). Example: a 10B active model ≈ 20 GFLOPs / token.
- Baseline GPU and effective throughput (assumption): NVIDIA H100 (FP8 peak ≈ 3.958e15 FLOPS). Assume a conservative model FLOPS utilization (MFU) so effective sustained FLOPS ≈ 1.0e15 FLOPS (≈25% of peak). This is the dominant uncertainty.
- Baseline GPU price: $3.00 per GPU‑hour (market median / example). => $0.0008333333 per GPU‑second.
- Cost formula (used to produce the table):
  cost_per_1M_tokens = (1e6 tokens × 2 × active_params) / effective_FLOPS × (GPU_price_per_hour / 3600)
  With the baseline numbers above this simplifies to approximately:
  cost_per_1M_tokens (USD) ≈ active_params_in_billions / 600
- Rescaling notes:
  - To change the GPU price: multiply all costs by (new_GPU_hour_price / $3.00).
  - To change the effective FLOPS: multiply all costs by (1e15 / new_effective_FLOPS).
  - To move from a slower GPU, reduce effective_FLOPS accordingly (cost ∝ 1 / effective_FLOPS).

**Caveats:**
- These are lower‑bound, model‑compute-only estimates. Ollama Cloud may add platform margin, minimums, model‑load costs, caching effects, and billing rounding that increase the real billed amount.
- MoE models have extra routing/overhead and often benefit from batching; the "2 × active_params" rule is a simplification but gives a consistent relative comparison across models.
- Several table entries use estimated/rounded active‑param values where vendor docs are ambiguous; rows with "(est.)" are marked.

**Key sources used:** Ollama pricing/docs (usage measured by GPU time); model cards / Hugging Face pages and publisher docs for DeepSeek, Kimi, Qwen/Qwen3.5, NVIDIA Nemotron, GLM, MiniMax, Gemma families and other vendors (used to determine MoE vs dense and active‑param counts).