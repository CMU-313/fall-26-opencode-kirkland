import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import fc from "fast-check"
import path from "node:path"
import { rm } from "node:fs/promises"
import { parse } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { TuiKeybind } from "../../src/config/keybind"
import { clearKeybind, loadKeybinds, setKeybind, tuiConfigFile } from "../../src/config/keybind-persist"

const SCHEMA = "https://opencode.ai/tui.json"
const json = path.join(Global.Path.config, "tui.json")
const jsonc = path.join(Global.Path.config, "tui.jsonc")
const decoy = `{ "keybinds": { "decoy": "ctrl+z" } }\n`

async function reset() {
  await rm(json, { force: true })
  await rm(jsonc, { force: true })
}

beforeEach(reset)
afterEach(reset)

// Names are mostly real command names from the definitions table so overrides
// land on entries the dialog lists, plus a few made-up ones because the file format does
// not care. Values cover the boundaries interviewees asked about: plain chords, single
// letters, leader chords, comma-separated multi-chords, "none", and the reserved ctrl+r.
const name = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom(...Object.keys(TuiKeybind.Definitions)) },
  { weight: 1, arbitrary: fc.stringMatching(/^[a-z][a-z_]{0,15}$/) },
)

const key = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  "space",
  "return",
  "tab",
  "escape",
  "backspace",
  "up",
  "down",
  "left",
  "right",
  "f1",
  "f12",
)
const chord = fc.tuple(fc.subarray(["ctrl", "meta", "alt", "shift"]), key).map(([mods, k]) => [...mods, k].join("+"))
const value = fc.oneof(
  { weight: 6, arbitrary: chord },
  { weight: 1, arbitrary: key.map((k) => `<leader>${k}`) },
  { weight: 1, arbitrary: fc.array(chord, { minLength: 2, maxLength: 3 }).map((c) => c.join(",")) },
  { weight: 1, arbitrary: fc.constant("none") },
  { weight: 1, arbitrary: fc.constantFrom("ctrl+r", "ctrl+shift+r") },
)

// Starting state on disk: no file, a tui.json, or a tui.jsonc with comments and sometimes a
// stale tui.json beside it that must be ignored. Extra top-level keys and pre-existing
// keybinds (which reuse the same name generator, so overwrites happen often) are what R2
// says must survive.
const extras = fc.dictionary(
  fc.stringMatching(/^[a-z][a-z_]{0,8}$/).filter((k) => k !== "keybinds"),
  fc.oneof(fc.string(), fc.integer(), fc.boolean(), fc.dictionary(fc.string(), fc.string(), { maxKeys: 3 })),
  { maxKeys: 4 },
)
const config = fc.record({
  kind: fc.constantFrom("none", "json", "jsonc"),
  extras,
  existing: fc.dictionary(name, value, { maxKeys: 5 }),
  comments: fc.uniqueArray(fc.nat(999), { maxLength: 3 }).map((ns) => ns.map((n) => `// note-${n}`)),
  stale: fc.boolean(),
})
type Config = typeof config extends fc.Arbitrary<infer T> ? T : never

function baseline(cfg: Config) {
  if (cfg.kind === "none") return { $schema: SCHEMA }
  return {
    $schema: SCHEMA,
    ...cfg.extras,
    ...(Object.keys(cfg.existing).length ? { keybinds: cfg.existing } : {}),
  }
}

function render(cfg: Config) {
  const lines = JSON.stringify(baseline(cfg), null, 2).split("\n")
  if (cfg.kind !== "jsonc") return lines.join("\n") + "\n"
  return [lines[0], ...cfg.comments.map((c) => `  ${c}`), ...lines.slice(1)].join("\n") + "\n"
}

async function seed(cfg: Config) {
  await reset()
  if (cfg.kind === "none") return
  if (cfg.kind === "json") return Bun.write(json, render(cfg))
  await Bun.write(jsonc, render(cfg))
  if (cfg.stale) await Bun.write(json, decoy)
}

async function fileText() {
  return Bun.file(await tuiConfigFile()).text()
}

function without(obj: Record<string, unknown> | undefined, k: string) {
  return Object.fromEntries(Object.entries(obj ?? {}).filter(([key]) => key !== k))
}

function keybindsOf(obj: Record<string, unknown>) {
  return (obj.keybinds ?? {}) as Record<string, unknown>
}

const op = fc.oneof(
  { weight: 3, arbitrary: fc.record({ type: fc.constant("set" as const), name, value }) },
  { weight: 1, arbitrary: fc.record({ type: fc.constant("clear" as const), name }) },
)

