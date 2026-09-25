import { describe, expect, test } from "bun:test"
import { parseTokens } from "../../src/component/dialog-budget"

describe("parseTokens", () => {
  test("parses plain numbers", () => {
    expect(parseTokens("500000")).toBe(500000)
  })

  test("parses k and m suffixes", () => {
    expect(parseTokens("500k")).toBe(500_000)
    expect(parseTokens("1.5m")).toBe(1_500_000)
    expect(parseTokens("2M")).toBe(2_000_000)
  })

  test("ignores separators and surrounding space", () => {
    expect(parseTokens(" 1,000,000 ")).toBe(1_000_000)
    expect(parseTokens("1_000")).toBe(1000)
  })

  test("returns undefined for empty or invalid input", () => {
    expect(parseTokens("")).toBeUndefined()
    expect(parseTokens("   ")).toBeUndefined()
    expect(parseTokens("abc")).toBeUndefined()
    expect(parseTokens("10x")).toBeUndefined()
    expect(parseTokens("1.2.3")).toBeUndefined()
  })
})
