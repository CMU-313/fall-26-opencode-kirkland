# Traceability: rkadakia

## Requirements

| ID | Interview evidence | Requirement | Acceptance criteria | Property | Test | Changed in P4? | Mutants it kills |
|---|---|---|---|---|---|---|---|
| R1 | C-5, S-9: "Same prompt just reworded should stay at the same model" | The classifier is deterministic: the same prompt and context give the same tier on every run. Each pair in a fixed list of paraphrase pairs gives the same tier for both prompts in the pair. | Running "fix the typo in README.md" 10 times returns the same tier every time. Each pair returns the same tier: "fix the typo in README.md" / "please correct the README.md typo"; "what does git status do?" / "explain what git status does"; "rename utils.ts to helpers.ts" / "change the name of utils.ts to helpers.ts". | **Invariant:** For any generated prompt (realistic prompts, arbitrary strings, edge cases, with or without files, images, and editor context), classify returns the same result on 10 runs and doesn't mutate its input; each listed paraphrase pair gets the same tier. | `packages/opencode/test/auto-model/auto-model.property.test.ts`: "R1: classifier is deterministic" | Yes | None |
| R2 | C-1, C-6, S-10, O-1, O-2: "for more direct answer questions I will switch down to Sonnet" | Short factual or yes/no questions that don't ask to change code get the low tier. Prompts asking to design, refactor, or change multiple files get the high tier. | "What does git status do?" → low. "Design and implement a caching layer for the session module, then refactor prompt.ts to use it" → high. | **Invariant:** Every generated factual or yes/no question is low tier; every generated multi-part design/refactor task is high tier. | Same file: "R2: questions are low tier, design/refactor tasks are high tier" | No | None (H4 and H5 target R2 and both survive) |
| R3 | S-8, O-6, C-6: "The more complicated the prompt (error log) then you might want a smarter model" | Appending a stack trace, a code block, additional file attachments, or additional task steps to a prompt never lowers its tier. | If prompt P gets tier t, then P plus a stack trace of up to 200 lines, a code block, extra attached files, or "and also update the tests and docs" each gets tier ≥ t. | **Metamorphic:** For any base prompt, appending a JS or Python stack trace (up to 200 frames), a code block, extra file attachments, or extra task steps never lowers the tier. | Same file: "R3: adding context never lowers the tier" | Yes | H3 |
| R4 | C-3: "I want to see some flag about what setting I am in" | When Auto is on, the prompt footer shows that Auto is active and which model it picked for the last message. | Auto on, send "What does ls do?" → footer shows "Auto" and the low-tier model's name. Auto off → footer shows only the manually chosen model, with no "Auto" label. | — | — | No | — |
| R5 | C-4, S-6, S-7 (O-5 disagrees): "It should keep the last model that the auto model chooser picked" | Turning Auto off keeps the model Auto last used as the active model (the majority preference), and a toast names that model so the user can switch if they want a different one. | Start on model A, turn Auto on, send a high-tier prompt (Auto picks B), turn Auto off → a toast names B, the active model is B, and the next prompt is sent with B. | — | — | Yes | — |
| R6 | O-4, C-7: "I don't think it should override a model I choose" | If the user picks a model by hand from the model dialog while Auto is on, Auto turns off and that model is used for every later prompt until Auto is turned back on. | Auto on, user picks model X → Auto shows as off. The next 3 prompts, including a high-complexity one, are all sent with X. | — | — | No | — |
| R7 | O-3, O-4, O-8: "If I ask a follow up question it should have a very solid understanding" | After a high-tier turn, the next two lower-tier prompts stay on the high tier. The tier drops only after three consecutive lower-tier prompts, to the highest tier among those three. | Previous turn high. "ok continue" → still high. "yes, do that" → still high. A third low-tier prompt → drops to low. | **Model/oracle:** For any tier sequence, the active tier matches a reference implementation that keeps the full history. **Invariant:** After any history, a high prompt holds for two lower prompts and drops on the third, to the highest of the three. | Same file: "R7: hysteresis matches the reference" and "R7: two follow-ups stay high, the third drops" | Yes | H1, H2 |
| R8 | S-4, S-5, S-12: "It should never go over the token amount without warning me" | If a token budget is set, before sending a prompt the system estimates its input tokens (current context plus the new prompt). If tokens used plus that estimate exceeds the budget, it shows a warning and waits for confirmation before sending. The warning states that response tokens aren't included in the estimate. | Budget 100k tokens, 95k used, prompt estimated at 10k input tokens → a warning appears and nothing is sent until the user confirms. With 10k used → no warning. | — | — | Yes | — |

## Requirement changes

Note: the token-budget requirement was mislabeled as a second R7 in P3; it is renumbered R8 below and in the main table.

R2, R4, and R6 are kept as written: each is checkable with a concrete example, and they don't conflict with the other requirements.

### R1

| | |
|---|---|
| **Original (P3)** | The classifier is deterministic. The same prompt and context always give the same tier, and a reworded prompt with the same intent and scope gives the same tier. |
| **Why it can't be built as is** | "Same intent and scope" is subjective and covers an unlimited set of rewordings, so it can't be checked. A keyword-based classifier also can't guarantee it for every possible paraphrase. |
| **What the user actually needed** | Interviewees didn't want the model to change because of random variation or small wording differences in the same request. |
| **Revised (P4)** | The classifier is deterministic: the same prompt and context give the same tier on every run. Each pair in a fixed list of paraphrase pairs gives the same tier for both prompts in the pair. |

### R3

