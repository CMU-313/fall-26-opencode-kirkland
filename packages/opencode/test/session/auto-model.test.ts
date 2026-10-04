import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "../../src/provider/provider"
import { AutoModel } from "../../src/session/auto-model"
import { ProviderTest } from "../fake/provider"

// Six paid models priced 1..6 plus a free counterpart of model-3. Sorted by price this builds the tiers
// simple [model-1, model-2], moderate [model-3, model-3:free, model-4], complex [model-5, model-6].
function makeProvider(overrides: Record<string, Partial<Provider.Model>> = {}) {
  const models = [
    ...[1, 2, 3, 4, 5, 6].map((price) =>
      ProviderTest.model({
        id: ModelV2.ID.make(`model-${price}`),
        cost: { input: price, output: price, cache: { read: 0, write: 0 } },
        ...overrides[`model-${price}`],
      }),
    ),
    ProviderTest.model({
      id: ModelV2.ID.make("model-3:free"),
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      ...overrides["model-3:free"],
    }),
  ]
  return ProviderTest.info({ models: Object.fromEntries(models.map((model) => [model.id, model])) })
}
const provider = makeProvider()

const COMPLEX_PROMPT = "Refactor the auth module and migrate the session store to the new architecture"
const MODERATE_PROMPT = "add a retry flag to the CLI"

type RouteInput = Parameters<typeof AutoModel.route>[0]

function route(input: Partial<RouteInput> & { text?: string } = {}) {
  return AutoModel.route({
    parts: [{ type: "text", text: input.text ?? "hi" }],
    agent: { mode: "primary" },
    session: { id: "ses_test", metadata: { autoModel: { enabled: true } } },
    base: { providerID: "openai", modelID: "model-6" },
    providers: { [provider.id]: provider },
    config: undefined,
    ...input,
  })
}

describe("AutoModel enablement", () => {
  test("is disabled by default", () => {
    expect(route({ session: { id: "ses_test" } })).toEqual({ action: "disabled", switched: false })
  })

  test("config enables routing when the session has no preference", () => {
    expect(route({ session: { id: "ses_test" }, config: { enabled: true } }).action).toBe("route")
  })

  test("session metadata overrides config", () => {
    const session = { id: "ses_test", metadata: { autoModel: { enabled: false } } }
    expect(route({ session, config: { enabled: true } }).action).toBe("disabled")
  })
})

describe("AutoModel skip reasons", () => {
  const cases: [string, Partial<RouteInput>][] = [
    ["child-session", { session: { id: "ses_test", parentID: "ses_parent", metadata: { autoModel: { enabled: true } } } }],
    ["subagent", { agent: { mode: "subagent" } }],
    ["hidden-agent", { agent: { mode: "primary", hidden: true } }],
    [
      "agent-model",
      { agent: { mode: "primary", model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("x") } } },
    ],
    ["no-reply", { noReply: true }],
    ["no-user-text", { parts: [{ type: "text", text: "hi", synthetic: true }] }],
  ]
  cases.forEach(([reason, input]) =>
    test(reason, () => {
      const decision = route(input)
      expect(decision.action).toBe("skip")
      expect(decision.model).toBeUndefined()
      expect(decision.metadata).toBeUndefined()
      expect(decision.log?.reason).toBe(reason)
    }),
  )
})

describe("AutoModel routing", () => {
  test("routes each tier to its model", () => {
    expect(route().model?.modelID).toBe("model-1")
    expect(route({ text: MODERATE_PROMPT }).model?.modelID).toBe("model-3:free")
    expect(route({ text: COMPLEX_PROMPT }).model?.modelID).toBe("model-6")
  })

  test("persists hysteresis so one simple prompt after a complex one stays on the complex model", () => {
    const first = route({ text: COMPLEX_PROMPT })
    const second = route({ session: { id: "ses_test", metadata: first.metadata } })
    expect(second.model?.modelID).toBe("model-6")
    expect(second.switched).toBe(false)
    expect(second.toast).toBeUndefined()
    expect(second.log?.reason).toBe("lower-streak:1/3")

    const third = route({ session: { id: "ses_test", metadata: second.metadata } })
    const fourth = route({ session: { id: "ses_test", metadata: third.metadata } })
    expect(fourth.model?.modelID).toBe("model-1")
    expect(fourth.switched).toBe(true)
    expect(fourth.toast).toBe("simple → model-1")
  })

  test("toasts only when the routed model changes", () => {
    const first = route()
    expect(first.switched).toBe(true)
    expect(first.toast).toBe("simple → model-1")
    const second = route({ session: { id: "ses_test", metadata: first.metadata } })
    expect(second.switched).toBe(false)
    expect(second.toast).toBeUndefined()
  })

  test("merges metadata without dropping unrelated keys or the enabled flag", () => {
    const decision = route({ session: { id: "ses_test", metadata: { other: 1, autoModel: { enabled: true } } } })
    expect(decision.metadata).toEqual({
      other: 1,
      autoModel: {
        enabled: true,
        state: { tier: "simple", streak: 0, streakTiers: [] },
        last: { providerID: "openai", modelID: "model-1", tier: "simple" },
      },
    })
  })

  test("keeps the requested variant only when the routed model supports it", () => {
    const withVariant = makeProvider({ "model-1": { variants: { high: {} } } })
    const base = { providerID: "openai", modelID: "model-6", variant: "high" }
    expect(route({ base, providers: { [withVariant.id]: withVariant } }).model).toEqual({
      providerID: "openai",
      modelID: "model-1",
      variant: "high",
    })
    expect(route({ base }).model).toEqual({ providerID: "openai", modelID: "model-1" })
  })

  test("honors config exclude and freeOnly", () => {
    expect(route({ config: { exclude: ["openai/model-1"] } }).model?.modelID).toBe("model-2")
    expect(route({ text: COMPLEX_PROMPT, config: { freeOnly: true } }).model?.modelID).toBe("model-3:free")
  })
})

