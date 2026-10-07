import { describe, expect, test } from "bun:test"
import { SessionBudget } from "@/session/budget"

const tokens = (over: Partial<{ input: number; output: number; reasoning: number; read: number; write: number }> = {}) => ({
  input: over.input ?? 0,
  output: over.output ?? 0,
  reasoning: over.reasoning ?? 0,
  cache: { read: over.read ?? 0, write: over.write ?? 0 },
})

describe("total", () => {
  test("sums every counter including reasoning and cache", () => {
    expect(SessionBudget.total(tokens({ input: 1, output: 2, reasoning: 4, read: 8, write: 16 }))).toBe(31)
  })

  test("treats missing tokens as zero", () => {
    expect(SessionBudget.total(undefined)).toBe(0)
  })
})

describe("check", () => {
  test("returns undefined when no budget is configured", () => {
    expect(SessionBudget.check({ usage: { cost: 100, tokens: 100 } })).toBeUndefined()
  })

  test("returns undefined while under the cost limit", () => {
    expect(SessionBudget.check({ budget: { cost: 5 }, usage: { cost: 4.99, tokens: 0 } })).toBeUndefined()
  })

  test("reports the cost limit once spend reaches it", () => {
    expect(SessionBudget.check({ budget: { cost: 5 }, usage: { cost: 5, tokens: 0 } })).toEqual({
      limit: "cost",
      max: 5,
      used: 5,
    })
  })

  test("reports the token limit", () => {
    expect(SessionBudget.check({ budget: { tokens: 1000 }, usage: { cost: 0, tokens: 1200 } })).toEqual({
      limit: "tokens",
      max: 1000,
      used: 1200,
    })
  })

  test("prefers cost when both limits are exceeded", () => {
    const hit = SessionBudget.check({ budget: { cost: 1, tokens: 10 }, usage: { cost: 2, tokens: 20 } })
    expect(hit?.limit).toBe("cost")
  })

  test("an approval raises the ceiling instead of re-triggering", () => {
    const budget = { cost: 5 }
    const usage = { cost: 6, tokens: 0 }
    expect(SessionBudget.check({ budget, usage, approvals: 1 })).toBeUndefined()
    expect(SessionBudget.check({ budget, usage: { cost: 10, tokens: 0 }, approvals: 1 })).toEqual({
      limit: "cost",
      max: 10,
      used: 10,
    })
  })

  test("a zero limit stops immediately", () => {
    expect(SessionBudget.check({ budget: { cost: 0 }, usage: { cost: 0, tokens: 0 } })?.limit).toBe("cost")
  })
})
