# GitHub Copilot Model Pricing Reference

> **Note (2026-06-01):** Token pricing from this document has been ingested into `models.json`
> as the authoritative pricing source. See `docs/internal/model-token-pricing-sources.md` for
> the full evidence ledger. The legacy `cost` field in `model-profiles.yaml` derived from
> premium-request multipliers is now a fallback only.

Last updated: 2026-05-16

## Cost Mapping

The `cost` field in `model-profiles.yaml` for Copilot models is derived from
GitHub Copilot's **premium request multiplier** system. The mapping is:

| Multiplier | Cost | Meaning |
|---|---|---|
| 0x | 0 | Included / free (no premium requests consumed) |
| 0.33x | 3 | Low-cost (1 premium request per 3 prompts) |
| 1x | 10 | Baseline (1 premium request per prompt) |
| 3x | 18 | Expensive (3 premium requests per prompt) |
| 7.5x | 25 | Very expensive (7.5 premium requests per prompt) |
| 15x | 30 | Extremely expensive (15 premium requests per prompt) |

The scale (0–30+) is documented in `model-profiles.yaml` as a relative ranking
heuristic, not a dollar amount. The subagent selector penalizes fitness by
`0.5 × cost`, so higher-cost models are chosen less aggressively.

## Copilot Model ↔ Multiplier ↔ Cost

### Current multipliers (effective until June 1, 2026)

These are the **premium request multipliers** currently in effect for all
Copilot plans.

| Model | Current Multiplier | Cost |
|---|---|---|
| GPT-4o | 0x | 0 |
| GPT-4.1 | 0x | 0 |
| GPT-5 mini | 0x | 0 |
| Raptor mini (fine-tuned) | 0x | — |
| Claude Haiku 4.5 | 0.33x | 3 |
| GPT-5.1-Codex-Mini | 0.33x | 3 |
| GPT-5.4 mini | 0.33x | 3 |
| Gemini 3 Flash | 0.33x | 3 |
| Claude Sonnet 4 | 1x¹ | 10 |
| Claude Sonnet 4.5 | 1x | 10 |
| Claude Sonnet 4.6 | 1x | 10 |
| GPT-5.1 | 1x | 10 |
| GPT-5.1-Codex | 1x | 10 |
| GPT-5.1-Codex-Max | 1x | 10 |
| GPT-5.2 | 1x | 10 |
| GPT-5.2-Codex | 1x | 10 |
| GPT-5.3-Codex | 1x | 10 |
| GPT-5.4 | 1x | 10 |
| Gemini 2.5 Pro | 1x | 10 |
| Gemini 3 Pro | 1x | 10 |
| Gemini 3.1 Pro | 1x | 10 |
| Claude Opus 4.5 | 3x | 18 |
| Claude Opus 4.6 | 3x | 18 |
| GPT-5.5 | 7.5x² | 25 |
| Claude Opus 4.7 | 15x | 30 |

¹ Claude Sonnet 4 is not explicitly in the multiplier table; assigned 1x based
on its token pricing matching Sonnet 4.5/4.6.

² GPT-5.5 multiplier is listed as "7.5x (promotional)" and may change.

### New multipliers (June 1, 2026, annual plans only)

Starting June 1, 2026, Copilot is shifting from request-based billing to
**usage-based billing** (token pricing). The new multipliers below only apply
to Copilot Pro/Pro+ subscribers who remain on existing **annual plans** under
the premium request model. Monthly and new subscribers will use token pricing.

