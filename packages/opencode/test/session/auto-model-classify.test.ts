import { describe, expect, test } from "bun:test"
import { AutoModelClassify } from "../../src/session/auto-model-classify"

const text = (value: string) => [{ type: "text" as const, text: value }]
const file = (mime: string) => ({ type: "file" as const, mime, url: "file:///tmp/x" })

describe("AutoModelClassify.classify tiers", () => {
  test("empty or synthetic-only input is simple", () => {
    expect(AutoModelClassify.classify([])).toEqual({ tier: "simple", score: 0, signals: ["empty"] })
    expect(AutoModelClassify.classify([{ type: "text", text: "refactor everything", synthetic: true }]).tier).toBe(
      "simple",
    )
  })

  test("trivial edits and questions are simple", () => {
    expect(AutoModelClassify.classify(text("fix the typo in the README")).tier).toBe("simple")
    expect(AutoModelClassify.classify(text("rename getUser to fetchUser")).tier).toBe("simple")
    const question = AutoModelClassify.classify(text("what does this function do?"))
    expect(question.tier).toBe("simple")
    expect(question.signals).toContain("question(-1)")
  })

  test("feature and bug-fix work is moderate", () => {
    expect(AutoModelClassify.classify(text("add a retry flag to the CLI")).tier).toBe("moderate")
    expect(AutoModelClassify.classify(text("Add Tests for the parser")).tier).toBe("moderate")
    expect(AutoModelClassify.classify(text("the login handler throws on empty input")).tier).toBe("moderate")
  })

  test("architectural work is complex", () => {
    const result = AutoModelClassify.classify(
      text("Refactor the auth module and migrate the session store to the new architecture"),
    )
    expect(result.tier).toBe("complex")
    // Three complex keywords are worth 9 but capped at 6.
    expect(result.signals).toContain("keyword-cap(-3)")
    expect(result.score).toBe(6)
  })
})

describe("AutoModelClassify.classify signals", () => {
  test("logged signal weights always sum to the score", () => {
    const prompts = [
      "fix the typo",
      "what is this? explain the comment, remove unused imports, and delete the old lint config",
      "add a cache to the API endpoint",
      "investigate the race condition across the codebase then optimize performance",
    ]
    prompts.forEach((prompt) => {
      const result = AutoModelClassify.classify(text(prompt))
      const sum = result.signals
        .map((signal) => Number(signal.match(/\(([+-]\d+)\)$/)![1]))
        .reduce((total, weight) => total + weight, 0)
      expect(sum).toBe(result.score)
      expect(result.score).toBeGreaterThanOrEqual(0)
    })
  })

  test("negative scores are clamped to zero", () => {
    const result = AutoModelClassify.classify(text("explain this comment?"))
    expect(result.score).toBe(0)
    expect(result.signals.some((signal) => signal.startsWith("clamp("))).toBe(true)
  })

  test("keywords match whole words, case-insensitively, with plurals", () => {
    expect(AutoModelClassify.classify(text("show the latest version")).signals).not.toContain("keyword:test(+2)")
    expect(AutoModelClassify.classify(text("run the TESTS")).signals).toContain("keyword:test(+2)")
  })

  test("length buckets", () => {
    expect(AutoModelClassify.classify(text("x".repeat(250))).signals).toContain("length:250(+1)")
    expect(AutoModelClassify.classify(text("x".repeat(1500))).signals).toContain("length:1500(+2)")
    expect(AutoModelClassify.classify(text("x".repeat(5000))).signals).toContain("length:5000(+3)")
  })

  test("counts list lines, sequencing words, and serial enumerations as steps", () => {
    const list = AutoModelClassify.classify(text("- update foo\n- update bar\n- update baz\n- update qux"))
    expect(list.signals).toContain("steps:4(+3)")
    expect(list.tier).toBe("moderate")
    expect(AutoModelClassify.classify(text("update foo then update bar")).signals).toContain("steps:2(+1)")
    expect(AutoModelClassify.classify(text("update foo, bar, and baz")).signals).toContain("steps:3(+2)")
  })

  test("pasted code and stack frames do not contribute prose keywords", () => {
    const code = AutoModelClassify.classify(text("```\nrefactor(); migrate(); redesign()\n```"))
    expect(code.signals).toContain("code-block(+1)")
    expect(code.signals.some((signal) => signal.startsWith("keyword:"))).toBe(false)
    expect(code.tier).toBe("simple")

    const trace = AutoModelClassify.classify(text("TypeError: boom\n    at next (router.js:12:3)\n    at then (a.js:1:1)"))
    expect(trace.signals).toContain("stack-trace(+1)")
    expect(trace.signals.some((signal) => signal.startsWith("steps:"))).toBe(false)
  })

  test("value swaps and quoted literals lower the score", () => {
    expect(AutoModelClassify.classify(text("change the timeout from 60 to 300")).signals).toContain("value-swap(-1)")
    expect(AutoModelClassify.classify(text('change the label "Save" to "Submit"')).signals).toContain(
      "quoted-literal(-1)",
    )
    // Contractions never pair up as a quoted literal.
    expect(AutoModelClassify.classify(text("it doesn't work and it's broken")).signals).not.toContain(
      "quoted-literal(-1)",
    )
  })

  test("a single pair of quotes around the whole prompt is stripped", () => {
    expect(AutoModelClassify.classify(text('"rename foo to bar"')).signals).not.toContain("quoted-literal(-1)")
  })

  test("attachments and agent mentions add weight", () => {
    const result = AutoModelClassify.classify([
      ...text("look at these"),
      file("text/plain"),
      file("text/plain"),
      file("application/x-directory"),
      file("image/png"),
      { type: "agent", name: "explore" },
    ])
    expect(result.signals).toEqual(
      expect.arrayContaining(["files:4(+2)", "directory(+2)", "image(+1)", "agent(+1)"]),
    )
    expect(result.tier).toBe("complex")
    expect(AutoModelClassify.classify([...text("compare"), file("text/plain"), file("text/plain")]).signals).toContain(
      "files:2(+1)",
    )
  })
})
