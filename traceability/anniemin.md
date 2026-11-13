# Traceability: Annie Min (anniemin)

**Target feature:** As a developer, I want to preview and approve or reject each proposed code change before it is applied, so that I retain precise control over modifications without disabling the agent's ability to edit code entirely. Main source files: `packages/tui/src/util/edit-approval.ts`, `packages/tui/src/component/dialog-permissions.tsx`, `packages/tui/src/routes/session/permission.tsx`, `packages/opencode/src/permission/index.ts`.

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R2 | C-8, O-9, S-10: "The very next change should ask" | Switching from Always ask to Never ask and back to Always ask leaves the session in Always ask, with no approvals carried over from the Never ask period. | In a session set to Always ask, switch to Never ask and then back to Always ask with /permissions. Send a message requesting an edit to a.ts. The approval prompt appears, and a.ts is unchanged until Allow once is chosen. | No | Returning to Always ask after any sequence of mode switches prompts on the next edit (round-trip) | `packages/opencode/test/permission/approval.property.test.ts`: "R2: returning to Always ask prompts on the next edit" | H2 |
| R3 | S-7, S-8: "If there is a ui element with a light/toggle that let's me know what mode I'm on" | Whenever the session has an approval mode set, the prompt footer shows it in normal input mode. It updates as soon as the mode changes and is still shown after a restart. | After choosing Simple changes only in /permissions, the footer shows edits: simple with no further input. After choosing Never ask it shows edits: never. After quitting, restarting and reopening the session, it still shows edits: never. | Yes | Not covered: the footer logic lives in packages/tui | — | — |
| R4 | C-3, C-4, C-5, O-3, S-4: "It should not cover changes, such as things that are a security vulnerability"; "I wouldn't want it to do something like rm -rf" | No approval mode and no Allow always choice overrides a deny rule. A denied edit is never written, regardless of mode. | With config `{"permission": {"edit": {"*": "allow", "*.env": "deny"}}}` and the mode set to Never ask, a requested edit to .env is refused, .env is unchanged, and no approval badge is recorded. An edit to src/a.ts in the same session is applied. The same holds after choosing Allow always on an earlier edit, and in plan mode under all three modes. | No | For every mode, with or without an earlier Allow always, and with or without plan mode, a `*.env` edit is denied without a prompt (invariant) | `packages/opencode/test/permission/approval.property.test.ts`: "R4: deny rules win over every mode and Allow always" | H1, H3, H5 (H3 and H5 only after strengthening) |
| R5 | C-7, O-5, O-6: "Each time you open a new ide or window it makes sense for it to ask again" | Allow always lasts only until opencode restarts. It does not persist across a restart. | In Always ask, choose Allow always on an edit. The next edit in that session is applied without a prompt and shows approved (always). Quit opencode, restart it and reopen the session. The next edit shows the approval prompt. | No | After any set of Allow always approvals, the next edit is auto-approved before a restart and prompts after it (invariant) | `packages/opencode/test/permission/approval.property.test.ts`: "R5: Allow always does not survive a restart" | H3, H4 |
| R6 | S-15, S-16: "If it's going to change two files, does the user have to approve twice? … I'd prefer to approve once" | A single tool call that changes several files is approved or rejected as a whole, with one prompt. When the changes arrive as separate tool calls, choosing Allow always on the first approves the rest without another prompt. | With a GPT model in Always ask, an apply_patch that changes a.ts and b.ts shows exactly one prompt listing 2 files. Allow once writes both files, and Reject leaves both unchanged. With a non-GPT model, the agent edits a.ts and then b.ts. Choosing Allow always on the a.ts prompt applies the b.ts edit with no second prompt. | Yes | Adding a file to a change never adds prompts, for a single call, for separate calls, and for parallel calls settled by one answer (metamorphic) | `packages/opencode/test/permission/approval.property.test.ts`: "R6: adding files to a change never adds prompts", "R6: one answer settles every parallel edit in the session" | H3, H4 |

