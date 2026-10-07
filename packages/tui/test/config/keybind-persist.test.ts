import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { rm } from "node:fs/promises"
import { Global } from "@opencode-ai/core/global"
import { clearAllKeybinds, clearKeybind, loadKeybinds, setKeybind, tuiConfigFile } from "../../src/config/keybind-persist"

async function clearConfigDir() {
  await rm(path.join(Global.Path.config, "tui.json"), { force: true })
  await rm(path.join(Global.Path.config, "tui.jsonc"), { force: true })
}

beforeEach(clearConfigDir)
afterEach(clearConfigDir)

test("loadKeybinds returns an empty object when the file is missing", async () => {
  expect(await loadKeybinds()).toEqual({})
})

test("loadKeybinds returns an empty object when keybinds is missing or not an object", async () => {
  await Bun.write(path.join(Global.Path.config, "tui.json"), `{ "theme": "custom" }\n`)
  expect(await loadKeybinds()).toEqual({})

  await Bun.write(path.join(Global.Path.config, "tui.json"), `{ "keybinds": "nope" }\n`)
  expect(await loadKeybinds()).toEqual({})
})

test("loadKeybinds skips values that are not strings", async () => {
  await Bun.write(
    path.join(Global.Path.config, "tui.json"),
    JSON.stringify({ keybinds: { session_list: "ctrl+t", tips_toggle: 1, variant_cycle: null } }),
  )
  expect(await loadKeybinds()).toEqual({ session_list: "ctrl+t" })
})

test("setKeybind creates tui.json with the schema and stores the value", async () => {
  await setKeybind("session_list", "ctrl+t")
  const file = await tuiConfigFile()
  expect(file).toBe(path.join(Global.Path.config, "tui.json"))
  const text = await Bun.file(file).text()
  expect(text).toContain("https://opencode.ai/tui.json")
  expect(await loadKeybinds()).toEqual({ session_list: "ctrl+t" })
})

test("tuiConfigFile prefers tui.jsonc and setKeybind keeps comments", async () => {
  const jsonc = path.join(Global.Path.config, "tui.jsonc")
  await Bun.write(
    jsonc,
    `{
  // keep me
  "theme": "custom",
  "keybinds": {
    "tips_toggle": "ctrl+h"
  }
}
`,
  )
  expect(await tuiConfigFile()).toBe(jsonc)
  await setKeybind("session_list", "ctrl+t")
  const text = await Bun.file(jsonc).text()
  expect(text).toContain("// keep me")
  expect(text).toContain("custom")
  expect(await loadKeybinds()).toEqual({ tips_toggle: "ctrl+h", session_list: "ctrl+t" })
})

test("clearKeybind removes one key and clearAllKeybinds removes the block", async () => {
  await setKeybind("session_list", "ctrl+t")
  await setKeybind("tips_toggle", "ctrl+h")
  await clearKeybind("session_list")
  expect(await loadKeybinds()).toEqual({ tips_toggle: "ctrl+h" })
  await clearAllKeybinds()
  expect(await loadKeybinds()).toEqual({})
})

test("round trip set, load, clear, load", async () => {
  await setKeybind("session_list", "ctrl+t")
  expect(await loadKeybinds()).toEqual({ session_list: "ctrl+t" })
  await clearKeybind("session_list")
  expect(await loadKeybinds()).toEqual({})
})
