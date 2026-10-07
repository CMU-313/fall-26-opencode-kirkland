export * as KeybindEdit from "./keybind-edit"

import { stringifyKeyStroke, type KeyStringifyInput } from "@opentui/keymap"
import { TuiKeybind } from "./keybind"

const DefinitionByCommand = Object.fromEntries(
  Object.entries(TuiKeybind.CommandMap).map(([definition, command]) => [command, definition]),
)

export function matchesWords(query: string, ...fields: string[]) {
  const needles = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (needles.length === 0) return true
  const words = fields.flatMap((field) => field.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))
  return needles.every((needle) => words.some((word) => word.startsWith(needle)))
}

export function definitionFor(command: string) {
  if (command in DefinitionByCommand) return DefinitionByCommand[command]
  if (command in TuiKeybind.Definitions) return command
}

export function displayLeader(overlay: Record<string, string>, leader?: string | KeyStringifyInput) {
  if (typeof overlay.leader === "string" && overlay.leader !== "none") return overlay.leader
  if (typeof leader === "string" && leader) return leader
  if (leader && typeof leader === "object") return stringifyKeyStroke(leader)
  return TuiKeybind.LeaderDefault
}

export function formatStored(value: string, overlay: Record<string, string>, leader?: string | KeyStringifyInput) {
  if (value === "none") return "none"
  return value.replaceAll("<leader>", `${displayLeader(overlay, leader)} `)
}

export function storedDefault(name: string) {
  if (!(name in TuiKeybind.Definitions)) return "none"
  const value = TuiKeybind.defaultValue(name as keyof typeof TuiKeybind.Definitions)
  if (typeof value === "string") return value
  if (value === false) return "none"
  return "none"
}

export function isDefaultShortcut(
  name: string,
  overlay: Record<string, string>,
  listed: { value: string; footer: string }[],
  leader?: string | KeyStringifyInput,
) {
  const expected = formatStored(storedDefault(name), overlay, leader) || "none"
  if (typeof overlay[name] === "string") return formatStored(overlay[name], overlay, leader) === expected
  return (listed.find((item) => item.value === name)?.footer || "none") === expected
}

export function leaderChord(overlay: Record<string, string>, leader?: string | KeyStringifyInput) {
  return displayLeader(overlay, leader)
}

export function recordChord(event: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean }) {
  if (["ctrl", "control", "shift", "alt", "meta", "super", "option"].includes(event.name)) return
  const parts: string[] = []
  if (event.ctrl) parts.push("ctrl")
  if (event.meta) parts.push("meta")
  if (event.alt) parts.push("alt")
  if (event.shift) parts.push("shift")
  parts.push(event.name)
  return parts.join("+")
}

export function interruptsTyping(value: string) {
  return signatures(value).some((chord) => {
    if (chord.includes("<leader>")) return false
    if (/(^|\+)(ctrl|alt|meta|super)(\+|$)/.test(chord)) return false
    const key = chord.split("+").at(-1) ?? chord
    return key.length === 1 || ["space", "return", "enter", "tab", "backspace"].includes(key)
  })
}

export function reservedFor(value: string) {
  if (value === "ctrl+r") return "Reset"
  if (value === "ctrl+shift+r") return "Reset all"
}

export function signatures(value: unknown): string[] {
  if (value === false || value === "none" || value == null) return []
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.flatMap(signatures)
  if (typeof value === "object" && value && "key" in value) return signatures(value.key)
  return []
}

export function effectiveSignatures(name: string, overlay: Record<string, string>) {
  if (typeof overlay[name] === "string") return signatures(overlay[name])
  return signatures(storedDefault(name))
}

export function conflictFor(name: string, value: string, overlay: Record<string, string>, listed: string[]) {
  const owned = new Set(signatures(value))
  if (owned.size === 0) return
  const titles = listed.flatMap((other) => {
    if (other === name) return []
    if (!effectiveSignatures(other, overlay).some((item) => owned.has(item))) return []
    if (!(other in TuiKeybind.Definitions)) return []
    return [TuiKeybind.Definitions[other as keyof typeof TuiKeybind.Definitions].description]
  })
  if (titles.length === 0) return
  return titles.join(", ")
}
