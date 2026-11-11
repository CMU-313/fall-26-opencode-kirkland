# Traceability: Gavin Lin (gavinlin)

**Target feature:** Session budget — a per-session cap on tokens and/or USD cost, checked before every model request, which stops the turn or asks for approval and warns once at 80%. It lives in [`packages/opencode/src/session/budget.ts`](../packages/opencode/src/session/budget.ts) (the decision logic), [`packages/opencode/src/session/prompt.ts`](../packages/opencode/src/session/prompt.ts) (`enforceBudget`, at the top of the agent loop), [`packages/core/src/v1/config/config.ts`](../packages/core/src/v1/config/config.ts) (the `budget` config block), and the TUI's `/budget` dialog and sidebar panel.

## Requirements

| ID | Interview evidence | Requirement | Acceptance Criteria | Changed in P4? | Property (kind) | Test | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | S-2, S-4, O-4: "Expect it to enforce the limit"; "tell you after the current prompt"; "No it should not because thats the whole point of budget setting fo rme" | Once usage has reached the budget, no new model request is sent. A request already in progress may finish, and the stop is reported right after it. | Token budget 500,000, action "stop": with usage at 499,000, a request that uses 2,000 tokens completes (usage 501,000) and the next request is blocked with a stop message. With usage at exactly 500,000, the next request is blocked. | No | **Invariant:** for any budget, approval count and usage placed anywhere from 0 to 3× a ceiling, `check` reports a hit exactly when some configured limit has reached its ceiling, and the limit it names is itself at or past its ceiling. | `budget.property.test.ts`: "R1: a request is blocked exactly when usage has reached a ceiling" | H1 (its boundary property), and Stryker's removal of the no-budget guard on line 43 (killed by the no-budget property added in P5). |
| R2 | S-5, O-6, C-6: "It should be a separate setting for" how much more to add; "It should ask me a new budget, and then never ask again until that budget is hit"; "It should be set to whatever new budget i set it to" | When the user approves continuing past the budget, they choose how much extra budget the approval grants, and opencode asks again only after that extra amount is used. | Token budget 1,000 with `grant.tokens` 500, action "ask": usage reaches 1,000, the user approves, so no approval prompt appears at usage 1,200, and a prompt appears once usage reaches 1,500. With no `grant` set the approval grants one more full budget, so the next prompt is at 2,000. | No — code changed instead | **Model / oracle:** the closed-form ceiling is compared against an obviously-correct version that adds the granted amount once per approval. **Metamorphic:** adding one approval moves the stop by exactly the grant and by nothing else. | `budget.property.test.ts`: "R2: the approval ladder matches adding the grant one approval at a time" and "R2: approving moves the next stop by exactly the granted amount" | H1 and H2. H2 is killed only by the model/oracle half, which rebuilds the ladder independently; the invariant half calls `ceiling` itself and is blind to it. |
| R3 | S-6, O-8: "You should see that warning again"; "the warning should be relative to my current budget setting"; C-8: "It should still give the same since it is still 50% usage" | Changing the budget and then changing it back re-arms the 80% warning, so it shows again (once) when usage is at or above 80% of the restored budget. | Budget 1,000 with usage 850: the warning shows once. Change the budget to 2,000, then back to 1,000: the warning shows again exactly once. | No — code changed instead | **Round-trip:** warn once, edit the budget away, edit it back, and the warning is due again and is the same warning; left alone, it stays quiet. **Metamorphic:** scaling every limit and every usage figure by the same power of two changes no decision. | `budget.property.test.ts`: "R3: changing the budget away and back re-arms the warning" and "R3: scaling the budget and the usage together changes no decision" | H3, and Stryker's collapse of `key` to a constant on line 66 (killed by the key property added in P5). |
| R4 | S-1, S-8, C-1, O-1: "the UI is better than the general number"; "breakdown by time"; "check the percentage usage" | The stop message shows usage against the limit and names which limit was hit. | Cost budget $1.00, stopped at $1.02: the message shows $1.0200 used of $1.00 and names cost as the limit hit. | **Yes** | **Invariant:** for every stop, the message names the limit that was hit and contains both the used figure and the limit figure. | `budget.property.test.ts`: "R4, R6: every stop message names the limit, shows both numbers, and says how to continue" | H5, via the shared R4/R6 message property. |
| R5 | S-9, C-4, C-9, O-10: "let me know before the ... limit is hit"; "If it didn't give me the warning when it reached the limit"; "it defeats the purpose of the warning of this feature" | A session is never stopped by a limit without first showing the 80% warning for that same limit. | Token budget 1,000 and cost budget $1.00: cost reaches $0.80 first, so a cost warning shows. If a turn jumps from $0.70 to $1.05, the cost warning still appears before or together with the stop message. | No — code changed instead | **Invariant:** whenever `check` reports a stop, a warning is due for the same limit and the same ceiling. | `budget.property.test.ts`: "R5: a stop always comes with the warning for the same limit" | H4, and Stryker's whole ranking-and-boundary family: lines 45 and 60 (the sort), 59 (the zero-ceiling ratio guard), 61 (`find(...) && ranked[0]`) and 81 (the 80% boundary). All of these needed the strengthened R5 property; the original one killed none of them. |
| R6 | S-10: "suggest [to] users how to fix it" | Every budget stop message tells the user how to continue. | When a turn is stopped by the budget, the message text includes how to raise the budget (the `/budget` command) or how to approve continuing. | No — code changed instead | **Invariant:** every stop message, for either limit and either action, mentions `/budget`. | `budget.property.test.ts`: "R4, R6: every stop message names the limit, shows both numbers, and says how to continue" | H5, and all four of Stryker's action-branch mutants on line 98 (killed by the message-instruction property added in P5). |
| R7 | C-5, O-5: "nothing should be able to be used"; "I am expecting nothing get spend except the prompt to set the budget" | A budget of 0 blocks every model request in the session. Setting the budget itself does not send a model request. | Set a token budget of 0 with action "stop", then send a prompt: no model request is sent, usage stays at 0 tokens and $0.00, and a stop message is shown. | No | **Invariant:** a limit of 0 blocks at every usage figure and after any number of approvals, because with no grant configured an approval adds nothing to a zero ceiling. | `budget.property.test.ts`: "R7: a budget of 0 blocks every request, at any usage and after any approval" | H1. |
| R8 | C-3, O-3, O-7: "if i set x amount it should stay at x"; "The budget should never be forgotten within this session"; "It should remember my budget" | The budget stays the same for the whole session, including after opencode is restarted and the session is resumed, until the user changes it with /budget. Usage spent so far is kept too. | Set a token budget of 500,000 and use 300,000 tokens. Quit opencode and resume the same session: the budget is still 500,000, usage shows 300,000, and the stop happens at 500,000 total, not after 500,000 more. | No | **Round-trip:** a budget survives the real `ConfigV1.Info` decoder after a JSON round-trip and still produces identical stop and warning decisions. This covers the reload path a restart takes; resuming the session itself is integration-tested, not property-tested. | `budget.property.test.ts`: "R8: a budget survives a config round-trip and decides identically" | None on its own. It re-decides everything through the real config decoder, so it re-kills what the other properties already kill rather than catching a mutant none of them catch. |