| | |
|---|---|
| **Original (P3)** | Adding more content (a pasted error log, more files, more steps) never lowers the tier. |
| **Why it can't be built as is** | "More content" includes any text. Added text can itself describe a simpler task (for example, "just remove the unused import"), which a keyword-based classifier scores lower, so the guarantee can't hold for arbitrary additions. |
| **What the user actually needed** | Pasting an error log or widening the scope of a task shouldn't make the system pick a weaker model. |
| **Revised (P4)** | Appending a stack trace, a code block, additional file attachments, or additional task steps to a prompt never lowers its tier. |

### R5

| | |
|---|---|
| **Original (P3)** | Turning Auto off keeps the model Auto last picked as the active model. |
| **Why it can't be built as is** | Interviewees disagreed: C-4, S-6, and S-7 wanted to keep Auto's last model, while O-5 expected to return to the model they had before turning Auto on. Both can't be the default. |
| **What the user actually needed** | No surprise model change when turning Auto off, and knowing which model is now active. |
| **Revised (P4)** | Turning Auto off keeps the model Auto last used as the active model (the majority preference), and a toast names that model so the user can switch if they want a different one. |

### R7

| | |
|---|---|
| **Original (P3)** | Within a multi-step task, a short follow-up message ("continue", "yes, do that") doesn't drop to a lower tier than the previous turn. |
| **Why it can't be built as is** | The system can't reliably tell a follow-up from a new simple request, and "never drop" conflicts with R2: a session that once used the high tier would never return to a cheaper model. |
| **What the user actually needed** | Short follow-ups in the middle of a hard task shouldn't lose the stronger model. |
| **Revised (P4)** | After a high-tier turn, the next two lower-tier prompts stay on the high tier. The tier drops only after three consecutive lower-tier prompts, to the highest tier among those three. |

### R8 (previously the second R7)

| | |
|---|---|
| **Original (P3)** | If a token budget is set and the chosen model would push estimated usage past it, the user gets a warning before the prompt is sent. |
| **Why it can't be built as is** | The number of tokens a response will use isn't known until after the model answers, so whether a prompt "would push usage past" the budget can't be determined before sending. |
| **What the user actually needed** | No surprise overruns: a warning before going over budget, not after. |
| **Revised (P4)** | If a token budget is set, before sending a prompt the system estimates its input tokens (current context plus the new prompt). If tokens used plus that estimate exceeds the budget, it shows a warning and waits for confirmation before sending. The warning states that response tokens aren't included in the estimate. |

## Run, triage, and fix

All properties passed on the first run. To confirm they can fail, I temporarily changed the downgrade threshold from 3 to 2 and both R7 properties failed with a shrunk counterexample.

## Hand-written mutants

Each mutant is saved as a patch in `mutants/rkadakia/` (H1.patch–H5.patch). Predictions were written before any mutant was run. To run one: `git apply` the patch, run `bun test test/auto-model/auto-model.property.test.ts` from `packages/opencode`, then `git apply -R` the patch.

| ID | Requirement targeted | Change | Predicted killer | Actual result |
|---|---|---|---|---|
| H1 | R7 | `auto-model-hysteresis.ts`: downgrade check changed from `streakTiers.length >= DOWNGRADE_AFTER` to `>`, so the third lower-tier prompt doesn't drop the tier (and the saved `streak: 3` is then rejected as invalid, resetting state on the fourth) | "Hysteresis matches the reference" and "Two follow-ups stay high, the third drops" (R7) | Killed by both R7 properties. Oracle counterexample `["complex","simple","simple","simple"]`; invariant counterexample `[[],"simple","simple","simple"]`, which stays `complex` on the third lower prompt instead of dropping |
| H2 | R7 | `auto-model-hysteresis.ts`: the lower-streak branch saves `streakTiers: prior.streakTiers` instead of the new list, so every field updates except the streak list; the saved count and list then disagree and the next prompt resets state | "Hysteresis matches the reference" and "Two follow-ups stay high, the third drops" (R7) | Killed by both R7 properties. Oracle counterexample `["moderate","simple","simple"]` (drops on the second lower prompt instead of the third); invariant counterexample `[[],"simple","simple","simple"]`, failing at the second follow-up |
| H3 | R3 | `auto-model-classify.ts`: removed the `Traceback` alternative from `STACK_TRACE_PATTERN`, so Python tracebacks are silently not detected; the trace loses its +1 and its quoted `'user_id'` now counts as a quoted-literal (−1) simple-edit signal | "P plus added context gets a tier >= P's tier" (R3), with a moderate base prompt plus a short Python trace (medium confidence) | Killed by R3 after 7 inputs. Counterexample: `"write unit tests for git status"` plus a 1-frame Python traceback; the tier dropped from moderate to simple |
| H4 | R2 | `auto-model-classify.ts`: `matchKeywords` filters `keywords.slice(0, -1)`, so the loop skips the last keyword in each list (`everywhere`, `wrong`, `unused`); "update the logging everywhere" drops from moderate to simple | None: no generator produces `everywhere`, `wrong`, or `unused` | Survived (8/8 properties pass): R2's multi-file generator only expresses "multiple files" through attached filenames, never through scope words like "everywhere" |
| H5 | R2 | `auto-model-classify.ts`: complex check in `tierFor` changed from `score >= COMPLEX_MIN_SCORE` to `>`, so prompts scoring exactly 5 ("refactor the config parser", "debug the flaky test") drop from complex to moderate | None: every generated design task has 2+ complex verbs and a "then" step, so it scores at least 7 | Survived (8/8 properties pass): the design-task generator only makes multi-part tasks, so single-step design/refactor prompts at the tier boundary are never tested |

## AI use

All eight properties and their generators were drafted with Claude (an AI assistant). I reviewed each one against its requirement, ran them locally, and confirmed they can fail by temporarily changing the downgrade threshold from 3 to 2, which made both R7 properties fail with a shrunk counterexample.