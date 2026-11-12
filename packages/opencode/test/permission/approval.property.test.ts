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

// A fixed seed makes every run generate the same inputs, so Stryker's kill/survive results are repeatable.
fc.configureGlobal({ seed: 42 })

const sessionID = SessionID.make("session_property")
const otherSessionID = SessionID.make("session_other")
const alwaysAsk = { edit_approval: "always" }

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
// Session metadata as the TUI stores it: one of the three modes a user can pick in /permissions, a session
// whose metadata has no mode, or a session with no metadata at all. Both of the last two mean "the config
// decides". They go through Permission.editMode, the same mapping the server applies before every edit.
const sessionMetadata = fc.constantFrom<Record<string, unknown> | undefined>(
  { edit_approval: "always" },
  { edit_approval: "simple" },
  { edit_approval: "never" },
  {},
  undefined,
)
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

// Asks to edit `paths` the way the edit tools do, and starts it in the background.
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

// Asks to edit `paths` and answers a prompt with `reply` if one appears.
// Returns whether the user was prompted, plus how the ask ended.
const edit = (input: {
  paths: string[]
  session: Record<string, unknown> | undefined
  rules: PermissionV1.Rule[]
  reply: "once" | "always" | "reject"
}) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const fiber = yield* start({ ...input, sessionID })
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

// Waits until exactly `count` prompts are open.
const waitForPending = (count: number) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    while (true) {
      const pending = yield* permission.list()
      if (pending.length === count) return pending
      yield* Effect.sleep("1 millis")
    }
  }).pipe(Effect.timeout("1 second"), Effect.orDie)

// Starts one ask per path at the same time, the way a model's parallel tool calls arrive, while another
// session also has a prompt open. Answers the first of this session's prompts with `reply`, records which
// prompts are still open, then rejects those so every ask can finish.
const parallel = (input: { paths: string[]; rules: PermissionV1.Rule[]; reply: "always" | "reject" }) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    const other = yield* start({ sessionID: otherSessionID, paths: ["src/other.ts"], session: alwaysAsk, rules: [] })
    const fibers = yield* Effect.forEach(input.paths, (path) =>
      start({ sessionID, paths: [path], session: alwaysAsk, rules: input.rules }),
    )
    const pending = yield* waitForPending(input.paths.length + 1)
    const first = pending.find((item) => item.sessionID === sessionID)
    if (!first) throw new Error("no prompt for this session")
    yield* permission.reply({ requestID: first.id, reply: input.reply })
    const open = yield* permission.list()
    for (const item of open) yield* permission.reply({ requestID: item.id, reply: "reject" })
    yield* Fiber.join(other)
    return { open, exits: yield* Effect.forEach(fibers, Fiber.join) }
  })

