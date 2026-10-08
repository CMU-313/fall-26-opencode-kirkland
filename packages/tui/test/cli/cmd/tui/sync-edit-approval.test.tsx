/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { createTwoFilesPatch } from "diff"
import { tmpdir } from "../../../fixture/fixture"
import { global, session } from "./approval-fixture"
import { json, mount, wait } from "./sync-fixture"

// Simple mode: the TUI answers small edit requests itself and leaves the rest for the user.

const small = createTwoFilesPatch("/repo/a.ts", "/repo/a.ts", "let x = 1\n", "const x = 1\n")
const large = createTwoFilesPatch(
  "/repo/a.ts",
  "/repo/a.ts",
  Array.from({ length: 20 }, (_, i) => `old${i}\n`).join(""),
  Array.from({ length: 20 }, (_, i) => `new${i}\n`).join(""),
)

function asked(id: string, sessionID: string, diff: string, permission = "edit") {
  return global({
    id: `evt_${id}`,
    type: "permission.asked",
    properties: { id, sessionID, permission, patterns: ["a.ts"], metadata: { diff }, always: ["*"] },
  })
}

async function setup() {
  const replies: string[] = []
  const tmp = await tmpdir()
  await Bun.write(`${tmp.path}/kv.json`, "{}")
  const mounted = await mount((url) => {
    const match = url.pathname.match(/^\/permission\/([^/]+)\/reply$/)
    if (!match) return undefined
    replies.push(match[1])
    return json(true)
  }, tmp.path)
  for (const info of [
    session("ses_simple", { metadata: { edit_approval: "simple" } }),
    session("ses_child", { parentID: "ses_simple" }),
    session("ses_always", { metadata: { edit_approval: "always" } }),
    session("ses_default"),
  ]) {
    mounted.emit(global({ id: `evt_${info.id}`, type: "session.updated", properties: { sessionID: info.id, info } }))
  }
  await wait(() => mounted.sync.data.session.length === 4)
  return { ...mounted, replies, tmp }
}

function pending(sync: Awaited<ReturnType<typeof setup>>["sync"], sessionID: string) {
  return (sync.data.permission[sessionID] ?? []).map((request) => request.id)
}

test("simple mode auto-approves small edits and leaves large edits for the user", async () => {
  const { app, emit, sync, replies, tmp } = await setup()
  await using _ = tmp
  try {
    emit(asked("per_small", "ses_simple", small))
    emit(asked("per_large", "ses_simple", large))

    await wait(() => replies.includes("per_small") && pending(sync, "ses_simple").includes("per_large"))
    expect(replies).toEqual(["per_small"])
    expect(pending(sync, "ses_simple")).toEqual(["per_large"])
  } finally {
    app.renderer.destroy()
  }
})

test("subagent sessions follow the parent's simple mode", async () => {
  const { app, emit, sync, replies, tmp } = await setup()
  await using _ = tmp
  try {
    emit(asked("per_child", "ses_child", small))

    await wait(() => replies.includes("per_child"))
    expect(pending(sync, "ses_child")).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})

test("always mode, no mode, and non-edit permissions are never auto-approved", async () => {
  const { app, emit, sync, replies, tmp } = await setup()
  await using _ = tmp
  try {
    emit(asked("per_always", "ses_always", small))
    emit(asked("per_default", "ses_default", small))
    emit(asked("per_bash", "ses_simple", small, "bash"))

    await wait(
      () =>
        pending(sync, "ses_always").length === 1 &&
        pending(sync, "ses_default").length === 1 &&
        pending(sync, "ses_simple").length === 1,
    )
    expect(replies).toEqual([])
  } finally {
    app.renderer.destroy()
  }
})
