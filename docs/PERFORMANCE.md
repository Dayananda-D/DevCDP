# Token cost and performance

Measured, not estimated: a scripted 24-call debugging session against the fixture
app, with every response serialised exactly as the MCP client receives it. Token
figures use 3.6 chars/token, which is close for dense JSON.

Reproduce with the audit script pattern in this file's history, or measure any single
call with `devtools_status` → `buffers` plus the byte counts your client reports.

---

## Where the tokens went

| | Before | After | Saved |
|---|---|---|---|
| **`tools/list`** — paid once per conversation | 12,222 | **9,866** | −19% |
| **24-call session** | 14,996 | **11,107** | −26% |
| **Total for that session** | 27,218 | **20,973** | **−23%** |

### The fixed overhead is the biggest single item

`tools/list` is sent before any work happens, in **every** conversation. At 60 tools
it was 12,222 tokens — more than the entire session that followed.

Its composition, measured:

| Part | Bytes | Note |
|---|---|---|
| JSON Schema | 25,814 | argument names, types, defaults, enums |
| Descriptions | 14,530 | tool + argument prose |
| **The `verbose` argument** | **7,440** | **on all 60 tools; not one used it** |

`verbose` existed to switch on a `compact` response projection. **No tool ever
defined one**, so it was ~2,000 tokens of schema, in every conversation, for an
argument that did nothing. It is now emitted only by tools that actually have a
compact projection — currently none, so it costs nothing.

### Per-call costs, largest first (after)

| tokens | call | what dominated it |
|---|---|---|
| 1,604 | `debugger_get_capture` | scope expansion — depth is quadratic in tokens |
| 1,153 | `dom_get_html` | one long string; capped |
| 1,103 | `session_get_activity` | 30 rows × per-row fields |
| 1,065 | `dom_query` (40 elements) | per-element fields |
| 779 | `devcdp_settings` | ~45 keys |
| 671 | `workflow_guide` | prose, returned once per session |
| 614 | `network_get_requests` + bodies | response bodies, opt-in |
| 568 | `session_get_state` | three buffers in one call |

Everything else is under 550 tokens.

---

## What was changed

**A ceiling that cannot be forgotten.** `maxResponseBytes` (16 KB default) is applied
centrally in the dispatcher, so no tool — including one added later — can return an
unbounded payload. It trims the largest arrays first, then long strings, never scalar
fields, and reports what it dropped plus the argument that would fetch it. Silent
truncation would be worse than the cost it saves.

**Depth where it pays.** Auto-capture expands the innermost frame fully (depth 3) and
outer frames shallowly (depth 1), because the answer is almost always in frame 0 and
depth costs tokens quadratically. Any frame can still be expanded on demand with
`debugger_get_scope`. Console lines 15 → 8, network rows 10 → 6.

**Attributes are opt-in.** `dom_query` no longer returns every HTML attribute of every
match. On a real app that was the bulk of the response; `include_attrs: true` restores
it.

**Lean network rows.** `requestId`, url, method, status, duration, size and anything
that failed. Mime type, remote address, cache flag and initiator are real but rarely
read, and at twenty rows they were most of the response — `include_headers` restores
the full row.

**Defaults are values, not objects.** `devcdp_settings` reported `{value: X, from:
"default"}` for forty keys. A default is now just its value; only an overridden
setting carries the wrapper saying where it came from.

**Shorter prose.** `workflow_guide` roughly halved, the five most expensive argument
descriptions trimmed, duplicated advice removed. The aim is that a small model reads
one clear sentence rather than three overlapping ones.

**Smaller discovery payloads.** OpenAPI paths 300 → 60, observed endpoints 80 → 40,
discovered buttons/fields 40 → 25. A specification dump is not an answer.

---

## Response shape: written to be read by a small model

Cutting tokens and being clear pull in the same direction more often than not, but
where they conflicted, clarity won:

- **Flat over nested.** `debugger_get_capture` returns `live: true|false` at the top
  rather than a nested status object.
- **Booleans over prose** for anything a caller must branch on:
  `bound`, `live`, `consoleHistoryAvailable`, `pageResponsive`, `grouped`. A flag is
  more reliable for a weak model than inferring the same fact from a sentence — which
  is why `consoleHistoryAvailable` was restored after being trimmed away.
- **One hint, not three.** Overlapping `note` / `caution` / `guidance` fields
  collapsed into a single actionable line.
- **Names that say what they mean.** `isCurrent` → `live`, `staleNote` → `note`,
  `nextSteps[4]` → `next` (one sentence).
- **Omit rather than pad.** Fields that would be `null`, `0` or a repeat of another
  field are left out; `matchedInPage` only appears when it differs from `count`.

---

## Latency

| Call | ms | Note |
|---|---|---|
| `devtools_connect` | ~100 | claim, wire, enable, inject, snapshot |
| `list_tabs` | ~42 | visibility probing, one short connection per tab |
| `api_discover` | ~20 | plus an OpenAPI probe |
| everything else | 0–10 | in-memory buffers |

Nothing here needs optimising. The two probe-based calls are the only ones with real
work in them, and both are bounded.

---

## Where the remaining cost is, and why it stays

**`tools/list` at 9,866 tokens** is still the largest single item. Reducing it further
means removing tools or shortening descriptions, and both trade away the thing that
makes the model choose the *right* tool. Descriptions are 14.5 KB for 60 tools —
about 240 bytes each, which is one clear sentence plus a caveat. That is close to the
floor for tools whose misuse is expensive.

Consolidating tools was considered and rejected: merging `debugger_step_over/into/out`
into one `debugger_step({direction})` saves ~250 tokens and replaces three
unambiguous names with a mode flag. Cheaper to send, more expensive to get wrong.

**If your budget is tight**, these are safe to lower in settings:

```json
{
  "maxResponseBytes": 8000,
  "consoleBufferSize": 500,
  "networkBufferSize": 200,
  "activityBufferSize": 200
}
```

Buffer sizes cost nothing per call — they cap what a single call *can* return, and
eviction is always reported.

---

## Time, not tokens: searching a real application

Token cost is not the only cost. The slowest thing in the tool is `source_search`,
because finding a string means fetching script text, and a framework that loads a class
per file loads a great many scripts.

Measured against a real application — 1,525 scripts, ~10 MB of JavaScript:

| | Before | After |
|---|---|---|
| Full scan, no match | 4,983 ms | ~800 ms |
| The same scan again | 4,983 ms | ~40 ms |
| Search narrowed with `url_filter` | — | 1–6 ms |

Three changes account for it. Script text is cached by `scriptId` — a script's contents
cannot change under a given id, so this is safe — bounded at 32 MB with oldest evicted
first. Fetches run in parallel batches rather than one round trip at a time. And
sources are searched in ranked order, so a query that stops at `max_results` stops after
a handful of files rather than dragging through vendor code first.

`url_filter` remains the cheapest search by a wide margin. When a truncated result
appears, the response says how many sources went unsearched — worth reading before
concluding that the matches you got are all there are.
