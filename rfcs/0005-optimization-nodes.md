# RFC 0005 — Optimization nodes

**Status:** proposed, 2026-11-17, and revised the same day with the
maintainer's rulings on every open question. Not decided design. `SPEC.md`
describes the running system until a ticket that builds a section of this RFC
amends it. Decisions are in §13; §14 records what is deferred.

**Hat:** product. The objective, the measurement gate, the proposer phase,
the stop policy, the events, the operator surfaces and the guidance ship to
every user. Nothing here encodes this repository's configuration. Trying an
optimization node on this repository is separate, later work (§15).

---

## 1. Problem

Some work has no fixed list of tasks, but it does have a number. Make this
query faster. Shrink this bundle. Raise this eval's pass rate. Make this
prose read better, as judged by a panel. The work is done when the number is
good enough, or when it has stopped getting better.

The usual way to do this work is a hill climb: try a strategy, measure it,
keep it if it helped, and try another. Recursive self-improvement research
made the pattern popular, but it is general. It fits any work with a clear
measure of progress.

Autobuild cannot run this loop today:

- **A node is complete when its children run out** (`SPEC.md` §13.1). An
  optimization is complete when a measure crosses a threshold or stops
  moving, however many attempts that takes.
- **Someone has to file every child.** A human in the loop for each attempt
  defeats the purpose.
- **A child merges once it passes verify.** Verify asks whether the change is
  correct, not whether it helped. Correct attempts that did nothing would
  accumulate on the node.
- **Nothing measures.** No step produces a number, compares two heads, or
  stops anything when the number is good enough.

## 2. Summary

An **optimization node** is a node whose spec declares an **objective**: a
metric, the direction to push it, a threshold, a budget, and the reason the
metric matters.

1. **A proposer phase owned by the node** reads what has been tried and files
   new **attempts** as child tickets, inside a budget the human set while
   grooming the node (§5).
2. **Attempts are ordinary work builds** in a checkout at the node head. They
   get the objective, its purpose and the measurement command for their own
   inner loop, and may declare that their strategy found nothing (§6).
3. **A measurement gate decides whether an attempt merges into the node.**
   The kernel measures the candidate against the current node head, with the
   harness pinned so attempts cannot change the ruler. An attempt merges only
   if it improves the head by a meaningful margin. Attempts that don't move
   to the rejected role (§7, §8).
4. **The node head is therefore always the best result so far.** It is safe
   to land at any time.
5. **The node stops** when the threshold is met, progress plateaus, the
   budget runs out, or an operator calls it. Stopping aborts in-flight
   attempts by default, or lets them finish (§9).
6. **The objective can change while the node runs.** A threshold change takes
   effect on the next tick, with no replanning (§4.3).
7. **The guidance says the job is a meaningful improvement**, not the largest
   number. Regressing behavior or gaming the test is a failure even when the
   number improves (§10).

## 3. Ontology

| Term | Meaning |
|---|---|
| Optimization node | A node whose accepted spec declares an objective. |
| Objective | The metric, direction, threshold, ε, budget, stop policy, harness and purpose. |
| Purpose | Prose: why the metric matters and what it stands in for. Required. |
| Harness | The repository paths that do the measuring: scripts, datasets, rubrics. |
| Attempt | A work build the proposer filed, targeting the optimization node. |
| Baseline | The node head an attempt is measured against. |
| Measurement | One paired comparison of a candidate head against a baseline head. |
| Ratchet | The rule that the node head moves only when a measurement shows improvement. |

`kind` stays `node`. The objective block in the node spec is the only marker
(§4.1), so ticket sources, labels and the `node` port capabilities do not
change. Terms in this RFC follow the current vocabulary; renaming the `node`
kind is under consideration separately, and any rename carries through.

## 4. The objective

### 4.1 Declaration

The node spec carries one fenced TOML block whose info string is exactly
`autobuild-objective`. It is validated when the node opens, together with
the rest of the spec. An invalid objective refuses the opening and names the
field.

