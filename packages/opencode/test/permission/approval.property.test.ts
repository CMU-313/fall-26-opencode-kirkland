import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Scope } from "effect"
import fc from "fast-check"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)

const sessionID = SessionID.make("session_property")

// Generators.
// File names are short lowercase identifiers under a few common directories, so paths look like real
// worktree-relative edit targets. Secret paths always end in ".env" and safe paths never do, so whether a
// path matches the "*.env" deny rule is known by construction. Safe extensions include near misses
// (".envrc", ".env.ts", ".env.example") that contain "env" but must not be denied.
const dir = fc.constantFrom("", "src/", "lib/util/", "test/", "config/")
const name = fc.stringMatching(/^[a-z][a-z0-9_-]{0,7}$/)
const safePath = fc
  .tuple(dir, name, fc.constantFrom("ts", "tsx", "md", "json", "envrc", "env.ts", "env.example"))
  .map(([d, n, ext]) => `${d}${n}.${ext}`)
const secretPath = fc.oneof(
  dir.map((d) => `${d}.env`),
  fc.tuple(dir, name).map(([d, n]) => `${d}${n}.env`),
)
// The three modes a user can pick in /permissions, or no mode at all (the config decides). They go through
// Permission.editMode, the same mapping the server applies to session metadata before every edit.
const approvalMode = fc.constantFrom("always", "simple", "never", undefined)
// Config edit rules a project might have. "Always ask" must prompt no matter which one is set.
const configRules = fc.constantFrom<PermissionV1.Rule[]>(
  [],
  [{ permission: "edit", pattern: "*", action: "allow" }],
  [{ permission: "edit", pattern: "*", action: "ask" }],
)

// Each generated case gets its own Permission service in its own directory, so approvals from one case
// can't leak into another. Building `env` again on the same directory is a fresh process: a restart.
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

// Asks to edit `paths` the way the edit tools do, and answers a prompt with `reply` if one appears.
// Returns whether the user was prompted, plus how the ask ended.
const edit = (input: {
  paths: string[]
  mode: string | undefined
  rules: PermissionV1.Rule[]
  reply: "once" | "always" | "reject"
}) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* permission
      .ask({
        sessionID,
        permission: "edit",
        patterns: input.paths,
        metadata: {},
        always: ["*"],
        ruleset: input.rules,
        mode: Permission.editMode({ edit_approval: input.mode }),
      })
      .pipe(Effect.exit, Effect.forkScoped)
    const pending = yield* settled(fiber)
    if (pending.length === 0) return { prompted: [], exit: yield* Fiber.join(fiber) }
    yield* permission.reply({ requestID: pending[0].id, reply: input.reply })
    return { prompted: pending, exit: yield* Fiber.join(fiber) }
  })

// Waits until the ask either finished without prompting or is waiting on a prompt.
const settled = <A>(fiber: Fiber.Fiber<A>) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    while (true) {
      if (fiber.pollUnsafe()) return []
      const pending = yield* permission.list()
      if (pending.length > 0) return pending
      yield* Effect.sleep("1 millis")
    }
  }).pipe(Effect.timeout("1 second"), Effect.orDie)

// R2: Switching from Always ask to Never ask and back to Always ask leaves the session in Always ask, with no
// approvals carried over from the Never ask period.
// Kind: round-trip
// Generates any sequence of mode switches that ends back in Always ask, with edits in between. Prompts in
// between are answered "once" or "reject", never "always": Allow always is meant to carry over (R5, R6).
test("R2: returning to Always ask prompts on the next edit", async () => {
  const step = fc.record({ mode: fc.constantFrom("always", "simple", "never"), path: safePath })
  await fc.assert(
    fc.asyncProperty(
      configRules,
      safePath,
      fc.array(step, { maxLength: 8 }),
      fc.constantFrom("once" as const, "reject" as const),
      safePath,
      async (rules, first, steps, reply, next) => {
        const result = await run(
          Effect.gen(function* () {
            const before = yield* edit({ paths: [first], mode: "always", rules, reply: "once" })
            for (const item of steps) yield* edit({ paths: [item.path], mode: item.mode, rules, reply })
            const after = yield* edit({ paths: [next], mode: "always", rules, reply: "once" })
            return { before, after }
          }),
        )
        expect(result.before.prompted).toHaveLength(1)
        expect(result.after.prompted).toHaveLength(1)
        expect(result.after.exit).toEqual(Exit.succeed("once"))
      },
    ),
    { numRuns: 50 },
  )
}, 60_000)

