import { createMemo } from "solid-js"
import { TuiKeybind } from "../config/keybind"
import { useTuiConfig } from "../config"
import {
  COMMAND_PALETTE_COMMAND,
  formatKeyBindings,
  type OpenTuiKeymap,
  useKeymapSelector,
} from "../keymap"
import { DialogSelect } from "../ui/dialog-select"

const DefinitionByCommand = Object.fromEntries(
  Object.entries(TuiKeybind.CommandMap).map(([definition, command]) => [command, definition]),
)

export function DialogKeybinds() {
  const config = useTuiConfig()
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
      if (!definitionFor(entry.command.name)) return []
      return [
        {
          title: typeof entry.command.title === "string" ? entry.command.title : entry.command.name,
          value: entry.command.name,
          category: typeof entry.command.category === "string" ? entry.command.category : "General",
          footer: formatKeyBindings(entry.bindings, config) || "none",
        },
      ]
    }),
  )

  return <DialogSelect title="Keyboard shortcuts" options={options()} />
}

function definitionFor(command: string) {
  if (command in DefinitionByCommand) return DefinitionByCommand[command]
  if (command in TuiKeybind.Definitions) return command
}
