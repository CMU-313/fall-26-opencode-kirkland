import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { SessionBudget } from "@/session/budget"

// Fixed seed for reproducible mutation testing results
fc.configureGlobal({ seed: 42 })

// Generators
const tokenLimit = fc.constantFrom(0, 1, 1_000, 500_000, 1_000_000)
const costLimit = fc.constantFrom(0, 0.01, 1, 5, 12.5)

// Positions: just under warning, exactly on 80%, just under ceiling, exactly on ceiling, well past.
// These boundary values are critical for testing that warnings fire at exactly 80%.
const position = fc.constantFrom(0, 0.5, 0.79, 0.8, 0.95, 1, 1.05, 3)

const approvals = fc.integer({ min: 0, max: 4 })

const action = fc.constantFrom("stop" as const, "ask" as const, undefined)

// Budget with cost, tokens, both, or neither
const budget = fc.record({
  cost: fc.option(costLimit, { nil: undefined }),
  tokens: fc.option(tokenLimit, { nil: undefined }),
  action,
  grant: fc.option(
    fc.record({
      cost: fc.option(costLimit, { nil: undefined }),
      tokens: fc.option(tokenLimit, { nil: undefined }),
    }),
    { nil: undefined },
  ),
})

// Usage positioned at a fraction of each configured limit's live ceiling
function usageAt(config: SessionBudget.Budget, approved: number, costAt: number, tokensAt: number) {
  return {
    cost: config.cost === undefined ? 0 : SessionBudget.ceiling(config.cost, approved, config.grant?.cost) * costAt,
    tokens:
      config.tokens === undefined
        ? 0
        : Math.round(SessionBudget.ceiling(config.tokens, approved, config.grant?.tokens) * tokensAt),
  }
}

describe("session budget properties", () => {
  // R5: "A session is never stopped by a limit without first showing the 80%
  // warning for that same limit."
  // This strengthened property rebuilds the oracle independently to state the
  // rule over the whole range: a warning is due exactly when the most pressured
  // limit has a ratio at or above 0.8, and it names that limit. This catches
  // boundary mutations (<=/<), ranking bugs in the sort, zero-ceiling guards,
  // and the `find` predicate, all of which the weaker property misses.
  // Kind: model / oracle
  test("R5: a stop always comes with the warning for the same limit", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, (config, approved, costAt, tokensAt) => {
        const usage = usageAt(config, approved, costAt, tokensAt)

        // Build the oracle independently: list each configured limit with its live ceiling.
        const live = [
          config.cost === undefined
            ? undefined
            : {
                limit: "cost" as const,
                max: SessionBudget.ceiling(config.cost, approved, config.grant?.cost),
                used: usage.cost,
              },
          config.tokens === undefined
            ? undefined
            : {
                limit: "tokens" as const,
                max: SessionBudget.ceiling(config.tokens, approved, config.grant?.tokens),
                used: usage.tokens,
              },
        ].filter((candidate) => candidate !== undefined)

        // No budget means no stop and no warning.
        if (live.length === 0) {
          const hit = SessionBudget.check({ budget: config, usage, approvals: approved })
          const warn = SessionBudget.warning({ budget: config, usage, approvals: approved })
          expect(hit).toBeUndefined()
          expect(warn).toBeUndefined()
          return
        }

        // Compute the ratio for each limit; zero ceiling is maximum pressure (Infinity).
        const ratio = (candidate: (typeof live)[number]) =>
          candidate.max > 0 ? candidate.used / candidate.max : Infinity

        // Find the limit under most pressure; ties are resolved by order (cost first).
        const worst = live.reduce((best, candidate) => (ratio(candidate) > ratio(best) ? candidate : best))

        // R5: Whenever check reports a stop, warning must be due for the same limit.
        const hit = SessionBudget.check({ budget: config, usage, approvals: approved })
        const warn = SessionBudget.warning({ budget: config, usage, approvals: approved })

        if (hit !== undefined) {
          // A stop occurred. The warning must be due (not just exist, but be due).
          expect(warn).toBeDefined()
          // The warning must name the same limit that stopped.
          expect(warn!.limit).toBe(hit.limit)
          // The warning must report the same ceiling.
          expect(warn!.max).toBe(hit.max)
        }

        // Additionally: a warning is due exactly when the most pressured limit
        // is at or above 80%, and it names that limit.
        expect(warn !== undefined).toBe(ratio(worst) >= 0.8)
        if (warn) {
          expect(warn.limit).toBe(worst.limit)
          expect(warn.max).toBe(worst.max)
        }
      }),
      { numRuns: 500 },
    )
  })
})
