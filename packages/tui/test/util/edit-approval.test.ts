import { describe, expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import type { Session } from "@opencode-ai/sdk/v2"
import {
  approvalBadge,
  editApprovalMode,
  editApprovalSession,
  isSimpleEdit,
  parseEditApprovalMode,
  resolveEditApprovalMode,
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

describe("approval badge", () => {
  test("shows approvals recorded by the server", () => {
    expect(approvalBadge({ approval: { decision: "approved", reply: "once" } })).toEqual({
      text: "✓ approved",
      tone: "success",
    })
    expect(approvalBadge({ approval: { decision: "approved", reply: "always" } })).toEqual({
      text: "✓ approved (always)",
      tone: "success",
    })
  })

  test("shows auto-approved changes", () => {
    expect(approvalBadge({ approval: { decision: "auto" } })).toEqual({ text: "auto-approved", tone: "muted" })
  })

  test("shows rejections with the user's reason", () => {
    expect(approvalBadge({ approval: { decision: "rejected", feedback: "keep it as let" } })).toEqual({
      text: "✗ rejected: keep it as let",
      tone: "error",
    })
    expect(approvalBadge({ approval: { decision: "rejected" } })).toEqual({ text: "✗ rejected", tone: "error" })
    expect(approvalBadge({ approval: { decision: "rejected", feedback: "" } })).toEqual({
      text: "✗ rejected",
      tone: "error",
    })
  })

  test("shows nothing when no decision was recorded or it is malformed", () => {
    expect(approvalBadge(undefined)).toBeUndefined()
    expect(approvalBadge({})).toBeUndefined()
    expect(approvalBadge({ approval: "approved" })).toBeUndefined()
    expect(approvalBadge({ approval: { decision: "maybe" } })).toBeUndefined()
  })
})

describe("edit approval mode inheritance", () => {
  const sessions: Record<string, Partial<Session>> = {
    root: { id: "root", metadata: { edit_approval: "simple" } },
    child: { id: "child", parentID: "root" },
    grandchild: { id: "grandchild", parentID: "child" },
    own: { id: "own", parentID: "root", metadata: { edit_approval: "always" } },
    orphan: { id: "orphan" },
  }
  const get = (id: string) => sessions[id] as Session | undefined

  test("uses the session's own mode first", () => {
    expect(resolveEditApprovalMode("root", get)).toBe("simple")
    expect(resolveEditApprovalMode("own", get)).toBe("always")
  })

  test("subagent sessions inherit the parent's mode", () => {
    expect(resolveEditApprovalMode("child", get)).toBe("simple")
    expect(resolveEditApprovalMode("grandchild", get)).toBe("simple")
  })

  test("returns undefined when no session in the chain has a mode", () => {
    expect(resolveEditApprovalMode("orphan", get)).toBeUndefined()
    expect(resolveEditApprovalMode("missing", get)).toBeUndefined()
  })
})