````markdown
```autobuild-objective
purpose = """
p95 latency of the catalog search query, because users wait on it at every
keystroke. Results, their order and the query's semantics must not change.
"""

[metric]
kind = "command"                 # or "panel" (§8)
command = "bun bench/search.ts"  # prints one JSON object: {"value": <number>}
direction = "minimize"
samples = 7                      # paired runs per side (§7.3)
harness = ["bench/search/**", "bench/fixtures/catalog.sql"]

[target]
threshold = 40                   # milliseconds; optional
epsilon = { relative = 0.03 }    # or { absolute = 2 }

[budget]                         # at least one limit is required
maxAttempts = 60
maxHours = 24

[stop]
plateau = { attempts = 12 }      # optional (§9.1)
mode = "abort"                   # or "drain"; default "abort"

[proposer]
concurrency = 4                  # attempts in flight
```
````

A budget is required. An optimization node with no limit could spend
indefinitely without a human ever deciding again, so validation refuses one.

The marker turns a node into something that files and dispatches its own
work, so a false positive is expensive. The rules leave no room for one:

- **Only the exact info string counts.** A heading named "Objective", a plain
  `toml` block or prose describing an objective never does.
- **Exactly one block.** Two refuse the opening.
- **Only nodes.** A work ticket whose spec carries the block is refused at
  dispatch, naming the block, rather than silently ignoring it.
- **No silent fallback either way.** A node whose block fails to parse is
  refused, never opened as a plain node; a plain node is never promoted by a
  later edit.
- **Fixed for the node's life.** A spec revision on an open node may change
  the objective but cannot add or remove the block. Close the node and open a
  new one instead.
- **Visible everywhere.** `ab ticket show`, `ab ticket tree`, status and both
  dashboards label an accepted optimization node as one.

`ab-spec`, `ab-tickets` and `ab-guide` state the marker, these rules and their
consequences in the same words (§10).

### 4.2 Acceptance

Opening records `optimization.objective-accepted {objective, revision,
harnessPin}`. `harnessPin` is the node's opening commit. The kernel then
measures the opening head against itself (§7.3). That one run records both
the **starting value**, which progress is reported against, and the noise
spread (`optimization.baseline-measured`).

### 4.3 Revision while running

Two paths change the objective:

- **`ab objective <node> --threshold 35 --plateau 8 --max-hours 36`**
  (operator tool `optimization.revise`). Use it for the knobs that only change
  when to stop, how much to spend or how large a gain must be: threshold, ε,
  budget, plateau, stop mode, concurrency. It records `optimization.objective-revised {changes,
  revision}`. The completion check runs again on the next tick. Running
  attempts are unaffected, and nothing is replanned.
- **A node spec revision** (`ab answer <node> --revise-spec`) for anything
  else: the metric, the harness or the purpose. Changing what is measured
  pins the harness again at the current node head and measures that head
  against itself for a new starting value and noise spread. Earlier
  measurements stay in history but are not compared with new ones, because
  they used a different ruler.

The effective objective is the kernel's, read from events. A quick revision
is not written back to the ticket. This matches existing behavior, where an
edit to a ticket and a revision of the running node are separate.
`ab ticket show` and the status surfaces show the effective objective and
mark each field revised since the ticket's block, so a stale ticket is
visible rather than misleading.

## 5. The proposer phase

The integration grammar gains one agent phase for optimization nodes:

```
spec → branch opening → starting measurement → (propose → collecting)*
     → stopped → complete → verify:* → authorization → merge → close
```

### 5.1 When it runs

The dispatcher admits a proposer session for a node only when all of these
hold:

- the node has not stopped;
- the budget has room;
- fewer than `concurrency` attempts are queued or running;
- no proposer session for the node is already running.

A proposer run is admitted like node reconcile and verification. It takes a
dispatch slot ahead of new claims, under the existing admission rules in
`SPEC.md` §13.1.

### 5.2 What it reads

`ab context` gives the proposer:

- the objective and its purpose;
- the current value, the starting value and the threshold;
- the **attempt ledger**: one entry per settled attempt, holding the
  strategy summary, the outcome, the measured delta and the attempt's own
  closing note. Failed strategies are as valuable as accepted ones, because
  the next proposal should not repeat them. **Near misses**, attempts that
  improved by less than ε, are flagged: a refined follow-up of a near miss is
  a new attempt with its own place in the budget, never another round for
  the old one;
- the node head's tree, so it can read the code.

### 5.3 What it produces

The proposer deposits a typed `attempts` artifact with `ab propose`. Each entry
is a ticket title, a body written to the spec standard that names one
strategy, and a stable proposal id. It never creates tickets itself.

