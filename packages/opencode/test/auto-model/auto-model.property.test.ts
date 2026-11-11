import { afterAll, describe, expect, test } from "bun:test"
import fc from "fast-check"
import { classify, TIERS, type Tier } from "../../src/session/auto-model-classify"
import { next } from "../../src/session/auto-model-hysteresis"
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
// keywords ("flag", "test") on purpose, so R2 checks that a question stays low
// even when it mentions something that sounds like work. The last three name
// several work-sounding things at once ("API", "endpoint", "handler"), so a
// question about them only stays low if repeated keywords don't stack up.
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

// Multi-file change requests: the same change applied across several files.
// Users say this two ways, so both are generated: by naming 4–5 files (with the
// files attached), or with a scope phrase ("everywhere", "across the codebase")
// and no file list. A naive generator would name one file, which isn't what
// R2's "change multiple files" means.
const fileName = fc.constantFrom("src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts")
const changeAction = fc.constantFrom("update the logging", "switch the date library", "add error handling")
const multiFileChange = fc.oneof(
  fc
    .tuple(changeAction, fc.uniqueArray(fileName, { minLength: 4, maxLength: 5 }))
    .map(([action, files]) => ({ text: `${action} in ${files.join(", ")}`, files })),
  fc
    .tuple(changeAction, fc.constantFrom("everywhere", "across the codebase", "in all files", "in every file"))
    .map(([action, scope]) => ({ text: `${action} ${scope}`, files: [] as string[] })),
)

// Short factual or yes/no questions that don't ask to change code (R2 low tier).
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

// Design/refactor tasks spanning several parts of the code (R2 high tier).
// A naive generator would produce one verb and one target; real high-tier asks
// combine 2–3 distinct actions on different components, joined by "then".
const complexVerb = fc.constantFrom("design", "implement", "refactor", "redesign", "migrate", "rewrite")
const component = fc.constantFrom(
  "a caching layer for the session module",
  "the auth middleware",
  "the storage layer",
  "the plugin loader",
  "prompt.ts",
  "the config parser",
  "the websocket client",
)
const designTask = fc
  .tuple(fc.uniqueArray(complexVerb, { minLength: 2, maxLength: 3 }), fc.array(component, { minLength: 3, maxLength: 3 }))
  .map(([verbs, things]) => verbs.map((v, i) => `${v} ${things[i]}`).join(", then "))

// A mix of simple, moderate, and complex prompts, used as the "before" prompt in R3.
const basePrompt = fc.oneof(
  factualQuestion,
  designTask,
  identifier.map((x) => `fix the typo in ${x}`),
  identifier.map((x) => `write unit tests for ${x}`),
  identifier.map((x) => `add a retry to ${x}`),
)

// ---------- R1 ----------

// R1: The classifier is deterministic: the same prompt and context give the same
// tier on every run. Each pair in a fixed list of paraphrase pairs gives the same
// tier for both prompts in the pair.
// Kind: invariant
describe("R1: classifier is deterministic", () => {
  // Generator: realistic prompts, arbitrary strings, and edge cases (empty text,
  // a lone "?", an unclosed code fence, a very long prompt), combined with file
  // and image attachments and a synthetic editor-context part, since the
  // classifier reads all of these.
  const anyText = fc.oneof(
    factualQuestion,
    designTask,
    basePrompt,
    fc.string({ maxLength: 400 }),
    fc.constantFrom("", "?", "```", "a".repeat(5000)),
  )
  const anyParts = fc
    .tuple(anyText, fc.array(fc.constantFrom("src/a.ts", "src/b.ts", "shot.png"), { maxLength: 5 }), fc.boolean())
    .map(([text, files, withSynthetic]) =>
      toParts(
        textPart(text),
        ...(withSynthetic ? [{ type: "text", text: "<editor context>", synthetic: true }] : []),
        ...files.map((f) => filePart(f, f.endsWith(".png") ? "image/png" : "text/plain")),
      ),
    )

  test("same input gives the same result on 10 runs", () => {
    fc.assert(
      fc.property(anyParts, (parts) => {
        const first = classify(parts)
        // A result with no valid tier can't be routed, and would still pass the
        // equality checks below because it is wrong the same way every run.
        expect(TIERS).toContain(first.tier)
        for (let i = 0; i < 10; i++) expect(classify(structuredClone(parts))).toEqual(first)
        expect(classify(parts)).toEqual(first) // classify must not mutate its input
      }),
      RUNS,
    )
  })

  // `opencode run "<prompt>"` delivers a multi-word prompt wrapped in one pair of
  // literal quotes. That is the same prompt, so it must get the same tier.
  // Kind: metamorphic
  test("wrapping the whole prompt in one pair of quotes doesn't change the tier", () => {
    fc.assert(
      fc.property(basePrompt, fc.constantFrom('"', "'"), (prompt, quote) => {
        expect(classify(toParts(textPart(`${quote}${prompt}${quote}`))).tier).toBe(
          classify(toParts(textPart(prompt))).tier,
        )
      }),
      RUNS,
    )
  })

  // The fixed paraphrase list from the revised R1 acceptance criteria.
  const PARAPHRASE_PAIRS: [string, string][] = [
    ["fix the typo in README.md", "please correct the README.md typo"],
    ["what does git status do?", "explain what git status does"],
    ["rename utils.ts to helpers.ts", "change the name of utils.ts to helpers.ts"],
  ]
  test("each paraphrase pair gets the same tier", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PARAPHRASE_PAIRS), ([a, b]) => {
        expect(classify(toParts(textPart(a))).tier).toBe(classify(toParts(textPart(b))).tier)
      }),
    )
  })
})

