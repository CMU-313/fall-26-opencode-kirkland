import { describe, expect, test } from "bun:test"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { Provider } from "../../src/provider/provider"
import { AutoModelTiers } from "../../src/session/auto-model-tiers"
import { ProviderTest } from "../fake/provider"

function model(id: string, input: number, output = input, override: Partial<Provider.Model> = {}) {
  return ProviderTest.model({
    id: ModelV2.ID.make(id),
    cost: { input, output, cache: { read: 0, write: 0 } },
    ...override,
  })
}

function providers(models: Provider.Model[], id = "openai") {
  const info = ProviderTest.info({
    id: ProviderV2.ID.make(id),
    models: Object.fromEntries(models.map((item) => [item.id, item])),
  })
  return { [info.id]: info }
}

function candidate(modelID: string, referencePrice: number, providerID = "openai"): AutoModelTiers.Candidate {
  return { providerID, modelID, referencePrice, model: model(modelID, referencePrice) }
}

describe("AutoModelTiers pricing", () => {
  test("isFree requires the :free suffix and zero cost", () => {
    expect(AutoModelTiers.isFree(model("a:free", 0))).toBe(true)
    expect(AutoModelTiers.isFree(model("a:free", 1))).toBe(false)
    expect(AutoModelTiers.isFree(model("a", 0))).toBe(false)
  })

  test("reference price weights input 3:1 over output", () => {
    expect(AutoModelTiers.referencePrice(model("a", 2, 10), {})).toBe((3 * 2 + 10) / 4)
  })

  test("free models are priced as their paid counterpart", () => {
    const paid = model("a", 4, 8)
    expect(AutoModelTiers.referencePrice(model("a:free", 0), { a: paid })).toBe(5)
  })

  test("unpriced models and orphan free models have no reference price", () => {
    expect(AutoModelTiers.referencePrice(model("a", 0), {})).toBeUndefined()
    expect(AutoModelTiers.referencePrice(model("a:free", 0), {})).toBeUndefined()
  })
})

describe("AutoModelTiers.candidates", () => {
  test("excludes unusable models and counts each under one reason", () => {
    const result = AutoModelTiers.candidates(
      providers([
        model("good", 1),
        model("good:free", 0),
        model("no-tools", 1, 1, {
          capabilities: { ...model("x", 1).capabilities, toolcall: false },
        }),
        model("image-only", 1, 1, {
          capabilities: {
            ...model("x", 1).capabilities,
            output: { text: false, image: true, audio: false, video: false, pdf: false },
          },
        }),
        model("~latest", 1),
        model("openrouter/auto", 1),
        model("auto", 1),
        model("vendor/auto", 1),
        model("blocked-1", 1),
        model("unpriced", 0),
        model("orphan:free", 0),
      ]),
      { exclude: ["openai/blocked-*"] },
    )
    expect(result.candidates.map((item) => item.modelID).toSorted()).toEqual(["good", "good:free"])
    expect(result.excluded).toEqual({
      "no-toolcall": 1,
      "no-text-output": 1,
      alias: 4,
      "config-exclude": 1,
      "not-free": 0,
      "free-no-counterpart": 1,
      unpriced: 1,
    })
  })

  test("exclude globs match the full provider/model ID and treat other characters literally", () => {
    const pool = providers([model("gpt-5", 1), model("gpt-5.mini", 1), model("gpt-5xmini", 1)])
    expect(AutoModelTiers.candidates(pool, { exclude: ["gpt-5"] }).candidates).toHaveLength(3)
    expect(
      AutoModelTiers.candidates(pool, { exclude: ["openai/gpt-5.mini"] }).candidates.map((item) => item.modelID),
    ).toEqual(["gpt-5", "gpt-5xmini"])
    expect(AutoModelTiers.candidates(pool, { exclude: ["*"] }).candidates).toHaveLength(0)
  })

  test("freeOnly keeps only free models and counts every paid model as not-free", () => {
    const result = AutoModelTiers.candidates(
      providers([model("a", 1), model("a:free", 0), model("~alias", 1)]),
      { freeOnly: true },
    )
    expect(result.candidates.map((item) => item.modelID)).toEqual(["a:free"])
    expect(result.excluded["not-free"]).toBe(2)
    expect(result.excluded.alias).toBe(0)
  })
})

describe("AutoModelTiers.buildTiers and pick", () => {
  test("splits candidates into equal thirds by price", () => {
    const tiers = AutoModelTiers.buildTiers([6, 1, 5, 2, 4, 3].map((price) => candidate(`m${price}`, price)))
    expect(tiers.simple.map((item) => item.modelID)).toEqual(["m1", "m2"])
    expect(tiers.moderate.map((item) => item.modelID)).toEqual(["m3", "m4"])
    expect(tiers.complex.map((item) => item.modelID)).toEqual(["m5", "m6"])
  })

  test("uses rounded boundaries for uneven counts", () => {
    const tiers = AutoModelTiers.buildTiers([1, 2, 3, 4, 5, 6, 7].map((price) => candidate(`m${price}`, price)))
    expect([tiers.simple.length, tiers.moderate.length, tiers.complex.length]).toEqual([2, 3, 2])
  })

  test("fills every tier when fewer than three candidates exist", () => {
    const one = AutoModelTiers.buildTiers([candidate("only", 1)])
    expect([one.simple, one.moderate, one.complex].map((tier) => tier[0].modelID)).toEqual(["only", "only", "only"])
    const two = AutoModelTiers.buildTiers([candidate("b", 2), candidate("a", 1)])
    expect([two.simple, two.moderate, two.complex].map((tier) => tier[0].modelID)).toEqual(["a", "b", "b"])
  })

  test("breaks price ties by provider/model ID", () => {
    const tiers = AutoModelTiers.buildTiers([candidate("z", 1), candidate("a", 1, "zeta"), candidate("a", 1)])
    expect(tiers.simple.map((item) => `${item.providerID}/${item.modelID}`)).toEqual(["openai/a"])
  })

  test("picks the cheapest simple, the middle moderate, and the priciest complex model", () => {
    const tiers = AutoModelTiers.buildTiers([1, 2, 3, 4, 5, 6, 7, 8, 9].map((price) => candidate(`m${price}`, price)))
    expect(AutoModelTiers.pick(tiers, "simple")?.modelID).toBe("m1")
    expect(AutoModelTiers.pick(tiers, "moderate")?.modelID).toBe("m5")
    expect(AutoModelTiers.pick(tiers, "complex")?.modelID).toBe("m9")
    expect(AutoModelTiers.pick({ simple: [], moderate: [], complex: [] }, "simple")).toBeUndefined()
  })
})