The dispatcher creates the tickets. Each targets the node and goes straight
to the ready role. Creation is deduplicated by proposal id, so a crash between
the artifact and the ticket write cannot file the same attempt twice. The
proposer may propose fewer attempts than it has room for, including none,
with a reason. Two consecutive empty proposals stop the node with cause
`exhausted`.

### 5.4 Why grooming authorizes dispatch

Design rule 3 says generated work is groomed before it leaves triage. Here
the human grooms the objective instead of each attempt: the purpose, the
budget and the stop policy are the dispatch decision. Every attempt is
bounded by that budget and must pass the ratchet before it can affect
anything. `SPEC.md` §2, rule 3, should state this exception explicitly when
it is built, not imply it.

## 6. Attempts

### 6.1 Grammar

An attempt is a work build and follows the ordinary work grammar:

```
spec → plan ⇄ plan-review → implement ⇄ code-review → verify:* → finalize (+ finalize:*)
epilogue: landing measurement → merge into the node, or rejected
```

The kernel measures once, at landing, after review and verification. That
measurement is the attempt's canonical result. The implementer has already
measured its own work in its inner loop, and an attempt that found nothing
declines and stops (§6.2, item 3). A kernel measurement before code review
would mostly confirm what the implementer already knew.

### 6.2 Changes from a work build

1. **Context.** The attempt receives the objective, its purpose, the
   measurement command and the current value. Implement runs the measurement
   in its own inner loop, keeps what helps, and records its own numbers in
   its implement notes. The kernel never sees those runs. `ab done` means
   "this is my best result".
2. **Harness edits are refused at `ab done`.** A change that touches a
   harness path fails validation with a message naming the paths, as other
   invalid deposits do (`SPEC.md` §8.5). Review never sees it.
3. **Declining.** An attempt that concludes its strategy cannot produce a
   real gain says so with `ab done --no-improvement "<reason>"`. That skips
   review, verification and measurement, settles the attempt as `declined`,
   and puts the reason in the ledger. This is a successful outcome.
4. **No improvement at landing is terminal, not a failure.** An attempt whose
   landing measurement does not beat the baseline did nothing wrong; its
   strategy did not work. It gets no further implement round: the
   implementer already searched and did not find the gain. The build closes
   without merging and settles as `no-improvement`.

### 6.3 Settlement and the rejected role

Every attempt settles exactly once, with one outcome:

| Outcome | Meaning | Ticket moves to |
|---|---|---|
| `accepted` | Its landing measurement improved the head, and it merged. | done |
| `no-improvement` | Its landing measurement did not beat the head (§7). | rejected role |
| `declined` | It declared no improvement with `ab done --no-improvement`. | rejected role |
| `stopped` | The node stopped in abort mode while it was queued or running (§9.2). | rejected role |
| `aborted` | An operator aborted the attempt's build. | rejected role |

Today the dispatcher never moves tickets into the rejected role. Settled
attempts are a narrow exception: the dispatcher filed them, and the rejected
role is the honest record of an attempt that did not merge. The exception
covers the four outcomes above, and nothing else. An aborted attempt goes to
the rejected role rather than back to triage, because an attempt is never
groomed by hand. A rejected child does not keep its node open (`SPEC.md`
§13.1), so this needs no new completion rule.

An optimization node needs a rejected role to move tickets into. Opening
refuses an objective when the ticket source has none configured, and names
`[tickets].rejectedState`.

### 6.4 Children the proposer did not file

A human can still file a child against an optimization node, such as a
repair after a failed node verification. It is not required to improve the
metric, but at landing it must not make it worse by more than ε: the landing
measurement applies a non-regression rule instead of an improvement rule. A
child that regresses the metric escalates rather than moving to rejected,
because a human filed it on purpose. Such children are not attempts: they
never settle, and they count toward neither the budget nor the plateau.

## 7. The measurement gate

### 7.1 Where it sits

Measurement is a **landing condition** for children of optimization nodes,
not a verify step. A leaf becomes ready after verify and finalize on a
current base (`SPEC.md` §15.7). An attempt additionally needs a
**measurement whose candidate is its exact head and whose baseline is the
node's exact current head** that shows improvement. The node writer merges
it with the existing guarded fast-forward, guarded on that same node head. A
measurement that shows no improvement settles the attempt as
`no-improvement` (§6.3).

