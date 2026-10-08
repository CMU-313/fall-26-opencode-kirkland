# User Guide

How to use and test the features this team added to OpenCode. Each section covers one
feature, how to exercise it by hand, and where its automated tests live.

---

## Session Budget

Caps how much a single OpenCode session is allowed to spend, so the agent stops or asks
for approval instead of quietly running up API charges.

### Setting a budget

**From inside OpenCode** — type `/budget` in the message box. A dialog asks for a token
cap; it accepts plain numbers (`500000`), or `k`/`m` suffixes (`500k`, `1.5m`). The value
is saved to your global config, so it applies to every project.

**From a config file** — add a `budget` block to `opencode.json` in your project root, or
to `~/.config/opencode/opencode.json` to apply it everywhere:

```json
{
  "budget": {
    "cost": 5.00,
    "tokens": 1000000,
    "action": "ask"
  }
}
```

| Field | Meaning |
| --- | --- |
| `cost` | Maximum spend in USD for one session |
| `tokens` | Maximum total tokens for one session, counting input, output, reasoning and cache |
| `action` | `stop` ends the turn at the limit (default); `ask` requests approval to continue |

Both limits are optional. If you set both, whichever is reached first stops the session.

### What happens at the limit

The budget is checked **before every model request**, so the session stops before the
request that would exceed it rather than reporting the overage afterwards.

With `"action": "stop"` the turn ends and the transcript records why:

```
Session used 1,012,480 tokens, reaching the configured budget of 1,000,000
```

With `"action": "ask"` you get a prompt first:

```
$  Session budget reached
   Used 1,012,480 of 1,000,000 tokens. Continue?
```

Approving raises the ceiling by one more budget, so a `1000000` token cap asks again at
`2000000` rather than on every subsequent request. Declining ends the turn.

At 80% of the cap you get a warning notification before anything stops, so there is a
chance to wrap up or raise the limit:

```
Budget warning: 812,480 of 1,000,000 used
```

It fires once per ceiling rather than on every request, and fires again after an approval
raises the ceiling.

While a budget is set, the sidebar also shows a **Budget** panel with usage against the cap
and the percentage used, which turns yellow at 80% and red at 100%.

### Use a token budget on free models

Models priced at zero — OpenRouter's `:free` tier, for example — always report a cost of
`$0.00` no matter how much you use them, because cost is computed as tokens multiplied by
the model's rate. A `cost` budget will never trigger on those models. Use `tokens` instead.

### How to user test it

**1. Verify the limit fires (no API key needed, costs nothing).**

A budget of `0` is reached before OpenCode ever contacts a model, so you can confirm the
feature works without a provider configured. In a scratch directory:

```bash
mkdir -p /tmp/budget-demo
printf '{\n  "budget": { "tokens": 0, "action": "stop" }\n}\n' > /tmp/budget-demo/opencode.json
```

Run OpenCode against it and send any message. The turn should stop immediately with
`Session used 0 tokens, reaching the configured budget of 0`, and no request is made.

Now raise the limit to `999999999` and send the same message. It should go through to the
model instead. Flipping that one value is what demonstrates the budget is doing the work
rather than something else failing.

**2. Verify the UI.**

Start OpenCode in a directory with no budget set. Type `/budget`, enter `20k`, and confirm
a **Budget** panel appears in the sidebar reading `0 of 20,000 tokens`. This needs no API
key either, since setting a budget does not contact a model.

**3. Verify the limit during real use.**

With a provider configured, set a small token budget — `20k` is reached quickly because
OpenCode's system prompt and tool definitions are large. Send a prompt, watch the sidebar
percentage climb, then send a **second** prompt in the same session. The check runs before
each model request, so a single one-shot reply finishes the turn before the next check; the
second prompt is where the limit fires.

Watch for the warning notification as usage passes 80% of the cap, before the stop fires.

Set `"action": "ask"` and repeat to see the approval prompt. Approve it to continue with a
raised ceiling, or decline to end the turn.

### Automated tests

**Limit logic** — [`packages/opencode/test/session/budget.test.ts`](packages/opencode/test/session/budget.test.ts)

Fifteen tests over the pure functions in
[`packages/opencode/src/session/budget.ts`](packages/opencode/src/session/budget.ts):
token totalling across all five counters, being under the limit, reaching it exactly,
exceeding it, the token limit independently of cost, cost taking precedence when both are
exceeded, the ceiling raised by an approval, and a zero limit.

