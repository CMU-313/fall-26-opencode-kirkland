import type { Provider } from "@/provider/provider"
import type { Tier } from "@/session/auto-model-classify"

// Reference price weights input tokens 3:1 over output tokens, since agent turns re-send long contexts and
// produce comparatively short replies. Costs are USD per 1M tokens.
const INPUT_WEIGHT = 3
const OUTPUT_WEIGHT = 1

const FREE_SUFFIX = ":free"

// Aliases and meta-routers resolve to an unpredictable model, so they cannot be placed on a price scale.
// These match the model ID only, never the provider ID: regular OpenRouter models stay candidates.
const ALIAS_PREFIXES = ["~", "openrouter/"]
const ALIAS_IDS = ["unbiased/pareto", "auto"]
const ALIAS_SUFFIXES = ["/auto"]

// Checked in this order; each excluded model is counted under the first reason that applies. With freeOnly,
// "not-free" is checked first instead.
const EXCLUDE_REASONS = [
  "no-toolcall",
  "no-text-output",
  "alias",
  "config-exclude",
  "not-free",
  "free-no-counterpart",
  "unpriced",
] as const
export type ExcludeReason = (typeof EXCLUDE_REASONS)[number]

export type Candidate = {
  providerID: string
  modelID: string
  referencePrice: number
  model: Provider.Model
}

export function isFree(model: Provider.Model) {
  return model.id.endsWith(FREE_SUFFIX) && model.cost.input === 0 && model.cost.output === 0
}

// A free model is priced as its paid counterpart in the same provider. Returns undefined when the model (or the
// free model's counterpart) has no usable price: a missing `cost` converts to 0/0, which must not rank as cheapest.
export function referencePrice(model: Provider.Model, providerModels: Record<string, Provider.Model>) {
  const priced = isFree(model) ? providerModels[model.id.slice(0, -FREE_SUFFIX.length)] : model
  if (!priced || isFree(priced) || (priced.cost.input === 0 && priced.cost.output === 0)) return undefined
  return (INPUT_WEIGHT * priced.cost.input + OUTPUT_WEIGHT * priced.cost.output) / (INPUT_WEIGHT + OUTPUT_WEIGHT)
}

export function candidates(providers: Record<string, Provider.Info>, cfg: { freeOnly?: boolean; exclude?: string[] }) {
  const exclude = (cfg.exclude ?? []).map(globToRegExp)
  const excluded = Object.fromEntries(EXCLUDE_REASONS.map((reason) => [reason, 0])) as Record<ExcludeReason, number>
  const result = Object.values(providers).flatMap((provider) =>
    Object.entries(provider.models).flatMap(([modelID, model]): Candidate[] => {
      const price = referencePrice(model, provider.models)
      const reason = excludeReason({
        model,
        modelID,
        fullID: `${provider.id}/${modelID}`,
        price,
        freeOnly: cfg.freeOnly ?? false,
        exclude,
      })
      if (reason) {
        excluded[reason]++
        return []
      }
      return [{ providerID: provider.id, modelID, referencePrice: price!, model }]
    }),
  )
  return { candidates: result, excluded }
}

// Equal thirds by count with boundaries round(n/3) and round(2n/3). Below 3 candidates the thirds would leave tiers
// empty, so every tier resolves to the nearest model instead.
export function buildTiers(candidates: Candidate[]): Record<Tier, Candidate[]> {
  const sorted = candidates.toSorted(
    (a, b) =>
      a.referencePrice - b.referencePrice ||
      `${a.providerID}/${a.modelID}`.localeCompare(`${b.providerID}/${b.modelID}`),
  )
  if (sorted.length === 1) return { simple: sorted, moderate: sorted, complex: sorted }
  if (sorted.length === 2) return { simple: [sorted[0]], moderate: [sorted[1]], complex: [sorted[1]] }
  const i1 = Math.round(sorted.length / 3)
  const i2 = Math.round((2 * sorted.length) / 3)
  return { simple: sorted.slice(0, i1), moderate: sorted.slice(i1, i2), complex: sorted.slice(i2) }
}

export function pick(tiers: Record<Tier, Candidate[]>, tier: Tier): Candidate | undefined {
  const list = tiers[tier]
  if (tier === "simple") return list[0]
  if (tier === "moderate") return list[Math.floor((list.length - 1) / 2)]
  return list.at(-1)
}

function excludeReason(input: {
  model: Provider.Model
  modelID: string
  fullID: string
  price: number | undefined
  freeOnly: boolean
  exclude: RegExp[]
}): ExcludeReason | undefined {
  const free = isFree(input.model)
  // With freeOnly, paid models are never eligible, so count them all as not-free instead of spreading them
  // across capability and alias reasons.
  if (input.freeOnly && !free) return "not-free"
  if (!input.model.capabilities.toolcall) return "no-toolcall"
  if (!input.model.capabilities.output.text) return "no-text-output"
  if (isAlias(input.modelID)) return "alias"
  if (input.exclude.some((pattern) => pattern.test(input.fullID))) return "config-exclude"
  if (input.price !== undefined) return undefined
  return free ? "free-no-counterpart" : "unpriced"
}

function isAlias(modelID: string) {
  return (
    ALIAS_PREFIXES.some((prefix) => modelID.startsWith(prefix)) ||
    ALIAS_IDS.includes(modelID) ||
    ALIAS_SUFFIXES.some((suffix) => modelID.endsWith(suffix))
  )
}

// `*` matches any run of characters, including `/`. Everything else matches literally.
function globToRegExp(glob: string) {
  return new RegExp(
    "^" +
      glob
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*") +
      "$",
  )
}

export * as AutoModelTiers from "./auto-model-tiers"
