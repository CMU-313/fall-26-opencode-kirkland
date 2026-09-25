import { stringifyKeyStroke } from "@opentui/keymap"
import { createMemo, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { TuiKeybind } from "../config/keybind"
import { useApplyKeybinds, useTuiConfig } from "../config"
import {
  COMMAND_PALETTE_COMMAND,
  formatKeyBindings,
  type OpenTuiKeymap,
  useBindings,
  useKeymapSelector,
  useOpencodeKeymap,
} from "../keymap"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"

const DefinitionByCommand = Object.fromEntries(
  Object.entries(TuiKeybind.CommandMap).map(([definition, command]) => [command, definition]),
)

export function DialogKeybinds() {
  const config = useTuiConfig()
  const applyKeybinds = useApplyKeybinds()
  const keymap = useOpencodeKeymap()
  const toast = useToast()
  const [store, setStore] = createStore({
    overlay: {} as Record<string, string>,
    capture: null as string | null,
    pendingLeader: false,
    selected: "",
  })

  const entries = useKeymapSelector((keymap: OpenTuiKeymap) => {
    const reachable = keymap.getCommandEntries({
      namespace: "palette",
      visibility: "reachable",
      filter: (command) => command.hidden !== true && command.name !== COMMAND_PALETTE_COMMAND,
    })
    const registered = keymap.getCommandBindings({
      visibility: "registered",
      commands: reachable.map((entry) => entry.command.name),
    })
    return reachable.map((entry) => ({
      ...entry,
      bindings: registered.get(entry.command.name) ?? entry.bindings,
    }))
  })

  const options = createMemo(() =>
    entries().flatMap((entry) => {
      const name = definitionFor(entry.command.name)
      if (!name) return []
      const custom = store.overlay[name]
      return [
        {
          title: typeof entry.command.title === "string" ? entry.command.title : entry.command.name,
          value: name,
          category: typeof entry.command.category === "string" ? entry.command.category : "General",
          footer:
            typeof custom === "string"
              ? formatStored(custom, store.overlay, config)
              : formatKeyBindings(entry.bindings, config) || "none",
        },
      ]
    }),
  )

  const save = (name: string, value: string) => {
    const conflict = conflictFor(name, value, store.overlay, options().map((item) => item.value))
    if (conflict) {
      toast.show({
        title: "Shortcut already in use",
        message: `${value} is already assigned to ${conflict}.`,
        variant: "warning",
      })
      return
    }
    const overlay = { ...store.overlay, [name]: value }
    setStore("overlay", overlay)
    applyKeybinds(overlay)
    setStore({ capture: null, pendingLeader: false })
    toast.show({ message: "Keybind saved", variant: "success" })
  }

  const resetSelected = () => {
    const name = store.selected
    if (!(name in store.overlay)) {
      toast.show({ message: "Shortcut is already the default", variant: "info" })
      return
    }
    const overlay = Object.fromEntries(Object.entries(store.overlay).filter(([key]) => key !== name))
    setStore("overlay", overlay)
    applyKeybinds(overlay)
    toast.show({ message: "Shortcut reset to default", variant: "success" })
  }

  const resetAll = () => {
    const names = options()
      .map((item) => item.value)
      .filter((name) => name in store.overlay)
    const overlay = Object.fromEntries(Object.entries(store.overlay).filter(([key]) => !names.includes(key)))
    setStore("overlay", overlay)
    applyKeybinds(overlay)
    toast.show({ message: "Keyboard shortcuts have been reset to defaults.", variant: "success" })
  }

  const stopCapture = keymap.intercept(
    "key",
    ({ event }) => {
      const name = store.capture
      if (!name) return
      event.preventDefault()
      event.stopPropagation()
      if (event.name === "escape") {
        setStore({ capture: null, pendingLeader: false })
        return
      }
      const clear = (event.name === "backspace" || event.name === "delete") && !event.ctrl && !event.meta && !event.shift
      if (clear) {
        save(name, "none")
        return
      }
      const next = recordChord(event)
      if (!next) return
      if (store.pendingLeader) {
        save(name, `<leader>${event.name}`)
        return
      }
      if (next === leaderChord(store.overlay, config)) {
        setStore("pendingLeader", true)
        return
      }
      save(name, next)
    },
    { priority: 1000 },
  )
  onCleanup(stopCapture)

  useBindings(() => ({
    enabled: () => !store.capture,
    priority: 1,
    bindings: [
      { key: "ctrl+r", desc: "Reset shortcut", group: "Dialog", cmd: resetSelected },
      { key: "ctrl+shift+r", desc: "Reset all shortcuts", group: "Dialog", cmd: resetAll },
    ],
  }))

  return (
    <DialogSelect
      title={store.capture ? "Press keys" : "Keyboard shortcuts"}
      options={options()}
      locked={!!store.capture}
      current={store.selected}
      onMove={(option) => setStore("selected", option.value)}
      onSelect={(option) => setStore({ capture: option.value, pendingLeader: false })}
      footerHints={[
        { title: "Reset", label: "ctrl+r" },
        { title: "Reset all", label: "ctrl+shift+r" },
      ]}
    />
  )
}

function definitionFor(command: string) {
  if (command in DefinitionByCommand) return DefinitionByCommand[command]
  if (command in TuiKeybind.Definitions) return command
}

function displayLeader(overlay: Record<string, string>, config: ReturnType<typeof useTuiConfig>) {
  if (typeof overlay.leader === "string" && overlay.leader !== "none") return overlay.leader
  const key = config.keybinds.get("leader")[0]?.key
  if (!key) return TuiKeybind.LeaderDefault
  return typeof key === "string" ? key : stringifyKeyStroke(key)
}

function formatStored(value: string, overlay: Record<string, string>, config: ReturnType<typeof useTuiConfig>) {
  if (value === "none") return "none"
  return value.replaceAll("<leader>", `${displayLeader(overlay, config)} `)
}

function leaderChord(overlay: Record<string, string>, config: ReturnType<typeof useTuiConfig>) {
  return displayLeader(overlay, config)
}

function recordChord(event: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; alt?: boolean }) {
  if (["ctrl", "control", "shift", "alt", "meta", "super", "option"].includes(event.name)) return
  const parts: string[] = []
  if (event.ctrl) parts.push("ctrl")
  if (event.meta) parts.push("meta")
  if (event.alt) parts.push("alt")
  if (event.shift) parts.push("shift")
  parts.push(event.name)
  return parts.join("+")
}

function signatures(value: unknown): string[] {
  if (value === false || value === "none" || value == null) return []
  if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean)
  if (Array.isArray(value)) return value.flatMap(signatures)
  if (typeof value === "object" && value && "key" in value) return signatures(value.key)
  return []
}

function effectiveSignatures(name: string, overlay: Record<string, string>) {
  if (typeof overlay[name] === "string") return signatures(overlay[name])
  return signatures(TuiKeybind.defaultValue(name as keyof typeof TuiKeybind.Definitions))
}

function conflictFor(name: string, value: string, overlay: Record<string, string>, listed: string[]) {
  const owned = new Set(signatures(value))
  if (owned.size === 0) return
  const titles = listed.flatMap((other) => {
    if (other === name) return []
    if (!effectiveSignatures(other, overlay).some((item) => owned.has(item))) return []
    return [TuiKeybind.Definitions[other as keyof typeof TuiKeybind.Definitions].description]
  })
  if (titles.length === 0) return
  return titles.join(", ")
}