All properties live in [`packages/opencode/test/session/budget.property.test.ts`](../packages/opencode/test/session/budget.property.test.ts), under the `session budget properties` describe block. Kinds used: invariant, model/oracle, round-trip, metamorphic.

**Generator choices.** The budget rules only change behaviour at two points — 80% of a ceiling and the ceiling itself — and uniformly random numbers essentially never land on either. So limits are drawn from the round numbers users actually type (0, 1, 1,000, 500,000, 1,000,000 tokens; $0, $0.01, $1, $5, $12.50) and usage is positioned as a *fraction* of the resulting ceiling (0, 0.5, 0.79, 0.8, 0.95, 1, 1.05, 3) instead of being drawn independently. That is the only way to reach "exactly at it, like 500,000 out of 500,000", the case C-4, S-4 and O-4 all raised, and the 0.79/0.8 pair that straddles the warning. Budgets are generated with cost only, tokens only, both, or neither, because only a budget with *both* limits set can reach O-10's complaint of being warned about one limit and stopped by another. Approval counts run 0–4. The scaling factors for the metamorphic property are powers of two, so multiplying a limit or a usage figure by one is exact in binary floating point and the scaled session has bit-for-bit the same ratios.

Properties written or suggested by opencode or another AI tool: R1, R2, R3, R4, R5, R6, R7, R8 — every property and generator in this file was drafted with Claude Code (Opus) from the requirements above, then reviewed, run and triaged by me. The four code fixes below were also made with Claude Code.