| Model | Current → New Multiplier |
|---|---|
| Claude Haiku 4.5 | 0.33x → 0.33x |
| Claude Opus 4.5 | 3x → 15x |
| Claude Opus 4.6 | 3x → 27x |
| Claude Opus 4.7 | 15x → 27x |
| Claude Sonnet 4.5 | 1x → 6x |
| Claude Sonnet 4.6 | 1x → 9x |
| Gemini 2.5 Pro | 1x → 1x |
| Gemini 3 Flash | 0.33x → 0.33x |
| Gemini 3 Pro | 1x → 6x |
| Gemini 3.1 Pro | 1x → 6x |
| GPT-4o | 0x → 0.33x |
| GPT-4o mini | 0x → 0.33x |
| GPT-4.1 | 0x → 1x |
| GPT-5 mini | 0x → 0.33x |
| GPT-5.1 | 1x → 3x |
| GPT-5.1-Codex | 1x → 3x |
| GPT-5.1-Codex-Mini | 0.33x → 0.33x |
| GPT-5.1-Codex-Max | 1x → 3x |
| GPT-5.2 | 1x → 3x |
| GPT-5.2-Codex | 1x → 3x |
| GPT-5.3-Codex | 1x → 6x |
| GPT-5.4 | 1x → 6x |
| GPT-5.4 mini | 0.33x → 6x |
| GPT-5.5 | 7.5x → TBD |
| Raptor mini | 0x → 0.33x |

**Action needed (June 2026):** After the billing transition, revisit `cost`
values. Under token-based billing, costs should be recomputed from per-token
pricing (see below) rather than flat multipliers.

## Token-Based Pricing (effective June 1, 2026)

All prices per 1M tokens. 1 AI credit = $0.01 USD.

### OpenAI

| Model | Input | Cached Input | Output |
|---|---|---|---|
| GPT-4.1 | $2.00 | $0.50 | $8.00 |
| GPT-5 mini | $0.25 | $0.025 | $2.00 |
| GPT-5.2 | $1.75 | $0.175 | $14.00 |
| GPT-5.2-Codex | $1.75 | $0.175 | $14.00 |
| GPT-5.3-Codex | $1.75 | $0.175 | $14.00 |
| GPT-5.4 | $2.50 | $0.25 | $15.00 |
| GPT-5.4 mini | $0.75 | $0.075 | $4.50 |
| GPT-5.4 nano | $0.20 | $0.02 | $1.25 |
| GPT-5.5 | $5.00 | $0.50 | $30.00 |

### Anthropic

| Model | Input | Cached Input | Cache Write | Output |
|---|---|---|---|---|
| Claude Haiku 4.5 | $1.00 | $0.10 | $1.25 | $5.00 |
| Claude Sonnet 4 | $3.00 | $0.30 | $3.75 | $15.00 |
| Claude Sonnet 4.5 | $3.00 | $0.30 | $3.75 | $15.00 |
| Claude Sonnet 4.6 | $3.00 | $0.30 | $3.75 | $15.00 |
| Claude Opus 4.5 | $5.00 | $0.50 | $6.25 | $25.00 |
| Claude Opus 4.6 | $5.00 | $0.50 | $6.25 | $25.00 |
| Claude Opus 4.7 | $5.00 | $0.50 | $6.25 | $25.00 |

### Google

| Model | Input | Cached Input | Output |
|---|---|---|---|
| Gemini 2.5 Pro | $1.25 | $0.125 | $10.00 |
| Gemini 3 Flash | $0.50 | $0.05 | $3.00 |
| Gemini 3.1 Pro | $2.00 | $0.20 | $12.00 |

### Fine-tuned (GitHub)

| Model | Input | Cached Input | Output |
|---|---|---|---|
| Raptor mini | $0.25 | $0.025 | $2.00 |
| Goldeneye | $1.25 | $0.125 | $10.00 |

## Models Without Copilot Multipliers

These models in `model-profiles.yaml` have no official Copilot premium request
multiplier. Their cost values are manually set based on estimated relative
expense:

| Model | Cost | Basis |
|---|---|---|
| grok-code-fast-1 | 13 | Manual estimate (no Copilot multiplier) |

## Sources

- [Models and pricing for GitHub Copilot](https://docs.github.com/copilot/reference/copilot-billing/models-and-pricing)
- [Model multipliers for annual plans staying on request-based billing](https://docs.github.com/en/copilot/reference/copilot-billing/model-multipliers-for-annual-plans)
- [Requests in GitHub Copilot](https://docs.github.com/copilot/concepts/copilot-billing/understanding-and-managing-requests-in-copilot)