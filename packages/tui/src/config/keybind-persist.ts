import path from "path"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Global } from "@opencode-ai/core/global"
import { writeTextAtomic } from "../util/persistence"

const SCHEMA = "https://opencode.ai/tui.json"

export async function tuiConfigFile() {
  const jsonc = path.join(Global.Path.config, "tui.jsonc")
  if (await Bun.file(jsonc).exists()) return jsonc
  return path.join(Global.Path.config, "tui.json")
}

async function readConfig() {
  const file = await tuiConfigFile()
  if (!(await Bun.file(file).exists())) {
    return { file, text: `{\n  "$schema": "${SCHEMA}"\n}\n` }
  }
  return { file, text: await Bun.file(file).text() }
}

export async function loadKeybinds() {
  const current = await readConfig()
  const parsed = parse(current.text)
  if (!parsed || typeof parsed !== "object" || !("keybinds" in parsed)) return {}
  const keybinds = parsed.keybinds
  if (!keybinds || typeof keybinds !== "object") return {}
  return Object.fromEntries(
    Object.entries(keybinds).flatMap(([name, value]) => (typeof value === "string" ? [[name, value]] : [])),
  )
}

export async function setKeybind(name: string, value: string | undefined) {
  const current = await readConfig()
  await writeTextAtomic(
    current.file,
    applyEdits(
      current.text,
      modify(current.text, ["keybinds", name], value, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    ),
  )
}

export function clearKeybind(name: string) {
  return setKeybind(name, undefined)
}

export async function clearAllKeybinds() {
  const current = await readConfig()
  await writeTextAtomic(
    current.file,
    applyEdits(
      current.text,
      modify(current.text, ["keybinds"], undefined, {
        formattingOptions: { insertSpaces: true, tabSize: 2 },
      }),
    ),
  )
}