Six of those cover the 80% warning threshold specifically: staying quiet below it, firing at
it, staying quiet at or past the limit where the stop takes over instead, picking whichever
limit is closest to being reached, following a ceiling raised by an approval, and doing
nothing when no budget is set.

**Enforcement in the agent loop** — [`packages/opencode/test/session/prompt.test.ts`](packages/opencode/test/session/prompt.test.ts) (the "Budget semantics" section)

Eight integration tests that run the real session loop:

- a token budget stops the turn before any model request
- a cost budget does the same
- the stop is recorded as a durable assistant message, so the transcript still explains
  itself after a reload
- usage under the budget does not stop the loop, confirmed by asserting the model was
  actually reached
- declining the approval prompt ends the turn
- approving it lets the loop reach the model
- crossing 80% warns exactly once, and a second turn at the same ceiling does not warn again
- a budget written to config is still there after a config reload

**Input parsing** — [`packages/tui/test/component/dialog-budget.test.ts`](packages/tui/test/component/dialog-budget.test.ts)

Four tests on the `/budget` dialog's parser: plain numbers, `k` and `m` suffixes, commas
and underscores as separators, and rejection of empty or malformed input.

### Why these tests are sufficient

The three layers cover the feature end to end. The unit tests pin down *when* a limit is
considered reached, including the boundary case of usage exactly equal to the limit and the
arithmetic of raising the ceiling on approval — cases that are tedious to reach by hand.

The integration tests are the important ones, because they exercise the real decision point
rather than a reimplementation of it. Four of the six run with **no LLM server at all**,
which is what proves the budget stops the session *before* a model is contacted — the whole
point of the feature. The two that do run a model server assert on the recorded request
count, so "the gate did not fire" is verified positively rather than by absence of an error.

Both branches of `action` are covered, both limit types are covered, and both outcomes of
the approval prompt are covered. The durable-message test exists because manual testing
found the stop left no record in the transcript; it now guards against that regressing.

The parser tests cover the only user-supplied input in the feature, which is where malformed
values could otherwise be written into config.

The config-retention test exists for a specific reason. An earlier version of `/budget` wrote
to a file the config loader never reads, so the cap silently vanished and the session ran
unbounded. That was found by hand; this test would have caught it.

### Known limitations

- **Budgets are per session.** Subagents run in their own sessions with their own caps, so a
  parent that spawns subagents can exceed its own limit in aggregate.
- **Approval counts are held in memory.** Restarting the server resets the ceiling to the
  configured limit.
- **A budget of `0` combined with `"action": "ask"`** cannot be raised by approving, since
  the ceiling is a multiple of the limit. It prompts before every request.
- **The 80% warning cannot fire for a budget of `0`**, for the same reason — there is no room
  between 80% and the limit.
- **Removing a budget** requires editing the config file; `/budget` only sets one.

---

## Code Change Approval

Lets you preview every code change the agent proposes and approve or reject it before it is
written, without turning off the agent's ability to edit. You can also choose how often
OpenCode asks, and the session timeline records what you decided.

This feature is in the terminal UI (`bun dev`). It applies to the three tools that change
files: `edit`, `write` and `apply_patch`.

### Turning approvals on

By default OpenCode applies edits without asking. There are two ways to turn approvals on.

**From inside OpenCode**: type `/permissions` in the message box and pick a mode (see the
next section). This works from the home screen or inside a session.

**From a config file**: add an `edit` rule to `opencode.json` in your project root, or to
`~/.config/opencode/opencode.json` to apply it everywhere:

```json
{
  "permission": { "edit": "ask" }
}
```

### Choosing a mode with `/permissions`

| Mode | What happens |
| --- | --- |
| **Always ask** | Every code change shows the approval prompt. |
| **Simple changes only** | Edits to a single existing file that change at most 10 lines are applied without asking. New files and changes to more than one file still ask. |
| **Never ask** | Code changes are applied without asking. |

The mode you pick applies to the current session from the next message you send, and becomes
the default for new sessions. Both are saved, so the mode is still in effect after a restart. The current mode is shown next to the
agent name at the bottom of the screen, for example `Build  edits: simple`. Subagents follow the
mode of the session that started them.

