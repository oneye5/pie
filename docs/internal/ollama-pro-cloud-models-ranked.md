# Ollama Pro Cloud Models — Ranked by Parameter Size (Largest to Smallest)

> Sorted by total parameters. Source: `models.json` (pi-config).

## Full Model List (44 models)

| Rank | Model ID | Display Name | Total Params | Active Params | Cost (USD / 1M tokens) — H100 @ $3/hr |
|------|----------|--------------|-------------:|-------------:|----------------------------------------:|
| 1 | deepseek-v4-pro:cloud | DeepSeek V4 Pro | 1.6T | 49B | $0.0817 |
| 2 | kimi-k2.6:cloud | Kimi K2.6 | 1.04T | 32B | $0.0533 |
| 3 | glm-5.1:cloud | GLM 5.1 | 754B | 40B | $0.0667 |
| 4 | glm-5:cloud | GLM 5 | 744B | 40B | $0.0667 |
| 5 | deepseek-v3.2:cloud | DeepSeek V3.2 | 685B | 37B | $0.0617 |
| 6 | mistral-large-3:675b-cloud | Mistral Large 3 675B | 675B | 41B | $0.0683 |
| 7 | deepseek-v3.1:671b-cloud | DeepSeek V3.1 671B | 671B | 37B | $0.0617 |
| 8 | cogito-2.1:671b-cloud | Cogito 2.1 671B | 671B | 37B | $0.0617 |
| 9 | qwen3-coder:480b-cloud | Qwen3 Coder 480B | 480B | 35B | $0.0583 |
| 10 | qwen3.5:397b-cloud | Qwen 3.5 397B (A17B variant) | 397B | 17B | $0.0283 |
| 11 | glm-4.7:cloud | GLM 4.7 | 355B | 32B | $0.0533 |
| 12 | deepseek-v4-flash:cloud | DeepSeek V4 Flash | 284B | 13B | $0.0217 |
| 13 | qwen3-vl:235b-cloud | Qwen3 VL 235B | 235B | 22B | $0.0367 |
| 14 | qwen3-vl:235b-instruct-cloud | Qwen3 VL 235B Instruct | 235B | 22B | $0.0367 |
| 15 | minimax-m2.7:cloud | MiniMax M2.7 | 230B | 10B | $0.0167 |
| 16 | minimax-m2.5:cloud | MiniMax M2.5 | 230B | 10B | $0.0167 |
| 17 | minimax-m2.1:cloud | MiniMax M2.1 | 230B | 10B | $0.0167 |
| 18 | minimax-m2:cloud | MiniMax M2 | 230B | 10B | $0.0167 |
| 19 | devstral-2:123b-cloud | Devstral 2 123B | 123B | 123B | $0.2050 |
| 20 | nemotron-3-super:cloud | Nemotron 3 Super | 120B | 12B | $0.0200 |
| 21 | gpt-oss:120b-cloud | GPT OSS 120B | 120B | 120B | $0.2000 |
| 22 | qwen3-coder-next:cloud | Qwen3 Coder Next | 80B | 3B | $0.0050 |
| 23 | qwen3-next:80b-cloud | Qwen3 Next 80B | 80B | 3B | $0.0050 |
| 24 | kimi-k2:1t-cloud | Kimi K2 1T | ~1T | 32B (est.) | $0.0533 |
| 25 | devstral-small-2:24b-cloud | Devstral Small 2 24B | 24B | 24B | $0.0400 |
| 26 | gemma4:31b-cloud | Gemma 4 31B | 31B | 31B | $0.0517 |
| 27 | nemotron-3-nano:30b-cloud | Nemotron 3 Nano 30B | 30B | 30B | $0.0500 |
| 28 | gemma3:27b-cloud | Gemma 3 27B | 27B | 27B | $0.0450 |
| 29 | gpt-oss:20b-cloud | GPT OSS 20B | 20B | 20B | $0.0333 |
| 30 | ministral-3:14b-cloud | Ministral 3 14B | 14B | 14B | $0.0233 |
| 31 | glm-4.6:cloud | GLM 4.6 | ~340B | 32B (est.) | $0.0533 |
| 32 | qwen3.5:cloud | Qwen 3.5 (default variants) | 397B | 35B / 27B / 9B / 4B / 2B / 0.8B | $0.0583 / $0.0450 / $0.0150 / $0.0067 / $0.0033 / $0.0013 |
| 33 | kimi-k2.5:cloud | Kimi K2.5 | ~1T | 32B (est.) | $0.0533 |
| 34 | kimi-k2-thinking:cloud | Kimi K2 Thinking | ~1T | 32B (est.) | $0.0533 |
| 35 | ministral-3:8b-cloud | Ministral 3 8B | 8B | 8B | $0.0133 |
| 36 | gemma3:12b-cloud | Gemma 3 12B | 12B | 12B | $0.0200 |
| 37 | gemma3:4b-cloud | Gemma 3 4B | 4B | 4B | $0.0067 |
| 38 | rnj-1:8b-cloud | RNJ-1 8B | 8B | 8B | $0.0133 |
| 39 | ministral-3:3b-cloud | Ministral 3 3B | 3B | 3B | $0.0050 |
| 40 | gemini-3-flash-preview:cloud | Gemini 3 Flash Preview | undisclosed | — | N/A — closed-source (estimate range: $0.02–$0.08 / 1M tokens) |

