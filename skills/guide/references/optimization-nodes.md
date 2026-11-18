# Optimization nodes

An optimization node is a node whose spec declares an objective: a metric, a
direction or a judge panel, a target, a budget and a purpose. The objective is
the only marker. The ticket's `kind` stays `node`, and no label, ticket state or
source setting marks it. Because the marker makes a node file and dispatch its
own work, the rules below leave no room for a false positive and no silent
fallback in either direction.

This reference is the contract: how the marker is found, the objective schema,
what refuses an objective, how a node and its attempts are measured, how the
objective is revised, which facts the log records and what is derived from
them. It ends with grooming guidance.

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
| `optimization.proposal-requested` | node | id, node head, room, budget used (attempts, hours) |
| `optimization.attempts-proposed` | node | request, proposals (id, ticket, title, strategy), reason when empty |
| `attempt.measurement-requested` | attempt | id, node, candidate, baseline, harnessPin, revision, metric |
| `attempt.sampled` | attempt | request, candidate, baseline, harnessPin, revision, samples, medians, report |
| `attempt.measured` | attempt | request, candidate, baseline, harnessPin, revision, samples, medians or win rate, delta, decision, spread, report |
| `optimization.progress-measured` | node | revision, head, starting head, win rate, judges |
| `attempt.settled` | node | attempt (proposal, ticket, build), outcome, measurement (revision, baseline, candidate, delta), note |
| `optimization.stopped` | node | cause, mode |

`decision` is `improved`, `no-improvement`, `non-regressing` or `regressed`.
`outcome` is `accepted`, `no-improvement`, `declined`, `stopped` or `aborted`;
`accepted` and `no-improvement` carry their measurement. `cause` is
`threshold`, `plateau`, `budget`, `exhausted` or `operator`. `report`,
`spread` and a request's `metric` are optional: older facts lack them.
`attempt.sampled` records samples, never a decision; `attempt.measured` is the
decision.

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

## Attempts

A build is an attempt of a node exactly when its ticket was created from a
recorded proposal of that node (`optimization.attempts-proposed`). Children
filed any other way, for example a repair child, are not attempts and count
toward neither the budget nor the plateau.

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