## Requirement changes

Seven of the eight requirements were kept as written. R1 and R7 were already met by the code. R3, R5 and R6 were not met, but in each case the requirement was buildable and the code was wrong, so the code was fixed rather than the requirement (see "Run, triage and fix" below). R2 was not met either: the code granted one more full budget per approval instead of an amount the user picks. That was a contained change — a `grant` block in the budget config — and it is what S-5 asked for literally ("a separate setting for how much more you want to add after approving"), so again the code was changed. R2's wording is unchanged: the user does choose the amount, in the budget config rather than at the approval prompt, which is where S-5 and C-6 both put it ("It should be set to whatever new budget i set it to"). O-6 described being asked for a new budget at the prompt instead; that part is not built, because the approval is a yes/no permission prompt that cannot carry a number, and the majority preference was a setting. R8 is kept as written; only part of it is property-checkable, and the Property column says which part.

Only R4 changed.

### R4

| | |
|---|---|
| **Original (P3)** | The stop message shows usage against the limit and which limit was hit, plus a per-turn breakdown of usage over time. |
| **Why it can't be built as is** | The stop message is built by `SessionBudget.describe` from the budget check, which is handed only the limit, the ceiling and the total used. A per-turn breakdown would mean reading and aggregating every message in the session from inside the error path, which is both out of this feature's boundary and the wrong place for it: the usage breakdown belongs in a usage view, not in a one-line stop message. |
| **What the user actually needed** | S-1 and C-1 wanted to see usage as a proportion rather than a bare number ("the UI is better than the general number", "check the percentage usage"); S-8's "breakdown by time" was about reviewing usage, not about the stop message. The sidebar Budget panel already shows usage against the cap and the percentage used, turning yellow at 80% and red at 100%, which is where that need is met. |
| **Revised (P4)** | The stop message shows usage against the limit and names which limit was hit. |

## Run, triage and fix

Four properties failed against the code as it stood. All four were code bugs, so the code was fixed in each case; no property was rewritten to fit the code, and no requirement changed as a result. Each counterexample below is from running that property against the code with only that one fix reverted, to confirm the property really does catch the bug.

| Requirement | What the property found | Outcome | Fix |
|---|---|---|---|
| R5 | `warning` returned nothing once usage reached the limit, so a turn that overshoots the budget in a single request was stopped with no warning ever shown. Counterexample: `[{cost:0},0,0,0]` — a $0 budget stops immediately and warned about nothing. | Code bug | `warning` is now due from 80% onwards and stays due at and past the limit, until it has been shown for that exact ceiling. `enforceBudget` publishes it before the stop instead of only on the under-limit path. |
| R5 | `check` always reported `cost` first whatever the pressure, while `warning` reported whichever limit was closest to its ceiling, so a session could be warned about tokens and stopped by cost — exactly O-10's complaint. Counterexample: `[{cost:1,tokens:0},0,1,0]` — cost exactly at $1 and a 0-token ceiling; the stop said cost, the warning said tokens. | Code bug | Both now read one function, `pressure`, which prefers a limit that is actually exceeded and otherwise the one closest to its ceiling. `check` is a thin wrapper over it, so the two cannot disagree. |
| R3 | The 80% warning was remembered by ceiling value alone, so editing the budget from 1,000 to 2,000 and back to 1,000 landed on a ceiling that had already been warned about and the warning stayed suppressed — the exact scenario in R3's acceptance criteria. Counterexample: `[{tokens:0},{},0,0]`. | Code bug | Added `SessionBudget.rearm`, which drops the "already warned" marker whenever the configured budget differs from the one last seen. A ceiling alone cannot carry this, since an edit away and back returns to the same ceiling. `enforceBudget` now tracks the last budget per session. |
| R6 | `describe` ended at the numbers and never told the user how to continue, so every stop message was a dead end. Counterexample: `[{tokens:0},0,0,0,"stop"]`. | Code bug | `describe` now takes the configured action and appends how to get going again: raise it with `/budget`, or switch to `"ask"` to approve continuing. |

