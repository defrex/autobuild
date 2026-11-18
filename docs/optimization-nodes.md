# Optimization nodes

An optimization node is a node whose spec declares an objective: a metric, a
direction or a judge panel, a target, a budget and a purpose. The objective is
the only marker. The ticket's `kind` stays `node`, and no label, ticket state or
source setting marks it. Because the marker makes a node file and dispatch its
own work, the rules below leave no room for a false positive and no silent
fallback in either direction.

This reference is the contract: how the marker is found, the objective schema,
what refuses an objective, how a node and its attempts are measured, how the
objective is revised, which facts the log records, what is derived from them
and how the node proposes its own attempts. It ends with grooming guidance.

## The marker

A node becomes an optimization node only when its spec carries exactly one
fenced block whose info string is exactly `autobuild-objective`.

The scan follows CommonMark fences:

- A fence opens on a line indented at most three spaces with three or more
  backticks or tildes, and closes on a line of the same character, at least as
  long, carrying no info string.
- Only a fence whose trimmed info string equals `autobuild-objective`,
  case-sensitively, counts.
- A backtick line whose info string contains a backtick is inline code, not a
  fence.

None of these count:

- a fence nested inside another open fence, so a Markdown example that shows
  the block (as below) never marks the spec that contains it;
- a fence line that begins with a blockquote or list marker, or is indented
  four or more spaces;
- a fence inside an HTML block, such as an HTML comment, so a commented-out
  example never counts;
- a heading named "Objective";
- a `toml` block, or a fence with any other info string, such as
  `Autobuild-Objective` or `autobuild-objective toml`;
- prose describing an objective, and inline code.

