import { describe, expect, test } from "bun:test"
import type { Tier } from "../../src/session/auto-model-classify"
import { AutoModelHysteresis } from "../../src/session/auto-model-hysteresis"

// Feeds prompts through `next` the way the router does, persisting state between calls.
function run(tiers: Tier[], start?: unknown) {
  return tiers.reduce<ReturnType<typeof AutoModelHysteresis.next>[]>(
    (results, tier) => [...results, AutoModelHysteresis.next(results.at(-1)?.state ?? start, tier)],
    [],
  )
}

describe("AutoModelHysteresis.next", () => {
  test("first prompt adopts its own tier without counting as a switch", () => {
    expect(AutoModelHysteresis.next(undefined, "moderate")).toEqual({
      state: { tier: "moderate", streak: 0, streakTiers: [] },
      switched: false,
      fromTier: undefined,
      toTier: "moderate",
      reason: "initial",
    })
  })

  test("upgrades immediately", () => {
    const result = run(["simple", "complex"]).at(-1)!
    expect(result.toTier).toBe("complex")
    expect(result.switched).toBe(true)
    expect(result.fromTier).toBe("simple")
    expect(result.reason).toBe("upgrade")
  })

  test(`downgrades only after ${AutoModelHysteresis.DOWNGRADE_AFTER} consecutive lower prompts`, () => {
    const results = run(["complex", "simple", "simple", "simple"])
    expect(results.map((result) => result.toTier)).toEqual(["complex", "complex", "complex", "simple"])
    expect(results.map((result) => result.reason)).toEqual([
      "initial",
      "lower-streak:1/3",
      "lower-streak:2/3",
      "downgrade-after-3",
    ])
    expect(results.at(-1)!.switched).toBe(true)
    expect(results.at(-1)!.state).toEqual({ tier: "simple", streak: 0, streakTiers: [] })
  })

  test("steps down only as far as the most demanding prompt in the streak", () => {
    expect(run(["complex", "simple", "moderate", "simple"]).at(-1)!.toTier).toBe("moderate")
  })

  test("a same-tier prompt resets the streak", () => {
    const results = run(["complex", "simple", "simple", "complex", "simple", "simple"])
    expect(results.at(3)!.reason).toBe("same-tier")
    expect(results.at(-1)!.toTier).toBe("complex")
    expect(results.at(-1)!.state.streak).toBe(2)
  })

  test("an upgrade during a streak resets it", () => {
    const result = run(["moderate", "simple", "complex"]).at(-1)!
    expect(result.reason).toBe("upgrade")
    expect(result.state).toEqual({ tier: "complex", streak: 0, streakTiers: [] })
  })

  test("malformed persisted state restarts from the prompt's tier", () => {
    const malformed = [
      null,
      "complex",
      { tier: "bogus", streak: 0, streakTiers: [] },
      { tier: "complex", streak: 1.5, streakTiers: ["simple"] },
      { tier: "complex", streak: -1, streakTiers: [] },
      { tier: "complex", streak: 3, streakTiers: ["simple", "simple", "simple"] },
      { tier: "complex", streak: 2, streakTiers: ["simple"] },
      { tier: "moderate", streak: 1, streakTiers: ["complex"] },
      { tier: "complex", streak: 0 },
    ]
    malformed.forEach((state) => {
      const result = AutoModelHysteresis.next(state, "simple")
      expect(result.reason).toBe("initial")
      expect(result.toTier).toBe("simple")
    })
  })
})