async function run(ops: (typeof op extends fc.Arbitrary<infer T> ? T : never)[]) {
  for (const item of ops) {
    if (item.type === "set") await setKeybind(item.name, item.value)
    if (item.type === "clear") await clearKeybind(item.name)
  }
}

// R5: The config file must store exactly the shortcut the user saved. For any keybind name
// and value, after saving it the config file contains that value, and reading the file back
// gives the same value with nothing changed.
// Kind: round-trip
test("R5: saving a shortcut then loading it gives back exactly that value", async () => {
  await fc.assert(
    fc.asyncProperty(config, name, value, async (cfg, n, v) => {
      await seed(cfg)
      await setKeybind(n, v)
      expect((await loadKeybinds())[n]).toBe(v)
      expect(keybindsOf(parse(await fileText()))[n]).toBe(v)
    }),
  )
})

// R1: Users must be able to customize keyboard shortcuts. After saving session_list as
// ctrl+t, loading keybinds from the config file returns session_list = ctrl+t. Generalized
// to any sequence of saves and resets across any names.
// Kind: model / oracle
test("R1: any sequence of customizations loads back like a plain map of last writes", async () => {
  await fc.assert(
    fc.asyncProperty(config, fc.array(op, { maxLength: 8 }), async (cfg, ops) => {
      await seed(cfg)
      const model: Record<string, string> = cfg.kind === "none" ? {} : { ...cfg.existing }
      for (const item of ops) {
        if (item.type === "set") model[item.name] = item.value
        if (item.type === "clear") delete model[item.name]
      }
      await run(ops)
      expect(await loadKeybinds()).toEqual(model)
    }),
  )
})

// R2: Changing a keybind must not modify unrelated configuration settings. After changing
// one keybind, all other keybinds and config values remain unchanged.
// Kind: invariant
test("R2: changing one keybind leaves every other key, keybind, comment, and file alone", async () => {
  await fc.assert(
    fc.asyncProperty(config, name, value, async (cfg, n, v) => {
      await seed(cfg)
      const before = baseline(cfg)
      await setKeybind(n, v)
      const text = await fileText()
      const after = parse(text)
      expect(without(after, "keybinds")).toEqual(without(before, "keybinds"))
      expect(without(keybindsOf(after), n)).toEqual(without(keybindsOf(before), n))
      if (cfg.kind === "jsonc") for (const c of cfg.comments) expect(text).toContain(c)
      if (cfg.kind === "jsonc" && cfg.stale) expect(await Bun.file(json).text()).toBe(decoy)
    }),
  )
})

// R3: Resetting a keybind must remove the user's override so the default applies again.
// After saving a value for a keybind and then resetting it, the config file no longer
// contains an entry for that keybind, and loading keybinds does not return it. Everything
// else in the file is as it was before the save.
// Kind: round-trip
test("R3: save then reset removes the override and restores the rest of the file", async () => {
  await fc.assert(
    fc.asyncProperty(config, name, value, async (cfg, n, v) => {
      await seed(cfg)
      const before = baseline(cfg)
      await setKeybind(n, v)
      await clearKeybind(n)
      const after = parse(await fileText())
      expect((await loadKeybinds())[n]).toBeUndefined()
      expect(keybindsOf(after)[n]).toBeUndefined()
      expect(without(after, "keybinds")).toEqual(without(before, "keybinds"))
      expect(without(keybindsOf(after), n)).toEqual(without(keybindsOf(before), n))
    }),
  )
})

// R6: Custom keybinds must survive between sessions. After saving, a fresh load from disk
// returns the same shortcut with no in-memory state carried over. A restart is simulated by
// deleting everything and writing back only the bytes that were on disk (or nothing, when
// no file was ever written).
// Kind: round-trip
test("R6: the bytes on disk alone reproduce the saved keybinds after a restart", async () => {
  await fc.assert(
    fc.asyncProperty(config, fc.array(op, { minLength: 1, maxLength: 8 }), async (cfg, ops) => {
      await seed(cfg)
      await run(ops)
      const file = await tuiConfigFile()
      const bytes = (await Bun.file(file).exists()) ? await Bun.file(file).text() : undefined
      const loaded = await loadKeybinds()
      await reset()
      if (bytes !== undefined) await Bun.write(file, bytes)
      expect(await loadKeybinds()).toEqual(loaded)
    }),
  )
})

afterAll(() => {
  console.log("keybind-persist property tests ran: R1, R2, R3, R5, R6 (5 properties, 100 runs each)")
})
