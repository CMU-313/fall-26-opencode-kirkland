/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer, type JSX } from "@opentui/solid"
import { onCleanup, onMount } from "solid-js"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { tmpdir } from "../../../fixture/fixture"
import { createTuiResolvedConfig } from "../../../fixture/tui-runtime"
import { TestTuiContexts } from "../../../fixture/tui-environment"
import { createEventSource, createFetch, directory, json } from "../../../fixture/tui-sdk"
import { ArgsProvider } from "../../../../src/context/args"
import { KVProvider, useKV } from "../../../../src/context/kv"
import { ToastProvider } from "../../../../src/ui/toast"
import { TuiConfigProvider } from "../../../../src/config"
import { SDKProvider } from "../../../../src/context/sdk"
import { PermissionProvider } from "../../../../src/context/permission"
import { ProjectProvider } from "../../../../src/context/project"
import { ExitProvider } from "../../../../src/context/exit"
import { SyncProvider, useSync } from "../../../../src/context/sync"
import { ThemeProvider } from "../../../../src/context/theme"
import { DialogProvider } from "../../../../src/ui/dialog"
import { LocationProvider } from "../../../../src/context/location"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../../src/keymap"
export { wait } from "./sync-fixture"

// Mounts approval UI inside the app's providers with a fake server that records every request and its JSON body.

export type Recorded = { method: string; path: string; body: unknown }

export function global(payload: GlobalEvent["payload"]): GlobalEvent {
  return { directory: "/tmp/other", project: "proj_test", payload }
}

export function session(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    slug: id,
    projectID: "proj_test",
    title: id,
    time: { created: 0, updated: 0 },
    version: "1.15.13",
    directory: "/tmp/opencode/packages/opencode",
    ...extra,
  }
}

export async function mountApproval(view: () => JSX.Element) {
  const tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  const requests: Recorded[] = []
  const events = createEventSource()
  const base = createFetch((url) => {
    if (/^\/permission\/[^/]+\/reply$/.test(url.pathname)) return json(true)
    const match = url.pathname.match(/^\/session\/([^/]+)$/)
    if (match) return json(session(match[1]))
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    const text = request.method === "GET" ? "" : await request.clone().text()
    requests.push({ method: request.method, path: new URL(request.url).pathname, body: text ? JSON.parse(text) : undefined })
    return base.fetch(request)
  }) as typeof globalThis.fetch

  let sync!: ReturnType<typeof useSync>
  let kv!: ReturnType<typeof useKV>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    const ctx = { sync: useSync(), kv: useKV() }
    onMount(() => {
      sync = ctx.sync
      kv = ctx.kv
      ready()
    })
    return <></>
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({ leader_timeout: 1000 })
    onCleanup(registerOpencodeKeymap(keymap, renderer, config))
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <OpencodeKeymapProvider keymap={keymap}>
          <ArgsProvider>
            <KVProvider>
              <ToastProvider>
                <TuiConfigProvider config={config}>
                  <SDKProvider url="http://test" directory={directory} fetch={fetch} events={events.source}>
                    <PermissionProvider>
                      <ProjectProvider>
                        <ExitProvider exit={() => {}}>
                          <SyncProvider>
                            <ThemeProvider mode="dark">
                              <DialogProvider>
                                <LocationProvider>
                                  <Probe />
                                  {view()}
                                </LocationProvider>
                              </DialogProvider>
                            </ThemeProvider>
                          </SyncProvider>
                        </ExitProvider>
                      </ProjectProvider>
                    </PermissionProvider>
                  </SDKProvider>
                </TuiConfigProvider>
              </ToastProvider>
            </KVProvider>
          </ArgsProvider>
        </OpencodeKeymapProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 120, height: 40, kittyKeyboard: true })
  await mounted
  return {
    app,
    requests,
    emit: events.emit,
    sync,
    kv,
    async frame() {
      await app.renderOnce()
      return app.captureCharFrame()
    },
    async [Symbol.asyncDispose]() {
      app.renderer.destroy()
      await tmp[Symbol.asyncDispose]()
    },
  }
}
