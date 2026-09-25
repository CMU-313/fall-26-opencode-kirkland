import type { SessionPrompt } from "@/session/prompt"

export type Tier = "simple" | "moderate" | "complex"
export const TIERS: readonly Tier[] = ["simple", "moderate", "complex"]

// Length of the combined non-synthetic text, checked from the top down. Pasted logs are expanded inline by the TUI,
// so the largest bucket is a hard cap rather than a scale.
const LENGTH_WEIGHTS = [
  { min: 4000, weight: 3 },
  { min: 1000, weight: 2 },
  { min: 200, weight: 1 },
]

const MULTI_STEP_WEIGHTS = [
  { min: 4, weight: 3 },
  { min: 3, weight: 2 },
  { min: 2, weight: 1 },
]

const COMPLEX_KEYWORD_WEIGHT = 3
const COMPLEX_KEYWORD_CAP = 6
const COMPLEX_KEYWORDS = [
  "refactor",
  "architecture",
  "redesign",
  "migrate",
  "migration",
  "implement",
  "design",
  "debug",
  "investigate",
  "optimize",
  "performance",
  "race condition",
  "concurrency",
  "security",
  "across the codebase",
  "entire codebase",
  "all files",
  "end-to-end",
  "integrate",
  "rewrite",
  "leak",
  "split",
  "replace",
  "figure out why",
  "find out why",
  "every",
  "everywhere",
]

// Words that name a unit of real feature or bug-fix work: a behavior, an interface surface, or a failure symptom.
// Any one of them lifts a prompt out of the trivial-edit tier.
const MODERATE_KEYWORD_WEIGHT = 2
const MODERATE_KEYWORD_CAP = 2
const MODERATE_KEYWORDS = [
  "add a",
  "add an",
  "write a",
  "create a",
  "test",
  "endpoint",
  "handler",
  "middleware",
  "api",
  "cli",
  "flag",
  "config",
  "schema",
  "validation",
  "pagination",
  "cache",
  "retry",
  "toggle",
  "persist",
  "doesn't",
  "fails",
  "throws",
  "crash",
  "broken",
  "wrong",
]

const SIMPLE_KEYWORD_WEIGHT = -1
const SIMPLE_KEYWORD_CAP = -2
// Inflections are listed explicitly because matching only allows a plural "s" ("comments").
const SIMPLE_KEYWORDS = [
  "rename",
  "typo",
  "comment",
  "explain",
  "what does",
  "what is",
  "format",
  "formatter",
  "lint",
  "linter",
  "linting",
  "bump",
  "add a log",
  "delete",
  "remove",
  "unused",
]

// A literal numeric swap ("from 60 to 300") or a quoted target string pins the edit down to a known value.
const VALUE_SWAP_WEIGHT = -1
const QUOTED_LITERAL_WEIGHT = -1

const CODE_BLOCK_WEIGHT = 1
const STACK_TRACE_WEIGHT = 1

const FEW_FILES_WEIGHT = 1
const FEW_FILES_MIN = 2
const MANY_FILES_WEIGHT = 2
const MANY_FILES_MIN = 4
const DIRECTORY_WEIGHT = 2
const IMAGE_WEIGHT = 1

const AGENT_WEIGHT = 1

const QUESTION_WEIGHT = -1
const QUESTION_MAX_LENGTH = 200

const MODERATE_MIN_SCORE = 2
const COMPLEX_MIN_SCORE = 5

const SENTENCE_SPLIT = /[.;:!?\n]+/
const ENUMERATION_PATTERN = /,\s*(?:and|or)\s/i
const SEQUENCE_PATTERN = /\b(?:after that|and then|then|also|finally|next)\b/gi
const LIST_LINE_PATTERN = /^\s*(?:\d+[.)]|[-*•])\s+\S/gm
// JS/Java-style frames ("    at fn (file.ts:12:3)") or a Python traceback header.
const STACK_TRACE_PATTERN = /^\s+at\s.*:\d+(?::\d+)?\)?\s*$|\bTraceback\b/m
// Pasted code and stack frames are machine text: frames like "at next (router.js:1:1)" would otherwise read as
// sequencing words and keywords. Prose signals ignore them; length and stack-trace detection still see them.
const VALUE_SWAP_PATTERN = /\bfrom\s+\d+\S*\s+to\s+\d+/i
// Paired quotes that open after whitespace, so contractions like "doesn't ... it's" never pair up.
const QUOTED_LITERAL_PATTERN = /(?:^|\s)['"][^'"]+['"](?=\W|$)/
const CODE_FENCE_PATTERN = /```[\s\S]*?(?:```|$)/g
const STACK_FRAME_PATTERN = /^\s+(?:at\s|File ".*", line \d+).*$/gm