// ---------- R2 ----------

// R2: Short factual or yes/no questions that don't ask to change code get the
// low tier. Prompts asking to design, refactor, or change multiple files get the
// high tier.
// Kind: invariant
describe("R2: questions are low tier, design/refactor tasks are high tier", () => {
  test("every generated factual question is low tier", () => {
    fc.assert(
      fc.property(factualQuestion, (q) => {
        expect(classify(toParts(textPart(q))).tier).toBe("simple")
      }),
      RUNS,
    )
  })

  test("every generated multi-part design/refactor task is high tier", () => {
    fc.assert(
      fc.property(designTask, (task) => {
        expect(classify(toParts(textPart(task))).tier).toBe("complex")
      }),
      RUNS,
    )
  })

  test("every generated multi-file change request (4+ named files or a codebase-wide scope) is at least moderate", () => {
    fc.assert(
      fc.property(multiFileChange, ({ text, files }) => {
        const tier = classify(toParts(textPart(text), ...files.map((f) => filePart(f)))).tier
        expect(rank(tier)).toBeGreaterThanOrEqual(rank("moderate"))
      }),
      RUNS,
    )
  })
})
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
      { minLength: 1, maxLength: 100 },
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
  const addition = fc.oneof(
    fc.oneof(jsTrace, pyTrace).map((value) => ({ kind: "stack trace" as const, value })),
    codeBlock.map((value) => ({ kind: "code block" as const, value })),
    extraSteps.map((value) => ({ kind: "steps" as const, value })),
    extraFiles.map((value) => ({ kind: "files" as const, value })),
  )
  type Addition = { kind: "stack trace" | "code block" | "steps"; value: string } | { kind: "files"; value: string[] }
  const apply = (p: Prompt, a: Addition): Prompt =>
    a.kind === "files"
      ? { ...p, files: [...p.files, ...a.value] }
      : { ...p, text: `${p.text}${a.kind === "steps" ? " " : "\n"}${a.value}` }
  const tierOf = (p: Prompt) => classify(toParts(textPart(p.text), ...p.files.map((f) => filePart(f)))).tier

  test("P plus added context gets a tier >= P's tier", () => {
    fc.assert(
      fc.property(
        basePrompt,
        fc.array(fc.constantFrom("src/x.ts"), { maxLength: 1 }),
        addition,
        (text, files, add) => {
          const before: Prompt = { text, files }
          const after = apply(before, add)
          expect(rank(tierOf(after))).toBeGreaterThanOrEqual(rank(tierOf(before)))
        },
      ),
      RUNS,
    )
  })
})

// ---------- R7 ----------

// Generator for tier sequences. Uniform random tiers rarely produce the cases R7
// is about (an upgrade followed by three lower prompts, or a streak broken by an
// equal prompt), so sequences are built from runs of 1–4 repeated tiers.
const tierArb = fc.constantFrom<Tier>(...TIERS)
const tierSequence = fc
  .array(fc.record({ tier: tierArb, length: fc.integer({ min: 1, max: 4 }) }), { maxLength: 12 })
  .map((runs) => runs.flatMap((r) => Array<Tier>(r.length).fill(r.tier)))

// Runs the real state machine. State is round-tripped through JSON between calls
// because in the app it is stored in session metadata on disk.
function actual(seq: readonly Tier[]): Tier[] {
  let state: unknown = undefined
  return seq.map((tier) => {
    const result = next(state, tier)
    state = JSON.parse(JSON.stringify(result.state))
    return result.toTier
  })
}

// Oracle: a direct restatement of R7 that keeps the full list of lower prompts
// instead of the real implementation's validated summary state.
function reference(seq: readonly Tier[]): Tier[] {
  const out: Tier[] = []
  let active: Tier | undefined
  let lowers: Tier[] = []
  for (const p of seq) {
    if (active === undefined || rank(p) > rank(active)) {
      active = p
      lowers = []
    } else if (p === active) {
      lowers = []
    } else {
      lowers.push(p)
      if (lowers.length === 3) {
        active = lowers.reduce((a, b) => (rank(b) > rank(a) ? b : a))
        lowers = []
      }
    }
    out.push(active)
  }
  return out
}

