export * as SessionBudget from "./budget"

import type { ConfigV1 } from "@opencode-ai/core/v1/config/config"

export type Budget = NonNullable<ConfigV1.Info["budget"]>

export type Tokens = {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export type Usage = {
  cost: number
  tokens: number
}

export type Exceeded = {
  limit: "cost" | "tokens"
  max: number
  used: number
}

export function total(tokens: Tokens | undefined) {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

// Each approval grants one more budget's worth of headroom, so an approved
// session asks again at 2x, 3x, ... instead of on every subsequent step.
export function ceiling(max: number, approvals: number) {
  return max * (approvals + 1)
}

export function check(input: { budget?: Budget; usage: Usage; approvals?: number }): Exceeded | undefined {
  const budget = input.budget
  if (!budget) return undefined
  const approvals = input.approvals ?? 0

  if (budget.cost !== undefined) {
    const max = ceiling(budget.cost, approvals)
    if (input.usage.cost >= max) return { limit: "cost", max, used: input.usage.cost }
  }

  if (budget.tokens !== undefined) {
    const max = ceiling(budget.tokens, approvals)
    if (input.usage.tokens >= max) return { limit: "tokens", max, used: input.usage.tokens }
  }

  return undefined
}

export function describe(hit: Exceeded) {
  return hit.limit === "cost"
    ? `Session cost $${hit.used.toFixed(4)} reached the configured budget of $${hit.max.toFixed(2)}`
    : `Session used ${hit.used.toLocaleString()} tokens, reaching the configured budget of ${hit.max.toLocaleString()}`
}
