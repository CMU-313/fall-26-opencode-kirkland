import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import fc from "fast-check"
import path from "node:path"
import { chmod, mkdir, rm } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { TuiKeybind } from "../../src/config/keybind"
import { loadKeybinds, setKeybind, tuiConfigFile } from "../../src/config/keybind-persist"

fc.configureGlobal({ seed: 42 })

const SCHEMA = "https://opencode.ai/tui.json"
const json = path.join(Global.Path.config, "tui.json")
const jsonc = path.join(Global.Path.config, "tui.jsonc")

async function reset() {
  await mkdir(Global.Path.config, { recursive: true })
  await chmod(Global.Path.config, 0o755)
  await rm(json, { force: true })
  await rm(jsonc, { force: true })
}

beforeEach(reset)
afterEach(reset)

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
  "up",
  "down",
  "f1",
  "f12",
)
const chord = fc.tuple(fc.subarray(["ctrl", "meta", "alt", "shift"]), key).map(([mods, k]) => [...mods, k].join("+"))
const value = fc.oneof(
  { weight: 6, arbitrary: chord },
  { weight: 1, arbitrary: key.map((k) => `<leader>${k}`) },
  { weight: 1, arbitrary: fc.array(chord, { minLength: 2, maxLength: 3 }).map((c) => c.join(",")) },
  { weight: 1, arbitrary: fc.constant("none") },
)

const op = fc.record({ type: fc.constant("set" as const), name, value })

// R6: Custom keybinds must survive between sessions. After saving a shortcut, a fresh load
// of keybinds from disk returns the same shortcut, with no in-memory state carried over.
// A restart is simulated by deleting the whole config directory state and writing back only
// the bytes that were on disk, so the second load can only see what was persisted.
// Kind: round-trip
test("R6: a fresh load from disk returns the saved keybinds with no in-memory state", async () => {
  await fc.assert(
    fc.asyncProperty(fc.array(op, { minLength: 1, maxLength: 8 }), async (ops) => {
      await reset()
      for (const item of ops) await setKeybind(item.name, item.value)
      const file = await tuiConfigFile()
      const bytes = await Bun.file(file).text()
      const model: Record<string, string> = {}
      for (const item of ops) model[item.name] = item.value
      expect(await loadKeybinds()).toEqual(model)
      await reset()
      await Bun.write(file, bytes)
      expect(await loadKeybinds()).toEqual(model)
    }),
  )
})

// Strengthened version (by me, after H1 survived the property above). That property always
// starts from an empty config folder, so it never has the user's tui.jsonc and the "which
// file" logic is never tested. Here the user starts with a tui.jsonc holding their existing
// keybinds, sometimes with a stale tui.json left beside it, and the restart keeps only the
// tui.jsonc bytes, since that is the file the user owns.
const start = fc.record({ existing: fc.dictionary(name, value, { maxKeys: 4 }), stale: fc.boolean() })

test("R6 (strengthened): the user's tui.jsonc alone reproduces their keybinds after a restart", async () => {
  await fc.assert(
    fc.asyncProperty(start, fc.array(op, { minLength: 1, maxLength: 8 }), async (s, ops) => {
      await reset()
      await Bun.write(jsonc, JSON.stringify({ $schema: SCHEMA, keybinds: s.existing }, null, 2) + "\n")
      if (s.stale) await Bun.write(json, `{ "keybinds": { "stale": "ctrl+z" } }\n`)
      for (const item of ops) await setKeybind(item.name, item.value)
      const bytes = await Bun.file(jsonc).text()
      const model: Record<string, string> = { ...s.existing }
      for (const item of ops) model[item.name] = item.value
      await reset()
      await Bun.write(jsonc, bytes)
      expect(await loadKeybinds()).toEqual(model)
    }),
  )
})

afterAll(() => {
  console.log("keybind-persist agent property tests ran: R6 original and strengthened (100 runs each, seed 42)")
})