A mode never overrides a rule that **denies** edits. Plan mode stays read-only, and a config
rule such as `"edit": { "*.env": "deny" }` still blocks those files, even with **Never ask**.

### Reviewing a change

When a change needs approval, the agent pauses and shows a prompt before touching the file:

```
△ Permission required
  → Edit src/greet.ts

  Make name a constant since it never changes.
  1 file · +1 −1
   1 - let name = "world"
   1 + const name = "world"

  Allow once    Allow always    Reject
```

From top to bottom:

- **Summary**: one sentence from the model about what the change does and why. It only
  appears if the model provides one.
- **Size**: how many files change, with added lines (`+`, green) and removed lines (`−`, red).
- **Diff**: the exact change, with additions and deletions highlighted.

Then choose one of:

- **Allow once**: apply this change.
- **Allow always**: apply this change and stop asking for code changes until OpenCode restarts.
- **Reject** (or **Esc**): a box opens asking what to change.
  - Type a reason and press **Enter** to request modifications. The change is not applied,
    your reason is sent to the model, and it tries again with your feedback.
  - Leave the box empty and press **Enter** to just reject. The change is not applied and
    the agent stops.

### Timeline badges

After a decision, the edit's row in the conversation shows a badge, so you can scroll back and
see which changes you approved:

| Badge | Meaning |
| --- | --- |
| `✓ approved` | You chose **Allow once** |
| `✓ approved (always)` | You chose **Allow always**, or an earlier **Allow always** covered it |
| `auto-approved` | Applied without asking, because of **Never ask**, **Simple changes only**, or your config |
| `✗ rejected: <reason>` | You rejected it and gave a reason |
| `✗ rejected` | You rejected it without a reason |

Decisions are saved with the session, so badges are still there after a restart. Edits blocked
by a deny rule have no badge, since that was not your decision.

### How to user test it

You need a provider configured, since these steps ask the model to make changes. Start
OpenCode from `packages/opencode` with `bun dev` and work in a scratch project.

**1. Review and approve a change.**

Type `/permissions` and choose **Always ask**. Ask: *"Create a file greet.ts that prints hello"*.
Before the file is created, the prompt should show the summary sentence (if the model
gave one), a size line such as `1 file · +1 −0`, and the diff in green. Check that `greet.ts`
does not exist yet, then choose **Allow once**. The file should now exist and the row should
show `✓ approved`.

**2. Request a modification.**

Ask: *"Change greet.ts to print goodbye"*. At the prompt, press **Esc**, type
`print "see you" instead`, and press **Enter**. The file should be unchanged, the row should
show `✗ rejected: print "see you" instead`, and the model should propose a new change that
uses your wording.

**3. Reject without a reason.**

Ask for another change and reject it with an empty box. The file should be unchanged, the
row should show `✗ rejected`, and the agent should stop.

**4. Try each mode.**

- **Simple changes only**: ask for a one-line change to an existing file. It should be applied
  without a prompt and show `auto-approved`. Then ask for a new file, or a change of more than 10
  lines. That should still prompt.
- **Never ask**: any change should be applied without a prompt and show `auto-approved`.
- The footer next to the agent name should show `edits: always`, `edits: simple` or
  `edits: never` to match.

**5. Check that deny rules still win.**

With **Never ask** on, switch to **plan mode** and ask for a code change. It should be
refused, not applied. Switch back to build mode afterwards.

**6. Check that decisions are saved.**

Quit OpenCode, start it again, and reopen the session from steps 1–3 with `/sessions`. The badges should still be
there, and the footer should still show your mode.

### Automated tests

**Permission decisions and modes**: [`packages/opencode/test/permission/next.test.ts`](packages/opencode/test/permission/next.test.ts)

