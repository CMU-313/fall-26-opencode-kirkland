# Traceability: Deniel Chen (denielc)

**Target feature:** TUI keyboard shortcut editor (`/keybinds`), implemented in [`packages/tui/src/config/keybind-persist.ts`](../packages/tui/src/config/keybind-persist.ts) (load/save keybind overrides to `tui.json` / `tui.jsonc`).

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test |
|---|---|---|---|---|---|---|
| R1 | C-1, O-1 | Users must be able to customize keyboard shortcuts. | After saving `session_list` as `ctrl+t`, loading keybinds from the config file returns `session_list` = `ctrl+t`. | Yes | Model / oracle | [`keybind-persist.property.test.ts`](../packages/tui/test/config/keybind-persist.property.test.ts) |
| R2 | C-2, S-2, O-2 | Changing a keybind must not modify unrelated configuration settings. | After changing one keybind, all other keybinds and config values remain unchanged. | | Invariant | [`keybind-persist.property.test.ts`](../packages/tui/test/config/keybind-persist.property.test.ts) |
| R3 | C-4, S-4, O-4 | Resetting a keybind must remove the user's override so the default applies again. | After saving `ctrl+y` for a keybind and then resetting it, the config file no longer contains an entry for that keybind, and loading keybinds does not return it. | Yes | Round-trip | [`keybind-persist.property.test.ts`](../packages/tui/test/config/keybind-persist.property.test.ts) |
| R4 | C-3, S-3, O-3 | Reserved shortcuts such as `ctrl+r` must never be persisted as an override. | Attempting to assign `ctrl+r` is rejected before anything is written, and the config file text is identical to what it was before the attempt. | Yes |  | |
| R5 | C-8, C-9, S-8, S-9, O-8, O-9 | The config file must store exactly the shortcut the user saved. | For any keybind name and value, after saving it the config file contains that value, and reading the file back gives the same value with nothing changed. | Yes | Round-trip | [`keybind-persist.property.test.ts`](../packages/tui/test/config/keybind-persist.property.test.ts) |
| R6 | C-5, S-5, O-5 | Custom keybinds must survive between sessions. | After saving a shortcut, a fresh load of keybinds from disk returns the same shortcut, with no in-memory state carried over. | Yes | Round-trip | [`keybind-persist.property.test.ts`](../packages/tui/test/config/keybind-persist.property.test.ts) |

Properties written or suggested by opencode or another AI tool: all five properties and their generators were drafted with Claude Code (R1, R2, R3, R5, R6) and reviewed by me.

Bug found by the properties: R1 and R6 failed on the input "no config file, then reset a key." `clearKeybind` called jsonc-parser's `modify` with `undefined` on a path whose parent did not exist, which throws `Can not delete in empty document`. Fixed in `keybind-persist.ts` by making a clear of a key that was never written a no-op. After that fix R6 failed once more on the same input, this time because the test assumed a file always exists after a reset; that was a wrong test, and the property now treats "no file" as a valid state to carry across the restart.

## Requirement changes

Five of the six acceptance criteria could not be checked as written against the persistence module, which only reads and writes the config file. Each revision keeps what the user needed and restates the criterion in terms of file contents.

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R1 | Users must be able to customize keyboard shortcuts. AC: pressing `ctrl+t` opens the session list. | Same requirement. AC: after saving `session_list` as `ctrl+t`, loading keybinds returns that value. | Can't be checked: "opens the session list" is UI behavior. Users (C-1, O-1) needed their shortcut to take effect, which starts with the saved value coming back from the file. |
| R3 | Resetting a keybind must restore its default value. AC: resetting restores the original default binding and removes the override. | Resetting a keybind must remove the user's override so the default applies again. AC: after reset, the file has no entry for that keybind. | Can't be checked: defaults live in `keybind.ts`, not the persistence module. Users (C-4, S-4, O-4) needed the original shortcut back, which at the file level means the override is gone. |
| R4 | Reserved shortcuts such as `ctrl+r` cannot be reassigned. AC: the assignment is rejected and the original binding is unchanged. | Reserved shortcuts must never be persisted as an override. AC: the attempt is rejected before any write and the file text is unchanged. | Can't be checked: rejection happens in `keybind-edit.ts`, and the persistence module writes whatever it is given. Users (C-3, S-3, O-3) needed reset to always work, which holds if `ctrl+r` never reaches the file. |
| R5 | Saved shortcuts must match the config file and perform their assigned actions. AC: the file contains `ctrl+t` and pressing it opens the session list. | The config file must store exactly the shortcut the user saved. AC: after saving, the file contains that value and reading it back gives the same value. | Can't be checked: "performs the action" is UI behavior. Users (C-9, S-9, O-9) needed to tell from the file whether a save went wrong, which is the half that remains. |
| R6 | Custom keybinds must persist after restarting the TUI. AC: after restarting, the shortcut remains assigned and functional. | Custom keybinds must survive between sessions. AC: after saving, a fresh load from disk returns the same shortcut. | Can't be checked: a test cannot restart the TUI. Users (C-5, S-5, O-5) needed the shortcut to still be there next time, and a fresh read from disk is what a restart does at this layer. |

R2 was kept as written because it already describes file contents.