The measurement runs in the attempt's workspace, in an execution the
dispatcher admits the way it admits a re-verify (`SPEC.md` §12).

A candidate that reaches landing with a harness edit, for example from a
reconcile resolution, escalates instead of being measured.

### 7.2 Concurrency

This is optimistic concurrency. Measurements run in parallel in the attempts'
own executions, and the node writer is not held during a benchmark, except
by the starvation guard (§7.5).
Suppose a sibling lands first. The node head moves, the waiting attempt
restacks (an existing behavior), and its measurement no longer applies,
because improvements do not compose. It measures again against the new head.
A clean restack keeps existing verification, as it does today, but never
keeps a measurement.

### 7.3 Paired sampling

Benchmarks are noisy, and executions run on different hardware. A stored
number from another machine is not a fair baseline. Each measurement
therefore runs both sides in the same execution: the candidate tree and the
baseline tree in two worktrees, interleaved, for `samples` rounds each. The
gate compares medians:

- `minimize`: accept if `median(baseline) − median(candidate) ≥ ε`;
- `maximize`: the mirror image;
- `ε` is absolute, or relative to the baseline median.

The command prints one JSON object per run. A command failure, a timeout or
unparseable output is a measurement failure: the attempt escalates rather
than being scored.

**Noise check.** When the objective is accepted, the kernel also measures
the opening head against itself, with the same pairing and sample count, and
records the spread between the two medians. If ε is smaller than that
spread, the gate would accept noise, so the node raises attention naming
both numbers. It still opens: the operator decides whether to raise ε or
`samples`. Every reported delta shows the noise beside it. A significance
test is deferred (§14). Panels have their own form of this check (§8).

A command threshold is an absolute number, so it assumes the environments
that run measurements are comparable. The gate itself never compares
numbers from different executions.

### 7.4 Harness pinning

The candidate's code is measured with the original ruler:

1. Both worktrees get the harness paths overwritten with their contents at
   `harnessPin`.
2. The command runs from that overwritten state.

`ab done` already refused edits to harness paths (§6.2). The overwrite also
covers harness changes that arrive through a node restack from its parent.
Attempts can read and run the harness freely; they cannot change what
counts. Changing the harness on purpose is an objective revision (§4.3).

### 7.5 Starvation

With many fast siblings, a slow measurement can be overtaken again and
again. Each pass costs one measurement and wastes nothing else. After
`3` consecutive overtakes, the attempt gets the next turn: the node writer
holds the node head for that attempt's measurement, and later candidates wait
behind it. The number is a fixed constant in v1.

## 8. Judge panels

For work without a mechanical measure, `kind = "panel"`:

```toml
[metric]
kind = "panel"
judges = 5
rubric = "evals/prose-rubric.md"   # a harness path
harness = ["evals/**"]
```

A panel measurement runs `judges` concurrent agent sessions, reusing the
machinery verify stages use for concurrent agent sessions (`SPEC.md` §5).
Each judge receives the rubric, the purpose and two harness-pinned worktrees
labeled A and B, and examines both together.
The order is randomized per judge, and neither label reveals which is the
candidate. Each judge returns a **preference** (A, B or tie) with a
one-paragraph reason. Judges see the purpose, so they can penalize gaming as
a human reviewer would.

Panels use preferences, never absolute scores, for both decisions:

- **Acceptance** compares the candidate with the current node head. Its win
  rate across judges, ties counted as half, must reach `0.5 + ε`.
- **Progress and the threshold** compare the current node head with the
  starting head. After each accepted attempt the kernel runs one more panel,
  head against start, and records the win rate
  (`optimization.progress-measured`). A panel threshold is a win rate: "stop
  when 80% of judges prefer the current head over the original". The
  starting value is 0.5 by definition.
- **The noise check** runs the starting head against itself. The distance of
  that win rate from 0.5 is the panel's noise, compared with ε as in §7.3.

Asking judges which of two variants is better asks the question we care
about directly. Rating each variant separately and subtracting the averages
answers it indirectly, through scales that drift between sessions and crowd
the top (§16).

## 9. Stopping and completion

### 9.1 Stop causes