Properties written or suggested by opencode or another AI tool: R2, R4, R5, R6 (written with Claude Code, then reviewed and run by me). Separately, the first test in `packages/opencode/test/permission/approval.opencode.property.test.ts` was written by opencode (Nemotron 3.5 Lightning via OpenRouter) for the agent failure case below; the second test in that file is my strengthened version of it.

## Requirement changes

| ID | Original requirement (P3) | Revised requirement | Why it changed |
|---|---|---|---|
| R3 | The footer always shows the session's current approval mode and updates as soon as the mode changes. | Whenever the session has an approval mode set, the prompt footer shows it in normal input mode. It updates as soon as the mode changes and is still shown after a restart. | Not feasible as written. A session that never had a mode chosen in /permissions has no mode (the config decides), so there is nothing to show, and the footer is hidden in shell mode. The revision keeps what S-7 and S-8 needed, knowing at a glance which mode is active, for every session that has one. |
| R6 | A single change that touches several files is approved or rejected as a whole, with one prompt. | A single tool call that changes several files is approved or rejected as a whole, with one prompt. When the changes arrive as separate tool calls, choosing Allow always on the first approves the rest without another prompt. | Not feasible for every model. Only GPT models get apply_patch, which sends several files in one tool call. Other models use edit/write, which change one file per call, and each call must be approved before it runs, before anyone knows another edit is coming, so separate calls can't share one prompt. The revision keeps what S-15 and S-16 needed, not approving the same change twice, through Allow always. |

## Hand-written mutants

Five mutants, designed and predicted before any of them was run. All five change [`packages/opencode/src/permission/index.ts`](../packages/opencode/src/permission/index.ts), the server-side `Permission` service that decides whether an edit is denied, auto-approved or prompted. The patches are in [`mutants/anniemin/`](../mutants/anniemin/). To run one: `git apply mutants/anniemin/H1.patch`, then `bun test test/permission/approval.property.test.ts` from `packages/opencode`, then `git checkout -- packages/opencode/src/permission/index.ts`.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R4 | `ask`: the deny check reuses the `rule` already computed a line above (`rule.action === "deny"`) instead of evaluating the config and agent rules on their own. It looks like removing a duplicate `evaluate` call, but `rule` includes the user's Allow always approvals, so an approval of `"*"` overrides every deny. This is the bug the R4 property found in Project 4. | **R4** ("deny rules win over every mode and Allow always"). Whenever `approvedAlways` is true and the target is a secret path or plan mode is on, the mutant returns success instead of `DeniedError`. Both booleans are generated, so about a quarter of the cases hit it. | **Killed** by R4, as predicted, and by nothing else. Shrunk to `["always", true, true, {path: "a.ts", secret: false}]`: after Allow always on `src/a.ts`, an edit to `a.ts` in plan mode is allowed instead of denied. fast-check found the plan-mode case first, not the `.env` one; both come from the same approval overriding the deny. |
| H2 | R2 | `ask`: when a mode auto-approves an edit (Never ask), its `always` patterns are pushed onto the approved list, "so the same edit is not re-evaluated next time". Since every edit tool sends `always: ["*"]`, one edit in Never ask silently becomes an Allow always that outlives the switch back to Always ask. | **R2** (round-trip). Any generated sequence containing at least one Never ask edit leaves `"*"` approved, so the edit after returning to Always ask is not prompted. I expect R4, R5 and R6 to stay green: none of them edit in Never ask before checking for a prompt. | **Killed** by R2 only, as predicted. Shrunk to a single Never ask edit between the two Always ask edits (`[[], "a.ts", [{mode: "never", path: "a.ts"}], "once", "a.ts"]`): that one auto-approved edit records `"*"`, and the next Always ask edit is not prompted. R4, R5 and R6 stayed green. |
| H3 | R5 | The approved list moves out of per-instance state into one module-level array, "so an Allow always isn't lost when an instance reloads". A plausible refactor that makes approvals outlive a restart. | **R5** (restart). The property restarts by building a fresh service on the same directory, and a module-level array survives that, so the edit after the restart is not prompted. I also expect **R6** to fail as a side effect: the array is shared by every generated case, so once an earlier test has approved `"*"`, R6's edits stop prompting at all. | **Killed** by R5 and R6, as predicted. R5 shrank to one Allow always on `a.ts` followed by a restart (`[[], ["a.ts"], "a.ts"]`): the module-level list survives, so the edit after the restart is not prompted. R6 shrank to `[[], ["a.ts"], "a.ts", "once"]` and failed on its very first case, because R5 had already left `"*"` in the shared list, so even the single-call edit was never prompted. |
| H4 | R6 | `reply`: on Allow always, the approved patterns come from `existing.info.patterns` (the files in the prompt) instead of `existing.info.always`. It reads like a safety tightening, "only approve the files the user actually saw", but it breaks "Allow always on the first approves the rest". | **R6** (metamorphic). With 2 or more files arriving as separate calls, every file after the first is prompted again, so the prompt count grows with the number of files. I also expect **R5** to fail: its "before restart" check edits a new file after the Allow always and expects no prompt. | **Killed** by R5 and R6, as predicted. R5 shrank to Allow always on `a.ts` and then an edit to `a.env.example`, which prompted again before any restart. R6 shrank to `[[], ["a.ts"], "a.tsx", "once"]`: with separate calls for `a.ts` and `a.tsx`, Allow always on the first no longer covers the second, so there were 2 prompts instead of 1. |
| H5 | R4 | `ask`: the deny check evaluates `request.patterns[0]` instead of the current `pattern`, so only the first file of a request is checked against deny rules. A multi-file `apply_patch` whose first file is allowed can write a denied `.env` as its second file. | **Nothing. I expect this to survive.** R4 only ever asks to edit one path at a time, so `patterns[0]` is always the path being checked. R6 does send several paths in one request, but only safe paths with no deny rule. No property combines several files with a deny rule. | **Survived**, as predicted, against all four properties. No property sends a multi-file request that includes a denied path, so checking only `patterns[0]` is invisible to them. To kill it, R4 would need to generate requests with several paths in which a secret path is not first. |

