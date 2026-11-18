# Optimization nodes

An optimization node is a node whose spec declares an objective: a metric, a
direction or a judge panel, a target, a budget and a purpose. The objective is
the only marker. The ticket's `kind` stays `node`, and no label, ticket state or
source setting marks it. Because the marker makes a node file and dispatch its
own work, the rules below leave no room for a false positive and no silent
fallback in either direction.

This reference is the contract: how the marker is found, the objective schema,
what refuses an objective, how a node and its attempts are measured, how the
objective is revised, which facts the log records, what is derived from them,
and how the node stops and completes. It ends with grooming guidance.

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
ab objective <node> --stop [--drain | --abort] [--json] [--store <ref>]
```

`--epsilon 2` is absolute; `--epsilon 3%` is relative 0.03. A revision records
`optimization.objective-revised` with the changes and the next revision, then
shows the result. The operator tool `optimization.revise` does the same; see the
[operator API](operator-api.md#optimization-objective-revision). Both refuse a
build that is not a node, a node with no accepted objective and a terminal node,
and the revised objective must still validate. Running attempts are unaffected
and nothing is replanned: the dispatcher checks the revised threshold, budget
and plateau on its next tick, so lowering the threshold to the current value or
the budget to what was already spent stops the node then. A stop is final; a
revision after it is recorded but never resumes proposing. `--stop` is
described under [stopping and completion](#stopping-and-completion).

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
two sides' medians. A panel decides by win rate instead, with ties counted as
half: a win rate of at least 0.5 + ε is `improved`, so 3 of 5 judges meets an
ε of 0.1, and anything less is `no-improvement`. Its delta is
`winRate − 0.5`.

**Spread beside every delta.** A command's `attempt.measured` carries the
node's starting spread as `spread`, and `ab watch` prints it next to the
delta, such as `delta 6 (noise ±0.4)`. The raw per-sample values, or a
panel's judgments, are deposited as a `measurement-samples` artifact
referenced by `report`.

**Attempts.** An `attempt.measurement-requested` names the candidate, the
baseline, the harness pin, the objective revision and the node's metric. A
panel request also carries the objective's purpose, which its judges read. A
parked attempt with such a request takes a runner slot as a re-verify does,
and its runner samples in the attempt's own workspace and records
`attempt.sampled`. For a panel, the runner runs one [judge
panel](#judge-panels) of the attempt's head against the node head and records
the win rate, with the judge count as `samples`. The runner reads only its own
build, so the dispatcher decides: it reads the node once, checks that the
request's revision and harness pin are still the node's ruler, and records
`attempt.measured` using the node's current ε and, for a command, its starting
spread. A panel decision needs no starting value. A quick ε revision made while
the samples ran therefore applies. A request whose ruler or pin was replaced
while it was sampled records no decision; the attempt needs a fresh request.

**Failures.** None of these record a value or a decision:

- the command exits nonzero, times out, or prints anything other than one
  JSON object with a numeric `value`;
- a worktree or setup command fails;
- a judge panel fails: a judge failed twice, or the variants could not be
  prepared;
- a request names no metric, a panel request names no purpose, or its ruler
  is no longer the node's.

Instead, the build escalates with target `measurement` and policy cause
`measurement-failed`. The question names the cause, the failing sample and
the output tail. Answering a runner failure measures again; for a panel the
answer starts a fresh panel, while a crash resumes the same one and keeps its
judgments. Abort still aborts. A refusal of samples taken under a replaced ruler stays refused after
the answer, because sampling the same request again cannot succeed.

## Judge panels

A panel objective is measured by agent judges instead of a command. A panel
run compares two heads, a candidate and a baseline, under one harness pin, and
returns the candidate's win rate. Attempt acceptance runs one to measure each
attempt on a panel objective (see [Measurement](#measurement) and [Landing and
settlement](#landing-and-settlement)), and records the decision in
`attempt.measured.winRate`. A panel node records no baseline noise check and
no `optimization.progress-measured` yet. Those callers will record their
decisions in `optimization.baseline-measured` and
`optimization.progress-measured`.

**The run.** `panel.started` records the run's inputs: the candidate, the
baseline, the harness pin, the purpose, the rubric path, the harness and the
judge count. Every judge then runs in its own session, all of them at once,
under the `judge` role. Judges are build sessions, so the build's profile
applies to them.

**Blind, pinned variants.** Each judge gets a fresh root in the system
temporary directory, outside any repository. The root holds the two variants
as plain trees labeled `A/` and `B/`, a brief, and the `ab-judge` skill. Each
judge's order is drawn at random. Both trees carry the exact committed bytes
at every path, with no line-ending, filter or keyword conversion. Every harness
path, the rubric included, carries the harness pin's bytes, and a harness file
the pin lacks is absent. The skill is copied from the harness pin's
`.agents/skills/ab-judge/SKILL.md`, so a candidate cannot rewrite its own
judges' instructions. The variants are checked out from private Git material
outside the roots, and that material is deleted before any judge starts.
The runner refuses to start a judge whose root is inside the workspace or
inside any Git repository, and fails the run with that cause. Point `TMPDIR`
outside any repository.

**What a judge can learn.** Nothing Autobuild gives a judge reveals which
variant is the candidate: not its context, its environment, its labels, the
location or names of its variant trees, its store credential, nor any Git
metadata reachable from its working directory. Nothing under the judge's
root links back to the repository it was prepared from. The guarantee covers
these Autobuild-provided channels. A judge process that deliberately reads the
repository or the store from outside its root crosses the shared trust
boundary of unconfined local agent sessions.

**The order is recorded where judges cannot read it.** The kernel records each
judge's order in `panel.judge-started` before the session starts. No judge
channel reads the log: the judge's environment carries `AB_STORE`, `AB_JUDGE`
(`<build>:<panel>:<judge>`), `AB_SESSION`, `AB_CONTEXT_DIR` and, for a remote
store, a `build-judge` credential in `AB_TOKEN`. It carries no `AB_BUILD`, no
`AB_PHASE`, no inherited `AB_*` or `GIT_*` value and no `PWD`. The credential
is write-only. It can append exactly one `panel.preferred` for its own panel,
judge and session while the session is open, and every read is refused. Any
read command run with `AB_JUDGE` set fails.

**The terminal.** A judge runs `ab judge context`, which writes `purpose.md`,
`rubric.md` and `context.json` from its brief and reads no store. It compares
`A/` and `B/` and ends with exactly one
`ab judge prefer <A|B|tie> --reason "<paragraph>"`. The reason must not be
blank, and a second call is refused. After the turn, the kernel records
`panel.judged` with the judge's index, its order, the preference and the
reason.

**Win rate.** A judge who prefers the candidate scores 1, a tie scores 0.5 and
a preference for the baseline scores 0. The win rate is the mean over the
recorded judgments, so ties count as half.

**Resumption.** A run resumed after a crash or restart keeps every recorded
judgment. A judge whose preference was saved before the crash is completed
from that preference and its recorded order without a new session. A dangling
session is closed as `reclaimed`. Only judges with no recorded preference run
again, each with a freshly drawn order.

**Failures.** A judge's turn that ends without a preference (`no-terminal`),
fails (`failed`) or exceeds the session budget (`expired`) counts as a
failure. After two counted failures for one judge, the run fails and names the
judge and its last outcome. A shutdown records `interrupted`, which does not
count. A run that cannot prepare its variants fails with the Git output tail.
A variant holding a committed symlink that resolves outside its judge root
fails the run before any judge starts, naming the link.
Every judge root is removed when the run ends.

## Events

| Event | Log | Facts |
|---|---|---|
| `optimization.objective-accepted` | node | objective, revision, harnessPin, specRev |
| `optimization.objective-revised` | node | changes, revision (human) |
| `optimization.baseline-measured` | node | revision, head, harnessPin, samples, median, spread, report |
| `optimization.noise-exceeded` | node | revision, head, harnessPin, median, spread, epsilon, effective ε (advisory) |
| `optimization.proposal-requested` | node | id, node head, room, budget used (attempts, hours) |
| `optimization.attempts-proposed` | node | request, proposals (id, ticket, title, strategy), reason when empty |
| `attempt.measurement-requested` | attempt | id, node, candidate, baseline, harnessPin, revision, metric, purpose (panel) |
| `attempt.sampled` | attempt | request, candidate, baseline, harnessPin, revision, samples (judges for a panel), medians or win rate, report |
| `attempt.measured` | attempt | request, candidate, baseline, harnessPin, revision, samples, medians or win rate, delta, decision, spread, report |
| `optimization.progress-measured` | node | revision, head, starting head, win rate, judges |
| `implement.declined` | attempt | round, reason, artifact? (agent) |
| `attempt.settled` | node | attempt (proposal, ticket, build), outcome, measurement (revision, baseline, candidate, delta), note |
| `optimization.stopped` | node | cause, mode |
| `attempt.ticket-rejected` | node | proposal, ticket, rejected state the ticket moved to |
| `panel.started` | panel host | panel, candidate, baseline, harnessPin, purpose, rubric, harness, judges |
| `panel.judge-started` | panel host | panel, judge, session, order, runner, model?, account? |
| `panel.preferred` | panel host | panel, judge, session, preference, reason (agent) |
| `panel.judged` | panel host | panel, judge, session, order, preference, reason |
| `panel.judge-ended` | panel host | panel, judge, session, outcome, error?, transcript? |

`decision` is `improved`, `no-improvement`, `non-regressing` or `regressed`.
`outcome` is `accepted`, `no-improvement`, `declined`, `stopped` or `aborted`;
`accepted` and `no-improvement` carry their measurement. `cause` is
`threshold`, `plateau`, `budget`, `exhausted` or `operator`. `report`,
`spread` and a request's `metric` are optional: older facts lack them.
`attempt.sampled` records samples, never a decision; `attempt.measured` is the
decision.
The panel facts live on the log of the build that runs the panel. `order` is
`candidate-first` or `baseline-first`, `preference` is `A`, `B` or `tie`, and
a judge's `outcome` is `completed`, `no-terminal`, `failed`, `expired`,
`interrupted` or `reclaimed`. `panel.preferred` never carries the order.

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
  aborted) and running, plus the settled attempts whose ticket has not yet
  moved to the rejected role. Those still occupy a concurrency slot, so a
  tracker that refuses the move stalls new proposals instead of piling up.
- **Plateau counter**: consecutive `no-improvement` or `declined` settlements
  since the last `accepted`; `stopped` and `aborted` leave it unchanged.
- **Elapsed budget**: hours since the first acceptance, against `maxHours`, and
  attempts filed, against `maxAttempts`.
- **Stop eligibility** by threshold, plateau and budget, and whether the node
  has stopped. Once stopped, `ab objective` also shows what still blocks
  completion, or `ready for node verification`.

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

## Attempts

A build is an attempt of a node exactly when its ticket was created from a
recorded proposal of that node (`optimization.attempts-proposed`). Children
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

## Landing and settlement

Passing verify and finalize is not enough for a child of an optimization node
to land. Verify asks whether a change is correct; measurement asks whether it
helped. Once a child is ready to land, the dispatcher records
`attempt.measurement-requested` on the child's log for one exact pair: the
child's candidate head and the node head it would land on. The child lands only
with an `attempt.measured` result for that same pair, under the accepted
harness pin and the current ruler. The node writer's guarded merge is guarded
on that measured node head.

- **Freshness.** When a sibling lands first, the node head moves and the
  measurement no longer applies. The child restacks and a new measurement is
  requested. A clean restack keeps verification; it never keeps a measurement.
  The node writer is never held while a measurement runs.
  A landing interrupted after its writer reservation publishes on recovery only
  while that pair still passes the gate; after a revision it does not pass, the
  reservation is abandoned.
- **Attempts must improve.** An attempt lands when its delta is at least ε;
  on a panel objective, when its win rate against the current node head
  reaches 0.5 + ε. Anything less settles it `no-improvement`: its PR closes
  without merging and no further implement round runs.
- **Other children must not regress.** A child that is not an attempt lands
  when its delta is at least −ε, or its win rate at least 0.5 − ε. A
  regressing child escalates with both medians or the win rate, the delta and
  ε; answering asks for a fresh measurement. These
  children never settle and count toward neither budget nor plateau.
- **Harness edits escalate.** An attempt whose head changes a harness path is
  never measured. It escalates naming the paths, and that head stays
  unmeasured even after an answer; revise the attempt or abort it.
- **Turn.** An attempt overtaken by sibling landings three consecutive times
  gets the next turn. Later candidates neither request measurements nor land
  until it lands, closes, or escalates.

`ab watch` and `ab build status <child>` print the recorded measurement: a
command's medians or a panel's win rate, the delta and the decision, such as
`win rate 0.8: delta 0.3 → improved`.

Every attempt settles exactly once, on the node's log. A measured settlement
records the medians, or for a panel a baseline of 0.5 and the win rate as the
candidate:

| How the attempt ends | Outcome | Ticket role |
|---|---|---|
| Merged into the node, with a measurement of the merged head | `accepted` | done |
| Landing measurement shows no improvement | `no-improvement` | rejected |
| Proposer declines it | `declined` | rejected |
| Node stops | `stopped` | rejected |
| Operator abort, or a human closes its PR | `aborted` | rejected |

A human forge merge bypasses the landing gate. When no measurement exists for
the merged head, the attempt cannot settle `accepted`: the dispatcher records a
followup observation, and the attempt stays in flight and keeps its concurrency
slot until your operator agent acts. Its build and ticket still complete.

This is the one case in which the dispatcher moves a ticket into the rejected
role. Once the attempt's build is done (or it never had one), the node's poll
moves the ticket, comments the outcome, and records `attempt.ticket-rejected`.
An aborted or closed attempt never returns to triage. A completed node keeps
being polled until every such move has committed.

## Stopping and completion

An optimization node is done when the number is good enough, when it stops
getting better, when the budget runs out, or when an operator takes the
progress so far. Every accepted attempt improved the node head, so stopping at
any point lands real, verified progress.

**Causes.** The node records `optimization.stopped {cause, mode}` once:

| Cause | When |
|---|---|
| `threshold` | The node head's current value has reached `target.threshold` in the objective's direction. |
| `plateau` | `stop.plateau.attempts` consecutive `no-improvement` or `declined` settlements. |
| `budget` | Attempts filed reached `maxAttempts`, or hours since the first acceptance reached `maxHours`. |
| `exhausted` | The proposer has nothing left to try. |
| `operator` | A human stopped it with `ab objective <node> --stop` or `optimization.stop`. |

The dispatcher checks every open, unpaused optimization node on every tick and
records the first eligible of threshold, plateau and budget, with the
objective's stop mode. It checks the effective objective, so a quick revision
takes effect on the next tick.

**Stopping by hand.** `ab objective <node> --stop` uses the objective's stop
mode, `abort` unless the objective says otherwise; `--stop --drain` and
`--stop --abort` override it for this stop. The operator tool
`optimization.stop` takes an optional `mode`; see the
[operator API](operator-api.md#optimization-stop). Both refuse a build that is
not a node, a plain node, a terminal node and a node that has already stopped.
`--stop` cannot be combined with revision flags.

**Modes.** Every cause, `exhausted` included, applies the same modes:

- **abort**: queued attempts are cancelled and running attempts are aborted
  through the ordinary abort saga, with a dispatcher `build.abort-requested`
  naming the stop. Those aborted by the stop settle `stopped`.
- **drain**: queued attempts are cancelled and settle `stopped`; running
  attempts finish and face the landing gate.

The first recorded `build.abort-requested` fixes the abort's cause. A node-stop
request records `origin {kind: optimization-stop, node}`; an operator request has
operator origin (no node-stop origin). Abort cleanup alone settles an aborted
build: `stopped` for a node-stop request, `aborted` for an operator request.
An existing request is never replaced: identical repeats are idempotent and
conflicting operator requests are refused. The stop enforcer waits for a pending
abort, so an operator abort before a stop remains `aborted`; an operator abort
during drain is also `aborted`. Settlement is conditional on the attempt still
being in flight, and the existing node sweep alone moves its ticket to rejected.

An attempt with no build yet is cancelled and settles `stopped` in both modes. No proposer runs after
a stop, and dispatch refuses an attempt ticket of a stopped node with
`target optimization node <id> has stopped; attempt <ticket> is cancelled`.
Children filed by hand, such as repair tickets, are still admitted.

**Completion.** The node is complete when it has stopped, no attempt is running
or waiting to land, and every child is otherwise resolved under the ordinary
node completion rule. It then verifies, authorizes and merges like any other
node. Stopping is not consent: once the node is ready, land it with
`ab merge <node>`. `ab merge` refuses an optimization node that has not
stopped, or whose attempts are still in flight, and names which.

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

**Write a panel's rubric for comparing two variants.** Judges see two
variants side by side and say which is better, so write criteria a reader can
apply to a pair: "which explains the setup steps in fewer, clearer sentences"
compares; "scores 1–10 on clarity" does not. Name what must not be traded away,
and say that text written for the judges rather than for the reader counts
against a variant. Keep the rubric and any fixtures the judges read inside the
harness, so the pin fixes them. Choose `judges` for cost against noise: each
judge is one agent session per comparison, and more judges narrow the win
rate's spread. Five suits most prose; use more when a single preference
should not decide an ε of 0.1. See [judge panels](#judge-panels).

**Choose a budget you would sign off on unattended.** It is the limit a human
approves once for the whole run. `maxAttempts` bounds cost; `maxHours` bounds wall-clock
time. Set a plateau when a run of failed strategies should end the search
early. Set a threshold only when there is a value at which you would stop
looking. Use `concurrency` above 1 only when attempts are independent enough to
run side by side.

**Configure the rejected role first.** The ticket source must name
`[tickets].rejectedState`, or the node is refused. Every attempt that does not
land ends there.
