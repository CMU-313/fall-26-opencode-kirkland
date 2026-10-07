/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { Global } from "@opencode-ai/core/global"
import { tmpdir } from "../fixture/fixture"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { TestTuiContexts } from "../fixture/tui-environment"
import type { ToastContext } from "../../src/ui/toast"
import { loadKeybinds } from "../../src/config/keybind-persist"

async function wait(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition")
    await Bun.sleep(10)
  }
}

async function clearConfigDir() {
  await rm(path.join(Global.Path.config, "tui.json"), { force: true })
  await rm(path.join(Global.Path.config, "tui.jsonc"), { force: true })
}

beforeEach(clearConfigDir)
afterEach(clearConfigDir)

async function mountEditor() {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const [
    { DialogProvider },
    { DialogKeybinds },
    { KVProvider },
    { ThemeProvider },
    { TuiConfigProvider },
    { ToastProvider, Toast, useToast },
    { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings },
  ] = await Promise.all([
    import("../../src/ui/dialog"),
    import("../../src/component/dialog-keybinds"),
    import("../../src/context/kv"),
    import("../../src/context/theme"),
    import("../../src/config"),
    import("../../src/ui/toast"),
    import("../../src/keymap"),
  ])

  let toast: ToastContext | undefined
  const resolvedConfig = createTuiResolvedConfig({ leader_timeout: 1000 })

  function PaletteCommands() {
    useBindings(() => ({
      commands: [
        {
          name: "session.list",
          title: "Switch session",
          category: "Session",
          namespace: "palette",
          run() {},
        },
        {
          name: "agent.list",
          title: "Switch agent",
          category: "Agent",
          namespace: "palette",
          run() {},
        },
        {
          name: "tips.toggle",
          title: "Hide tips",
          category: "System",
          namespace: "palette",
          run() {},
        },
      ],
    }))
    return <box />
  }

  function ToastProbe() {
    toast = useToast()
    return <Toast />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const off = registerOpencodeKeymap(keymap, renderer, resolvedConfig)
    onCleanup(off)

    return (
      <TestTuiContexts
        directory={tmp.path}
        paths={{
          home: tmp.path,
          state,
          worktree: tmp.path,
        }}
      >
        <OpencodeKeymapProvider keymap={keymap}>
          <TuiConfigProvider config={resolvedConfig}>
            <KVProvider>
              <ThemeProvider mode="dark">
                <ToastProvider>
                  <DialogProvider>
                    <PaletteCommands />
                    <DialogKeybinds />
                    <ToastProbe />
                  </DialogProvider>
                </ToastProvider>
              </ThemeProvider>
            </KVProvider>
          </TuiConfigProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { kittyKeyboard: true, width: 80, height: 40 })
  await wait(() => {
    const frame = app.captureCharFrame()
    return frame.includes("Switch session") && frame.includes("Search")
  })
  await Bun.sleep(20)
  return {
    app,
    toast: () => toast,
    async cleanup() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}

test("lists palette shortcuts with categories and formatted defaults", async () => {
  const editor = await mountEditor()
  try {
    const frame = editor.app.captureCharFrame()
    expect(frame).toContain("Keyboard shortcuts")
    expect(frame).toContain("Switch session")
    expect(frame).toContain("Session")
    expect(frame).toContain("ctrl+x l")
    expect(frame).toContain("Switch agent")
    expect(frame).toContain("Hide tips")
    expect(frame).toContain("Reset")
  } finally {
    await editor.cleanup()
  }
})

test("word search filters rows and arrows move past the first match", async () => {
  const editor = await mountEditor()
  try {
    await editor.app.mockInput.typeText("swi")
    await wait(() => {
      const frame = editor.app.captureCharFrame()
      return frame.includes("Switch session") && frame.includes("Switch agent") && !frame.includes("Hide tips")
    })
    editor.app.mockInput.pressArrow("down")
    await editor.app.renderOnce()
    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    expect(editor.app.captureCharFrame()).toContain("Switch agent")
    expect(editor.app.captureCharFrame()).not.toContain("session_list")
  } finally {
    await editor.cleanup()
  }
})

test("escape cancels capture and keeps the search text", async () => {
  const editor = await mountEditor()
  try {
    await editor.app.mockInput.typeText("swi")
    await wait(() => !editor.app.captureCharFrame().includes("Hide tips"))
    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    expect(editor.app.captureCharFrame()).not.toContain("Search")
    editor.app.mockInput.pressEscape()
    await wait(() => editor.app.captureCharFrame().includes("Keyboard shortcuts"))
    expect(editor.app.captureCharFrame()).toMatch(/swi/i)
    expect(editor.app.captureCharFrame()).not.toContain("Hide tips")
  } finally {
    await editor.cleanup()
  }
})

test("saving a shortcut updates the list, toast, and tui.json without jumping", async () => {
  const editor = await mountEditor()
  try {
    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    expect(editor.app.captureCharFrame()).toContain("Switch session")
    editor.app.mockInput.pressKey("t", { ctrl: true })
    await wait(() => editor.toast()?.currentToast?.message?.includes("Switch session keybind updated to ctrl+t") === true)
    expect(editor.toast()?.currentToast?.title).toBeFalsy()
    await wait(() => editor.app.captureCharFrame().includes("ctrl+t"))
    const frame = editor.app.captureCharFrame()
    expect(frame).toContain("Switch session")
    expect(frame.indexOf("Switch session")).toBeLessThan(frame.indexOf("Hide tips"))
    expect(await loadKeybinds()).toEqual({ session_list: "ctrl+t" })
  } finally {
    await editor.cleanup()
  }
})

test("leader capture waits for a follow-up key and ignores a repeated leader", async () => {
  const editor = await mountEditor()
  try {
    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    editor.app.mockInput.pressKey("x", { ctrl: true })
    await wait(() => editor.app.captureCharFrame().includes("Press a key after ctrl+x"))
    editor.app.mockInput.pressKey("x", { ctrl: true })
    await editor.app.renderOnce()
    expect(editor.app.captureCharFrame()).toContain("Press a key after ctrl+x")
    editor.app.mockInput.pressKey("k")
    await wait(() => editor.toast()?.currentToast?.message?.includes("keybind updated to ctrl+x k") === true)
    expect(await loadKeybinds()).toEqual({ session_list: "<leader>k" })
  } finally {
    await editor.cleanup()
  }
})

test("rejects typing keys, reserved reset keys, and conflicts", async () => {
  const editor = await mountEditor()
  try {
    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    editor.app.mockInput.pressKey("p")
    await wait(() => editor.toast()?.currentToast?.message?.includes("leader key (ctrl+x)") === true)
    expect(await loadKeybinds()).toEqual({})

    editor.app.mockInput.pressKey("r", { ctrl: true })
    await wait(() => editor.toast()?.currentToast?.message === "ctrl+r is reserved for Reset.")
    editor.app.mockInput.pressKey("r", { ctrl: true, shift: true })
    await wait(() => editor.toast()?.currentToast?.message === "ctrl+shift+r is reserved for Reset all.")

    editor.app.mockInput.pressKey("x", { ctrl: true })
    await wait(() => editor.app.captureCharFrame().includes("Press a key after ctrl+x"))
    editor.app.mockInput.pressKey("h")
    await wait(() => editor.toast()?.currentToast?.message?.includes("already assigned") === true)
    expect(await loadKeybinds()).toEqual({})
  } finally {
    await editor.cleanup()
  }
})

test("backspace unbinds a shortcut", async () => {
  const editor = await mountEditor()
  try {
    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    editor.app.mockInput.pressBackspace()
    await wait(() => editor.toast()?.currentToast?.message?.includes("keybind updated to none") === true)
    expect(await loadKeybinds()).toEqual({ session_list: "none" })
    await wait(() => {
      const frame = editor.app.captureCharFrame()
      return frame.includes("none") && frame.includes("Keyboard shortcuts")
    })
  } finally {
    await editor.cleanup()
  }
})

test("reset restores the default immediately and reset all clears every override", async () => {
  const editor = await mountEditor()
  try {
    editor.app.mockInput.pressArrow("down")
    editor.app.mockInput.pressArrow("up")
    editor.app.mockInput.pressKey("r", { ctrl: true })
    await wait(() => editor.toast()?.currentToast?.message === "Shortcut is already the default")
    expect(editor.toast()?.currentToast?.title).toBeFalsy()

    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    editor.app.mockInput.pressKey("t", { ctrl: true })
    await wait(() => editor.app.captureCharFrame().includes("ctrl+t"))

    editor.app.mockInput.pressArrow("down")
    editor.app.mockInput.pressEnter()
    await wait(() => editor.app.captureCharFrame().includes("Press a new shortcut"))
    editor.app.mockInput.pressKey("y", { ctrl: true })
    await wait(() => editor.app.captureCharFrame().includes("ctrl+y"))

    editor.app.mockInput.pressArrow("up")
    await editor.app.renderOnce()
    editor.app.mockInput.pressKey("r", { ctrl: true })
    await wait(() => editor.toast()?.currentToast?.message === "Shortcut reset to default")
    await wait(() => editor.app.captureCharFrame().includes("ctrl+x l"))
    expect(await loadKeybinds()).toEqual({ agent_list: "ctrl+y" })

    editor.app.mockInput.pressKey("r", { ctrl: true, shift: true })
    await wait(() => editor.toast()?.currentToast?.message === "Keyboard shortcuts have been reset to defaults.")
    expect(await loadKeybinds()).toEqual({})
    expect(editor.app.captureCharFrame()).toContain("ctrl+x a")
  } finally {
    await editor.cleanup()
  }
})
