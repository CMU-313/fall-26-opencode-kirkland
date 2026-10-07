# User Guide

# Section outline (copy this)

```markdown
## Feature: <short name>

**Author:**
**PRs:**

### What it does
### How to use it
### How to user-test it
### Automated tests
- Files / PR:
- How to run:
- What is tested, and why that is enough:
```

## Features

1. [Customize keyboard shortcuts](#feature-customize-keyboard-shortcuts) 
2.  
3.  
4. 

---

## Feature: Customize keyboard shortcuts

**Author:** Daniel Chen
**PRs:** [#16](https://github.com/CMU-313/fall-26-opencode-kirkland/pull/16) (view list), [#18](https://github.com/CMU-313/fall-26-opencode-kirkland/pull/18) (editor), [#24](https://github.com/CMU-313/fall-26-opencode-kirkland/pull/24) (persist), [#27](https://github.com/CMU-313/fall-26-opencode-kirkland/pull/27) (behavior fixes), [#28](https://github.com/CMU-313/fall-26-opencode-kirkland/pull/28) (visual / reserved keys), [#40](https://github.com/CMU-313/fall-26-opencode-kirkland/pull/40) (tests).

### What it does

This feature lets you change OpenCode’s command-palette shortcuts from inside the TUI. You can search the list, remap or unbind a command, and reset one shortcut or all of them. New bindings take effect right away and are saved in `~/.config/opencode/tui.json` (or `tui.jsonc` if you already have that file).

### How to use it

1. `bun dev .`, then `/keybinds` or `ctrl+p` → **Edit keybinds**.
2. Search filters by word prefix (`swi` matches “Switch session”).
3. Enter → Press a new shortcut. `ctrl+t` remaps. `ctrl+x` then a key saves a leader chord. Backspace unbinds (`none`). Esc cancels and keeps the search text.
4. `ctrl+r` resets the selected row. `ctrl+shift+r` resets all. Restart OpenCode to confirm persist.

### How to user-test it

- Open `/keybinds`. You should see command names (like Switch session) and shortcuts (like `ctrl+x l`).
- Type in search, then press down. Selection should move to the next match, not jump back to the first.
- Remap Switch session to `ctrl+t`. You get a toast, the list stays put, and `ctrl+t` opens sessions. Quit and reopen: it should still be `ctrl+t`.
- Trying a single letter, `ctrl+r`, or a shortcut another command already uses should fail with a toast.
- Backspace clears the shortcut. `ctrl+r` restores that row’s default. `ctrl+shift+r` restores everything.

### Automated tests

Added in [#40](https://github.com/CMU-313/fall-26-opencode-kirkland/pull/40):

- `[packages/tui/test/config/keybind-edit.test.ts](packages/tui/test/config/keybind-edit.test.ts)` — matching, chords, reserved keys, conflicts
- `[packages/tui/test/config/keybind-persist.test.ts](packages/tui/test/config/keybind-persist.test.ts)` — `tui.json` / `tui.jsonc` load, set, clear
- `[packages/tui/test/config.test.tsx](packages/tui/test/config.test.tsx)` — live `useApplyKeybinds`
- `[packages/tui/test/component/dialog-keybinds.test.tsx](packages/tui/test/component/dialog-keybinds.test.tsx)` — rendered dialog (search, capture, leader, guards, save, reset)

```bash
bun test --cwd packages/tui test/config/keybind-edit.test.ts test/config/keybind-persist.test.ts test/config.test.tsx test/component/dialog-keybinds.test.tsx
```

The unit tests cover the rules (search, conflicts, reserved keys, saving to `tui.json`). The dialog tests open the real editor and check what you would see: the list, toasts, and the file on disk. Together that matches the user-test steps above. One thing to still try by hand: after you close the dialog, `ctrl+t` should actually open Switch session.