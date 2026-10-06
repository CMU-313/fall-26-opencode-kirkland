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