export function classify(parts: SessionPrompt.PromptInput["parts"]) {
  const text = stripOuterQuotes(
    parts
      .flatMap((part) => (part.type === "text" && part.synthetic !== true ? [part.text] : []))
      .join("\n")
      .trim(),
  )
  if (!text) return { tier: "simple" as Tier, score: 0, signals: ["empty"] }

  const prose = text.replace(CODE_FENCE_PATTERN, "").replace(STACK_FRAME_PATTERN, "").trim()
  const signals: { name: string; weight: number }[] = []
  const add = (name: string, weight: number) => signals.push({ name, weight })

  const length = LENGTH_WEIGHTS.find((bucket) => text.length >= bucket.min)
  if (length) add(`length:${text.length}`, length.weight)

  const steps = countSteps(prose)
  const multiStep = MULTI_STEP_WEIGHTS.find((bucket) => steps >= bucket.min)
  if (multiStep) add(`steps:${steps}`, multiStep.weight)

  const complex = matchKeywords(prose, COMPLEX_KEYWORDS)
  complex.forEach((keyword) => add(`keyword:${keyword}`, COMPLEX_KEYWORD_WEIGHT))
  const complexOver = complex.length * COMPLEX_KEYWORD_WEIGHT - COMPLEX_KEYWORD_CAP
  if (complexOver > 0) add("keyword-cap", -complexOver)

  const moderate = matchKeywords(prose, MODERATE_KEYWORDS)
  moderate.forEach((keyword) => add(`keyword:${keyword}`, MODERATE_KEYWORD_WEIGHT))
  const moderateOver = moderate.length * MODERATE_KEYWORD_WEIGHT - MODERATE_KEYWORD_CAP
  if (moderateOver > 0) add("keyword-cap", -moderateOver)

  const simple = matchKeywords(prose, SIMPLE_KEYWORDS)
  simple.forEach((keyword) => add(`keyword:${keyword}`, SIMPLE_KEYWORD_WEIGHT))
  const simpleUnder = simple.length * SIMPLE_KEYWORD_WEIGHT - SIMPLE_KEYWORD_CAP
  if (simpleUnder < 0) add("keyword-cap", -simpleUnder)

  const codeBlock = text.includes("```")
  const stackTrace = STACK_TRACE_PATTERN.test(text)
  if (VALUE_SWAP_PATTERN.test(prose)) add("value-swap", VALUE_SWAP_WEIGHT)
  // Pasted errors quote identifiers ("reading 'id'") on lines the prose filter keeps, so a quote next to pasted code
  // or a stack trace is not a literal edit target.
  if (!codeBlock && !stackTrace && QUOTED_LITERAL_PATTERN.test(prose)) add("quoted-literal", QUOTED_LITERAL_WEIGHT)

  if (codeBlock) add("code-block", CODE_BLOCK_WEIGHT)
  if (stackTrace) add("stack-trace", STACK_TRACE_WEIGHT)

  const files = parts.filter((part) => part.type === "file")
  if (files.length >= MANY_FILES_MIN) add(`files:${files.length}`, MANY_FILES_WEIGHT)
  if (files.length >= FEW_FILES_MIN && files.length < MANY_FILES_MIN) add(`files:${files.length}`, FEW_FILES_WEIGHT)
  if (files.some((file) => file.mime === "application/x-directory")) add("directory", DIRECTORY_WEIGHT)
  if (files.some((file) => file.mime.startsWith("image/"))) add("image", IMAGE_WEIGHT)

  if (parts.some((part) => part.type === "agent")) add("agent", AGENT_WEIGHT)

  if (prose.endsWith("?") && prose.length < QUESTION_MAX_LENGTH && complex.length === 0)
    add("question", QUESTION_WEIGHT)

  const raw = signals.reduce((sum, signal) => sum + signal.weight, 0)
  // Record the clamp as its own signal so the logged weights always sum to the score.
  if (raw < 0) add("clamp", -raw)
  const score = Math.max(0, raw)
  return {
    tier: tierFor(score),
    score,
    signals: signals.map((signal) => `${signal.name}(${signal.weight >= 0 ? "+" : ""}${signal.weight})`),
  }
}

// Takes the strongest of three step counts: one per list line, one more than the sequencing words ("do A then B" is
// two), and the items of the longest serial enumeration ("add A, B, and C" is three).
function countSteps(text: string) {
  const listLines = text.match(LIST_LINE_PATTERN)?.length ?? 0
  const sequencers = text.match(SEQUENCE_PATTERN)?.length ?? 0
  const enumeration = Math.max(
    0,
    ...text
      .split(SENTENCE_SPLIT)
      .filter((sentence) => ENUMERATION_PATTERN.test(sentence))
      .map((sentence) => sentence.split(",").length),
  )
  return Math.max(listLines, sequencers > 0 ? sequencers + 1 : 0, enumeration)
}

// Whole words or phrases, case-insensitive, with an optional plural "s" ("tests", "migrations").
function matchKeywords(text: string, keywords: string[]) {
  return keywords.filter((keyword) =>
    new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+")}s?\\b`, "i").test(text),
  )
}

function tierFor(score: number): Tier {
  if (score >= COMPLEX_MIN_SCORE) return "complex"
  if (score >= MODERATE_MIN_SCORE) return "moderate"
  return "simple"
}

// `opencode run "<prompt>"` sends a multi-word argument wrapped in literal quotes (cli/cmd/run.ts). A single pair
// around the whole prompt is transport, not a quoted target string, so it must not trigger `quoted-literal`.
function stripOuterQuotes(text: string) {
  const quote = text[0]
  if (text.length < 2 || (quote !== '"' && quote !== "'") || !text.endsWith(quote)) return text
  const inner = text.slice(1, -1)
  return inner.includes(quote) ? text : inner.trim()
}

export * as AutoModelClassify from "./auto-model-classify"
