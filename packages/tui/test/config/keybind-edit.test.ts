import { expect, spyOn, test } from "bun:test"
import {
  conflictFor,
  definitionFor,
  displayLeader,
  effectiveSignatures,
  formatStored,
  interruptsTyping,
  isDefaultShortcut,
  leaderChord,
  matchesWords,
  recordChord,
  reservedFor,
  signatures,
  storedDefault,
} from "../../src/config/keybind-edit"
import { TuiKeybind } from "../../src/config/keybind"

test("matchesWords treats an empty query as a match", () => {
  expect(matchesWords("", "Switch session", "Session")).toBe(true)
  expect(matchesWords("   ", "Switch session")).toBe(true)
})

test("matchesWords matches word prefixes across title and category", () => {
  expect(matchesWords("swi ses", "Switch session", "Session")).toBe(true)
  expect(matchesWords("ses", "Switch session", "Session")).toBe(true)
  expect(matchesWords("SYS", "Hide tips", "System")).toBe(true)
})

test("matchesWords does not match letter subsequences", () => {
  expect(matchesWords("aaa", "Toggle animations")).toBe(false)
  expect(matchesWords("sws", "Switch session")).toBe(false)
})

test("recordChord ignores modifier-only keys and orders modifiers", () => {
  expect(recordChord({ name: "ctrl" })).toBeUndefined()
  expect(recordChord({ name: "shift" })).toBeUndefined()
  expect(recordChord({ name: "k" })).toBe("k")
  expect(recordChord({ name: "k", ctrl: true, meta: true, alt: true, shift: true })).toBe("ctrl+meta+alt+shift+k")
})

test("interruptsTyping blocks keys that would fire while typing", () => {
  expect(interruptsTyping("p")).toBe(true)
  expect(interruptsTyping("shift+p")).toBe(true)
  expect(interruptsTyping("space")).toBe(true)
  expect(interruptsTyping("return")).toBe(true)
  expect(interruptsTyping("enter")).toBe(true)
  expect(interruptsTyping("tab")).toBe(true)
  expect(interruptsTyping("backspace")).toBe(true)
  expect(interruptsTyping("ctrl+p,q")).toBe(true)
})

test("interruptsTyping allows modified, leader, and function keys", () => {
  expect(interruptsTyping("ctrl+p")).toBe(false)
  expect(interruptsTyping("alt+p")).toBe(false)
  expect(interruptsTyping("<leader>p")).toBe(false)
  expect(interruptsTyping("f2")).toBe(false)
  expect(interruptsTyping("none")).toBe(false)
})

test("reservedFor only covers reset shortcuts", () => {
  expect(reservedFor("ctrl+r")).toBe("Reset")
  expect(reservedFor("ctrl+shift+r")).toBe("Reset all")
  expect(reservedFor("ctrl+t")).toBeUndefined()
})

test("signatures reads none, false, strings, arrays, and key objects", () => {
  expect(signatures(null)).toEqual([])
  expect(signatures(false)).toEqual([])
  expect(signatures("none")).toEqual([])
  expect(signatures("ctrl+t, ctrl+y")).toEqual(["ctrl+t", "ctrl+y"])
  expect(signatures(["ctrl+t", { key: "alt+p" }])).toEqual(["ctrl+t", "alt+p"])
  expect(signatures({ key: "ctrl+v" })).toEqual(["ctrl+v"])
  expect(signatures(1)).toEqual([])
})

test("effectiveSignatures prefers an overlay value over the default", () => {
  expect(effectiveSignatures("session_list", {})).toEqual(["<leader>l"])
  expect(effectiveSignatures("session_list", { session_list: "ctrl+t" })).toEqual(["ctrl+t"])
  expect(effectiveSignatures("help_show", {})).toEqual([])
})

test("conflictFor reports other commands and ignores the command being edited", () => {
  expect(conflictFor("session_list", "none", {}, ["session_list", "tips_toggle"])).toBeUndefined()
  expect(conflictFor("session_list", "<leader>l", {}, ["session_list", "tips_toggle"])).toBeUndefined()
  expect(conflictFor("session_list", "ctrl+t", {}, ["session_list", "not_a_bind"])).toBeUndefined()
  expect(conflictFor("session_list", "<leader>h", {}, ["session_list", "tips_toggle"])).toBe(
    TuiKeybind.Definitions.tips_toggle.description,
  )
  expect(
    conflictFor("session_list", "<leader>h", { tips_toggle: "<leader>h", variant_cycle: "<leader>h" }, [
      "session_list",
      "tips_toggle",
      "variant_cycle",
    ]),
  ).toBe(`${TuiKeybind.Definitions.tips_toggle.description}, ${TuiKeybind.Definitions.variant_cycle.description}`)
})

test("displayLeader and formatStored expand leader tokens", () => {
  expect(displayLeader({})).toBe("ctrl+x")
  expect(displayLeader({ leader: "none" })).toBe("ctrl+x")
  expect(displayLeader({ leader: "ctrl+z" })).toBe("ctrl+z")
  expect(displayLeader({}, "alt+x")).toBe("alt+x")
  expect(displayLeader({}, { name: "k", ctrl: true })).toBe("ctrl+k")
  expect(leaderChord({})).toBe("ctrl+x")
  expect(formatStored("none", {})).toBe("none")
  expect(formatStored("<leader>x", {})).toBe("ctrl+x x")
  expect(formatStored("<leader>x", { leader: "ctrl+z" })).toBe("ctrl+z x")
})

test("storedDefault and isDefaultShortcut compare formatted values", () => {
  expect(storedDefault("session_list")).toBe("<leader>l")
  expect(storedDefault("help_show")).toBe("none")
  expect(storedDefault("unknown")).toBe("none")
  expect(storedDefault("input_paste")).toBe("none")
  const spy = spyOn(TuiKeybind, "defaultValue").mockReturnValueOnce(false)
  expect(storedDefault("session_list")).toBe("none")
  spy.mockRestore()
  expect(isDefaultShortcut("session_list", {}, [{ value: "session_list", footer: "ctrl+x l" }])).toBe(true)
  expect(isDefaultShortcut("session_list", { session_list: "<leader>l" }, [])).toBe(true)
  expect(isDefaultShortcut("session_list", { session_list: "ctrl+t" }, [])).toBe(false)
  expect(isDefaultShortcut("session_list", {}, [{ value: "session_list", footer: "ctrl+t" }])).toBe(false)
})

test("definitionFor maps commands and definition keys", () => {
  expect(definitionFor("session.list")).toBe("session_list")
  expect(definitionFor("session_list")).toBe("session_list")
  expect(definitionFor("not.a.command")).toBeUndefined()
})
