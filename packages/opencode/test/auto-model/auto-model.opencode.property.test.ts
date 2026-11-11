import { afterAll, describe, expect, test } from "bun:test"
import fc from "fast-check"
import { classify, TIERS, type Tier } from "../../src/session/auto-model-classify"
import type { SessionPrompt } from "../../src/session/prompt"

// Fixed seed so every run (including each Stryker mutant run) sees the same generated inputs.
fc.configureGlobal({ seed: 42 })

type Parts = SessionPrompt.PromptInput["parts"]
const rank = (t: Tier) => TIERS.indexOf(t)
const textPart = (text: string) => ({ type: "text" as const, text })
const filePart = (name: string, mime = "text/plain") => ({
  type: "file" as const,
  mime,
  filename: name,
  url: `file:///repo/${name}`,
})
const toParts = (...p: object[]) => p as unknown as Parts
const RUNS = { numRuns: 500 }

// ---------- Shared generators ----------

// Real-looking identifiers a developer would ask about. A few contain moderate
// keywords ("flag", "test") on purpose, so the base prompts cover more than one tier.
const identifier = fc.constantFrom(
  "git status",
  "ls -la",
  "the parseArgs function",
  "README.md",
  "the useEffect hook",
  "Array.prototype.map",
  "the --verbose flag",
  "bun test",
  "SessionPrompt.prompt",
  "the .env file",
  "the API endpoint handler",
  "the CLI --verbose flag",
  "the test config",
)

// Short factual or yes/no questions that don't ask to change code (low tier).
const factualQuestion = fc
  .tuple(
    fc.constantFrom(
      (x: string) => `What does ${x} do?`,
      (x: string) => `What is ${x}?`,
      (x: string) => `Explain what ${x} does.`,
      (x: string) => `Is ${x} async?`,
      (x: string) => `Does ${x} need sudo?`,
    ),
    identifier,
  )
  .map(([template, x]) => template(x))

// Design/refactor tasks spanning several parts of the code (high tier).
const complexVerb = fc.constantFrom("design", "implement", "refactor", "redesign", "migrate", "rewrite")
const component = fc.constantFrom(
  "a caching layer for the session module",
  "the auth middleware",
  "the storage layer",
  "the plugin loader",
  "prompt.ts",
  "the config parser",
  "the websocket client",
  "the test config",
)
const designTask = fc
  .tuple(fc.uniqueArray(complexVerb, { minLength: 2, maxLength: 3 }), fc.array(component, { minLength: 3, maxLength: 3 }))
  .map(([verbs, things]) => verbs.map((v, i) => `${v} ${things[i]}`).join(", then "))

// A mix of simple, moderate, and complex prompts, used as the base prompt in R3.
// Strengthened: prompt kinds whose tier R2 already fixes carry that tier as an
// anchor (factual questions are low, multi-part design tasks are high). The other
// kinds have no requirement-defined tier, so they stay unanchored.
const basePrompt = fc.oneof(
  factualQuestion.map((text) => ({ text, expected: "simple" as Tier | undefined })),
  designTask.map((text) => ({ text, expected: "complex" as Tier | undefined })),
  identifier.map((x) => ({ text: `fix the typo in ${x}`, expected: undefined })),
  identifier.map((x) => ({ text: `write unit tests for ${x}`, expected: undefined })),
  identifier.map((x) => ({ text: `add a retry to ${x}`, expected: undefined })),
)

