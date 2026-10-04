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