One existing example test, `warning > stays quiet at or past the limit, where the stop takes over`, asserted the behaviour R5 forbids. It was rewritten as `warning > still fires at or past the limit, so a stop is never silent`, and a second example test was added for the "only once per ceiling" half that the old test was conflating with it.

## Hand-written mutants

Five mutants, written and predicted before Stryker ran and before I had seen anything it
generates. All five change [`packages/opencode/src/session/budget.ts`](../packages/opencode/src/session/budget.ts),
and all five are meant to read as acceptable in review: a boundary moved by one character, a
refactor that quietly drops an argument, a comparison narrowed to one field, a message that
stops one clause short. The patches are in [`mutants/gavinlin/`](../mutants/gavinlin).

Apply one with `git apply mutants/gavinlin/H1.patch`, run
`bun test test/session/budget.property.test.ts` from `packages/opencode`, then revert it with
`git apply -R mutants/gavinlin/H1.patch`.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R1 | `check`: the under-limit guard goes from `hit.used < hit.max` to `hit.used <= hit.max`, so usage sitting exactly on the ceiling no longer blocks. This is the "500,000 out of 500,000" case C-4, S-4 and O-4 each raised unprompted. | **R1** ("blocked exactly when usage has reached a ceiling"). Its oracle computes `reached` with `>=`, and `position` generates exactly `1`, so the two disagree on the first budget that lands on its ceiling. **R2**'s second property and **R7** should also fail, since both assert a stop exactly at a ceiling. | **Killed**, by all three predicted properties. R1 shrank to `[{cost:0,tokens:undefined,action:"stop",grant:undefined},0,0,0]`: a $0 cost budget with $0 spent sits exactly on its ceiling, so `reached` is true and the mutated `check` returns nothing. R2's second property shrank to `[0,0,0]` and R7 to `["cost",0,0,0]`, both the same boundary. |
| H2 | R2 | `ceiling`: `max + (grant ?? max) * approvals` becomes `max * (approvals + 1)`. Identical when no `grant` is configured, which is what makes it survive a reading; with a `grant` set it silently ignores it and hands back one more whole budget per approval — the exact behaviour R2 was written to replace. | **R2**'s model/oracle property, which rebuilds the ladder independently by adding `grant` once per approval, so it disagrees whenever `grant ≠ max` and `approvals ≥ 1`. I expect **R1** to stay green and miss it: R1's oracle calls `ceiling` itself, so the mutant moves both sides of its comparison equally. | **Killed**, by R2's model/oracle property only, shrunk to `[0,1000000,1]` — a limit of 0 with a grant of 1,000,000 and one approval, where the real ladder gives 1,000,000 and the mutant gives 0. R1 stayed green exactly as predicted: its oracle calls `ceiling` itself, so the mutant moves both sides of its comparison together and it cannot see the change. The independent reimplementation is what catches this, not the invariant. |
| H3 | R3 | `rearm`: the whole-budget comparison `JSON.stringify(previous) === JSON.stringify(next)` narrows to `previous?.tokens === next?.tokens`. Re-arms on a token edit but not on a cost-only edit — an undo that restores everything except one field. | **R3**'s round-trip property. It generates a second budget, requires it to differ from the first, and then edits away and back; whenever the two differ only in cost (or in `action`/`grant`) the mutant keeps the stale "already warned" marker and the warning never comes back. | **Killed**, by R3's round-trip property, shrunk to `[{cost:0,tokens:1000,...},{cost:undefined,tokens:1000,...},0,0]` — two budgets with the same token limit that differ only in whether a cost limit is set. The mutant compares tokens, sees no change, keeps the stale marker, and the warning never comes back. |
| H4 | R5 | `warning`: `worst.ratio < WARNING_RATIO` becomes `<=`, so a session sitting exactly on 80% is never warned. | **Nothing — I think this one survives.** Every property that touches `warning` either preconditions on a warning already existing (R3's round-trip uses `fc.pre(first !== undefined)`, R5 only runs once a stop has happened) or compares two runs that shift together (R3's metamorphic scaling, R8's config round-trip). None of them ever asserts that a warning *is* due at exactly 80%, so moving that boundary is invisible to all nine. | **Survived**, as predicted, against all nine properties. See [Strengthening](#strengthening) for the property I added to kill it. |
| H5 | R6 | `describe`: the non-`ask` branch returns `` `${reached}.` `` and drops "Raise it with /budget, or set budget.action to..." — the dead-end message R6 was written against, reintroduced for one branch only while the `ask` branch still reads correctly. | **R4/R6** ("every stop message names the limit, shows both numbers, and says how to continue"), which asserts `toContain("/budget")` and generates `action` as `"stop"`, `"ask"` and `undefined`, so two of three generated actions hit the mutated branch. | **Killed**, by R4/R6, shrunk to `[{cost:0,...},0,0,0,"stop"]` — the first generated `"stop"` action produces a message with no `/budget` in it. |

## Stryker comparison

Configuration: [`packages/opencode/stryker.gavinlin.config.json`](../packages/opencode/stryker.gavinlin.config.json).
It runs only my property file (`bun test test/session/budget.property.test.ts`) through the
command runner, and mutates only `src/session/budget.ts:30-101` — everything my properties
actually call. Line 25–28 (`total`, which sums a `Tokens` record) is deliberately left out: it is
reached only through `enforceBudget`, no property calls it, so every mutant in it would survive
for a reason that says nothing about my properties. A run takes about 10 seconds.

**fast-check seed: 42**, set with `fc.configureGlobal({ seed: 42 })` at the top of the property
file. Without it a mutant can die on one run and live on the next, and the score is not a number
you can compare against anything.

Stryker generated **80 mutants** over those lines. Before strengthening: **60 killed, 20
survived, 75.00%**. The report is committed at [`mutants/gavinlin/mutation.html`](../mutants/gavinlin/mutation.html).

The 20 survivors fell into four groups:

| Where | Count | What the mutants did |
|---|---|---|
| `pressure`'s ranking (lines 45, 59, 60, 61) | 12 | removed the `.sort`, reversed it to `+`, replaced the zero-ceiling ratio guard with `true`/`false`/`>=`/`<=`, and replaced the `find` predicate five ways |
| the no-budget guard (line 43) | 1 | `if (!budget)` → `if (false)` |
| `key` (line 66) | 1 | collapsed `` `${hit.limit}:${hit.max}` `` to the empty string |
| `warning`'s boundary (line 81) | 2 | `< WARNING_RATIO` → `<=`, and the whole guard → `if (false)` |
| `describe`'s action branch (line 98) | 4 | `action === "ask"` → `true`, `false`, `!== "ask"`, `=== ""` |

### Which of my hand-written mutants did Stryker never generate? Why not?

**H2, H3 and H5.** All three are multi-token rewrites, and Stryker's operators are deliberately
local — it changes one token or one node and leaves the shape of the expression alone. The JSON
report shows exactly what it did to `ceiling` instead of H2: `max - (grant ?? max) * approvals`,
`(grant ?? max) / approvals`, and `grant && max`. Every one keeps the three-term shape. H2's
`max * (approvals + 1)` drops a sub-expression and rebuilds the arithmetic, which no single-node
operator can reach. H3 is further out still: replacing a structural `JSON.stringify` comparison
with `previous?.tokens === next?.tokens` means inventing a property access that does not appear
on that line. Stryker only flipped the `===` to `!==` and emptied the literals. H5 is the same
story in a template literal — Stryker replaced whole strings with `""`, but it has no operator for
"keep the sentence and drop its second clause", which is what makes H5 read as plausible.

**H1 and H4 it generated exactly.** `hit.used <= hit.max` is an `EqualityOperator` mutant on line
88, and `worst.ratio <= WARNING_RATIO` is one on line 81. That overlap is the useful part: where
I reasoned from boundaries, the tool and I picked the same two lines, and H4 surviving *both* runs
told me the gap was in my properties rather than in my imagination.

### Which Stryker survivors would I never have thought of? Are any of them bugs a real developer might plausibly write?

The whole `pressure` ranking group, and it is the answer to both halves of the question. I wrote
my five mutants by reading R1–R8, and **no requirement of mine mentions ranking at all** — R5 says
a stop must come with the warning for the same limit, which constrains the two outputs to *agree*,
not to be *right*. So it never occurred to me to attack the sort. Stryker, which does not read
requirements, mutated it eight different ways and all eight lived.

Three of them are plausible bugs:

- **`.sort((a, b) => a.ratio - b.ratio)`** (Stryker's reversal is `+`, but ascending is the same
  class and the slip a real developer makes, since ascending is the default habit). It names the
  *least* pressured limit, so a session at 99% of its token cap gets warned about cost at 1%.
  That is O-10's complaint — warned about one limit, stopped by another — reintroduced through
  the one line my fix in P4 did not constrain.
- **`candidate.max > 0 ? ... : Infinity` → dropping the guard.** With a zero ceiling this divides
  0 by 0, and every comparison against the resulting `NaN` is false. A developer tidying up what
  looks like a dead defensive branch writes exactly this, and the symptom is a budget of 0 that
  stops correctly but whose warning is nonsense — the case C-5 and O-5 both asked about.
- **`describe`'s `action !== "ask"`** (line 98, four mutants). The most plausible of the lot: one
  character, and it still compiles and still produces a sensible-looking sentence. It tells a user
  with `action: "stop"` to "approve continuing when asked", promising an approval prompt that will
  never appear, and tells a user on `"ask"` to go edit their config instead. S-10 asked for a
  message that says how to fix it; this one says how to fix it *wrongly*, which is worse than
  saying nothing.

The `if (!budget) return undefined` → `if (false)` survivor is not plausible as written — nobody
deletes a null guard like that — but it exposed the real hole: **every property I had generated a
budget**, so nothing ever called this module the way it is called for a user who has never run
`/budget`, which is most users. That is a gap in my generators that no amount of rereading R1–R8
would have shown me.

### What does each approach find that the other doesn't?

Stryker is exhaustive and indifferent. It enumerated all 80 single-token edits in the lines I
pointed it at, which is how it reached the ranking logic and the no-budget guard — code my
requirements do not talk about, so code I was never going to attack. It also quantifies: "20 of
80 survive" is a fact about my properties that no amount of hand-writing produces.

Hand-written mutants reach changes no operator can express, and they are tied to a *requirement*
rather than to a token. H3 exists because R3's once-per-ceiling rule is subtle and I wanted to
know whether my round-trip really pinned it down; it is a cleanup that narrows a comparison, the
kind of change that passes review precisely because it looks like simplification. Stryker cannot
generate it, and nothing in the source would have drawn a tool's attention to that line.

They also fail differently. Stryker's survivors need triage — 3 of my 20 turned out to be
behaviourally identical to the original and unkillable by anything — whereas every hand-written
mutant came with a prediction, so a surprise was immediately informative. H4 surviving was worth
more to me than any single Stryker result, because I had written down beforehand *why* I expected
it to survive, and being right meant I understood the shape of the hole before I started fixing it.

## Strengthening

I added four properties and changed no existing one. All four work by strengthening the oracle or
widening the generator; none is an example-based test, and none of the survivors was killed by
asserting a specific input/output pair.

| New property | Kind | Requirement | Kills |
|---|---|---|---|
| "the warning is due exactly from 80% of the most pressured limit, and names that limit" | model / oracle | R5 | H4 and 11 Stryker mutants: lines 45, 59 (×4), 60 (×2), 61 (`&&` and `>`), 81 (×2) |
| "the stop message offers the way to continue that the configured action allows" | invariant | R6 | H5 and all 4 line-98 mutants |
| "the warned-ceiling key tells two different ceilings apart" | invariant | R3 | the line-66 `key` mutant |
| "with no budget configured nothing is blocked and nothing is warned" | invariant | R1 | the line-43 no-budget mutant |

The first one is the substantive change. The original R5 property only asked that a stop be
accompanied by a warning naming the same limit; the strengthened version states the rule over the
whole range instead — rebuild each configured limit's live ceiling, take the one with the greatest
ratio, and require that a warning is due *exactly* when that ratio is at or above 0.8 and that it
names that limit. That single statement covers the boundary, the ranking and the zero-ceiling
guard at once, which is why it accounts for 11 of the 17 newly killed mutants.

The last one widened coverage rather than tightening an assertion: no generator had ever produced
"no budget at all", so I added a property that calls `check` and `warning` with the budget omitted.

### Results

| | Mutants | Killed | Survived | Score |
|---|---|---|---|---|
| Before strengthening | 80 | 60 | 20 | **75.00%** |
| After strengthening | 80 | 77 | 3 | **96.25%** |

All five hand-written mutants are now killed as well; H4 was the only one that had survived.

### Equivalent mutants

The three remaining survivors are all on line 61 and are all the same mutant in effect:

```
return ranked.find((candidate) => candidate.used >= candidate.max) ?? ranked[0]
                  ^ replaced by () => undefined, (candidate) => false, or (candidate) => true
```

Each reduces that line to `return ranked[0]`. With `() => undefined` and `=> false` the callback
is never truthy, so `find` yields `undefined` and `??` falls through to `ranked[0]`; with `=> true`
`find` returns the first element, which *is* `ranked[0]`. So all three are the program
`return ranked[0]`, and that program cannot be distinguished from the original. `ranked` is sorted
by `ratio` descending, and for every candidate `ratio >= 1` holds exactly when `used >= max`:
when `max > 0` because `ratio` is `used / max`, and when `max === 0` because `ratio` is `Infinity`
while `used >= 0 === max` is always true. So if any candidate satisfies the `find` predicate, the
one with the greatest ratio satisfies it too — and that is `ranked[0]`. The `find` therefore
returns `ranked[0]` whenever it returns anything at all, and `ranked[0]` is what the fallback
supplies when it doesn't. No input can tell the two apart, so no test can kill them.

That the original `find` is redundant is a fact about the code rather than about my properties.
I left it in place: it states the intent of the line, and Stryker's own fourth mutant on that
line — `used > max`, which is *not* equivalent, because two zero ceilings tie on `Infinity` and
the strict version skips the first of them — is killed by the strengthened R5 property.

### Final mutation score

- **As Stryker reports it: 96.25%** (77 killed of 80)
- **Excluding the 3 equivalent mutants: 100%** (77 of 77)

## Agent failure case

The agent here was **Claude Code (Opus)**, not opencode. As the AI-use note above records, every
property and generator in this file was drafted by it from my requirements table and then reviewed,
run and triaged by me, so the failure case comes from the properties I actually shipped rather
than from one written to order afterwards.

### Transcript excerpt

Session "Project 4: Properties & Fixes", November 5, 2026. The prompt that produced the properties
was the Project 4 brief I pasted in, whose Step 2 is the instruction it worked from:

> **Step 2: Write Properties for Your Requirements (Individual) (40 pts)**
> [...]
> Write property-based tests for at least 4 of your requirements.
> [...]
> Put your property tests next to the package's existing tests (e.g.
> `packages/opencode/test/<feature>/<feature>.property.test.ts`) and run them with `bun test` from
> inside the package. fast-check works with any test runner; you call `fc.assert(fc.property(...))`
> inside an ordinary `test(...)` block.