// ---------- R3 ----------
// R3: Appending a stack trace, a code block, additional file attachments, or
// additional task steps to a prompt never lowers its tier.
// Kind: metamorphic
describe("R3: adding context never lowers the tier", () => {
  // Stack traces: 1–200 frames (the acceptance criterion uses 200 lines), in both
  // JS and Python styles, with realistic error headers. A naive generator would
  // append random text, which isn't what users paste and can contain words that
  // legitimately make a task simpler.
  const errorHeader = fc.constantFrom(
    "TypeError: Cannot read properties of undefined (reading 'id')",
    "RangeError: Maximum call stack size exceeded",
    "Error: ENOENT: no such file or directory, open 'settings.json'",
    "SyntaxError: Unexpected token '<'",
  )
  const jsFrame = fc
    .tuple(
      fc.constantFrom("loadUser", "parse", "main", "run", "dispatch"),
      fc.constantFrom("src/server.ts", "src/db.ts", "lib/util.js"),
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 1, max: 80 }),
    )
    .map(([fn, file, line, col]) => `    at ${fn} (${file}:${line}:${col})`)
  const jsTrace = fc
    .tuple(errorHeader, fc.array(jsFrame, { minLength: 1, maxLength: 200 }))
    .map(([header, frames]) => [header, ...frames].join("\n"))
  // Function names include "delete" and "remove": real tracebacks name whatever
  // function failed, and a frame that happens to read like an instruction is
  // still pasted machine text, not a request.
  const pyTrace = fc
    .array(
      fc.tuple(
        fc.constantFrom("app.py", "models.py"),
        fc.integer({ min: 1, max: 500 }),
        fc.constantFrom("load", "save", "delete", "remove"),
      ),
      { minLength: 1, maxLength: 200 },
    )
    .map((frames) =>
      [
        "Traceback (most recent call last):",
        ...frames.map(([f, l, fn]) => `  File "${f}", line ${l}, in ${fn}`),
        "KeyError: 'user_id'",
      ].join("\n"),
    )
  // Code lines include calls like `list.remove(item)` and `format(...)`: pasted
  // code uses ordinary identifiers that look like simple-edit words, and they
  // must not make the request look simpler than it was.
  const codeBlock = fc
    .array(
      fc.constantFrom(
        "const user = await db.get(id)",
        "return user.id",
        "if (!res.ok) throw err",
        "list.remove(item)",
        "return format(user.createdAt)",
      ),
      { minLength: 1, maxLength: 30 },
    )
    .map((lines) => "```ts\n" + lines.join("\n") + "\n```")
  const extraSteps = fc.constantFrom(
    "and also update the tests and docs",
    "then update the changelog",
    "and also add a migration note to the README",
  )
  const extraFiles = fc.array(fc.constantFrom("src/a.ts", "src/b.ts", "src/c.ts", "docs/guide.md"), {
    minLength: 1,
    maxLength: 4,
  })

  type Prompt = { text: string; files: string[] }
  type Addition =
    | { kind: "stack trace" | "code block" | "steps"; value: string }
    | { kind: "files"; value: string[] }
  const addition = fc.oneof(
    fc.oneof(jsTrace, pyTrace).map((value) => ({ kind: "stack trace" as const, value })),
    codeBlock.map((value) => ({ kind: "code block" as const, value })),
    extraSteps.map((value) => ({ kind: "steps" as const, value })),
    extraFiles.map((value) => ({ kind: "files" as const, value })),
  )
  const apply = (p: Prompt, a: Addition): Prompt =>
    a.kind === "files"
      ? { ...p, files: [...p.files, ...a.value] }
      : { ...p, text: `${p.text}${a.kind === "steps" ? " " : "\n"}${a.value}` }
  const tierOf = (p: Prompt) =>
    classify(toParts(textPart(p.text), ...p.files.map((f) => filePart(f)))).tier

  test("P plus added context gets a tier >= P's tier", () => {
    fc.assert(
      fc.property(
        basePrompt,
        fc.array(fc.constantFrom("src/x.ts"), { maxLength: 1 }),
        addition,
        (base, files, add) => {
          const before: Prompt = { text: base.text, files }
          const after = apply(before, add)
          // "after >= before" alone holds for a classifier that returns the same
          // tier for everything, so anchor the starting point first.
          if (base.expected) expect(tierOf(before)).toBe(base.expected)
          expect(rank(tierOf(after))).toBeGreaterThanOrEqual(rank(tierOf(before)))
        },
      ),
      RUNS,
    )
  })
})

// Prints a line in CI logs, which only list failing tests, so the PR's test
// log shows this property ran.
afterAll(() => {
  console.log("auto-model property tests ran: R3 (1 property, 500 runs)")
})