**Numeric cost estimation methodology & assumptions (detailed):**
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
  - To move from H100 to a slower GPU, reduce effective_FLOPS accordingly (cost ∝ 1 / effective_FLOPS).

**Caveats:**
- These are lower‑bound, model‑compute-only estimates. Ollama Cloud may add platform margin, minimums, model‑load costs, caching effects, and billing rounding that increase the real billed amount.
- MoE models have extra routing/overhead and often benefit from batching; the "2 × active_params" rule is a simplification but gives a consistent relative comparison across models.
- Several table entries use estimated/rounded active‑param values where vendor docs are ambiguous; rows with "(est.)" are marked.

**Key sources used:** Ollama pricing/docs (usage measured by GPU time); model cards / Hugging Face pages and publisher docs for DeepSeek, Kimi, Qwen/Qwen3.5, Mistral, Cogito, GLM, Devstral, Gemma families and other vendors (used to determine MoE vs dense and active‑param counts).

## Parameter Tiers

| Tier | Range | Count | Models |
|------|-------|------:|---------|
| Frontier | >600B | 9 | DeepSeek-V4-Pro, Kimi K2.6/K2.5/K2-1T/K2-Thinking, GLM-5.1/5, DeepSeek-V3.2/V3.1, Mistral Large 3, Cogito |
| Large | 200-480B | 10 | Qwen3-Coder-480B, Qwen3.5-397B, GLM-4.7/4.6, DeepSeek-V4-Flash, Qwen3-VL-235B, MiniMax M2 series |
| Medium | 80-123B | 6 | Devstral-2, Nemotron-3-Super, GPT-OSS-120B, Qwen3-Coder-Next, Qwen3-Next-80B |
| Compact | <40B | 14 | Devstral-Small-2, Gemma4, Nemotron-3-Nano, Gemma3, GPT-OSS-20B, Ministral-3, RNJ-1 |

## Reasoning Models

These models support explicit reasoning/thinking modes:

- cogito-2.1:671b-cloud
- deepseek-v3.1:671b-cloud
- deepseek-v3.2:cloud
- deepseek-v4-flash:cloud
- deepseek-v4-pro:cloud
- gemini-3-flash-preview:cloud
- gemma4:31b-cloud
- glm-4.6:cloud
- glm-4.7:cloud
- glm-5:cloud
- glm-5.1:cloud
- gpt-oss:120b-cloud
- gpt-oss:20b-cloud
- kimi-k2.5:cloud
- kimi-k2.6:cloud
- kimi-k2-thinking:cloud
- minimax-m2.5:cloud
- minimax-m2.7:cloud
- nemotron-3-nano:30b-cloud
- nemotron-3-super:cloud
- qwen3-next:80b-cloud
- qwen3.5:397b-cloud
- qwen3.5:cloud

## Multimodal Models (Vision)

Models that accept image input:

- devstral-small-2:24b-cloud
- gemini-3-flash-preview:cloud
- gemma3:12b-cloud
- gemma3:27b-cloud
- gemma3:4b-cloud
- gemma4:31b-cloud
- glm-5:cloud
- glm-5.1:cloud
- kimi-k2.5:cloud
- kimi-k2.6:cloud
- ministral-3:14b-cloud
- ministral-3:3b-cloud
- ministral-3:8b-cloud
- mistral-large-3:675b-cloud
- qwen3-vl:235b-cloud
- qwen3-vl:235b-instruct-cloud
- qwen3.5:397b-cloud
- qwen3.5:cloud