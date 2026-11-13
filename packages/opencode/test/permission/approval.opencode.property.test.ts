import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import fc from "fast-check"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)

fc.configureGlobal({ seed: 42 })

const sessionID = SessionID.make("session_property_r4")
const alwaysAsk = { edit_approval: "always" }

const dir = fc.constantFrom("", "src/", "lib/util/", "test/", "config/")
const name = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/)
const safePath = fc
  .tuple(dir, name, fc.constantFrom("ts", "tsx", "md", "json", "envrc", "env.ts", "env.example"))
  .map(([d, n, ext]) => `${d}${n}.${ext}`)
const secretPath = fc.oneof(
  dir.map((d) => `${d}.env`),
  fc.tuple(dir, name).map(([d, n]) => `${d}${n}.env`),
)

const sessionMetadata = fc.constantFrom<Record<string, unknown> | undefined>(
  { edit_approval: "always" },
  { edit_approval: "simple" },
  { edit_approval: "never" },
  {},
  undefined,
)

const configDenyEnv = Permission.fromConfig({ edit: { "*": "allow", "*.env": "deny" } })

const boot =
  (directory: string) =>
  <A, E>(self: Effect.Effect<A, E, Permission.Service | Scope.Scope>) =>
    self.pipe(provideInstance(directory), Effect.provide(env))

const spawner = AppNodeBuilder.build(CrossSpawnSpawner.node)

const run = <A, E>(self: Effect.Effect<A, E, Permission.Service | Scope.Scope>) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    return yield* self.pipe(boot(directory))
  }).pipe(Effect.scoped, Effect.provide(spawner), Effect.runPromise)

const start = (input: {
  sessionID: SessionID
  paths: string[]
  session: Record<string, unknown> | undefined
  rules: PermissionV1.Rule[]
}) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission
      .ask({
        sessionID: input.sessionID,
        permission: "edit",
        patterns: input.paths,
        metadata: {},
        always: ["*"],
        ruleset: input.rules,
        mode: Permission.editMode(input.session),
      })
      .pipe(Effect.exit, Effect.forkScoped)
  })

const edit = (input: {
  paths: string[]
  session: Record<string, unknown> | undefined
  rules: PermissionV1.Rule[]
  reply: "once" | "always" | "reject"
}) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* start({ ...input, sessionID })
    const settled = yield* settleFiber(fiber)
    if (settled.pending.length === 0) return { prompted: [], exit: yield* Fiber.join(fiber) }
    yield* permission.reply({ requestID: settled.pending[0].id, reply: input.reply })
    return { prompted: settled.pending, exit: yield* Fiber.join(fiber) }
  })

const settleFiber = <A>(fiber: Fiber.Fiber<A>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    while (true) {
      if (fiber.pollUnsafe()) return { pending: [] }
      const pending = yield* permission.list()
      if (pending.length > 0) return { pending }
      yield* Effect.sleep("1 millis")
    }
  }).pipe(Effect.timeout("1 second"), Effect.orDie)

const isSecretPath = (p: string) => p.endsWith(".env") || p === ".env"

test("R4: deny rules win over every mode and Allow always", async () => {
  await fc.assert(
    fc.asyncProperty(
      sessionMetadata,
      fc.boolean(),
      fc.oneof(safePath, secretPath),
      async (session, approvedAlways, path) => {
        const rules = configDenyEnv
        const result = await run(
          Effect.gen(function* () {
            if (approvedAlways && path !== "src/a.ts" && path !== "src/b.ts") {
              yield* edit({ paths: ["src/a.ts"], session: alwaysAsk, rules, reply: "always" })
            }
            return yield* edit({ paths: [path], session, rules, reply: "once" })
          }),
        )
        if (isSecretPath(path)) {
          expect(result.prompted).toHaveLength(0)
          const error = Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : undefined
          expect(error).toBeInstanceOf(PermissionV1.DeniedError)
          return
        }
        // Non-secret path: should not be denied by the *.env rule
        expect(Exit.isFailure(result.exit)).toBe(false)
      },
    ),
    { numRuns: 200 },
  )
}, 120_000)

// Strengthened by hand (agent failure case in traceability/anniemin.md). The test above was written by
// opencode and lets mutant H5 survive: it only ever sends one path per request, so a deny check that looks at
// request.patterns[0] instead of every file is invisible to it. Same assertions, but each request now holds
// one to four files, and when a secret path is included it can be at any position, like an apply_patch that
// edits a.ts and .env together.
test("R4 (strengthened): a denied file anywhere in a request denies the whole request", async () => {
  const request = fc
    .record({
      safe: fc.array(safePath, { maxLength: 3 }),
      secret: fc.option(secretPath, { nil: undefined }),
      at: fc.nat(),
    })
    .filter((item) => item.safe.length > 0 || item.secret !== undefined)
    .map((item) =>
      item.secret === undefined ? item.safe : item.safe.toSpliced(item.at % (item.safe.length + 1), 0, item.secret),
    )
  await fc.assert(
    fc.asyncProperty(sessionMetadata, fc.boolean(), request, async (session, approvedAlways, paths) => {
      const rules = configDenyEnv
      const result = await run(
        Effect.gen(function* () {
          if (approvedAlways) yield* edit({ paths: ["src/a.ts"], session: alwaysAsk, rules, reply: "always" })
          return yield* edit({ paths, session, rules, reply: "once" })
        }),
      )
      if (paths.some(isSecretPath)) {
        expect(result.prompted).toHaveLength(0)
        const error = Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : undefined
        expect(error).toBeInstanceOf(PermissionV1.DeniedError)
        return
      }
      expect(Exit.isFailure(result.exit)).toBe(false)
    }),
    { numRuns: 200 },
  )
}, 120_000)