// R7: After a high-tier turn, the next two lower-tier prompts stay on the high
// tier. The tier drops only after three consecutive lower-tier prompts, to the
// highest tier among those three.
// Kind: model / oracle
describe("R7: hysteresis matches the reference", () => {
  test("active tier matches the reference for any prompt sequence", () => {
    fc.assert(
      fc.property(tierSequence, (seq) => {
        expect(actual(seq)).toEqual(reference(seq))
      }),
      RUNS,
    )
  })
})

// R7: After a high-tier turn, the next two lower-tier prompts stay on the high
// tier. The tier drops only after three consecutive lower-tier prompts, to the
// highest tier among those three. (Checks the acceptance criteria directly.)
// Kind: invariant
describe("R7: two follow-ups stay high, the third drops", () => {
  const lowerTier = fc.constantFrom<Tier>("simple", "moderate")
  test("after any history, a high prompt holds for two lower prompts and drops on the third", () => {
    fc.assert(
      fc.property(tierSequence, lowerTier, lowerTier, lowerTier, (prefix, l1, l2, l3) => {
        const seq = [...prefix, "complex" as Tier, l1, l2, l3]
        const out = actual(seq)
        const k = prefix.length
        expect(out[k]).toBe("complex")
        expect(out[k + 1]).toBe("complex")
        expect(out[k + 2]).toBe("complex")
        expect(out[k + 3]).toBe([l1, l2, l3].reduce((a, b) => (rank(b) > rank(a) ? b : a)))
      }),
      RUNS,
    )
  })
})

// R7: The hysteresis state lives in session metadata on disk, so it can come back
// corrupted (hand-edited, truncated, or written by another version). A corrupt
// state must not hold the session on a stale tier or count a bogus streak: it
// must behave exactly like a session with no saved state.
// Kind: invariant
describe("R7: corrupt saved state behaves like no saved state", () => {
  // Each branch breaks exactly one rule of a valid state, built so the result is
  // invalid by construction rather than by re-checking it with the code's own
  // validation. "complex" is used as the state tier wherever a streak of lower
  // tiers is needed, since only it has two tiers below it.
  const lower = fc.constantFrom<Tier>("simple", "moderate")
  const corruptState = fc.oneof(
    // not an object at all
    fc.constantFrom<unknown>(null, 0, "complex", true, []),
    // tier missing or not a tier name
    fc.constantFrom<unknown>("ultra", "", "Complex", 2, null).map((tier) => ({ tier, streak: 0, streakTiers: [] })),
    fc.constant({ streak: 0, streakTiers: [] }),
    // streak not a non-negative integer below the downgrade threshold
    fc
      .tuple(fc.constantFrom<unknown>(-1, 1.5, 3, 4, "1", null), fc.array(lower, { maxLength: 4 }))
      .map(([streak, streakTiers]) => ({ tier: "complex", streak, streakTiers })),
    fc.constant({ tier: "complex", streakTiers: [] }),
    // streakTiers missing or not an array
    fc.constantFrom<unknown>("simple", null, {}).map((streakTiers) => ({ tier: "complex", streak: 1, streakTiers })),
    fc.constant({ tier: "complex", streak: 0 }),
    // streak count disagrees with the recorded streak
    fc
      .tuple(fc.integer({ min: 0, max: 2 }), fc.array(lower, { maxLength: 3 }))
      .filter(([streak, streakTiers]) => streakTiers.length !== streak)
      .map(([streak, streakTiers]) => ({ tier: "complex", streak, streakTiers })),
    // streak records something that isn't a tier
    fc.constantFrom<unknown>("ultra", 1, null).map((bad) => ({ tier: "complex", streak: 1, streakTiers: [bad] })),
    // streak records a prompt that wasn't lower than the active tier
    fc.constantFrom(
      { tier: "simple", streak: 1, streakTiers: ["simple"] },
      { tier: "moderate", streak: 1, streakTiers: ["complex"] },
      { tier: "moderate", streak: 2, streakTiers: ["simple", "moderate"] },
      { tier: "complex", streak: 1, streakTiers: ["complex"] },
    ),
  )

  test("next(corrupt, tier) gives the same result as next(undefined, tier)", () => {
    fc.assert(
      fc.property(corruptState, tierArb, (state, tier) => {
        expect(next(state, tier)).toEqual(next(undefined, tier))
      }),
      RUNS,
    )
  })
})

// Prints a line in CI logs, which only list failing tests, so the PR's test
// log shows these properties ran.
afterAll(() => {
  console.log("auto-model property tests ran: R1, R2, R3, R7 (10 properties, 500 runs each)")
})