// R2: Switching from Always ask to Never ask and back to Always ask leaves the session in Always ask, with no
// approvals carried over from the Never ask period.
// Kind: round-trip
// Generates any sequence of mode switches that ends back in Always ask, with edits in between. Prompts in
// between are answered "once" or "reject", never "always": Allow always is meant to carry over (R5, R6).
// Every step is checked too, so a switch that silently lands in the wrong mode is caught where it happens:
// Never ask never prompts, while Always ask and Simple changes only always reach the user. (The server asks
// for every Simple changes only edit; the TUI then auto-approves the small ones.)
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
            const before = yield* edit({ paths: [first], session: alwaysAsk, rules, reply: "once" })
            const between = yield* Effect.forEach(steps, (item) =>
              edit({ paths: [item.path], session: { edit_approval: item.mode }, rules, reply }),
            )
            const after = yield* edit({ paths: [next], session: alwaysAsk, rules, reply: "once" })
            return { before, between, after }
          }),
        )
        expect(result.before.prompted).toHaveLength(1)
        expect(result.between.map((item) => item.prompted.length)).toEqual(
          steps.map((item) => (item.mode === "never" ? 0 : 1)),
        )
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
// Generates every approval mode (and sessions with no mode), with and without an earlier Allow always, with
// and without plan mode's deny rules. A request holds one to four files, like apply_patch; when it includes
// a secret path, that path can be at any position, so a check that only looks at one file is caught.
// The config also has a non-edit rule, so the deny error must name only the edit rules that applied.
test("R4: deny rules win over every mode and Allow always", async () => {
  const config = Permission.fromConfig({ bash: "allow", edit: { "*": "allow", "*.env": "deny" } })
  const plan = Permission.fromConfig({ edit: { "*": "deny", ".opencode/plans/*.md": "allow" } })
  const request = fc
    .record({
      safe: fc.array(safePath, { maxLength: 3 }),
      secret: fc.option(secretPath, { nil: undefined }),
      at: fc.nat(),
    })
    .filter((item) => item.safe.length > 0 || item.secret !== undefined)
    .map((item) =>
      item.secret === undefined
        ? { paths: item.safe, secret: false }
        : { paths: item.safe.toSpliced(item.at % (item.safe.length + 1), 0, item.secret), secret: true },
    )
  await fc.assert(
    fc.asyncProperty(
      sessionMetadata,
      fc.boolean(),
      fc.boolean(),
      request,
      async (session, approvedAlways, planMode, target) => {
        const rules = planMode ? [...config, ...plan] : config
        const result = await run(
          Effect.gen(function* () {
            if (approvedAlways) yield* edit({ paths: ["src/a.ts"], session: alwaysAsk, rules: config, reply: "always" })
            return yield* edit({ paths: target.paths, session, rules, reply: "once" })
          }),
        )
        if (target.secret || planMode) {
          expect(result.prompted).toHaveLength(0)
          const error = Exit.isFailure(result.exit) ? Cause.squash(result.exit.cause) : undefined
          expect(error).toBeInstanceOf(PermissionV1.DeniedError)
          expect(error instanceof PermissionV1.DeniedError && error.ruleset).toEqual(
            rules.filter((rule) => rule.permission === "edit"),
          )
          return
        }
        // Nothing is denied, so the mode decides: Always ask and Simple changes only prompt unless Allow
        // always was chosen; Never ask and no mode fall through to the config's "*": "allow".
        const mode = session?.edit_approval
        const asks = !approvedAlways && (mode === "always" || mode === "simple")
        expect(result.prompted).toHaveLength(asks ? 1 : 0)
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
            for (const path of approved) yield* edit({ paths: [path], session: alwaysAsk, rules, reply: "always" })
            return yield* edit({ paths: [next], session: alwaysAsk, rules, reply: "once" })
          }).pipe(boot(directory))
          const after = yield* edit({ paths: [next], session: alwaysAsk, rules, reply: "once" }).pipe(boot(directory))
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
        const single = (paths: string[]) => run(edit({ paths, session: alwaysAsk, rules, reply }))
        const separate = (paths: string[]) =>
          run(
            Effect.forEach(paths, (path) => edit({ paths: [path], session: alwaysAsk, rules, reply: "always" })).pipe(
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

// R6 (separate calls in parallel): models often issue several edit tool calls at once, so all of their
// prompts are open together. Answering the first one settles the rest of that session's prompts the same way,
// with no further prompt, and leaves another session's open prompt alone.
// Kind: metamorphic
// Generates one to five files edited in parallel and either reply. Changing how many files are edited never
// changes how many prompts the user answers (one), and every edit ends the way that one answer said.
test("R6: one answer settles every parallel edit in the session", async () => {
  await fc.assert(
    fc.asyncProperty(
      configRules,
      fc.uniqueArray(safePath, { minLength: 1, maxLength: 5 }),
      fc.constantFrom("always" as const, "reject" as const),
      async (rules, files, reply) => {
        const result = await run(parallel({ paths: files, rules, reply }))
        expect(result.open.map((item) => item.sessionID)).toEqual([otherSessionID])
        if (reply === "always") {
          expect(result.exits).toEqual(files.map(() => Exit.succeed("always")))
          return
        }
        expect(result.exits.every((exit) => Exit.isFailure(exit))).toBe(true)
      },
    ),
    { numRuns: 50 },
  )
}, 60_000)
