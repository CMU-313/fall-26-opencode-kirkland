import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import type { Session } from "@opencode-ai/sdk/v2"
import {
  editApprovalMode,
  editApprovalSession,
  isSimpleEdit,
  parseEditApprovalMode,
} from "../../src/util/edit-approval"

function lines(count: number, prefix: string) {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}\n`).join("")
}

describe("edit approval", () => {
  test("treats a small edit to one existing file as simple", () => {
    expect(isSimpleEdit(createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", "let x = 1\n", "const x = 1\n"))).toBe(true)
  })

  test("allows up to 10 changed lines", () => {
    expect(isSimpleEdit(createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", lines(5, "old"), lines(5, "new")))).toBe(true)
    expect(isSimpleEdit(createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", lines(5, "old"), lines(6, "new")))).toBe(false)
  })

  test("always reviews new files", () => {
    expect(isSimpleEdit(createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", "", "hello\n"))).toBe(false)
  })

  test("always reviews multi-file changes", () => {
    const diff = [
      createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", "one\n", "two\n"),
      createTwoFilesPatch("/repo/b.ts", "/repo/b.ts", "one\n", "two\n"),
    ].join("\n")
    expect(isSimpleEdit(diff)).toBe(false)
  })

  test("reviews missing or non-string diffs", () => {
    expect(isSimpleEdit(undefined)).toBe(false)
    expect(isSimpleEdit("")).toBe(false)
    expect(isSimpleEdit(42)).toBe(false)
  })

  test("reads the mode from session metadata", () => {
    const session = (metadata?: Record<string, unknown>) => ({ metadata }) as Session
    expect(editApprovalMode(session({ edit_approval: "simple" }))).toBe("simple")
    expect(editApprovalMode(session({ edit_approval: "bogus" }))).toBeUndefined()
    expect(editApprovalMode(session())).toBeUndefined()
    expect(editApprovalMode(undefined)).toBeUndefined()
  })

  test("parses stored default modes", () => {
    expect(parseEditApprovalMode("never")).toBe("never")
    expect(parseEditApprovalMode("sometimes")).toBeUndefined()
    expect(parseEditApprovalMode(undefined)).toBeUndefined()
  })

  test("builds an ask rule for always and simple, and an allow rule for never", () => {
    expect(editApprovalSession("always").permission).toEqual([{ permission: "edit", pattern: "*", action: "ask" }])
    expect(editApprovalSession("simple").permission).toEqual([{ permission: "edit", pattern: "*", action: "ask" }])
    expect(editApprovalSession("never").permission).toEqual([{ permission: "edit", pattern: "*", action: "allow" }])
  })

  test("keeps existing session metadata when setting the mode", () => {
    expect(editApprovalSession("simple", { pinned: true }).metadata).toEqual({ pinned: true, edit_approval: "simple" })
  })
})
