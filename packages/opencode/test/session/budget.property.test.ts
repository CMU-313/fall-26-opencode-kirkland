import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { Schema } from "effect"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionBudget } from "@/session/budget"

// Generators
//
// The budget rules only change behaviour at two points: 80% of a ceiling, and
// the ceiling itself. Uniformly random numbers essentially never land on either,
// so limits are drawn from the round numbers users actually type, plus 0, and
// usage is positioned as a fraction of the resulting ceiling rather than drawn
// independently. That is what reaches "exactly at it, like 500,000 out of
// 500,000", the case C-4, S-4 and O-4 all raised.
const tokenLimit = fc.constantFrom(0, 1, 1_000, 500_000, 1_000_000)
const costLimit = fc.constantFrom(0, 0.01, 1, 5, 12.5)

// Just under the warning, exactly on it, just under the ceiling, exactly on it,
// and well past it, which is the turn that overshoots in one request.
const position = fc.constantFrom(0, 0.5, 0.79, 0.8, 0.95, 1, 1.05, 3)

const approvals = fc.integer({ min: 0, max: 4 })

const action = fc.constantFrom("stop" as const, "ask" as const, undefined)

// Cost only, tokens only, both, or neither. Only a budget with both limits set
// can reach the case where the warning and the stop disagree about the limit.
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

// Powers of two, so multiplying a limit or a usage by one is exact in binary
// floating point and the scaled session has bit-for-bit the same ratios.
const factor = fc.constantFrom(1, 2, 4, 8, 1024)

// Usage sitting at the given fraction of each configured limit's live ceiling.
function usageAt(config: SessionBudget.Budget, approved: number, costAt: number, tokensAt: number) {
  return {
    cost: config.cost === undefined ? 0 : SessionBudget.ceiling(config.cost, approved, config.grant?.cost) * costAt,
    tokens:
      config.tokens === undefined
        ? 0
        : Math.round(SessionBudget.ceiling(config.tokens, approved, config.grant?.tokens) * tokensAt),
  }
}

const named = (hit: SessionBudget.Exceeded | undefined) => hit?.limit