It then worked straight from the requirements table with no further prompting from me. The
response that created the file was announced in one line —

> Now the property test file.

— followed by a single write of all nine properties. The one it wrote for R5 was:

```ts
  // R5: "A session is never stopped by a limit without first showing the 80%
  // warning for that same limit." O-10 is the complaint this comes from: being
  // warned about tokens and then stopped by cost "defeats the purpose of the
  // warning".
  // Kind: invariant
  test("R5: a stop always comes with the warning for the same limit", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, (config, approved, costAt, tokensAt) => {
        const usage = usageAt(config, approved, costAt, tokensAt)
        const hit = SessionBudget.check({ budget: config, usage, approvals: approved })
        fc.pre(hit !== undefined)

        const warn = SessionBudget.warning({ budget: config, usage, approvals: approved })
        expect(warn).toBeDefined()
        expect(warn!.limit).toBe(hit!.limit)
        expect(warn!.max).toBe(hit!.max)
      }),
      { numRuns: 500 },
    )
  })
```

### The mutant it let survive

**H4**, and Stryker's identical twin at line 81, plus five more in the same family:

```diff
 export function warning(input: { budget?: Budget; usage: Usage; approvals?: number; warned?: string }) {
   const worst = pressure(input)
   if (!worst) return undefined
-  if (worst.ratio < WARNING_RATIO) return undefined
+  if (worst.ratio <= WARNING_RATIO) return undefined
```