## Stryker comparison

**Setup.** Config: [`packages/opencode/stryker.anniemin.config.json`](../packages/opencode/stryker.anniemin.config.json). It uses the `command` runner with `bun test test/permission/approval.property.test.ts` (only my property file) and mutates only the functions my properties call in `src/permission/index.ts`: `evaluate` (lines 35-45), `ask` (74-117), `reply` (119-177) and `editMode` (211-216). `fromConfig` and `expand` are left out, because the properties use them only to build a fixed config. **fast-check seed: 42**, set with `fc.configureGlobal({ seed: 42 })` at the top of the test file. The final report is [`mutants/anniemin/mutation.html`](../mutants/anniemin/mutation.html).

**Mutation score.**

| Run | Killed | Timeout | Survived | Score |
|---|---|---|---|---|
| First run, Stryker's default timeout | 44 | 55 | 3 | 97.06% (not trustworthy, see below) |
| Before strengthening, `timeoutMS: 60000`, `concurrency: 4` | 51 | 1 | 50 | **50.98%** |
| After strengthening | 76 | 1 | 25 | **75.49%** |

The first run's 97% was wrong. With 8 `bun test` processes running at once, Stryker's default timeout (about 1.5 × the clean run time + 5 s) was too short, and 55 mutants "timed out". Stryker counts a timeout as a kill. Many of them could not have changed behavior at all, such as the log message on line 81 and the `Effect.fn` span name on line 74. Raising `timeoutMS` to 60 s and capping `concurrency` at 4 left a single timeout (mutant 44, which empties the whole `reply` body so every prompt waits forever: a real hang). Every number below comes from the corrected runs.

