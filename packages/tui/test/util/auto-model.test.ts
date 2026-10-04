import { describe, expect, test } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2"
import {
  effectiveAutoEnabled,
  getAutoModelLast,
  mergeAutoModelMetadata,
  writeAutoModelToSession,
} from "../../src/util/auto-model"

// Only `metadata` is read by these helpers.
const session = (metadata: Record<string, unknown> | undefined) => ({ metadata }) as Session

describe("util.auto-model effectiveAutoEnabled", () => {
  const enabledConfig = { autoModel: { enabled: true } }

  test("defaults to off", () => {
    expect(effectiveAutoEnabled(undefined, undefined, {}, undefined)).toBe(false)
    expect(effectiveAutoEnabled("ses", session(undefined), undefined, undefined)).toBe(false)
  })

  test("falls back to config", () => {
    expect(effectiveAutoEnabled(undefined, undefined, enabledConfig, undefined)).toBe(true)
    expect(effectiveAutoEnabled("ses", session({}), enabledConfig, undefined)).toBe(true)
  })

  test("session metadata overrides config once a session exists", () => {
    expect(effectiveAutoEnabled("ses", session({ autoModel: { enabled: false } }), enabledConfig, true)).toBe(false)
    expect(effectiveAutoEnabled("ses", session({ autoModel: { enabled: true } }), {}, false)).toBe(true)
  })

  test("the pending toggle overrides config before a session exists", () => {
    expect(effectiveAutoEnabled(undefined, undefined, enabledConfig, false)).toBe(false)
    expect(effectiveAutoEnabled(undefined, undefined, {}, true)).toBe(true)
  })

  test("ignores malformed values", () => {
    expect(effectiveAutoEnabled("ses", session({ autoModel: { enabled: "yes" } }), { autoModel: null }, true)).toBe(
      false,
    )
  })
})

describe("util.auto-model getAutoModelLast", () => {
  test("returns the last routed model for the footer label", () => {
    expect(getAutoModelLast(session({ autoModel: { last: { providerID: "openai", modelID: "gpt" } } }))).toEqual({
      providerID: "openai",
      modelID: "gpt",
    })
  })

  test("returns undefined when missing or malformed", () => {
    expect(getAutoModelLast(undefined)).toBeUndefined()
    expect(getAutoModelLast(session({ autoModel: { last: { providerID: 1, modelID: "gpt" } } }))).toBeUndefined()
  })
})

describe("util.auto-model mergeAutoModelMetadata", () => {
  const current = {
    other: 1,
    autoModel: { enabled: false, state: { tier: "complex" }, last: { providerID: "a", modelID: "b" } },
  }

  test("preserves unrelated keys and routing state when disabling", () => {
    expect(mergeAutoModelMetadata(current, { enabled: false })).toEqual({
      ...current,
      autoModel: { ...current.autoModel, enabled: false },
    })
  })

  test("clears hysteresis state and last model when enabling with reset", () => {
    expect(mergeAutoModelMetadata(current, { enabled: true, resetState: true })).toEqual({
      other: 1,
      autoModel: { enabled: true, state: undefined, last: undefined },
    })
  })

  test("works without existing metadata", () => {
    expect(mergeAutoModelMetadata(undefined, { enabled: true })).toEqual({ autoModel: { enabled: true } })
  })
})

describe("util.auto-model writeAutoModelToSession", () => {
  test("writes the merged metadata through the session update function", async () => {
    const calls: unknown[] = []
    await writeAutoModelToSession((params) => calls.push(params), "ses_1", { other: 1 }, { enabled: true })
    expect(calls).toEqual([{ sessionID: "ses_1", metadata: { other: 1, autoModel: { enabled: true } } }])
  })
})