| Cause | Fires when |
|---|---|
| `threshold` | The node head's value reaches the threshold. For a command, that is the candidate median of the measurement that accepted it; for a panel, the head's win rate against the starting head (§8). |
| `plateau` | `plateau.attempts` consecutive attempts settled as `no-improvement` or `declined`. |
| `budget` | `maxAttempts` attempts were filed, or `maxHours` passed since opening. |
| `exhausted` | The proposer returned no attempts twice in a row (§5.3). |
| `operator` | `ab objective <node> --stop [--drain \| --abort]` (operator tool `optimization.stop`). |

The kernel records `optimization.stopped {cause, mode}` once. Every cause
uses the objective's `stop.mode` unless the operator passes an explicit mode.

### 9.2 Modes

- **abort** (default): queued attempts are cancelled, and running attempts
  are aborted. All of them settle as `stopped` (§6.3).
- **drain**: queued attempts are cancelled. Running attempts finish and face
  the measurement gate as usual. They merge only if they improve the head.

### 9.3 Completion

An optimization node is **complete** when it has stopped, no attempt is
running or waiting to land, and its exhaustive child enumeration otherwise
satisfies §13.1. After that the ordinary node grammar takes over: verify at
the exact head and parent, authorization by `[[merge]]` rules (consent by
default), merge and close. Stopping is not consent. An operator who wants to
"call it and land it" stops the node and then runs `ab merge`.

Because of the ratchet, a node that stops on budget, plateau or operator
request lands real, verified progress. Nothing is lost by calling it early.

## 10. Guidance

Attempts are not supposed to optimize at all costs. Their job is to find
meaningful improvements without regressing behavior or cheating the spirit
of the test. Agents respect a larger goal when they are told what it is and
why the metric only stands in for it. The pinned harness is a backstop. The
guidance is the primary defense.

Every passage below changes in all three copies (`skills/`,
`.agents/skills/ab-*`, `.agents/skills/.ab-pristine/ab-*`) in the same commit
as the behavior it describes:

- **`ab-implement`**, a new optimization section:
  - the goal is a meaningful improvement, not the largest number;
  - regressing behavior is a failure even when the metric improves;
  - changing what the test measures, overfitting to the eval, or
    special-casing the benchmark defeats the point of the run;
  - concluding "this strategy produced no real gain" is a successful outcome
    (`ab done --no-improvement`), and it teaches the proposer something.
- **`ab-plan`**: plan the strategy the attempt was given; don't drift into
  another attempt's strategy.
- **`ab-plan-review` and `ab-code-review`**: judge the attempt against the
  purpose, not only the score. Code review sees the implementer's own
  measurements as claims, not as the gate. A change that games the spirit of
  the test is a blocking finding, whatever the number did.
- **`ab-propose`**, a new canonical skill: propose diverse strategies that
  could produce real gains, read the ledger first, never propose a strategy
  that exploits how the metric is measured, and propose none when the ideas
  run out.
- **`ab-spec` and `ab-tickets`**: how to groom an optimization node, the
  exact `autobuild-objective` marker and its false-positive rules (§4.1), how
  to write a good purpose, and how to choose a harness, ε and budget.
- **`ab-reconcile`**: never resolve a conflict by editing a harness path; an
  attempt that reaches landing with one escalates (§7.1).
- **`ab-operate`**: reading progress, revising the threshold, stopping with
  abort or drain, landing.
- **`ab-guide`**: the integration grammar with the proposer phase, the
  objective marker and schema, the measurement gate, the noise check, panel
  win rates and the rejected-role exception.

## 11. Events and read cost

### 11.1 Events

| Event | Facts |
|---|---|
| `optimization.objective-accepted` | objective, revision, harnessPin |
| `optimization.objective-revised` | changed fields, revision, actor |
| `optimization.baseline-measured` | head, samples, median, noise spread |
| `optimization.proposal-requested` | node head, room, budget used |
| `optimization.attempts-proposed` | proposal ids, ticket ids (after creation) |
| `attempt.measured` | candidate head, baseline head, harnessPin, samples, medians, delta, decision |
| `optimization.progress-measured` | panels only: head, starting head, win rate |
| `attempt.settled` | outcome: accepted, no-improvement, declined, stopped, aborted |
| `optimization.stopped` | cause, mode |

`attempt.measured` is on the attempt's log. Every other event is on the
node's log, including `attempt.settled`, which the dispatcher writes when an
attempt settles and which carries the measured delta. The node's digest and
ledger therefore never read attempt logs.