Unit tests on the permission service. A request allowed by rules reports `auto`, and a user
reply reports `once` or `always`, including for requests that **Allow always** resolves
automatically. **Always ask** forces a prompt even when rules allow, **Never ask** skips a prompt
the rules would show, neither one overrides a deny rule (using plan mode's rules), and **Always
ask** does not re-ask after **Allow always**. Also covers how a session's stored mode maps to
those overrides.

**The real agent loop**: [`packages/opencode/test/session/prompt.test.ts`](packages/opencode/test/session/prompt.test.ts) (the "edit approval" tests)

Integration tests that run a real session against a scripted model, which calls the real
`edit` and `write` tools while the test plays the user:

- the prompt carries the diff and the model's summary, and the file is unchanged until approval
- approving applies the change and records `approved`
- rejecting with a reason leaves the file unchanged, records the reason, and sends it to the
  model's next request
- rejecting without a reason leaves the file unchanged and stops the agent
- rejecting a `write` means the new file is never created
- **Never ask** applies changes without a prompt, and **Always ask** prompts even when rules allow
- plan mode still refuses edits under all three modes
- subagent sessions inherit the parent's mode

**Recording decisions**: [`packages/opencode/test/session/processor-effect.test.ts`](packages/opencode/test/session/processor-effect.test.ts)

A test that forces a recorded decision to arrive before the model's tool-call event, and
checks the badge data is not lost.

**Tool summaries**: [`packages/opencode/test/tool/edit.test.ts`](packages/opencode/test/tool/edit.test.ts),
[`write.test.ts`](packages/opencode/test/tool/write.test.ts),
[`apply_patch.test.ts`](packages/opencode/test/tool/apply_patch.test.ts),
and [`parameters.test.ts`](packages/opencode/test/tool/parameters.test.ts)

Each tool passes the model's summary to the approval request and leaves it out when there is none.
The parameter snapshots confirm the only change to what the model sees is the new optional
`summary` field.

**The approval UI**: [`packages/tui/test/cli/cmd/tui/approval-ui.test.tsx`](packages/tui/test/cli/cmd/tui/approval-ui.test.tsx)

Renders the real components in a test terminal and presses keys. The prompt shows the
summary, the `1 file · +1 −1` line and the diff. **Allow once** sends `once`. **Reject** opens the
reason box and sends your reason, or a plain reject when it is empty. The `/permissions` dialog
lists all three modes and saves your choice on the session and as the default. The badges render.

**Simple mode**: [`packages/tui/test/cli/cmd/tui/sync-edit-approval.test.tsx`](packages/tui/test/cli/cmd/tui/sync-edit-approval.test.tsx)

Feeds approval requests into the terminal UI. Small edits in **Simple changes only** are
approved automatically, larger ones are left for you, subagents follow their parent's mode,
and nothing is approved automatically in **Always ask**, with no mode set, or for non-edit permissions.

**Helpers**: [`packages/tui/test/util/edit-approval.test.ts`](packages/tui/test/util/edit-approval.test.ts)
and [`packages/tui/test/util/revert-diff.test.ts`](packages/tui/test/util/revert-diff.test.ts)

Unit tests for the rules behind the UI. These cover the 10-line limit (10 passes, 11 asks),
new files and multi-file changes always asking, badge text for each decision and for
malformed data, mode inheritance through subagents, the default for new sessions, and counting
added and removed lines in single-file and multi-file diffs.

### Why these tests are sufficient

Every acceptance criterion is tested at the level where it could actually break:

| Criterion | Where it is tested |
| --- | --- |
| A summary of the change before it is applied | UI test (shown), tool tests and loop test (sent with the request) |
| Approve, reject, or request modifications | Loop tests (file changed or not, feedback reaches the model), UI tests (keys send the right reply) |
| Additions and deletions highlighted | UI test (`+1 −1` and diff), diff counting unit tests |
| Always ask / simple only / never | Permission unit tests, loop tests, Simple mode wiring test, dialog UI test |
| Timeline shows approved changes | Loop tests (decision saved), recording test, UI test (badges) |
| Rejection reason captured | Loop test (saved, and in the model's next request), UI test (sent) |

The loop tests matter most. They run the real permission check, tools, and session storage,
and they check results a user would notice: whether the file changed, what was saved, and
what the model was told.

The tests were also checked against the bugs they guard. Each fix was temporarily undone and
the matching tests failed: modes overriding plan mode (4 tests), the reason box being skipped
(2), **Simple changes only** not approving small edits (2), and a decision being lost (1).
Writing the plan mode test is how that bug was found.

### Known limitations

- **Terminal UI only.** The web app does not show the summary, the size line, the reason box or
  the badges, and modes can only be chosen with `/permissions`.
- **The 10-line limit for Simple changes only is fixed.**
- **The summary depends on the model.** If the model leaves it out, the prompt shows the size
  line and diff only.
- **Rejection reasons are used within the session.** The model does not remember them in later
  sessions.
- **Allow always lasts until OpenCode restarts.**
- **Badges only appear for code changes** decided after this feature was added.