A node spec with no block is a plain node. A work ticket that carries the
block is refused at dispatch; see [Refusals](#refusals).

## The objective

The block's content is TOML. This command objective is valid as written:

````markdown
```autobuild-objective
purpose = """
p95 latency of the catalog search query, because users wait on it at every
keystroke. Results, their order and the query's semantics must not change.
"""

[metric]
kind = "command"                 # or "panel"
command = "bun bench/search.ts"  # prints one JSON object: {"value": <number>}
direction = "minimize"
samples = 7                      # paired runs per side
harness = ["bench/search/**", "bench/fixtures/catalog.sql"]

[target]
threshold = 40                   # milliseconds; optional
epsilon = { relative = 0.03 }    # or { absolute = 2 }

[budget]                         # at least one limit is required
maxAttempts = 60
maxHours = 24

[stop]
plateau = { attempts = 12 }      # optional
mode = "abort"                   # or "drain"; default "abort"

[proposer]
concurrency = 4                  # attempts in flight
```
````

A panel replaces the metric for work without a mechanical measure. Judges
compare two variants and state a preference, so a panel always maximizes a win
rate:

```toml
[metric]
kind = "panel"
judges = 5
rubric = "evals/prose-rubric.md"   # a harness path
harness = ["evals/**"]
```

### Schema

Every table is strict: an unknown key is refused and named, for example
`unknown field metric.cmd`. The stored objective is the normalized form, with
defaults applied.

| Field | Required | Constraint | Default |
|---|---|---|---|
| `purpose` | yes | Nonblank string. | — |
| `metric.kind` | yes | `"command"` or `"panel"`. | — |
| `metric.command` | command | Nonblank string. Refused for a panel. | — |
| `metric.direction` | command | `"minimize"` or `"maximize"`. Refused for a panel. | — |
| `metric.samples` | command | Integer from 1 to 100. Refused for a panel. | — |
| `metric.judges` | panel | Integer from 1 to 20. Refused for a command. | — |
| `metric.rubric` | panel | A literal repository-relative path, no `*` or `?`, matched by `metric.harness`. Refused for a command. | — |
| `metric.harness` | yes | Nonempty array of path selectors (below). | — |
| `target.epsilon` | yes | Exactly one of `{ absolute = n }` with n > 0, or `{ relative = n }` with 0 < n < 1. A panel accepts only an absolute value below 0.5. | — |
| `target.threshold` | no | A number. A panel threshold is a win rate in (0.5, 1]. | none |
| `budget.maxAttempts` | at least one | Integer ≥ 1. | none |
| `budget.maxHours` | at least one | Number > 0. | none |
| `stop.plateau.attempts` | no | Integer ≥ 1. | none |
| `stop.mode` | no | `"abort"` or `"drain"`. | `"abort"` |
| `proposer.concurrency` | no | Integer ≥ 1. | `1` |

Harness entries are path selectors, the grammar `[[merge]]` and verify `paths`
already use: positive, repository-relative, case-sensitive Git-style globs made
of literal characters, `*`, `?` and whole-segment `**`. Absolute paths,
backslashes, negation, empty or `.`/`..` segments, character classes, braces
and extglobs are refused, naming the entry, for example
`metric.harness[1]: path selectors must be repository-relative`.

## Refusals

Each refusal names its reason:

| Condition | Reason |
|---|---|
| Two or more blocks | `exactly one autobuild-objective block (found N)` |
| A block never closed | `a valid autobuild-objective block: the fence is never closed` |
| A TOML syntax error | `a valid autobuild-objective block: TOML syntax error at line L: …` |
| A schema failure | `a valid autobuild-objective block: <field>: <message>`, for example `metric.rubric: must be inside metric.harness` |
| No budget limit | `a budget limit in the autobuild-objective block: set budget.maxAttempts or budget.maxHours` |
| No rejected role in the ticket source | `a rejected role for optimization attempts: set [tickets].rejectedState` |
| A work ticket carrying the block | `no autobuild-objective block in a work ticket: the block marks an optimization node (file it with --kind node)` |

The dispatcher checks the ticket body when it prepares a claimed ticket, before
any spec authoring. A refusal bounces the ticket back to triage with a comment
naming every reason and creates no build. A refused node never opens as a plain
node instead. Fix the block, or file the ticket with `--kind node`, and move it
to ready again.

## Opening

Opening an optimization node records `optimization.objective-accepted` with the
objective, revision 1, a `harnessPin` equal to the node's opening commit, and
the spec revision it was parsed from. It is recorded before `node.opened`, so an
opened optimization node always has an accepted objective.

A command node then measures its opening head against itself, with the
objective's pairing and sample count (see [Measurement](#measurement)), and
records `optimization.baseline-measured` with the starting value and the noise
spread. The dispatcher admits that run as it admits a node verification: the
node takes a runner slot, gets a workspace for the run, and releases it once
the starting value is recorded.

**Noise check.** When ε, in metric units, is smaller than the measured spread,
the gate would accept noise. The node records `optimization.noise-exceeded`
naming both numbers, which `ab watch` reports as attention. The node still
opens: raise `target.epsilon` with `ab objective`, or raise `metric.samples`
with a spec revision. A relative ε over a starting value of 0 is 0, so any
spread exceeds it.

## Revisions

Two paths change the objective of an open optimization node.

**Quick revision.** `ab objective <node>` shows the effective objective and
progress. Flags revise the knobs that only change when to stop, how much to
spend or how large a gain must be:

```sh
ab objective <node> [--threshold n] [--epsilon n|n%] [--max-attempts n] \
  [--max-hours n] [--plateau n] [--stop-mode abort|drain] [--concurrency n] \
  [--json] [--store <ref>]
```

`--epsilon 2` is absolute; `--epsilon 3%` is relative 0.03. A revision records
`optimization.objective-revised` with the changes and the next revision, then
shows the result. The operator tool `optimization.revise` does the same; see the
[operator API](operator-api.md#optimization-objective-revision). Both refuse a
build that is not a node, a node with no accepted objective and a terminal node,
and the revised objective must still validate. Running attempts are unaffected.

**Spec revision.** `ab answer <node> --revise-spec <file>` or
`--revise-spec-from-ticket` changes anything else: the metric, the harness or
the purpose. The replacement may change the objective, but it must keep exactly
one valid block:

- removing the block from an optimization node is refused; close the node and
  open a new one instead;
- adding a block to a plain node or a work build is refused;
- an invalid replacement block is refused, naming the field.

A refused revision records nothing. After an accepted one, the dispatcher
records `optimization.objective-accepted` again with the next revision. When the
metric changed, or the purpose of a panel (judges read it), it pins the harness
again at the current node head and starts a new ruler: earlier measurements stay
in history but are never compared with new ones, and the node measures the new
pin against itself for a new starting value and noise check. Otherwise the pin
is unchanged.

A quick revision is never written back to the ticket. `ab ticket show` prints
the effective objective of an open optimization node and marks each field that
differs from the ticket's block `(revised)`, so a stale ticket is visible. The
open build, not the ticket body, decides this: when an edit removes the block or
leaves it invalid, every field is marked.
`ab ticket tree` labels the ticket `[node, optimization]`, and status labels the
build `optimization node`.

## Measurement

A measurement compares two heads in one execution, so both sides run on the
same hardware. A stored number from another machine is never a baseline.

**Pairing.** The measurer makes two detached worktrees, one at the candidate
and one at the baseline. A round runs the metric command once in each, and
the rounds alternate which side runs first, so a warming cache or a
throttling CPU cancels out. There are `samples` rounds. When `[commands].setup`
is configured, it runs once in each worktree first, because a fresh worktree
has no installed dependencies.

**Harness pinning.** Before any run, every path matched by `metric.harness` is
overwritten in both worktrees with its contents at `harnessPin`, and a harness
file the pin lacks is deleted. A candidate that edits the benchmark, or a
harness change arriving through a node restack, never moves the ruler.
Attempts can read and run the harness; they cannot change what counts.

**Output contract.** Each run must exit 0 and print exactly one JSON object
whose `value` is a finite number, such as `{"value": 41.7}`. Each run, and each
setup run, has a 30-minute timeout.

**Decision.** The value of a side is the median of its samples. The delta is
positive for an improvement: `baseline − candidate` when minimizing,
`candidate − baseline` when maximizing. ε in metric units is the absolute ε,
or the relative ε times the baseline median's magnitude. A delta of at least ε
is `improved`; anything less is `no-improvement`. A starting measurement's
value is the median of all samples, and its spread is the distance between the
two sides' medians.

**Spread beside every delta.** Each `attempt.measured` carries the node's
starting spread as `spread`, and `ab watch` prints it next to the delta, such
as `delta 6 (noise ±0.4)`. The raw per-sample values are deposited as a
`measurement-samples` artifact referenced by `report`.

**Attempts.** An `attempt.measurement-requested` names the candidate, the
baseline, the harness pin, the objective revision and the command metric. A
parked attempt with such a request takes a runner slot as a re-verify does,
and its runner samples in the attempt's own workspace and records
`attempt.sampled`. The runner reads only its own build, so the dispatcher
decides: it reads the node once, checks that the request's revision and
harness pin are still the node's ruler, and records `attempt.measured` using
the node's current ε and starting spread. A quick ε revision made while the
samples ran therefore applies. A request whose ruler or pin was replaced
while it was sampled records no decision; the attempt needs a fresh request.

**Failures.** None of these record a value or a decision:

- the command exits nonzero, times out, or prints anything other than one
  JSON object with a numeric `value`;
- a worktree or setup command fails;
- a request names no command metric, or its ruler is no longer the node's.

Instead, the build escalates with target `measurement` and policy cause
`measurement-failed`. The question names the cause, the failing sample and
the output tail. Answering a runner failure measures again; abort still
aborts. A refusal of samples taken under a replaced ruler stays refused after
the answer, because sampling the same request again cannot succeed.

## Events

| Event | Log | Facts |
|---|---|---|
| `optimization.objective-accepted` | node | objective, revision, harnessPin, specRev |
| `optimization.objective-revised` | node | changes, revision (human) |
| `optimization.baseline-measured` | node | revision, head, harnessPin, samples, median, spread, report |
| `optimization.noise-exceeded` | node | revision, head, harnessPin, median, spread, epsilon, effective ε (advisory) |
| `optimization.proposal-requested` | node | id, node head, room, budget used (attempts, hours) (dispatcher) |
| `optimization.attempts-proposed` | node | request, proposals (id, ticket, title, strategy), reason when empty; recorded after every ticket exists (dispatcher) |
| `attempt.measurement-requested` | attempt | id, node, candidate, baseline, harnessPin, revision, metric |
| `attempt.sampled` | attempt | request, candidate, baseline, harnessPin, revision, samples, medians, report |
| `attempt.measured` | attempt | request, candidate, baseline, harnessPin, revision, samples, medians or win rate, delta, decision, spread, report |
| `optimization.proposal-deferred` | node | reason: `paused`, `blocked`, `command`, `restack`, `integration`, `landing` or `compatibility` (dispatcher) |
| `optimization.proposal-withdrawn` | node | request, reason: `stopped`, `budget` or `concurrency` (dispatcher) |
| `propose.started` | node | round, request (kernel) |
| `propose.completed` | node | round, request, proposal ids, `attempts` artifact (proposer) |
| `optimization.progress-measured` | node | revision, head, starting head, win rate, judges |
| `implement.declined` | attempt | round, reason, artifact? (agent) |
| `attempt.settled` | node | attempt (proposal, ticket, build), outcome, measurement (revision, baseline, candidate, delta), note |
| `optimization.stopped` | node | cause, mode |

`decision` is `improved`, `no-improvement`, `non-regressing` or `regressed`.
`outcome` is `accepted`, `no-improvement`, `declined`, `stopped` or `aborted`;
`accepted` and `no-improvement` carry their measurement. `cause` is
`threshold`, `plateau`, `budget`, `exhausted` or `operator`. `report`,
`spread` and a request's `metric` are optional: older facts lack them.
`attempt.sampled` records samples, never a decision; `attempt.measured` is the
decision.
The dispatcher records `exhausted` after two consecutive empty proposals.

A positive delta is an improvement in the objective's direction:
`baseline − candidate` when minimizing, `candidate − baseline` when maximizing,
and `winRate − 0.5` for a panel. `revision` counts every acceptance and quick
revision, starting at 1; measurement facts carry the revision they ran under.

## Progress

Progress is derived from the node's log, never recorded:

- **Starting value and noise spread** from the baseline measurement under the
  current ruler. A panel's starting value is 0.5.
- **Current value**: for a command, the candidate value of the latest accepted
  attempt, else the starting value; for a panel, the head's latest win rate
  against the starting head, else 0.5. **Best value** in the objective's
  direction.
- **Attempts**: filed, accepted, rejected (no-improvement, declined, stopped or
  aborted) and running.
- **Plateau counter**: consecutive `no-improvement` or `declined` settlements
  since the last `accepted`; `stopped` and `aborted` leave it unchanged.
- **Elapsed budget**: hours since the first acceptance, against `maxHours`, and
  attempts filed, against `maxAttempts`.
- **Stop eligibility** by threshold, plateau and budget, and whether the node
  has stopped.

The attempt ledger holds one entry per settled attempt: strategy, outcome,
measured delta and closing note. A **near miss** is a `no-improvement`
settlement that improved by less than ε (0 < delta < ε, with a relative ε
scaled by the baseline's magnitude).

### Where progress appears

Every surface shows the same objective row, read from the node's digest alone:

- The terminal dashboard prints it under the node's progress bar and as the
  `Objective` field of the detail view.
- `ab status` prints it on a continuation line under the node's row, and
  `ab build status <node>` prints it under `optimization node: objective
  revision N`.
- `--json` summaries, the `builds.list` and `builds.get` operator tools, and
  `ab watch --json` records (`state.objective`) carry it as `objective`;
  `builds.get` also carries the dashboard's `objectiveRow`. `ab watch` appends
  it to the line of every optimization event.

```text
objective 50 → 44 (minimize) · threshold 35 · noise ±1.5
attempts 1 accepted · 3 rejected · 0 running
budget 4/60 attempts · 3.1/24 hours
stopped plateau (drain)
```

A panel shows `win rate 50% → 70%` instead. Only configured budgets appear,
`no threshold` and `objective not measured` stand in for absent values, and
the `stopped` segment appears once the node stops. Budget hours stop at the
stop time; a watch record evaluates them at its own timestamp. `ab objective`
remains the full view, with the best value, plateau and stop eligibility.

## Proposer phase

An optimization node proposes its own attempts. Its grammar is
`branch opening → starting measurement → (propose → collecting)*`, followed by
the node's normal completion, verification and merge. Grooming the objective,
its purpose, budget and stop policy, is the dispatch decision for every attempt
the node generates: the proposer's attempts go straight to ready, within that
budget, and each must pass the measurement gate before it lands.

**Admission.** The dispatcher records `optimization.proposal-requested` when
the node is open, has not stopped, has a starting measurement under the
current ruler, has no open request, has fewer than two consecutive empty
proposals, and has room. Room is the smaller of the free concurrency slots
(`proposer.concurrency` minus attempts queued or running) and the attempts
the budget still allows, and is 0 once the attempts or hours budget is spent.
An open request means a proposer session is running, so the node never has
two. A node that is paused, blocked, has a pending command, an active or
conflicted node restack, a landing intent or a merged or closed PR, or is
deferred for runtime compatibility gets `optimization.proposal-deferred` with
that reason instead, and is reconsidered once a fact that can clear it lands.
The request takes a slot ahead of new ticket claims, like node reconcile and
verification. Before the session starts, the dispatcher re-checks the request:
when the node stopped, the hours budget expired, or room fell below the
recorded room, it records `optimization.proposal-withdrawn`, which clears the
request and never counts as an empty proposal. A session that already started
keeps the room it was granted.

**Context.** The session runs the `ab-propose` skill on the node head, checked
out detached. `ab context` writes:

- `objective.json`: the effective objective, its revision and the fields
  quick-revised since its latest acceptance;
- `progress.json`: starting, current, best and threshold values, attempt
  counts, attempts in flight, the plateau counter, consecutive empty proposals,
  the opening time and the request (`id`, `head`, `room`);
- `ledger.json`: `settled`, one entry per settled attempt with `nearMiss: true`
  on a near miss, and `inFlight`, the running attempts with their titles and
  strategies;

plus the spec, answered guidance and ticket assets. The manifest's
`optimization` names the request, head and room.

**`ab propose`.** The session ends with `ab propose <file>`,
`ab propose --none <reason>` or `ab escalate`; `ab done` and `ab verdict` are
refused. The file is JSON:

```json
{"proposals": [{"id": "batch-index-lookups", "title": "…", "strategy": "…", "body": "…"}], "reason": "…"}
```

- `id` matches `^[a-z0-9][a-z0-9-]{0,63}$`, is unique in the file and was never
  used by this node before, whether settled, pending or in flight.
- `title` is one line of at most 200 characters; `strategy` is one line of at
  most 300 characters naming one strategy.
- `body` meets the [spec standard](spec-standard.md) (what and why,
  `## Acceptance criteria` with at least one item, `## Out of scope`) and
  carries no `autobuild-objective` block.
- The count is at most the request's room. An empty list needs a `reason`.

A valid file is deposited as an `attempts` artifact together with
`propose.completed`. The proposer never creates tickets.

**Filing.** The dispatcher reads the deposit once and creates one work ticket
per proposal, targeting the node, in the source's ready role. Each creation
carries an idempotency key derived from the repository, the node and the
proposal id, so a crash between the deposit, the creation and the record
adopts the ticket an earlier try created instead of filing it twice. Until the
record lands, intake withholds ready tickets whose creation key matches a
deposited proposal. Once every ticket exists, the dispatcher records
`optimization.attempts-proposed` and releases the node's workspace. If that
release never happens, after a crash, a failed release or a runner still
leased, a later dispatcher pass releases any optimization-node workspace that
no runner, proposal, restack or integration work owns. A ticket source without integration-tree support, or an unreadable deposit, raises an
escalation on the node instead of creating anything.

**Exhausted.** Two consecutive empty proposals stop the node: the dispatcher
records `optimization.stopped` with cause `exhausted` and the objective's stop
mode, and requests no further proposals. Recording the stop does not abort or
drain attempts already in flight.

Baseline measurement has precedence over new proposer admission. A proposer
already started when a ruler revision makes a baseline due finishes and its
deposit is filed normally. Measurement runs next, before another proposer.
The node workspace remains held while either a baseline measurement or a
proposal request or session needs it; neither owner releases the other’s workspace.

## Attempts

A build is an attempt of a node exactly when its ticket was created from a
recorded proposal of that node (`optimization.attempts-proposed`), which the
dispatcher files from the proposer's deposit. Children
filed any other way, for example a repair child, are not attempts and count
toward neither the budget nor the plateau. The proposal's ticket and the
build's ticket are compared through any recorded ticket-source migration, so a
proposal recorded before a migration still matches its child. When that
continuity cannot be resolved, the command refuses with `cannot resolve
optimization attempt identity for build <slug>: …` rather than treating the
build as an ordinary child.

An attempt keeps the ordinary work grammar: plan, plan review, implement, code
review, verify and finalize.

### Attempt context

In every phase of an attempt, `ab context` writes a derived `objective.md` and
adds an `attempt` block to the manifest. Reviewers need the purpose as much as
the implementer does. The document names the node and the objective revision
and gives:

- the purpose, verbatim;
- the measurement: the command, its direction and samples, or a panel's judges
  and rubric;
- the harness selectors, with a note that the harness is pinned and `ab done`
  refuses any change to it;
- ε, the threshold if any, and the node's current value ("not measured yet"
  before a baseline), with the best and starting values when present.

The manifest block is
`{node, proposal, revision, purpose, metric: {kind, command?, direction?,
samples?, judges?, rubric?}, harness, current?, path}`, where `path` is the
workspace-relative `objective.md`.

### Harness edits are refused

The harness is the ruler. In an attempt's implement phase, `ab done` compares
the net contribution (`base..head`, renames as delete plus add) with
`metric.harness`. A change to a matching path is refused before anything is
deposited or published, as other invalid deposits are, so no event is written
and code review never sees it:

```text
publication rejected: an optimization attempt must not change its harness (the measurement's ruler):
  bench/search/run.ts
Revert these paths to the contribution base, commit, then retry 'ab done'.
```

Only the net diff counts: a harness edit reverted in a later commit changes
nothing the ruler measures. Children that are not attempts are not checked.

### Declining

When a strategy finds no real gain, the implementer declines:

```sh
ab done --no-improvement "<what was tried and why it did not help>" [--notes <file>]
```

It records `implement.declined {round, reason, artifact?}`, with the notes as
`implement-notes` when `--notes` is given. The reason is trimmed and must be 1
to 4000 characters. Declining needs no commits and no clean worktree, and it
publishes nothing. No review, verification, finalize or measurement follows.
The dispatcher then appends `attempt.settled {outcome: declined, note}` to the
node with the reason as the note, releases the attempt's workspace, and
completes the build `closed-unmerged`. A declined settlement enters the ledger
the proposer reads and advances the plateau counter.

Declining is a successful outcome: a specific reason tells the proposer what
not to try again. The flag is refused outside implement (`'--no-improvement'
is only valid in implement of an optimization attempt`) and in a build that is
not an attempt (`ab done --no-improvement is only for optimization attempts:
build <slug> is not an attempt of an optimization node`).

## Grooming an optimization node

The node ticket is still a spec-standard charter, with what and why,
acceptance criteria, out of scope and evidence. The block adds what to
improve and when to stop.

**Write the purpose for an agent that will try to game the number.** Say why
the metric matters, what it stands in for, and what must not change while it
moves: behavior, output, semantics, interfaces. "p95 latency of catalog search,
because users wait on it at every keystroke; results and their order must not
change" is a purpose. "Make search faster" is not.

**Choose the harness as everything that decides the number.** Include the
measurement command's script, its fixtures and datasets, and a panel's rubric.
The harness is the ruler, pinned at the node's opening commit (`harnessPin`),
not the code under improvement, so leave that code out. Keep selectors narrow:
a harness that covers the code being optimized pins the very code attempts are
meant to change.

**Choose ε above the noise.** ε is the smallest gain worth landing. Run the
command several times on the same tree first. If the median moves by more than
your ε between identical runs, raise ε or `samples`. The node checks this when
it opens: its starting measurement raises `optimization.noise-exceeded` when ε
is below the measured spread. A relative ε suits
metrics whose scale may change; an absolute ε suits metrics with a natural
unit. A panel's ε is a win-rate margin above 0.5, such as 0.1.

**Choose a budget you would sign off on unattended.** It is the limit a human
approves once for the whole run. `maxAttempts` bounds cost; `maxHours` bounds wall-clock
time. Set a plateau when a run of failed strategies should end the search
early. Set a threshold only when there is a value at which you would stop
looking. Use `concurrency` above 1 only when attempts are independent enough to
run side by side.

**Configure the rejected role first.** The ticket source must name
`[tickets].rejectedState`, or the node is refused.
