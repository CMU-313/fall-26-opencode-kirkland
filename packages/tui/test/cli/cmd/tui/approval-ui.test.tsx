/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import type { PermissionRequest, ToolPart } from "@opencode-ai/sdk/v2"
import { global, mountApproval, session, wait } from "./approval-fixture"
import { PermissionPrompt } from "../../../../src/routes/session/permission"
import { DialogPermissions } from "../../../../src/component/dialog-permissions"
import { ApprovalBadge } from "../../../../src/routes/session"
import { EDIT_APPROVAL_DEFAULT_KEY } from "../../../../src/util/edit-approval"

// Component tests for the code change approval UI: the approval prompt, the /permissions dialog, and timeline badges.

const request: PermissionRequest = {
  id: "per_edit",
  sessionID: "ses_top",
  permission: "edit",
  patterns: ["a.ts"],
  metadata: {
    filepath: "/tmp/opencode/a.ts",
    diff: createTwoFilesPatch("/tmp/opencode/a.ts", "/tmp/opencode/a.ts", "let x = 1\nkeep\n", "const x = 1\nkeep\n"),
    summary: "Make x a constant since it never changes.",
  },
  always: ["*"],
}

const replies = (requests: { method: string; path: string; body: unknown }[]) =>
  requests.filter((item) => item.path === `/permission/${request.id}/reply`).map((item) => item.body)

test("approval prompt shows the model's summary, line counts, and diff before the change", async () => {
  await using ui = await mountApproval(() => <PermissionPrompt request={request} />)
  await wait(() => ui.app.captureCharFrame().includes("Make x a constant"))
  const frame = await ui.frame()

  expect(frame).toContain("Permission required")
  expect(frame).toContain("Make x a constant since it never changes.")
  expect(frame).toContain("1 file ·")
  expect(frame).toContain("+1")
  expect(frame).toContain("−1")
  expect(frame).toContain("const x = 1")
  expect(replies(ui.requests)).toEqual([])
})

test("allow once sends a once reply", async () => {
  await using ui = await mountApproval(() => <PermissionPrompt request={request} />)
  await wait(() => ui.app.captureCharFrame().includes("Allow once"))

  ui.app.mockInput.pressEnter()

  await wait(() => replies(ui.requests).length === 1)
  expect(replies(ui.requests)).toEqual([{ reply: "once" }])
})

test("rejecting a top-level session's edit asks for a reason and sends it to the model", async () => {
  await using ui = await mountApproval(() => <PermissionPrompt request={request} />)
  await wait(() => ui.app.captureCharFrame().includes("Allow once"))

  ui.app.mockInput.pressEscape()
  await wait(() => ui.app.captureCharFrame().includes("Tell OpenCode what to change"))
  expect(replies(ui.requests)).toEqual([])

  await ui.app.mockInput.typeText("keep it as let")
  ui.app.mockInput.pressEnter()

  await wait(() => replies(ui.requests).length === 1)
  expect(replies(ui.requests)).toEqual([{ reply: "reject", message: "keep it as let" }])
})

test("rejecting with an empty reason sends a plain reject", async () => {
  await using ui = await mountApproval(() => <PermissionPrompt request={request} />)
  await wait(() => ui.app.captureCharFrame().includes("Allow once"))

  ui.app.mockInput.pressEscape()
  await wait(() => ui.app.captureCharFrame().includes("Tell OpenCode what to change"))
  ui.app.mockInput.pressEnter()

  await wait(() => replies(ui.requests).length === 1)
  expect(replies(ui.requests)).toEqual([{ reply: "reject" }])
})

test("/permissions dialog saves the mode on the session and as the default, without permission rules", async () => {
  await using ui = await mountApproval(() => <DialogPermissions sessionID="ses_top" />)
  const info = session("ses_top", { metadata: { pinned: true } })
  ui.emit(global({ id: "evt_ses_top", type: "session.updated", properties: { sessionID: info.id, info } }))
  await wait(() => ui.sync.data.session.length === 1 && ui.app.captureCharFrame().includes("Never ask"))
  const frame = await ui.frame()
  expect(frame).toContain("Always ask")
  expect(frame).toContain("Simple changes only")
  expect(frame).toContain("Never ask")

  await ui.app.mockInput.typeText("never")
  ui.app.mockInput.pressEnter()

  await wait(() => ui.requests.some((item) => item.method === "PATCH" && item.path === "/session/ses_top"))
  const update = ui.requests.find((item) => item.method === "PATCH" && item.path === "/session/ses_top")
  expect(update?.body).toEqual({ metadata: { pinned: true, edit_approval: "never" } })
  expect(ui.kv.get(EDIT_APPROVAL_DEFAULT_KEY)).toBe("never")
})

test("/permissions dialog on the home screen only saves the default for new sessions", async () => {
  await using ui = await mountApproval(() => <DialogPermissions />)
  await wait(() => ui.app.captureCharFrame().includes("Simple changes only"))

  await ui.app.mockInput.typeText("simple")
  ui.app.mockInput.pressEnter()

  await wait(() => ui.kv.get(EDIT_APPROVAL_DEFAULT_KEY) === "simple")
  expect(ui.requests.filter((item) => item.method === "PATCH")).toEqual([])
})

test("timeline badges show each recorded decision", async () => {
  const part = (approval: Record<string, unknown>) =>
    ({
      id: "prt_1",
      sessionID: "ses_top",
      messageID: "msg_1",
      type: "tool",
      callID: "call_1",
      tool: "edit",
      state: { status: "completed", input: {}, output: "", title: "a.ts", metadata: {}, time: { start: 0, end: 1 } },
      metadata: { approval },
    }) as ToolPart

  await using ui = await mountApproval(() => (
    <box flexDirection="column">
      <ApprovalBadge part={part({ decision: "approved", reply: "once" })} />
      <ApprovalBadge part={part({ decision: "auto" })} />
      <ApprovalBadge part={part({ decision: "rejected", feedback: "keep it as let" })} />
    </box>
  ))
  await wait(() => ui.app.captureCharFrame().includes("rejected"))
  const frame = await ui.frame()

  expect(frame).toContain("✓ approved")
  expect(frame).toContain("auto-approved")
  expect(frame).toContain("✗ rejected: keep it as let")
})
