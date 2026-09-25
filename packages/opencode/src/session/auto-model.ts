import type { Agent } from "@/agent/agent"
import type { Provider } from "@/provider/provider"
import { AutoModelClassify, TIERS, type Tier } from "@/session/auto-model-classify"
import { AutoModelHysteresis } from "@/session/auto-model-hysteresis"
import { AutoModelTiers } from "@/session/auto-model-tiers"
import type { SessionPrompt } from "@/session/prompt"

// A routed model must fit the last turn's context with room to grow: the next turn re-sends it plus the new prompt
// and the reply.
export const CONTEXT_BUFFER = 1.2

type ModelRef = { providerID: string; modelID: string; variant?: string }
type LogValue = string | number | boolean | string[]

export type Decision = {
  action: "disabled" | "skip" | "route"
  // Set only when action is "route"; otherwise the caller keeps its base model.
  model?: ModelRef
  // The full merged session metadata to write, or undefined when nothing should be written.
  metadata?: Record<string, unknown>
  switched: boolean
  toast?: string
  log?: Record<string, LogValue>
}

// Pure and synchronous: the caller performs every side effect (logging, metadata write, toast) from the decision.
export function route(input: {
  parts: SessionPrompt.PromptInput["parts"]
  agent: Pick<Agent.Info, "mode" | "hidden" | "model">
  session: { id: string; parentID?: string; metadata?: Record<string, unknown> }
  noReply?: boolean
  base: ModelRef
  providers: Record<string, Provider.Info>
  config: { enabled?: boolean; freeOnly?: boolean; exclude?: string[] } | undefined
  lastContextTokens?: number
}): Decision {
  const auto = readAutoModel(input.session.metadata)
  const enabled = typeof auto.enabled === "boolean" ? auto.enabled : (input.config?.enabled ?? false)
  if (!enabled) return { action: "disabled", switched: false }

  const freeOnly = input.config?.freeOnly ?? false
  const baseLog = {
    "session.id": input.session.id,
    baseModel: `${input.base.providerID}/${input.base.modelID}`,
    freeOnly,
  }
  const skip = skipReason(input)
  if (skip) return { action: "skip", switched: false, log: { ...baseLog, action: "skip", reason: skip } }

  const classified = AutoModelClassify.classify(input.parts)
  const hysteresis = AutoModelHysteresis.next(auto.state, classified.tier)
  const pool = AutoModelTiers.candidates(input.providers, { freeOnly, exclude: input.config?.exclude })
  const tiers = AutoModelTiers.buildTiers(pool.candidates)
  const filters = routingFilters(input)
  const filtered = Object.fromEntries(
    TIERS.map((tier) => [tier, tiers[tier].filter((candidate) => filters.every((filter) => filter.keep(candidate)))]),
  ) as Record<Tier, AutoModelTiers.Candidate[]>
  const usedTier = fallbackOrder(hysteresis.toTier).find((tier) => filtered[tier].length > 0)
  const picked = usedTier && AutoModelTiers.pick(filtered, usedTier)

  const log = {
    ...baseLog,
    fromTier: hysteresis.fromTier ?? "none",
    toTier: hysteresis.toTier,
    usedTier: usedTier ?? "none",
    // Tiers are never empty before filtering, so a fallback always traces back to the listed `filters`.
    fallback: usedTier && usedTier !== hysteresis.toTier ? `${hysteresis.toTier}-empty` : "none",
    filters: filters.map((filter) => filter.name),
    streak: hysteresis.state.streak,
    score: classified.score,
    signals: classified.signals,
    candidates: pool.candidates.length,
    excluded: Object.values(pool.excluded).reduce((sum, count) => sum + count, 0),
  }

  // The streak must advance even when nothing is routable, or the next prompt would see stale hysteresis state.
  if (!picked)
    return {
      action: "skip",
      switched: false,
      metadata: mergeMetadata(input.session.metadata, auto, { state: hysteresis.state }),
      log: { ...log, action: "skip", reason: "no-candidates", switched: false },
    }

  const switched = auto.last?.providerID !== picked.providerID || auto.last?.modelID !== picked.modelID
  const variant = input.base.variant && picked.model.variants?.[input.base.variant] ? input.base.variant : undefined
  return {
    action: "route",
    model: { providerID: picked.providerID, modelID: picked.modelID, ...(variant ? { variant } : {}) },
    metadata: mergeMetadata(input.session.metadata, auto, {
      state: hysteresis.state,
      last: { providerID: picked.providerID, modelID: picked.modelID, tier: usedTier },
    }),
    switched,
    toast: switched ? `${usedTier} → ${picked.modelID}` : undefined,
    log: {
      ...log,
      action: "route",
      reason: hysteresis.reason,
      model: `${picked.providerID}/${picked.modelID}`,
      referencePrice: picked.referencePrice,
      switched,
    },
  }
}

function skipReason(input: Parameters<typeof route>[0]) {
  if (input.session.parentID) return "child-session"
  if (input.agent.mode === "subagent") return "subagent"
  if (input.agent.hidden) return "hidden-agent"
  if (input.agent.model) return "agent-model"
  if (input.noReply) return "no-reply"
  if (!input.parts.some((part) => part.type === "text" && part.synthetic !== true)) return "no-user-text"
  return undefined
}

function routingFilters(input: Parameters<typeof route>[0]) {
  const minContext = (input.lastContextTokens ?? 0) * CONTEXT_BUFFER
  const needsImage = input.parts.some((part) => part.type === "file" && part.mime.startsWith("image/"))
  return [
    ...(minContext > 0
      ? [
          {
            name: `context>=${Math.ceil(minContext)}`,
            // A model without a known context size (0) is kept: the catalog lacks the data, not the capacity.
            keep: (candidate: AutoModelTiers.Candidate) =>
              !candidate.model.limit.context || candidate.model.limit.context >= minContext,
          },
        ]
      : []),
    ...(needsImage
      ? [{ name: "image", keep: (candidate: AutoModelTiers.Candidate) => candidate.model.capabilities.input.image }]
      : []),
  ]
}

// The target tier, then the tiers above it (nearest first), then the tiers below it (nearest first).
function fallbackOrder(target: Tier) {
  const rank = TIERS.indexOf(target)
  return [target, ...TIERS.slice(rank + 1), ...TIERS.slice(0, rank).toReversed()]
}

// `session.metadata` is JSON from disk, so every field is validated rather than trusted.
function readAutoModel(metadata: unknown) {
  const auto = isRecord(metadata) && isRecord(metadata.autoModel) ? metadata.autoModel : {}
  const last = isRecord(auto.last) ? auto.last : undefined
  return {
    raw: auto,
    enabled: auto.enabled,
    state: auto.state,
    last:
      last && typeof last.providerID === "string" && typeof last.modelID === "string"
        ? { providerID: last.providerID, modelID: last.modelID }
        : undefined,
  }
}

// `Session.setMetadata` replaces the whole object, so unrelated keys and the `enabled` flag are carried over.
function mergeMetadata(
  metadata: Record<string, unknown> | undefined,
  auto: ReturnType<typeof readAutoModel>,
  update: { state: AutoModelHysteresis.State; last?: { providerID: string; modelID: string; tier: Tier } },
) {
  return { ...(isRecord(metadata) ? metadata : {}), autoModel: { ...auto.raw, ...update } }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as AutoModel from "./auto-model"