**Which of my hand-written mutants did Stryker never generate, and why?** None of the five. Stryker only replaces or removes what is already there: it flips conditions and operators, empties blocks, blanks strings and objects, and swaps methods like `every` for `some`. Each of mine needs something its operators can't express:
- **H1** swaps one variable for another (`rule.action` instead of a fresh `evaluate(...)` call).
- **H2** adds new code, a `push` onto the approved list.
- **H3** moves state from per-instance storage to module scope.
- **H4** reads a different field of the same object (`patterns` instead of `always`).
- **H5** replaces the loop variable with `request.patterns[0]`.

The closest Stryker came is mutant 16 (`if (false)` on the deny check), which removes deny rules entirely. Any deny test kills that, but it says nothing about the subtle way H1 and H5 break deny rules only some of the time.

**Which Stryker survivors would I never have thought of? Are any plausible real bugs?** Before strengthening, several:
- **Mutant 35:** `request.id ?? PermissionV1.ID.ascending()` becomes `request.id && ...`. Callers never pass an id, so every prompt gets the id `undefined`, and two prompts open at once overwrite each other in the pending map. That is a plausible typo with a serious effect: parallel tool calls would hang.
- **Mutant 90:** `metadata?.edit_approval` becomes `metadata.edit_approval`. An edit in a session with no metadata would crash. Very plausible, since the optional chain looks unnecessary until you meet a session without metadata.
- **Mutants 101-103:** these drop `"simple"` from `editMode`, so Simple changes only falls back to the config. That's exactly the kind of bug someone writes when adding a third mode to a two-mode check.
- **Mutants 58-60 and 73-75:** these invert or remove the `sessionID` filter in `reply`, so answering one session's prompt would settle prompts in other sessions.
- **Mutants 76-84:** these weaken the "every file must already be approved" check that auto-settles parallel prompts.

I hadn't thought about parallel tool calls at all. My R6 property only ran separate calls one after another, so all of `reply`'s cascade loops were untested.

**What does each approach find that the other doesn't?** Hand-written mutants start from a requirement and ask how it could quietly break. That reaches bugs no operator can make: state that outlives a restart (H3), a field swapped for a similar one (H4), and a check that only looks at one element (H5). H5 exposed a real gap in R4, which only ever tested one file per request. Stryker starts from the code and tries every branch and literal. It found whole paths my properties never reached (the parallel cascade, sessions without metadata, the deny error's contents), but it also produces noise, such as log strings and span names, that has to be argued away as equivalent. And it needs care with timeouts before its score means anything.

## Strengthening

All survivors were killed by changing properties, not by adding example tests:

