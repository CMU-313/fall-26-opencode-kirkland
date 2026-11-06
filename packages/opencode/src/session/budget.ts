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

// Approvals add budget.grant of headroom each, or one more whole limit when no
// grant is configured.
export function ceiling(max: number, approvals: number, grant?: number) {
  return max + (grant ?? max) * approvals
}

// Fraction of a limit consumed before the user is warned.
export const WARNING_RATIO = 0.8

// The limit a stop would name, else the one closest to its ceiling. check and
// warning both read this, so they cannot name different limits.
export function pressure(input: { budget?: Budget; usage: Usage; approvals?: number }) {
  const budget = input.budget
  if (!budget) return undefined
  const approvals = input.approvals ?? 0
  const ranked = [
    budget.cost !== undefined
      ? { limit: "cost" as const, max: ceiling(budget.cost, approvals, budget.grant?.cost), used: input.usage.cost }
      : undefined,
    budget.tokens !== undefined
      ? {
          limit: "tokens" as const,
          max: ceiling(budget.tokens, approvals, budget.grant?.tokens),
          used: input.usage.tokens,
        }
      : undefined,
  ]
    .filter((candidate) => candidate !== undefined)
    // A zero ceiling is reached by anything, and must not divide by zero.
    .map((candidate) => ({ ...candidate, ratio: candidate.max > 0 ? candidate.used / candidate.max : Infinity }))
    .sort((a, b) => b.ratio - a.ratio)
  return ranked.find((candidate) => candidate.used >= candidate.max) ?? ranked[0]
}

// The ceiling a warning has been shown for, so it fires once per ceiling.
export function key(hit: Exceeded) {
  return `${hit.limit}:${hit.max}`
}

// A budget edit re-arms the warning. The ceiling alone cannot carry this: 1000
// to 2000 and back returns to a ceiling already warned about. Budgets come from
// the config decoder, so their key order is stable.
export function rearm(previous: Budget | undefined, next: Budget | undefined, warned: string | undefined) {
  return JSON.stringify(previous) === JSON.stringify(next) ? warned : undefined
}

// Due from WARNING_RATIO on, and still due past the limit, so a turn that
// overshoots in one request is warned rather than stopped silently.
export function warning(input: { budget?: Budget; usage: Usage; approvals?: number; warned?: string }) {
  const worst = pressure(input)
  if (!worst) return undefined
  if (worst.ratio < WARNING_RATIO) return undefined
  if (input.warned === key(worst)) return undefined
  return worst
}

export function check(input: { budget?: Budget; usage: Usage; approvals?: number }): Exceeded | undefined {
  const hit = pressure(input)
  if (!hit || hit.used < hit.max) return undefined
  return { limit: hit.limit, max: hit.max, used: hit.used }
}

export function describe(hit: Exceeded, action?: Budget["action"]) {
  const reached =
    hit.limit === "cost"
      ? `Session cost $${hit.used.toFixed(4)} reached the configured budget of $${hit.max.toFixed(2)}`
      : `Session used ${hit.used.toLocaleString()} tokens, reaching the configured budget of ${hit.max.toLocaleString()}`
  // Always says how to continue.
  return action === "ask"
    ? `${reached}. Raise it with /budget, or approve continuing when asked.`
    : `${reached}. Raise it with /budget, or set budget.action to "ask" to approve continuing.`
}