Events record facts. The current value, the best value, the plateau counter,
the attempts filed and the stop eligibility are derived in the reducer.

### 11.2 Recurring reads

- **The dispatcher's stop and admission check** runs every tick for each
  open optimization node. It reads the node's reduced digest only. The
  digest is a bounded fold, so the check costs the same at 10 attempts and
  10,000, and reads zero event rows while nothing changes.
- **The attempt ledger** is a reduced value advanced once per
  `attempt.settled`, not rebuilt from attempt logs. The proposer reads it once
  per run. Its size grows with the attempts in this node, which is an
  explicit history request bounded by `maxAttempts`.
- **A waiting attempt's measurement freshness** compares the recorded
  baseline head with the node head already in the digest. It needs no reads
  of its own.

The node digest and ledger bounds are proved by extending the existing
read-budget harnesses in `packages/core/src/testing/`.

## 12. Surfaces

The shared projection under `packages/core/src/cli/dashboard/` gains an
objective row: starting value → current value against the threshold;
accepted, rejected and running attempts; budget used; and stop cause. Both
dashboards render it with the same vocabulary. `ab status`, `ab build status
<node>`, `ab watch` and the operator tools carry the same fields.

The web app needs a design ticket. A progress visual for an objective is a
new surface, so its direction is a human decision and does not happen inside
an unattended build.

## 13. Decisions

Made by the maintainer on 2026-11-17:

1. **The node owns the proposer.** A new agent phase on the node, not the
   orchestrator and not humans. A human in the loop for each attempt defeats
   the purpose, and an orchestrator stops when no agent is attached.
2. **Stopping aborts by default.** An operator may choose drain instead,
   letting running attempts finish and be integrated or not on their merits.
3. **The builds optimize, not the node.** Attempts are ordinary work builds
   in a checkout at the node head.
4. **Names:** optimization node, with an objective.
5. **Guidance stresses meaningful improvement over the metric.** Attempts get
   the purpose and are told why the metric is not the only thing that
   matters (§10).
6. **Rejected attempts move to the rejected role** (§6.3), the one place the
   dispatcher moves tickets there.
7. **One canonical measurement, after review and verification.** A measure
   step before code review was briefly adopted and then withdrawn: the
   implementer already measures its own work, so it saved little. Attempts
   keep the ordinary work grammar (§6.1).
8. **The objective block is the marker; there is no new kind.** The spec,
   guidance and skills state the exact marker and rule out false positives
   (§4.1).
9. **Quick revisions are not written back to the ticket.** Surfaces mark
   revised fields instead (§4.3).
10. **No extra implement round** for an attempt that did not improve. Near
    misses are flagged in the ledger for the proposer (§5.2).
11. **Medians and ε, with a noise check** at objective acceptance (§7.3).
12. **Panels judge pairwise.** Acceptance is a win rate against the current
    head, and the threshold is a win rate against the starting head (§8).
13. **Budgets are attempts and hours.** No monetary or token budget.
14. **Held-out evaluation is deferred.** Typical uses measure performance or
    judge quality with a panel, where a held-out set does not apply.

## 14. Deferred

- **Held-out evaluation.** For dataset-style metrics, a held-out set stored
  as a node ticket asset, kept out of attempt context and measured at node
  verification, would catch overfitting. Revisit when someone runs one.
- **Significance tests.** An opt-in test such as Mann-Whitney, if the noise
  check shows medians and ε are not enough in practice.
- **Writing revisions back.** A best-effort ticket write after
  `optimization.objective-revised`, if stale tickets cause real confusion.
- **Token budgets.** Only if runners come to report usage reliably and
  someone asks.

## 15. Delivery plan

Filed 2026-11-17 as node AUT-1223, targeting root. Each child updates the
skills and `ab-guide` passages that describe its behavior in the same commit.
The first child is the contract; the rest build against it in parallel, with
recorded facts standing in for siblings that have not landed.