| Change | Property | Kills |
|---|---|---|
| Check every step of the mode-switch sequence, not just the end: Never ask never prompts, Always ask and Simple changes only always do | R2 (round-trip) | Stryker 92, 94, 101, 102, 103 (`editMode` dropping `"never"` or `"simple"`) |
| Generate requests of 1-4 files with the secret path at any position | R4 (invariant) | **H5** (now shrinks to `["a.ts", "a.env"]`) |
| Generate sessions with no mode, both `{}` and missing metadata, and assert the exact prompt count for every mode instead of only "not denied" | R4 (invariant) | Stryker 90 (`metadata?.` → `metadata.`), 95 (an unset mode treated as Always ask) |
| Add a `bash` rule to the config and assert the deny error lists exactly the edit rules | R4 (invariant) | Stryker 21, 22 (the deny error's `ruleset` left unfiltered or emptied). That list is part of the message the model sees. |
| New property: 1-5 edits issued in parallel, as a model's parallel tool calls are, while another session has a prompt open. One answer must settle every edit in the session the same way (`"always"` or rejected) and leave the other session's prompt open | R6 (metamorphic) | Stryker 35, 57-60, 72-75, 77, 79-83, 88 (`reply`'s cascade loops, the session filter, and prompt ids) |

After strengthening, all five hand-written mutants are killed: H3 is now also caught by R4, and H5 by R4.

## Equivalent mutants

Eleven of the 25 survivors are equivalent: no test can kill them, because nothing observable changes.

| Mutants | Change | Why it's equivalent |
|---|---|---|
| 6, 7, 8 | `evaluate`'s fallback rule (used when no rule matches) becomes `{}`, gets action `""`, or gets pattern `""` | Every caller of `evaluate` (`ask`, `reply`, `truncate.ts`, `registry.ts`, `skill/index.ts`, `prompt.ts`, the debug agent) only checks `action === "deny"` or `action === "allow"`, and `ask` prompts for any action that is neither. `"ask"`, `""` and `undefined` therefore behave the same everywhere. Nothing reads the fallback's `pattern`. |
| 9, 43 | The `Effect.fn` span names `"Permission.ask"` and `"Permission.reply"` become `""` | The span name only labels traces. It's never read by program logic and never part of a result, error or event. |
| 13, 14, 37, 38 | The `Effect.logInfo` messages `"evaluated"` and `"asking"`, or their payloads, become empty | Log output is a side channel that nothing in the program reads back. Every value the service returns, fails with, or publishes is unchanged. |
| 61, 85 | `reply` no longer deletes the other prompts it settles from `pending` (reject loop line 141, always loop line 169) | Each of those prompts belongs to an `ask` fiber that removes its own entry in `Effect.ensuring` as soon as its Deferred is completed. The `Deferred.fail`/`Deferred.succeed` on the next lines does that, so the entry disappears either way. The parallel property calls `list()` right after `reply` returns and never sees a leftover entry, which matches this: the woken fibers clean up before control comes back. |

**Survivors that are not equivalent but are outside my requirements (14):**
- **41, 42:** `ask`'s cleanup on interruption. Only matters when a session is cancelled while its prompt is open. No requirement covers cancellation.
- **47, 48:** answering a prompt id that no longer exists. A double-click in the TUI, not covered.
- **49, 50, 62, 63, 86, 87:** the `Replied` events the TUI uses to close prompt dialogs. The properties call the service directly and don't observe its events.
- **56:** the user's feedback text on a reject. "Reject with feedback" isn't one of my requirements.
- **76, 78, 84:** `every` → `some`, or the per-file check forced to `true`. These can't change an *edit*, because every edit tool sends `always: ["*"]`, so after Allow always every file is approved and `every`, `some` and `true` agree. They would matter for permissions with narrower patterns, like bash's `"git *"`, which none of my requirements cover.

**Final mutation score**
- As Stryker reports it: **75.49%** (77 detected out of 102 mutants).
- With the 11 equivalent mutants excluded: **84.6%** (77 detected out of 91).

## Agent failure case

None of my properties came from opencode (they were written with Claude Code, as noted above), so I asked opencode to write one for R4. I tried twice. Model: Nemotron 3.5 Lightning (free) via OpenRouter, in opencode's Build agent.

### Attempt 1: opencode copied my property

Share link: https://opncd.ai/share/Iqdx5HrI (screenshots: [prompt](anniemin-opencode-attempt1-prompt.png), [response](anniemin-opencode-attempt1-response.png))

> Read requirement R4 in traceability/anniemin.md and the permission service in packages/opencode/src/permission/index.ts. Write one fast-check property test for R4 in a new file packages/opencode/test/permission/approval.opencode.property.test.ts. Use bun:test and fast-check, and fix the fast-check seed to 42. Do not change any other file. don't take too long.

opencode read the traceability file and the permission service, then globbed `test/permission/`, read my existing `approval.property.test.ts`, and wrote back my already-strengthened R4 property almost line for line, comments removed. It killed every R4 mutant (H1, H3, H5), but only because it *was* my property. That doesn't work as a failure case. Still, it's worth recording: given an existing test nearby, the agent reproduced it instead of reasoning about the requirement.

### Attempt 2: opencode's own property

Share link: **https://opncd.ai/share/4yOrLoye** (screenshots: [prompt](anniemin-opencode-prompt.png), [response](anniemin-opencode-response.png))

> Read requirement R4 in traceability/anniemin.md and the permission service in packages/opencode/src/permission/index.ts. Write one fast-check property test for R4 in a new file packages/opencode/test/permission/approval.opencode.property.test.ts. Use bun:test and fast-check, and fix the fast-check seed to 42. Do not read, open or copy packages/opencode/test/permission/approval.property.test.ts or anything under mutants/; write the property and generators yourself. You may look at packages/opencode/test/permission/next.test.ts for how to set up the Permission service. Do not change any other file. don't take too long on this

opencode read the requirement, the service and `next.test.ts`, grepped for existing fast-check use, and then read the attempt-1 file it had written before (`approval.opencode.property.test.ts`, which my prompt didn't rule out). So it reused the setup helpers and path generators, but the property itself is new. This is its core, as written:

```ts
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
```

### The mutant it let survive

It passes on the real code and kills H1 (shrunk to `[{edit_approval: "always"}, true, "a.env"]`), but **H5 survives**. H5 is the R4 mutant where `ask` checks deny rules against `request.patterns[0]` instead of each file, so a multi-file `apply_patch` can write a denied `.env` as long as the first file is allowed. (H2, H3 and H4 survive as well, but they target R2, R5 and R6, which an R4 property isn't expected to catch.)

| Mutant | opencode's property | Strengthened property |
|---|---|---|
| H1 (R4) | Killed | Killed, `[{edit_approval: "always"}, true, [".env"]]` |
| H5 (R4) | **Survived** (200 runs, seed 42) | **Killed**, `[{edit_approval: "always"}, false, ["a.ts", ".env"]]` |

### Why the property was too weak

**The generator never reaches the bug.** `fc.oneof(safePath, secretPath)` produces exactly one path, and the edit is always `paths: [path]`, so `request.patterns[0]` *is* the path being checked and H5's change is invisible. R4's own acceptance criteria are about single files, which makes a one-path generator look complete. But the code it tests receives a list of files, and `apply_patch` really does send several at once. opencode modelled the requirement's example instead of the input space of the function. Two smaller weaknesses: it never turns on plan mode, which R4 names explicitly ("in plan mode under all three modes"), and for safe paths it only checks that the edit didn't fail. That last check is close to a weak oracle, since it doesn't check whether the user was prompted.

### Strengthened version and evidence

The second test in [`approval.opencode.property.test.ts`](../packages/opencode/test/permission/approval.opencode.property.test.ts), "R4 (strengthened): a denied file anywhere in a request denies the whole request", keeps opencode's assertions and changes only the generator. Each request holds one to four files, and when a secret path is included, `fc.nat()` places it at any position:

```ts
const request = fc
  .record({ safe: fc.array(safePath, { maxLength: 3 }), secret: fc.option(secretPath, { nil: undefined }), at: fc.nat() })
  .filter((item) => item.safe.length > 0 || item.secret !== undefined)
  .map((item) =>
    item.secret === undefined ? item.safe : item.safe.toSpliced(item.at % (item.safe.length + 1), 0, item.secret),
  )
// ...and the secret check becomes: if (paths.some(isSecretPath)) { ...expect DeniedError... }
```

Evidence: with `git apply mutants/anniemin/H5.patch`, `bun test test/permission/approval.opencode.property.test.ts` reports opencode's test passing and the strengthened test failing with the counterexample `[{edit_approval: "always"}, false, ["a.ts", ".env"]]`: a two-file request whose second file is `.env` is allowed instead of denied. Without the mutant, both tests pass. My main R4 property in `approval.property.test.ts` uses the same multi-file generator, plus plan mode and exact prompt counts (see Strengthening).