describe("AutoModel logging", () => {
  test("logs the complexity analysis and the reason for the selected model", () => {
    const log = route({ text: COMPLEX_PROMPT }).log
    expect(log).toMatchObject({
      "session.id": "ses_test",
      baseModel: "openai/model-6",
      action: "route",
      reason: "initial",
      fromTier: "none",
      toTier: "complex",
      usedTier: "complex",
      fallback: "none",
      score: 6,
      model: "openai/model-6",
      referencePrice: 6,
      candidates: 7,
      excluded: 0,
      switched: true,
    })
    expect(log?.signals).toEqual(
      expect.arrayContaining(["keyword:refactor(+3)", "keyword:migrate(+3)", "keyword:architecture(+3)"]),
    )
  })

  test("logs why a downgrade is being held back", () => {
    const first = route({ text: COMPLEX_PROMPT })
    expect(route({ session: { id: "ses_test", metadata: first.metadata } }).log).toMatchObject({
      fromTier: "complex",
      toTier: "complex",
      streak: 1,
      reason: "lower-streak:1/3",
    })
  })

  test("logs why routing was skipped", () => {
    expect(route({ agent: { mode: "subagent" } }).log).toMatchObject({ action: "skip", reason: "subagent" })
  })
})

describe("AutoModel filters", () => {
  test("skips models whose context would not fit the last turn and falls back to a higher tier", () => {
    const small = makeProvider({
      "model-1": { limit: { context: 1000, output: 100 } },
      "model-2": { limit: { context: 1000, output: 100 } },
    })
    const decision = route({ providers: { [small.id]: small }, lastContextTokens: 1000 })
    expect(decision.model?.modelID).toBe("model-3:free")
    expect(decision.log?.filters).toEqual(["context>=1200"])
    expect(decision.log?.fallback).toBe("simple-empty")
  })

  test("keeps models with unknown context size", () => {
    const unknown = makeProvider({ "model-1": { limit: { context: 0, output: 100 } } })
    expect(route({ providers: { [unknown.id]: unknown }, lastContextTokens: 1_000_000 }).model?.modelID).toBe(
      "model-1",
    )
  })

  test("requires image input when the prompt attaches an image", () => {
    const capabilities = ProviderTest.model().capabilities
    const vision = makeProvider({
      "model-4": { capabilities: { ...capabilities, input: { ...capabilities.input, image: true } } },
    })
    const decision = route({
      parts: [
        { type: "text", text: "hi" },
        { type: "file", mime: "image/png", url: "data:image/png;base64," },
      ],
      providers: { [vision.id]: vision },
    })
    expect(decision.model?.modelID).toBe("model-4")
    expect(decision.log?.filters).toEqual(["image"])
  })

  test("skips but still advances hysteresis state when nothing is routable", () => {
    const decision = route({ providers: {} })
    expect(decision.action).toBe("skip")
    expect(decision.model).toBeUndefined()
    expect(decision.log?.reason).toBe("no-candidates")
    expect(decision.metadata).toEqual({
      autoModel: { enabled: true, state: { tier: "simple", streak: 0, streakTiers: [] } },
    })
  })
})

describe("AutoModel out of funds", () => {
  test("simple prompt picks the cheapest model", () => {
    expect(route().model?.modelID).toBe("model-1")
  })

  test("skips every paid model of a provider that is out of funds", () => {
    expect(route({ outOfFunds: [provider.id] }).model?.modelID).toBe("model-3:free")
  })

  test("routes normally when an unrelated provider is out of funds", () => {
    expect(route({ outOfFunds: ["other"] }).model?.modelID).toBe("model-1")
  })

  test("detects billing errors", () => {
    const error = (data: { message: string; statusCode?: number; responseBody?: string }) =>
      new SessionV1.APIError({ isRetryable: false, ...data }).toObject()
    expect(AutoModel.isOutOfFunds(error({ message: "Payment Required", statusCode: 402 }))).toBe(true)
    expect(
      AutoModel.isOutOfFunds(error({ message: "Bad Request", responseBody: '{"error":"Insufficient credits"}' })),
    ).toBe(true)
    expect(
      AutoModel.isOutOfFunds(
        error({ message: "Insufficient credits. This account never purchased credits.", statusCode: 402 }),
      ),
    ).toBe(true)
    expect(AutoModel.isOutOfFunds(error({ message: "Bad Request", statusCode: 400 }))).toBe(false)
    expect(AutoModel.isOutOfFunds(undefined)).toBe(false)
  })
})
