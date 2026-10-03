# Auto model: cost and quality

1 prompts finished in both arms. Baseline = Auto off, pinned to the complex-tier model. Costs are simulated: free-model tokens priced at the paid counterpart's rates.

## Summary

| Group | Prompts | Baseline cost | Auto cost | Savings | Baseline pass | Auto pass |
|---|---:|---:|---:|---:|---:|---:|
| simple | 1 | $0.0159 | $0.0063 | 60.6% | 1/1 | 1/1 |
| **all** | 1 | $0.0159 | $0.0063 | 60.6% | 1/1 | 1/1 |

## Per prompt

| Prompt | Expected | Routed tiers | Auto models | Baseline | Auto | Savings | Tokens (base → auto) | Pass (base / auto) |
|---|---|---|---|---:|---:|---:|---:|---|
| s3-value-swap | simple | simple | poolside/laguna-xs-2.1:free | $0.0159 | $0.0063 | 60.6% | 41378 → 127327 | ✅ / ✅ |

## Quality differences

**Auto failed where baseline passed:** none

**Auto passed where baseline failed:** none

Diffs for side-by-side review are in `results/diffs/<prompt>.<arm>.diff`.