// R4: No approval mode and no Allow always choice overrides a deny rule. A denied edit is never written,
// regardless of mode.
// Kind: invariant
// Generates every approval mode, with and without an earlier Allow always, with and without plan mode's
// deny rules, against both secret and safe paths.
test("R4: deny rules win over every mode and Allow always", async () => {
  const config = Permission.fromConfig({ edit: { "*": "allow", "*.env": "deny" } })
  const plan = Permission.fromConfig({ edit: { "*": "deny", ".opencode/plans/*.md": "allow" } })
  await fc.assert(
    fc.asyncProperty(
      approvalMode,
      fc.boolean(),
      fc.boolean(),
      fc.oneof(
        secretPath.map((path) => ({ path, secret: true })),
        safePath.map((path) => ({ path, secret: false })),
      ),
      async (mode, approvedAlways, planMode, target) => {
        const rules = planMode ? [...config, ...plan] : config
        const result = await run(
          Effect.gen(function* () {
            if (approvedAlways) yield* edit({ paths: ["src/a.ts"], mode: "always", rules: config, reply: "always" })
            return yield* edit({ paths: [target.path], mode, rules, reply: "once" })
          }),
        )
        if (target.secret || planMode) {
          expect(result.prompted).toHaveLength(0)
          expect(Exit.isFailure(result.exit) && Cause.squash(result.exit.cause)).toBeInstanceOf(
            PermissionV1.DeniedError,
          )
          return
        }
        expect(Exit.isSuccess(result.exit)).toBe(true)
      },
    ),
    { numRuns: 100 },
  )
}, 60_000)

// R5: Allow always lasts only until opencode restarts. It does not persist across a restart.
// Kind: invariant
// Generates one or more Allow always approvals on any files, under any config rules, then restarts on the
// same directory. Before the restart the next edit is auto-approved; after it the next edit prompts again.
test("R5: Allow always does not survive a restart", async () => {
  await fc.assert(
    fc.asyncProperty(
      configRules,
      fc.array(safePath, { minLength: 1, maxLength: 5 }),
      safePath,
      async (rules, approved, next) => {
        const result = await Effect.gen(function* () {
          const directory = yield* tmpdirScoped()
          const before = yield* Effect.gen(function* () {
            for (const path of approved) yield* edit({ paths: [path], mode: "always", rules, reply: "always" })
            return yield* edit({ paths: [next], mode: "always", rules, reply: "once" })
          }).pipe(boot(directory))
          const after = yield* edit({ paths: [next], mode: "always", rules, reply: "once" }).pipe(boot(directory))
          return { before, after }
        }).pipe(Effect.scoped, Effect.provide(spawner), Effect.runPromise)
        expect(result.before.prompted).toHaveLength(0)
        expect(result.after.prompted).toHaveLength(1)
      },
    ),
    { numRuns: 50 },
  )
}, 60_000)

// R6: A single tool call that changes several files is approved or rejected as a whole, with one prompt.
// When the changes arrive as separate tool calls, choosing Allow always on the first approves the rest
// without another prompt.
// Kind: metamorphic
// Generates a set of distinct files and one extra file. Adding the extra file must not change the number of
// prompts: one prompt listing every file for a single call, and one prompt in total for separate calls.
test("R6: adding files to a change never adds prompts", async () => {
  await fc.assert(
    fc.asyncProperty(
      configRules,
      fc.uniqueArray(safePath, { minLength: 1, maxLength: 5 }),
      safePath,
      fc.constantFrom("once" as const, "reject" as const),
      async (rules, files, extra, reply) => {
        const more = files.includes(extra) ? files : [...files, extra]
        const single = (paths: string[]) => run(edit({ paths, mode: "always", rules, reply }))
        const separate = (paths: string[]) =>
          run(
            Effect.forEach(paths, (path) => edit({ paths: [path], mode: "always", rules, reply: "always" })).pipe(
              Effect.map((results) => results.flatMap((result) => result.prompted)),
            ),
          )

        for (const paths of [files, more]) {
          const result = await single(paths)
          expect(result.prompted).toHaveLength(1)
          expect(result.prompted[0].patterns).toEqual(paths)
          if (reply === "once") expect(result.exit).toEqual(Exit.succeed("once"))
          if (reply === "reject") expect(Exit.isFailure(result.exit)).toBe(true)
          expect(await separate(paths)).toHaveLength(1)
        }
      },
    ),
    { numRuns: 50 },
  )
}, 60_000)