| Ticket | Scope | Blocked by |
|---|---|---|
| AUT-1224 | Objective marker, schema and validation, every event, the reducer digest, attempt identity, the ledger, `ab objective`, ticket and tree labelling | — |
| AUT-1225 | Paired, harness-pinned measurement; starting measurement and noise check | 1224 |
| AUT-1226 | Landing gate, invalidation, starvation, settlement, the rejected-role move, non-regression for other children | 1224 |
| AUT-1227 | Attempt context, harness validation at `ab done`, declining, implement and review guidance | 1224 |
| AUT-1228 | Proposer phase, `ab propose`, dispatcher ticket creation, `ab-propose`, the design-rule exception | 1224 |
| AUT-1229 | Stop causes, abort and drain, completion, `ab-operate` | 1224 |
| AUT-1230 | Shared projection, terminal dashboard, status, watch, operator tools | 1224 |
| AUT-1231 | Judge panels | 1225, 1226 |
| AUT-1232 | End-to-end scenarios, adopter docs, stale-passage sweep | all of the above |

Not filed yet: the web app progress view (a design ticket with a human at the
table) and a first optimization node on this repository (this repository's
configuration, after the series lands).

## 16. Alternatives considered

- **One agent looping inside one build.** The simplest hill climb: edit,
  measure, keep or revert, repeat. It loses parallel strategies, review,
  verify and the per-attempt paper trail. The implement inner loop (§6) keeps
  what it is good at.
- **Measuring under the node writer lease.** Serializes measurement through
  the node: correct but slow, since one long benchmark blocks every sibling.
  Optimistic measurement with a starvation guard (§7.5) gives the same
  guarantee.
- **Comparing against a stored baseline.** Cheaper, but cross-machine noise
  swamps small improvements. Paired measurement costs one extra side per
  run.
- **Measurement as a verify step.** Verify's failure routes back to
  implement, which is wrong for "the strategy did not work". Verify also
  passes once per head, but a measurement depends on the node head as well.
- **Measuring before code review.** A kernel measurement when implement
  finishes would close losing attempts before review. Withdrawn: the
  implementer already measures its own work, and `ab done --no-improvement`
  lets it stop on its own, so the extra step saved little and complicated
  the grammar.
- **`kind = "optimization"`.** Explicit, but it changes every ticket
  source's storage. The marker rules in §4.1 give the same clarity.
- **Panels rating each variant separately.** Score both heads, average each,
  and treat the difference as lift. It asks the question indirectly, and
  absolute scales drift between sessions and crowd the top. A judge
  comparing both at once answers the real question.
- **Resolving rejected attempts as done.** Needs no dispatcher exception, but
  `done` reads as merged.
- **The orchestrator proposes.** Rejected by decision 1 (§13).

## Evidence

- Maintainer discussion, 2026-11-17: the pattern is "popular in the recursive
  self-improvement world, but I think it's just a general pattern"; example
  uses are optimizing a SQL query or an algorithm, or a panel of agents
  scoring subjectively, averaged.
- The same discussion on stopping: the threshold should be adjustable
  "without necessarily needing to restart everything or replan"; a user may
  decide progress has stalled, so "let's just call it and take the progress
  that we've made so far", possibly as a policy.
- On the pipeline: "my instinct is that it's the integration node that mainly
  needs to be specialized here rather than the build pipeline".
- On stopping modes: "let's call it but allow the current attempts to either
  get integrated or not" or "let's call it and abort", "with abort as the
  default".
- On guidance: attempts' "job is not to optimize at all costs. Their job is to
  find meaningful improvements without regressing functionality or cheating
  the spirit of the test", and "agents will respect a larger goal as well if
  you give them the context and explain why their current goal, while useful,
  is not the only thing we care about".
- On measurement timing: "since the implementer is already checking its own
  results while it's implementing, we're not actually saving anything" by
  measuring before review; "allow the implementer to do its thing, then run
  code review, then run all of the verifications, and then capture the
  canonical results for that build".
- On panels: comparing against the starting head "makes perfect sense", and
  pairwise judging "asks the judges to assess the thing we're trying to get
  at directly, rather than trying to interpret that result from a different
  question".
- On held-out sets: best practice for machine learning research, but typical
  use "will be measuring against some performance threshold or judging the
  quality of some UI component with a panel of judges", where a held-out set
  is "not quite applicable", so not in v1.
- `SPEC.md` §5: integration builds follow `spec → branch opening →
  collecting → complete → verify:* → authorization → merge → close` and never
  enter plan or implement. §13.1: node completion is exhaustive child
  enumeration; children merge by guarded fast-forward under the node writer
  lease. §15.7: clean waiting restacks keep existing verification.
- `skills/tickets/SKILL.md`: the dispatcher never claims from or moves into
  the backlog and rejected roles.
