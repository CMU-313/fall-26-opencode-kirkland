import { TIERS, type Tier } from "@/session/auto-model-classify"

// Number of consecutive lower-tier prompts needed before Auto steps down. Upgrades are always immediate.
export const DOWNGRADE_AFTER = 3

export type State = { tier: Tier; streak: number; streakTiers: Tier[] }

// `state` comes from session metadata (JSON from disk), so anything malformed restarts from the prompt's tier.
export function next(state: unknown, promptTier: Tier) {
  const prior = parseState(state)
  const reset = { tier: promptTier, streak: 0, streakTiers: [] }
  if (!prior) return result(reset, undefined, "initial")

  const promptRank = TIERS.indexOf(promptTier)
  const currentRank = TIERS.indexOf(prior.tier)
  if (promptRank > currentRank) return result(reset, prior.tier, "upgrade")
  if (promptRank === currentRank) return result(reset, prior.tier, "same-tier")

  const streakTiers = [...prior.streakTiers, promptTier]
  if (streakTiers.length >= DOWNGRADE_AFTER) {
    // Step down only as far as the most demanding prompt in the streak required.
    const tier = TIERS[Math.max(...streakTiers.map((tier) => TIERS.indexOf(tier)))]
    return result({ tier, streak: 0, streakTiers: [] }, prior.tier, `downgrade-after-${DOWNGRADE_AFTER}`)
  }
  return result(
    { tier: prior.tier, streak: streakTiers.length, streakTiers },
    prior.tier,
    `lower-streak:${streakTiers.length}/${DOWNGRADE_AFTER}`,
  )
}

function result(state: State, fromTier: Tier | undefined, reason: string) {
  return {
    state,
    switched: fromTier !== undefined && fromTier !== state.tier,
    fromTier,
    toTier: state.tier,
    reason,
  }
}

// A streak at or past DOWNGRADE_AFTER is rejected too: `next` always resets before persisting one.
function parseState(input: unknown): State | undefined {
  if (typeof input !== "object" || input === null) return
  if (!("tier" in input) || !isTier(input.tier)) return
  if (!("streak" in input) || typeof input.streak !== "number" || !Number.isInteger(input.streak)) return
  if (input.streak < 0 || input.streak >= DOWNGRADE_AFTER) return
  if (!("streakTiers" in input) || !Array.isArray(input.streakTiers)) return
  if (input.streakTiers.length !== input.streak) return
  const rank = TIERS.indexOf(input.tier)
  const streakTiers = input.streakTiers.filter(isTier).filter((tier) => TIERS.indexOf(tier) < rank)
  if (streakTiers.length !== input.streakTiers.length) return
  return { tier: input.tier, streak: input.streak, streakTiers }
}

function isTier(value: unknown): value is Tier {
  return typeof value === "string" && TIERS.some((tier) => tier === value)
}

export * as AutoModelHysteresis from "./auto-model-hysteresis"