A session sitting exactly on 80% of its budget is never warned. This property passed, and so did
the other eight.

### Why the property was too weak

Two things, and the second is the one I would have missed.

**The oracle only ever looks at the region after the stop.** `fc.pre(hit !== undefined)` discards
every run in which no limit has been reached — that is, every run with a ratio below 1. But R5 is
a requirement about what happens *before* the stop: "never stopped ... without **first** showing
the 80% warning". The entire interval the requirement is about, [0.8, 1), is thrown away by the
precondition before a single assertion runs. The property reads as though it tests the 80% rule
and in fact never visits 80%.

**The generator was not the problem — the precondition was.** This is what makes it a bad property
rather than a thin one. `position` contains `0.8` exactly; I chose those values in P4 precisely so
the boundary would be hit, and I wrote a paragraph in this file explaining why. So the input that
exposes H4 *was* generated, on this very seed, and then filtered out. Reviewing the generator — the
thing I was proud of — would never have found this.

There is a third, milder issue: after the P4 fix, `check` and `warning` both read the same
`pressure` function, deliberately, so that they cannot name different limits. That makes
`expect(warn!.limit).toBe(hit!.limit)` close to a tautology — it asserts that two values derived
from one source agree. The assertion that mattered in P4 had stopped carrying information by the
time P5 started, and nothing in the test said so.