describe("session budget properties", () => {
  // R1: "Once usage has reached the budget, no new model request is sent. A
  // request already in progress may finish, and the stop is reported right
  // after it." `check` is the gate the agent loop consults before each request,
  // so the property is that it blocks exactly at and past the ceiling, and never
  // before. The approval ladder that produces the ceiling is R2's property.
  // Kind: invariant
  test("R1: a request is blocked exactly when usage has reached a ceiling", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, (config, approved, costAt, tokensAt) => {
        const usage = usageAt(config, approved, costAt, tokensAt)
        const reached =
          (config.cost !== undefined &&
            usage.cost >= SessionBudget.ceiling(config.cost, approved, config.grant?.cost)) ||
          (config.tokens !== undefined &&
            usage.tokens >= SessionBudget.ceiling(config.tokens, approved, config.grant?.tokens))

        const hit = SessionBudget.check({ budget: config, usage, approvals: approved })
        expect(hit !== undefined).toBe(reached)
        // Whatever it names is a limit that really is at or past its ceiling.
        if (hit) expect(hit.used).toBeGreaterThanOrEqual(hit.max)
      }),
      { numRuns: 500 },
    )
  })

  // R2: "When the user approves continuing past the budget, they choose how much
  // extra budget the approval grants, and opencode asks again only after that
  // extra amount is used."
  // Kind: model / oracle. The closed-form ceiling is compared against an
  // obviously-correct version that adds the granted amount once per approval.
  test("R2: the approval ladder matches adding the grant one approval at a time", () => {
    fc.assert(
      fc.property(tokenLimit, tokenLimit, approvals, (limit, grant, approved) => {
        const slow = Array.from({ length: approved }).reduce<number>((total) => total + grant, limit)
        expect(SessionBudget.ceiling(limit, approved, grant)).toBe(slow)
        // With no grant configured the slice is the limit itself.
        expect(SessionBudget.ceiling(limit, approved)).toBe(
          Array.from({ length: approved }).reduce<number>((total) => total + limit, limit),
        )
      }),
      { numRuns: 500 },
    )
  })

  // R2, second half: approving asks again only once the granted amount is used.
  // Kind: metamorphic. Adding one approval moves the stop by exactly the grant.
  test("R2: approving moves the next stop by exactly the granted amount", () => {
    fc.assert(
      fc.property(tokenLimit, tokenLimit, approvals, (limit, grant, approved) => {
        const config = { tokens: limit, action: "ask" as const, grant: { tokens: grant } }
        const ceiling = SessionBudget.ceiling(limit, approved, grant)
        expect(
          SessionBudget.check({ budget: config, usage: { cost: 0, tokens: ceiling }, approvals: approved }),
        ).toBeDefined()
        // Token limits are integers, so one token below the ceiling is still under it.
        if (ceiling > 0) {
          expect(
            SessionBudget.check({ budget: config, usage: { cost: 0, tokens: ceiling - 1 }, approvals: approved }),
          ).toBeUndefined()
        }
      }),
      { numRuns: 500 },
    )
  })

  // R3: "Changing the budget and then changing it back re-arms the 80% warning,
  // so it shows again (once) when usage is at or above 80% of the restored
  // budget."
  // Kind: round-trip. The budget is edited away and straight back, and the
  // warning has to be due again on the far side.
  test("R3: changing the budget away and back re-arms the warning", () => {
    fc.assert(
      fc.property(budget, budget, position, position, (original, other, costAt, tokensAt) => {
        const usage = usageAt(original, 0, costAt, tokensAt)
        const first = SessionBudget.warning({ budget: original, usage })
        fc.pre(first !== undefined)
        const shown = SessionBudget.key(first!)

        // Shown once: not due again while the budget is left alone.
        expect(
          SessionBudget.warning({
            budget: original,
            usage,
            warned: SessionBudget.rearm(original, original, shown),
          }),
        ).toBeUndefined()

        fc.pre(JSON.stringify(other) !== JSON.stringify(original))
        // Edited away, then straight back: due again, and the same warning.
        const away = SessionBudget.rearm(original, other, shown)
        const back = SessionBudget.rearm(other, original, away)
        expect(SessionBudget.warning({ budget: original, usage, warned: back })).toEqual(first)
      }),
      { numRuns: 500 },
    )
  })

  // R3, second property, from the same evidence: O-8 "the warning should be
  // relative to my current budget setting" and C-8 "it should still give the
  // same since it is still 50% usage".
  // Kind: metamorphic. Scaling the budget and the usage by the same factor
  // leaves every decision alone.
  test("R3: scaling the budget and the usage together changes no decision", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, factor, (config, approved, costAt, tokensAt, scale) => {
        const usage = usageAt(config, approved, costAt, tokensAt)
        const scaled = {
          ...config,
          cost: config.cost === undefined ? undefined : config.cost * scale,
          tokens: config.tokens === undefined ? undefined : config.tokens * scale,
          grant:
            config.grant === undefined
              ? undefined
              : {
                  cost: config.grant.cost === undefined ? undefined : config.grant.cost * scale,
                  tokens: config.grant.tokens === undefined ? undefined : config.grant.tokens * scale,
                },
        }
        const scaledUsage = { cost: usage.cost * scale, tokens: usage.tokens * scale }

        expect(named(SessionBudget.check({ budget: scaled, usage: scaledUsage, approvals: approved }))).toBe(
          named(SessionBudget.check({ budget: config, usage, approvals: approved })),
        )
        expect(named(SessionBudget.warning({ budget: scaled, usage: scaledUsage, approvals: approved }))).toBe(
          named(SessionBudget.warning({ budget: config, usage, approvals: approved })),
        )
      }),
      { numRuns: 500 },
    )
  })

  // R5: "A session is never stopped by a limit without first showing the 80%
  // warning for that same limit." O-10 is the complaint this comes from: being
  // warned about tokens and then stopped by cost "defeats the purpose of the
  // warning".
  // Kind: invariant
  test("R5: a stop always comes with the warning for the same limit", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, (config, approved, costAt, tokensAt) => {
        const usage = usageAt(config, approved, costAt, tokensAt)
        const hit = SessionBudget.check({ budget: config, usage, approvals: approved })
        fc.pre(hit !== undefined)

        const warn = SessionBudget.warning({ budget: config, usage, approvals: approved })
        expect(warn).toBeDefined()
        expect(warn!.limit).toBe(hit!.limit)
        expect(warn!.max).toBe(hit!.max)
      }),
      { numRuns: 500 },
    )
  })

  // R4 (revised in P4): "The stop message shows usage against the limit and
  // which limit was hit." R6: "Every budget stop message tells the user how to
  // continue."
  // Kind: invariant
  test("R4, R6: every stop message names the limit, shows both numbers, and says how to continue", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, action, (config, approved, costAt, tokensAt, act) => {
        const usage = usageAt(config, approved, costAt, tokensAt)
        const hit = SessionBudget.check({ budget: config, usage, approvals: approved })
        fc.pre(hit !== undefined)

        const message = SessionBudget.describe(hit!, act)
        expect(message).toContain(hit!.limit)
        expect(message).toContain("/budget")
        // Both numbers are in the message, whatever separators the formatting uses.
        const digits = (text: string) => text.replace(/[^0-9]/g, "")
        expect(digits(message)).toContain(digits(Math.trunc(hit!.max).toLocaleString()))
        expect(digits(message)).toContain(digits(Math.trunc(hit!.used).toLocaleString()))
      }),
      { numRuns: 500 },
    )
  })

  // R7: "A budget of 0 blocks every model request in the session. Setting the
  // budget itself does not send a model request." Only the first sentence is
  // checkable here; the second is about the /budget dialog, which sends no
  // request at all. With no grant configured an approval adds nothing to a zero
  // ceiling, so approving cannot open a session back up.
  // Kind: invariant
  test("R7: a budget of 0 blocks every request, at any usage and after any approval", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("cost" as const, "tokens" as const),
        fc.double({ min: 0, max: 1e6, noNaN: true }),
        fc.nat({ max: 1e9 }),
        approvals,
        (limit, cost, tokens, approved) => {
          const config = limit === "cost" ? { cost: 0 } : { tokens: 0 }
          const hit = SessionBudget.check({ budget: config, usage: { cost, tokens }, approvals: approved })
          expect(hit).toBeDefined()
          expect(hit!.limit).toBe(limit)
          expect(hit!.max).toBe(0)
        },
      ),
      { numRuns: 500 },
    )
  })

  // R8: "The budget stays the same for the whole session, including after
  // opencode is restarted and the session is resumed, until the user changes it
  // with /budget." A restart reloads the budget by decoding the config file, so
  // the checkable part is that a budget survives the real config decoder and
  // still decides identically. Resuming a session is covered by the existing
  // integration tests, not here.
  // Kind: round-trip
  test("R8: a budget survives a config round-trip and decides identically", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, (config, approved, costAt, tokensAt) => {
        const usage = usageAt(config, approved, costAt, tokensAt)
        const reloaded = Schema.decodeUnknownSync(ConfigV1.Info)(JSON.parse(JSON.stringify({ budget: config }))).budget

        expect(reloaded).toEqual(config)
        expect(SessionBudget.check({ budget: reloaded, usage, approvals: approved })).toEqual(
          SessionBudget.check({ budget: config, usage, approvals: approved }),
        )
        expect(SessionBudget.warning({ budget: reloaded, usage, approvals: approved })).toEqual(
          SessionBudget.warning({ budget: config, usage, approvals: approved }),
        )
      }),
      { numRuns: 500 },
    )
  })
})
