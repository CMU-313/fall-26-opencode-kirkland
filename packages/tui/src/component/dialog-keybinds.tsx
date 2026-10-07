import { TextAttributes } from "@opentui/core"
import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { clearKeybind, loadKeybinds, setKeybind } from "../config/keybind-persist"
import { useApplyKeybinds, useTuiConfig } from "../config"
import {
  conflictFor,
  definitionFor,
  displayLeader,
  formatStored,
  interruptsTyping,
  isDefaultShortcut,
  leaderChord,
  matchesWords,
  recordChord,
  reservedFor,
  storedDefault,
} from "../config/keybind-edit"
import { useTheme } from "../context/theme"
import {
  COMMAND_PALETTE_COMMAND,
  type OpenTuiKeymap,
  useBindings,
  useKeymapSelector,
  useOpencodeKeymap,
} from "../keymap"
import { useToast } from "../ui/toast"
import { DialogSelect } from "../ui/dialog-select"

export function DialogKeybinds() {
  const config = useTuiConfig()
  const applyKeybinds = useApplyKeybinds()
  const keymap = useOpencodeKeymap()
  const toast = useToast()
  const { theme } = useTheme()
  const leader = () => config.keybinds.get("leader")[0]?.key
  const [overlay, setOverlay] = createSignal({} as Record<string, string>)
  const [order, setOrder] = createSignal<string[]>([])
  const [query, setQuery] = createSignal("")
  const [store, setStore] = createStore({
    capture: null as string | null,
    captureTitle: "",
    pendingLeader: false,
    selected: "",
  })

  onMount(() => {
    void loadKeybinds().then(setOverlay)
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

  const rows = createMemo(() =>
    entries().flatMap((entry) => {
      const name = definitionFor(entry.command.name)
      if (!name) return []
      const custom = overlay()[name]
      return [
        {
          title: typeof entry.command.title === "string" ? entry.command.title : entry.command.name,
          value: name,
          category: typeof entry.command.category === "string" ? entry.command.category : "General",
          footer:
            typeof custom === "string"
              ? formatStored(custom, overlay(), leader())
              : formatStored(storedDefault(name), overlay(), leader()) || "none",
        },
      ]
    }),
  )

  createEffect(() => {
    if (order().length) return
    const names = rows().map((item) => item.value)
    if (names.length) setOrder(names)
  })

  const options = createMemo(() => {
    const list = rows()
    const frozen = order()
    if (!frozen.length) return list
    const byName = new Map(list.map((item) => [item.value, item]))
    const used = new Set<string>()
    return [
      ...frozen.flatMap((name) => {
        const item = byName.get(name)
        if (!item) return []
        used.add(name)
        return [item]
      }),
      ...list.filter((item) => !used.has(item.value)),
    ]
  })

  const listed = createMemo(() => options().filter((item) => matchesWords(query(), item.title, item.category)))

  createEffect(() => {
    if (store.selected) return
    const first = options()[0]?.value
    if (first) setStore("selected", first)
  })

  const save = (name: string, value: string) => {
    if (value !== "none" && interruptsTyping(value)) {
      toast.show({
        message: `Use ctrl, alt, or the leader key (${displayLeader(overlay(), leader())}) so it does not fire while typing.`,
        variant: "warning",
      })
      return
    }
    const reserved = reservedFor(value)
    if (reserved) {
      toast.show({
        message: `${value} is reserved for ${reserved}.`,
        variant: "warning",
      })
      return
    }
    const conflict = conflictFor(name, value, overlay(), options().map((item) => item.value))
    if (conflict) {
      toast.show({
        message: `${value} is already assigned to ${conflict}.`,
        variant: "warning",
      })
      return
    }
    void setKeybind(name, value)
      .then(() => {
        const next = { ...overlay(), [name]: value }
        setOverlay(next)
        applyKeybinds(next)
        const title = store.captureTitle || options().find((item) => item.value === name)?.title || name
        setStore({ capture: null, captureTitle: "", pendingLeader: false, selected: name })
        toast.show({
          message: `${title} keybind updated to ${formatStored(value, next, leader()) || "none"}`,
          variant: "success",
        })
      })
      .catch((error) => toast.error(error))
  }

  const resetSelected = () => {
    const name = store.selected || options()[0]?.value
    if (!name || isDefaultShortcut(name, overlay(), options(), leader())) {
      toast.show({ message: "Shortcut is already the default", variant: "info" })
      return
    }
    void clearKeybind(name)
      .then(() => {
        const next = Object.fromEntries(Object.entries(overlay()).filter(([key]) => key !== name))
        setOverlay(next)
        applyKeybinds(next)
        toast.show({ message: "Shortcut reset to default", variant: "success" })
      })
      .catch((error) => toast.error(error))
  }

  const resetAll = () => {
    const names = options()
      .map((item) => item.value)
      .filter((name) => name in overlay())
    void Promise.all(names.map(clearKeybind))
      .then(() => {
        const next = Object.fromEntries(Object.entries(overlay()).filter(([key]) => !names.includes(key)))
        setOverlay(next)
        applyKeybinds(next)
        toast.show({ message: "Keyboard shortcuts have been reset to defaults.", variant: "success" })
      })
      .catch((error) => toast.error(error))
  }

  const stopCapture = keymap.intercept(
    "key",
    ({ event }) => {
      const name = store.capture
      if (!name) return
      event.preventDefault()
      event.stopPropagation()
      if (event.name === "escape") {
        setStore({ capture: null, captureTitle: "", pendingLeader: false })
        return
      }
      const clear = (event.name === "backspace" || event.name === "delete") && !event.ctrl && !event.meta && !event.shift
      if (clear) {
        save(name, "none")
        return
      }
      const next = recordChord(event)
      if (!next) return
      if (next === leaderChord(overlay(), leader())) {
        setStore("pendingLeader", true)
        return
      }
      if (store.pendingLeader) {
        save(name, `<leader>${event.name}`)
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
      title={
        store.capture
          ? store.pendingLeader
            ? `Press a key after ${displayLeader(overlay(), leader())}`
            : "Press a new shortcut"
          : "Keyboard shortcuts"
      }
      options={store.capture ? [] : listed()}
      skipFilter
      renderFilter={!store.capture}
      locked={!!store.capture}
      emptyView={
        store.capture ? (
          <box paddingLeft={4} paddingRight={4} paddingTop={1}>
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {store.captureTitle || store.capture}
            </text>
          </box>
        ) : undefined
      }
      preserveSelection
      current={store.selected}
      onFilter={setQuery}
      onMove={(option) => setStore("selected", option.value)}
      onSelect={(option) =>
        setStore({ capture: option.value, captureTitle: option.title, pendingLeader: false })
      }
      footerHints={
        store.capture
          ? []
          : [
              { title: "Reset", label: "ctrl+r" },
              { title: "Reset all", label: "ctrl+shift+r" },
            ]
      }
    />
  )
}