### Strengthened version

Stated over the whole range instead of conditioned on a stop, with the ratio and the chosen limit
both named explicitly:

```ts
  test("R5: the warning is due exactly from 80% of the most pressured limit, and names that limit", () => {
    fc.assert(
      fc.property(budget, approvals, position, position, (config, approved, costAt, tokensAt) => {
        const usage = usageAt(config, approved, costAt, tokensAt)
        const live = [
          config.cost === undefined
            ? undefined
            : {
                limit: "cost" as const,
                max: SessionBudget.ceiling(config.cost, approved, config.grant?.cost),
                used: usage.cost,
              },
          config.tokens === undefined
            ? undefined
            : {
                limit: "tokens" as const,
                max: SessionBudget.ceiling(config.tokens, approved, config.grant?.tokens),
                used: usage.tokens,
              },
        ].filter((candidate) => candidate !== undefined)

        const warn = SessionBudget.warning({ budget: config, usage, approvals: approved })
        if (live.length === 0) {
          expect(warn).toBeUndefined()
          return
        }

        // A zero ceiling is under maximum pressure: anything reaches it.
        const ratio = (candidate: (typeof live)[number]) =>
          candidate.max > 0 ? candidate.used / candidate.max : Infinity
        // Ties go to cost, which is the order the limits are ranked in.
        const worst = live.reduce((best, candidate) => (ratio(candidate) > ratio(best) ? candidate : best))

        expect(warn !== undefined).toBe(ratio(worst) >= 0.8)
        if (warn) {
          expect(warn.limit).toBe(worst.limit)
          expect(warn.max).toBe(worst.max)
        }
      }),
      { numRuns: 500 },
    )
  })
```

There is no `fc.pre` at all now, so no run is discarded: every generated session asserts something
about `warning`. The oracle rebuilds the ranking from the inputs rather than asking the code what
it thinks, which is what lets it disagree with the code about *which* limit is under most pressure.

### Evidence it kills the mutant

With H4 applied, on the recorded seed:

```
$ git apply mutants/gavinlin/H4.patch
$ bun test test/session/budget.property.test.ts

(fail) session budget properties > R5: the warning is due exactly from 80% of the
       most pressured limit, and names that limit
error: Property failed after 31 tests
{ seed: 42, path: "30:2:2:2:2", endOnFailure: true }
Counterexample: [{"cost":1,"tokens":undefined,"action":"stop","grant":undefined},0,0.8,0]

 12 pass
 1 fail
```

The counterexample is a $1 cost budget with usage at exactly `0.8` of it — $0.80 of $1.00, no
approvals. The oracle says a warning is due because the ratio is 0.8; the mutant says nothing is
due. The old R5 property still passes against H4, which is the point: the mutant did not become
easier to catch, the property became able to see it.
